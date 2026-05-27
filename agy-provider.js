// OpenAI-compatible local provider that wraps the Antigravity `agy --print` CLI.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let pty = null;
try {
  pty = require("node-pty");
} catch (_err) {
  pty = null;
}

const PORT = parseInt(process.env.AGY_PORT || "9996", 10);
const MAX_BODY_SIZE = 10 * 1024 * 1024;
const TIMEOUT_MS = parseInt(process.env.AGY_TIMEOUT_MS || "300000", 10);
const MAX_CONCURRENCY = parseInt(process.env.AGY_MAX_CONCURRENCY || "1", 10);
const API_KEY = process.env.AGY_PROVIDER_API_KEY;
const MODEL_NAME = process.env.AGY_MODEL || "agy/antigravity";
const SECONDARY_MODEL_NAME = process.env.AGY_SECONDARY_MODEL || "agy/antigravity-opus";
const SETTINGS_PATH = process.env.AGY_SETTINGS_PATH || path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const MODEL_SETTINGS = {
  [MODEL_NAME]: process.env.AGY_MODEL_SETTING || "Gemini 3.5 Flash (Medium)",
  [SECONDARY_MODEL_NAME]: process.env.AGY_SECONDARY_MODEL_SETTING || "Claude Opus 4.6 (Thinking)",
};
const DEBUG = process.env.AGY_DEBUG === "1";
const USE_PTY = process.env.AGY_USE_PTY !== "0" && Boolean(pty);
const ARG_PROMPT_MAX_BYTES = parseInt(process.env.AGY_ARG_PROMPT_MAX_BYTES || "16000", 10);

const CANDIDATE_BINS = [process.env.AGY_BIN, "agy"];
const AGY_BIN = CANDIDATE_BINS.find((p) => p && (p === "agy" || fs.existsSync(p))) || "agy";

let activeRequests = 0;
let setupProcess = null;
let setupOutput = [];
let setupStatus = "idle";

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, statusCode, message, type = "invalid_request_error") {
  sendJson(res, statusCode, {
    error: {
      message,
      type,
      code: null,
    },
  });
}

function authenticate(req, res) {
  if (!API_KEY) return true;

  const expected = `Bearer ${API_KEY}`;
  if (req.headers.authorization === expected) return true;

  sendError(res, 401, "Unauthorized", "authentication_error");
  return false;
}

function readBody(req, res, callback) {
  const chunks = [];
  let size = 0;

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      sendError(res, 413, "Payload too large");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    try {
      callback(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
    } catch (_err) {
      sendError(res, 400, "Request body must be valid JSON");
    }
  });

  req.on("error", (err) => {
    sendError(res, 400, err.message);
  });
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (part?.text) return part.text;
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function buildPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0 && typeof body.prompt === "string") return body.prompt;

  const sections = [];
  for (const message of messages) {
    const role = message.role || "user";
    const content = textFromContent(message.content);
    if (content) sections.push(`${role.toUpperCase()}:\n${content}`);

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      sections.push(`${role.toUpperCase()} TOOL CALLS:\n${JSON.stringify(message.tool_calls, null, 2)}`);
    }
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sections.push(`AVAILABLE TOOLS:\n${JSON.stringify(body.tools, null, 2)}`);
  }

  return sections.join("\n\n").trim();
}

function appendSetupOutput(source, chunk) {
  const text = chunk.toString("utf-8");
  setupOutput.push({ time: new Date().toISOString(), source, text });
  if (setupOutput.length > 500) setupOutput = setupOutput.slice(-500);
}

function startInteractiveSetup() {
  if (setupProcess) return { started: false, status: setupStatus };

  setupOutput = [];
  setupStatus = "running";

  if (USE_PTY) {
    try {
      setupProcess = pty.spawn(AGY_BIN, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: process.env,
      });
      appendSetupOutput("system", `Started PTY ${AGY_BIN}\n`);
      setupProcess.onData((data) => appendSetupOutput("pty", data));
      setupProcess.onExit(({ exitCode }) => {
        setupStatus = exitCode === 0 ? "completed" : `exited:${exitCode}`;
        appendSetupOutput("system", `agy interactive PTY exited with code ${exitCode}\n`);
        setupProcess = null;
      });
      return { started: true, status: setupStatus, pty: true };
    } catch (err) {
      setupStatus = "error";
      appendSetupOutput("error", `${err.message}\n`);
      setupProcess = null;
      return { started: false, status: setupStatus, pty: true, error: err.message };
    }
  }

  setupProcess = spawn(AGY_BIN, [], {
    windowsHide: false,
    env: process.env,
    shell: false,
  });

  appendSetupOutput("system", `Started ${AGY_BIN}\n`);
  setupProcess.stdout.on("data", (chunk) => appendSetupOutput("stdout", chunk));
  setupProcess.stderr.on("data", (chunk) => appendSetupOutput("stderr", chunk));
  setupProcess.on("error", (err) => {
    setupStatus = "error";
    appendSetupOutput("error", `${err.message}\n`);
    setupProcess = null;
  });
  setupProcess.on("close", (code) => {
    setupStatus = code === 0 ? "completed" : `exited:${code}`;
    appendSetupOutput("system", `agy interactive process exited with code ${code}\n`);
    setupProcess = null;
  });

  return { started: true, status: setupStatus, pty: false };
}

function stopInteractiveSetup() {
  if (!setupProcess) return false;
  if (USE_PTY && setupProcess.kill) setupProcess.kill();
  else setupProcess.kill("SIGTERM");
  appendSetupOutput("system", "Stopped interactive agy process\n");
  return true;
}

function stripAnsi(value) {
  return value
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\][^]*(|\\)/g, "")
    .replace(/\r/g, "");
}

function selectModel(model) {
  const setting = MODEL_SETTINGS[model];
  if (!setting) return;

  let settings = {};
  try {
    if (fs.existsSync(SETTINGS_PATH)) settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read agy settings at ${SETTINGS_PATH}: ${err.message}`);
  }

  if (settings.model === setting) return;
  settings.model = setting;

  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  } catch (err) {
    throw new Error(`Failed to write agy settings at ${SETTINGS_PATH}: ${err.message}`);
  }
  console.log(`[agy] selected Antigravity model ${setting}`);
}

function createPromptInvocation(prompt) {
  if (Buffer.byteLength(prompt, "utf-8") <= ARG_PROMPT_MAX_BYTES) {
    return { promptArg: prompt, promptFile: null };
  }

  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-provider-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf-8");
  return {
    promptArg: `Read the full prompt from this UTF-8 text file and respond to it exactly as instructed inside the file: ${promptFile}`,
    promptFile,
  };
}

function cleanupPromptFile(promptFile) {
  if (!promptFile) return;
  try {
    fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
  } catch (err) {
    if (DEBUG) console.error("[agy] failed to remove prompt file", err.message);
  }
}

function runAgyWithPty(prompt, callback) {
  if (!USE_PTY) return false;

  const invocation = createPromptInvocation(prompt);
  const args = ["--print", invocation.promptArg, "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1000)}s`];
  if (DEBUG) console.log("[agy] pty", AGY_BIN, args.map((arg) => (arg === invocation.promptArg ? "[PROMPT]" : arg)).join(" "));

  let child;
  try {
    child = pty.spawn(AGY_BIN, args, {
      name: "xterm-256color",
      cols: 160,
      rows: 40,
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (err) {
    cleanupPromptFile(invocation.promptFile);
    activeRequests -= 1;
    callback(err);
    return true;
  }

  const output = [];
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    cleanupPromptFile(invocation.promptFile);
    activeRequests -= 1;
    callback(new Error(`agy timed out after ${TIMEOUT_MS}ms`));
  }, TIMEOUT_MS + 5000);

  child.onData((data) => output.push(data));
  child.onExit(({ exitCode }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanupPromptFile(invocation.promptFile);
    activeRequests -= 1;

    const text = stripAnsi(output.join(""))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .join("\n")
      .trim();

    if (exitCode !== 0) {
      callback(new Error(text || `agy exited with code ${exitCode}`));
      return;
    }
    if (!text) {
      callback(new Error("agy returned no output"));
      return;
    }
    callback(null, text);
  });

  return true;
}

function runAgy(prompt, model, callback) {
  if (activeRequests >= MAX_CONCURRENCY) {
    callback(new Error(`Too many active agy requests; AGY_MAX_CONCURRENCY=${MAX_CONCURRENCY}`));
    return;
  }

  try {
    selectModel(model || MODEL_NAME);
  } catch (err) {
    callback(err);
    return;
  }

  activeRequests += 1;
  if (runAgyWithPty(prompt, callback)) return;

  const invocation = createPromptInvocation(prompt);
  const args = ["--print", invocation.promptArg, "--print-timeout", `${Math.ceil(TIMEOUT_MS / 1000)}s`];
  if (DEBUG) console.log("[agy] spawn", AGY_BIN, args.map((arg) => (arg === invocation.promptArg ? "[PROMPT]" : arg)).join(" "));

  const child = spawn(AGY_BIN, args, {
    windowsHide: true,
    env: process.env,
  });

  const stdout = [];
  const stderr = [];
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGTERM");
    cleanupPromptFile(invocation.promptFile);
    activeRequests -= 1;
    callback(new Error(`agy timed out after ${TIMEOUT_MS}ms`));
  }, TIMEOUT_MS + 5000);

  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanupPromptFile(invocation.promptFile);
    activeRequests -= 1;
    callback(err);
  });

  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanupPromptFile(invocation.promptFile);
    activeRequests -= 1;

    const out = Buffer.concat(stdout).toString("utf-8").trim();
    const err = Buffer.concat(stderr).toString("utf-8").trim();
    if (DEBUG && err) console.error("[agy] stderr", err);

    if (code !== 0) {
      callback(new Error(err || `agy exited with code ${code}`));
      return;
    }
    if (!out) {
      callback(new Error("agy returned no output"));
      return;
    }
    callback(null, out);
  });
}

function completionResponse(body, text) {
  const id = `chatcmpl-agy-${Date.now()}`;
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || MODEL_NAME,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function streamCompletion(res, body, text) {
  const id = `chatcmpl-agy-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || MODEL_NAME;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`);

  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`);

  res.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);

  res.end("data: [DONE]\n\n");
}

function renderUi() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>agy provider</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 32px auto; padding: 0 16px; line-height: 1.5; }
    code, pre { background: #f5f5f5; border-radius: 6px; }
    code { padding: 2px 4px; }
    pre { padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    button { margin-right: 8px; padding: 8px 12px; }
    input { width: 100%; padding: 8px; box-sizing: border-box; }
    .row { margin: 16px 0; }
    .ok { color: #0a7f34; }
    .warn { color: #a15c00; }
    .err { color: #b00020; }
  </style>
</head>
<body>
  <h1>agy provider</h1>
  <p>This local adapter exposes <code>http://127.0.0.1:${PORT}/v1</code> and wraps <code>agy --print</code>.</p>
  <div class="row"><strong>agy binary:</strong> <code>${escapeHtml(AGY_BIN)}</code></div>
  <div class="row"><strong>terminal mode:</strong> <code>${USE_PTY ? "PTY / ConPTY" : "plain pipes"}</code></div>
  <div class="row"><strong>setup status:</strong> <span id="status">loading</span></div>
  <div class="row">
    <button onclick="startSetup()">Start interactive agy login/setup</button>
    <button onclick="stopSetup()">Stop setup process</button>
    <button onclick="runTest()">Run OK test</button>
  </div>
  <div class="row">
    <label>Test prompt</label>
    <input id="prompt" value="Reply with exactly OK">
  </div>
  <h2>Setup output</h2>
  <pre id="output"></pre>
  <h2>Test result</h2>
  <pre id="test"></pre>
<script>
async function json(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  try { return JSON.parse(text); } catch (_) { return { raw: text, status: response.status }; }
}
async function refresh() {
  const data = await json('/setup/status');
  document.getElementById('status').textContent = data.status;
  document.getElementById('output').textContent = data.output.map(e => '[' + e.time + '] ' + e.source + ': ' + e.text).join('');
}
async function startSetup() {
  await json('/setup/start', { method: 'POST' });
  await refresh();
}
async function stopSetup() {
  await json('/setup/stop', { method: 'POST' });
  await refresh();
}
async function runTest() {
  document.getElementById('test').textContent = 'running...';
  const prompt = document.getElementById('prompt').value;
  const data = await json('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '${MODEL_NAME}', messages: [{ role: 'user', content: prompt }] })
  });
  document.getElementById('test').textContent = JSON.stringify(data, null, 2);
}
setInterval(refresh, 1500);
refresh();
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function handleChatCompletions(req, res) {
  if (!authenticate(req, res)) return;

  readBody(req, res, (body) => {
    const prompt = buildPrompt(body);
    if (!prompt) {
      sendError(res, 400, "Request must include messages or prompt");
      return;
    }

    const requestedModel = body.model || MODEL_NAME;
    const finish = (model, text) => {
      console.log(`POST /v1/chat/completions -> agy ${model} ${text.length} chars`);
      const responseBody = { ...body, model };
      if (body.stream) {
        streamCompletion(res, responseBody, text);
      } else {
        sendJson(res, 200, completionResponse(responseBody, text));
      }
    };

    runAgy(prompt, requestedModel, (err, text) => {
      if (!err) {
        finish(requestedModel, text);
        return;
      }
      if (requestedModel === MODEL_NAME && SECONDARY_MODEL_NAME && SECONDARY_MODEL_NAME !== MODEL_NAME) {
        console.error(`agy request failed on ${requestedModel}; retrying ${SECONDARY_MODEL_NAME}:`, err.message);
        runAgy(prompt, SECONDARY_MODEL_NAME, (fallbackErr, fallbackText) => {
          if (fallbackErr) {
            console.error("agy fallback request failed:", fallbackErr.message);
            sendError(res, 502, fallbackErr.message, "provider_error");
            return;
          }
          finish(SECONDARY_MODEL_NAME, fallbackText);
        });
        return;
      }
      console.error("agy request failed:", err.message);
      sendError(res, 502, err.message, "provider_error");
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, 200, renderUi());
    return;
  }

  if (req.method === "POST" && url.pathname === "/setup/start") {
    sendJson(res, 200, startInteractiveSetup());
    return;
  }

  if (req.method === "POST" && url.pathname === "/setup/stop") {
    sendJson(res, 200, { stopped: stopInteractiveSetup(), status: setupStatus });
    return;
  }

  if (req.method === "GET" && url.pathname === "/setup/status") {
    sendJson(res, 200, { status: setupStatus, running: Boolean(setupProcess), output: setupOutput });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok", agyBin: AGY_BIN, activeRequests, usePty: USE_PTY });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!authenticate(req, res)) return;
    sendJson(res, 200, {
      object: "list",
      data: [MODEL_NAME, SECONDARY_MODEL_NAME].map((id) => ({ id, object: "model", created: 0, owned_by: "antigravity" })),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    handleChatCompletions(req, res);
    return;
  }

  sendError(res, 404, `No route for ${req.method} ${url.pathname}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Error: 127.0.0.1:${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agy provider listening on http://127.0.0.1:${PORT}`);
  console.log(`agy binary: ${AGY_BIN}`);
  console.log(`OpenAI-compatible base URL: http://127.0.0.1:${PORT}/v1`);
});
