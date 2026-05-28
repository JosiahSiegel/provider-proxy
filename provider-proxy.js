// Generic reverse proxy for OpenCode — injects custom headers and patches request bodies.
//
// Usage:
//   TARGET_HOST=app.manifest.build USER_AGENT="claude-code/0.1.0" node provider-proxy.js
//
// Then set in opencode.json:
//   "baseURL": "http://127.0.0.1:9999/v1"
//
// Environment variables:
//   TARGET_HOST      Upstream provider hostname (required unless TARGETS is set)
//   TARGET_PORT      Upstream port (default: 443 for https, 80 for http)
//   TARGET_PROTOCOL  https or http (default: https)
//   TARGETS          JSON array of route objects for multi-target routing (optional)
//                    e.g. TARGETS='[{"pathPrefix":"/kimi","host":"api.kimi.com"}]'
//                    Each route: pathPrefix, host, protocol?, port?, headers?, stripPrefix?
//   PROXY_PORT       Local port to bind (default: 9999)
//   PROXY_BIND       Local address to bind (default: 127.0.0.1).
//                    Set to 0.0.0.0 only when the proxy must accept connections
//                    from a Docker bridge (e.g. host.docker.internal on Linux)
//                    or another non-loopback peer. The host firewall is then the
//                    only thing preventing remote access — keep it locked down.
//   OLLAMA_BASE_URL  Optional Ollama/OpenAI-compatible upstream URL for /ollama
//   OLLAMA_NGROK_SKIP_BROWSER_WARNING  Set to 1 to add ngrok-skip-browser-warning:true for /ollama
//   USER_AGENT       User-Agent header to inject (optional)
//   EXTRA_HEADERS    JSON object of extra headers to inject (optional)
//                    e.g. EXTRA_HEADERS='{"x-app":"cli","x-custom":"value"}'

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Load .env file into process.env if it exists
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  try {
    const text = fs.readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        try {
          val = JSON.parse(val);
        } catch (_) {
          val = val.slice(1, -1);
        }
      } else if (val.startsWith("'") && val.endsWith("'")) {
        val = val.slice(1, -1);
      } else {
        const hashIdx = val.indexOf("#");
        if (hashIdx !== -1) {
          val = val.slice(0, hashIdx).trim();
        }
      }
      process.env[key] = val;
    }
  } catch (err) {
    console.error("[env] failed to load .env file:", err.message);
  }
}
const { spawn, spawnSync } = require("child_process");
const { createKaggleOllamaKeeper } = require("./kaggle-ollama-keeper");

let pty = null;
try {
  pty = require("node-pty");
} catch (_err) {
  pty = null;
}

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "9999", 10);
const PROXY_BIND = process.env.PROXY_BIND || "127.0.0.1";
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const DEBUG_PROXY = process.env.DEBUG_PROXY === "1";
const DEBUG_BODY = process.env.DEBUG_BODY === "1";
const AGY_PATH_PREFIX = process.env.AGY_PATH_PREFIX || "/agy";
const OLLAMA_PATH_PREFIX = process.env.OLLAMA_PATH_PREFIX || "/ollama";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const kaggleOllamaKeeper = createKaggleOllamaKeeper();
const OLLAMA_PROVIDER_API_KEY = process.env.OLLAMA_PROVIDER_API_KEY;
const OLLAMA_NGROK_SKIP_BROWSER_WARNING = process.env.OLLAMA_NGROK_SKIP_BROWSER_WARNING === "1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "ollama";
const AGY_TIMEOUT_MS = parseInt(process.env.AGY_TIMEOUT_MS || "300000", 10);
const AGY_MAX_CONCURRENCY = parseInt(process.env.AGY_MAX_CONCURRENCY || "1", 10);
const AGY_PROVIDER_API_KEY = process.env.AGY_PROVIDER_API_KEY;
const AGY_MODEL = process.env.AGY_MODEL || "agy/antigravity";
const AGY_SECONDARY_MODEL = process.env.AGY_SECONDARY_MODEL || "agy/antigravity-opus";
const AGY_SETTINGS_PATH = process.env.AGY_SETTINGS_PATH || path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const AGY_MODEL_SETTINGS = {
  [AGY_MODEL]: process.env.AGY_MODEL_SETTING || "Gemini 3.5 Flash (Medium)",
  [AGY_SECONDARY_MODEL]: process.env.AGY_SECONDARY_MODEL_SETTING || "Claude Opus 4.6 (Thinking)",
};
const AGY_DEBUG = process.env.AGY_DEBUG === "1";
const AGY_USE_PTY = process.env.AGY_USE_PTY !== "0" && Boolean(pty);
const AGY_ARG_PROMPT_MAX_BYTES = parseInt(process.env.AGY_ARG_PROMPT_MAX_BYTES || "16000", 10);

function commandExists(command) {
  return spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    encoding: "utf8",
    windowsHide: true,
  }).status === 0;
}

function resolveCommand(command) {
  if (!command || path.isAbsolute(command) || command.includes(path.sep) || (path.sep === "\\" && command.includes("/"))) return command;
  const result = spawnSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? [command] : ["-v", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return command;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || command;
}

const AGY_CANDIDATE_BINS = [process.env.AGY_BIN, "agy"];
const AGY_BIN = resolveCommand(AGY_CANDIDATE_BINS.find((p) => p && (fs.existsSync(p) || commandExists(p))) || "agy");

let agyActiveRequests = 0;
let agySetupProcess = null;
let agySetupOutput = [];
let agySetupStatus = "idle";

// Default target (backward compatible single-target mode)
const DEFAULT_TARGET = {
  host: process.env.TARGET_HOST,
  protocol: (process.env.TARGET_PROTOCOL || "https").toLowerCase(),
  port: parseInt(
    process.env.TARGET_PORT || ((process.env.TARGET_PROTOCOL || "https") === "https" ? 443 : 80),
    10
  ),
};

// Parse optional multi-target routes from TARGETS JSON array.
// Each route: { pathPrefix: "/kimi", host: "api.kimi.com", protocol?: "https", port?: 443, headers?: {}, stripPrefix?: true }
let TARGET_ROUTES = [];
if (process.env.TARGETS) {
  try {
    TARGET_ROUTES = JSON.parse(process.env.TARGETS);
    if (!Array.isArray(TARGET_ROUTES)) throw new Error("TARGETS must be an array");
    for (const route of TARGET_ROUTES) {
      if (!route.pathPrefix || !route.host) {
        throw new Error("Each target route requires 'pathPrefix' and 'host'");
      }
      route.protocol = (route.protocol || "https").toLowerCase();
      route.port = parseInt(route.port || (route.protocol === "https" ? 443 : 80), 10);
      route.stripPrefix = route.stripPrefix !== false; // default true
    }
  } catch (err) {
    console.error("Error: TARGETS must be a valid JSON array of route objects.", err.message);
    process.exit(1);
  }
}

if (!DEFAULT_TARGET.host && TARGET_ROUTES.length === 0) {
  console.log("No TARGET_HOST or TARGETS configured; only built-in routes such as /agy will be available.");
}

// Build injected headers from environment
const INJECTED_HEADERS = {};
if (process.env.USER_AGENT) {
  INJECTED_HEADERS["user-agent"] = process.env.USER_AGENT;
}
if (process.env.EXTRA_HEADERS) {
  try {
    const extra = JSON.parse(process.env.EXTRA_HEADERS);
    Object.assign(INJECTED_HEADERS, extra);
  } catch (err) {
    console.error("Error: EXTRA_HEADERS must be valid JSON.", err.message);
    process.exit(1);
  }
}

function redactHeaders(headers) {
  const redacted = { ...headers };
  for (const key of Object.keys(redacted)) {
    if (["authorization", "cookie", "x-api-key", "api-key"].includes(key.toLowerCase())) {
      redacted[key] = "[REDACTED]";
    }
  }
  return redacted;
}

function resolveRoute(reqPath) {
  for (const route of TARGET_ROUTES) {
    if (reqPath.startsWith(route.pathPrefix)) {
      return route;
    }
  }
  return DEFAULT_TARGET.host ? DEFAULT_TARGET : null;
}

function getRequestModule(protocol) {
  return protocol === "https" ? https : http;
}

function summarizeJsonBody(bodyBuf) {
  try {
    const obj = JSON.parse(bodyBuf.toString("utf-8"));
    return {
      keys: Object.keys(obj),
      model: obj.model,
      stream: obj.stream,
      messages: Array.isArray(obj.messages) ? obj.messages.length : undefined,
      tools: Array.isArray(obj.tools) ? obj.tools.length : undefined,
      thinking: Boolean(obj.thinking),
    };
  } catch (_e) {
    return { parseable: false, bytes: bodyBuf.length };
  }
}

function debugRequest(options, bodyBuf, route) {
  if (!DEBUG_PROXY) return;
  console.log("[debug] upstream request", {
    method: options.method,
    url: `${route.protocol}://${route.host}:${route.port}${options.path}`,
    headers: redactHeaders(options.headers),
    body: bodyBuf ? summarizeJsonBody(bodyBuf) : undefined,
  });
  if (DEBUG_BODY && bodyBuf) {
    console.log("[debug] body", bodyBuf.toString("utf-8"));
  }
}

// Sanitize JSON Schema objects for providers with stricter schema subsets.
function sanitizeSchema(value) {
  if (!value || typeof value !== "object") return false;

  let modified = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (sanitizeSchema(item)) modified = true;
    }
    return modified;
  }

  for (const key of ["exclusiveMinimum", "exclusiveMaximum", "$ref", "ref", "$schema", "additionalProperties"]) {
    if (key in value) {
      delete value[key];
      modified = true;
    }
  }

  for (const item of Object.values(value)) {
    if (sanitizeSchema(item)) modified = true;
  }

  return modified;
}

// Patch request bodies to fix common provider-specific validation errors.
function patchRequestBody(bodyBuf, contentType) {
  if (!contentType?.includes("application/json")) return bodyBuf;
  try {
    const obj = JSON.parse(bodyBuf.toString("utf-8"));
    let modified = false;

    // Fix: thinking enabled but assistant messages lack reasoning_content
    if (obj.thinking && Array.isArray(obj.messages)) {
      for (const msg of obj.messages) {
        if (msg.role === "assistant" && msg.content != null && !("reasoning_content" in msg)) {
          msg.reasoning_content = "";
          modified = true;
        }
      }
      if (modified) console.log("[patch] injected reasoning_content into assistant messages");
    }

    // Fix: OpenAI-compatible providers reject the Anthropic-style thinking param.
    if ("thinking" in obj) {
      delete obj.thinking;
      modified = true;
      console.log("[patch] removed thinking param for provider compatibility");
    }

    // Fix: Gemini rejects unsupported JSON Schema keywords in tool declarations.
    if (sanitizeSchema(obj.tools)) {
      console.log("[patch] sanitized unsupported tool schema keywords");
      modified = true;
    }

    // Fix: If model is the generic "ollama", map it to the active Kaggle keeper model or default
    if (obj.model === "ollama" || obj.model === "ollama:latest") {
      const activeModel = kaggleOllamaKeeper.getStatus()?.model || OLLAMA_MODEL || "llama3.2";
      if (activeModel && activeModel !== obj.model) {
        console.log(`[patch] mapping model from "${obj.model}" to "${activeModel}"`);
        obj.model = activeModel;
        modified = true;
      }
    }

    if (modified) return Buffer.from(JSON.stringify(obj), "utf-8");
  } catch (_e) {
    // Not valid JSON or parse error — pass through unchanged
  }
  return bodyBuf;
}

// Returns true if the request method typically has a body we should buffer and patch.
function shouldBufferBody(method) {
  return ["POST", "PUT", "PATCH"].includes(method?.toUpperCase());
}

// Create upstream request options from incoming request.
function buildOptions(req, route) {
  const parsed = new URL(req.url, `http://127.0.0.1:${PROXY_PORT}`);
  let path = parsed.pathname + parsed.search;
  if (route.pathPrefix && route.stripPrefix && path.startsWith(route.pathPrefix)) {
    path = path.slice(route.pathPrefix.length) || "/";
  }

  const options = {
    hostname: route.host,
    port: route.port,
    path,
    method: req.method,
    headers: {
      ...req.headers,
      host: route.host,
      ...INJECTED_HEADERS,
      ...(route.headers || {}),
    },
  };

  // Remove hop-by-hop and connection-specific headers per RFC 2616
  delete options.headers["connection"];
  delete options.headers["proxy-connection"];
  delete options.headers["keep-alive"];
  delete options.headers["transfer-encoding"];
  delete options.headers["upgrade"];
  delete options.headers["te"];
  delete options.headers["trailer"];

  // Remove proxy chain headers to prevent information disclosure
  delete options.headers["x-forwarded-for"];
  delete options.headers["x-forwarded-host"];
  delete options.headers["x-forwarded-proto"];
  delete options.headers["x-forwarded-port"];
  delete options.headers["x-real-ip"];
  delete options.headers["x-original-host"];
  delete options.headers["x-original-url"];

  // Ensure host is always the upstream target (defensive)
  delete options.headers.host;
  options.headers.host = route.host;

  return options;
}

// Forward upstream response to client.
function forwardResponse(proxyRes, res) {
  // Strip hop-by-hop headers from upstream response
  const proxyResHeaders = { ...proxyRes.headers };
  delete proxyResHeaders["connection"];
  delete proxyResHeaders["keep-alive"];
  delete proxyResHeaders["proxy-connection"];

  res.writeHead(proxyRes.statusCode, proxyResHeaders);
  proxyRes.pipe(res, { end: true });

  proxyRes.on("error", (err) => {
    console.error("Upstream response error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad gateway", message: err.message }));
    } else {
      res.end();
    }
  });
}

// Wire up error handling and client disconnect cleanup.
function wireHandlers(proxyReq, req, res) {
  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad gateway", message: err.message }));
    }
  });

  req.on("aborted", () => proxyReq.destroy());
  req.on("error", (err) => {
    console.error("Client request error:", err.message);
    proxyReq.destroy();
  });
}

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
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

function sendOpenAiError(res, statusCode, message, type = "invalid_request_error", headers = {}) {
  const payload = JSON.stringify({ error: { message, type, code: null } });
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function authenticateAgy(req, res) {
  if (!AGY_PROVIDER_API_KEY) return true;
  if (req.headers.authorization === `Bearer ${AGY_PROVIDER_API_KEY}`) return true;
  sendOpenAiError(res, 401, "Unauthorized", "authentication_error");
  return false;
}

function authenticateOllama(req, res) {
  if (!OLLAMA_PROVIDER_API_KEY) return true;
  if (req.headers.authorization === `Bearer ${OLLAMA_PROVIDER_API_KEY}`) return true;
  sendOpenAiError(res, 401, "Unauthorized", "authentication_error");
  return false;
}

function readJsonBody(req, res, callback) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      sendOpenAiError(res, 413, "Payload too large");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      callback(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
    } catch (_err) {
      sendOpenAiError(res, 400, "Request body must be valid JSON");
    }
  });
  req.on("error", (err) => sendOpenAiError(res, 400, err.message));
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function textFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return part == null ? "" : String(part);
  if (part.type === "text") return part.text || "";
  if (part.type === "tool_use") return `[tool_use ${part.name || "unknown"}${part.id ? ` ${part.id}` : ""}]\n${stableJson(part.input || {})}`;
  if (part.type === "tool_result") return `[tool_result${part.tool_use_id ? ` ${part.tool_use_id}` : ""}]\n${textFromContent(part.content)}`;
  if (part.type === "thinking") return `[thinking]\n${part.thinking || ""}`;
  if (part.type) return `[${part.type}]\n${stableJson(part)}`;
  if (part.text) return part.text;
  return stableJson(part);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContentPart(content);
  return content.map(textFromContentPart).filter(Boolean).join("\n");
}

function buildAgyPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0 && typeof body.prompt === "string") return body.prompt;

  const sections = [];
  const system = Array.isArray(body.system) ? body.system.map(textFromContent).filter(Boolean).join("\n\n") : textFromContent(body.system);
  if (system) sections.push(`SYSTEM:\n${system}`);

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sections.push(`AVAILABLE TOOLS:\n${stableJson(body.tools)}`);
  }

  const requestSettings = {};
  for (const key of ["thinking", "output_config", "context_management", "max_tokens", "metadata"]) {
    if (body[key] !== undefined) requestSettings[key] = body[key];
  }
  if (Object.keys(requestSettings).length > 0) sections.push(`REQUEST SETTINGS:\n${stableJson(requestSettings)}`);

  for (const message of messages) {
    const role = message.role || "user";
    const content = textFromContent(message.content);
    if (content) sections.push(`${role.toUpperCase()}:\n${content}`);
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      sections.push(`${role.toUpperCase()} TOOL CALLS:\n${stableJson(message.tool_calls)}`);
    }
  }

  return sections.join("\n\n").trim();
}

function appendAgySetupOutput(source, chunk) {
  const text = chunk.toString("utf-8");
  agySetupOutput.push({ time: new Date().toISOString(), source, text });
  if (agySetupOutput.length > 500) agySetupOutput = agySetupOutput.slice(-500);
}

function startAgyInteractiveSetup() {
  console.log(`[agy] setup start requested; usePty=${AGY_USE_PTY}; bin=${AGY_BIN}`);
  if (agySetupProcess) return { started: false, status: agySetupStatus };
  agySetupOutput = [];
  agySetupStatus = "running";

  if (AGY_USE_PTY) {
    try {
      agySetupProcess = pty.spawn(AGY_BIN, [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: process.env,
      });
      appendAgySetupOutput("system", `Started PTY ${AGY_BIN}\n`);
      console.log(`[agy] setup started with PTY ${AGY_BIN}`);
      agySetupProcess.onData((data) => appendAgySetupOutput("pty", data));
      agySetupProcess.onExit(({ exitCode }) => {
        agySetupStatus = exitCode === 0 ? "completed" : `exited:${exitCode}`;
        appendAgySetupOutput("system", `agy interactive PTY exited with code ${exitCode}\n`);
        agySetupProcess = null;
      });
      return { started: true, status: agySetupStatus, pty: true };
    } catch (err) {
      console.error(`[agy] setup PTY failed: ${err.message}`);
      agySetupStatus = "error";
      appendAgySetupOutput("error", `${err.message}\n`);
      agySetupProcess = null;
      return { started: false, status: agySetupStatus, pty: true, error: err.message };
    }
  }

  agySetupProcess = spawn(AGY_BIN, [], { windowsHide: false, env: process.env, shell: false });
  appendAgySetupOutput("system", `Started ${AGY_BIN}\n`);
  console.log(`[agy] setup started with spawn ${AGY_BIN}`);
  agySetupProcess.stdout.on("data", (chunk) => appendAgySetupOutput("stdout", chunk));
  agySetupProcess.stderr.on("data", (chunk) => appendAgySetupOutput("stderr", chunk));
  agySetupProcess.on("error", (err) => {
    agySetupStatus = "error";
    appendAgySetupOutput("error", `${err.message}\n`);
    agySetupProcess = null;
  });
  agySetupProcess.on("close", (code) => {
    agySetupStatus = code === 0 ? "completed" : `exited:${code}`;
    appendAgySetupOutput("system", `agy interactive process exited with code ${code}\n`);
    agySetupProcess = null;
  });
  return { started: true, status: agySetupStatus, pty: false };
}

function stopAgyInteractiveSetup() {
  if (!agySetupProcess) return false;
  if (AGY_USE_PTY && agySetupProcess.kill) agySetupProcess.kill();
  else agySetupProcess.kill("SIGTERM");
  appendAgySetupOutput("system", "Stopped interactive agy process\n");
  return true;
}

function writeAgyInteractiveInput(data) {
  if (!agySetupProcess || agySetupStatus !== "running") return { ok: false, error: "agy setup process is not running" };
  if (typeof data !== "string") return { ok: false, error: "input must be a string" };
  if (Buffer.byteLength(data, "utf-8") > 4096) return { ok: false, error: "input too large" };
  if (AGY_USE_PTY && typeof agySetupProcess.write === "function") {
    agySetupProcess.write(data);
    return { ok: true };
  }
  if (agySetupProcess.stdin?.writable) {
    agySetupProcess.stdin.write(data);
    return { ok: true };
  }
  return { ok: false, error: "agy setup process is not writable" };
}

function stripAnsi(value) {
  return value
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\][^]*(|\\)/g, "")
    .replace(/\r/g, "");
}

function browserTerminalText(value) {
  return stripAnsi(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function extractTerminalUrls(value) {
  const lines = browserTerminalText(value).split("\n");
  const urls = [];
  const urlChars = /^[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+$/;
  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i].search(/https?:\/\//);
    if (start === -1) continue;
    let candidate = lines[i].slice(start).trim();
    for (let j = i + 1; j < lines.length; j += 1) {
      const part = lines[j].trim();
      if (!part || !urlChars.test(part)) break;
      candidate += part;
      i = j;
    }
    candidate = candidate.replace(/[>)}\].,;:'"]+$/g, "");
    try {
      urls.push(new URL(candidate).href);
    } catch (_err) {}
  }
  return [...new Set(urls)].slice(-5);
}

function selectAgyModel(model) {
  const setting = AGY_MODEL_SETTINGS[model];
  if (!setting) return;

  let settings = {};
  try {
    if (fs.existsSync(AGY_SETTINGS_PATH)) settings = JSON.parse(fs.readFileSync(AGY_SETTINGS_PATH, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to read agy settings at ${AGY_SETTINGS_PATH}: ${err.message}`);
  }

  if (settings.model === setting) return;
  settings.model = setting;

  try {
    fs.mkdirSync(path.dirname(AGY_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(AGY_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  } catch (err) {
    throw new Error(`Failed to write agy settings at ${AGY_SETTINGS_PATH}: ${err.message}`);
  }
  console.log(`[agy] selected Antigravity model ${setting}`);
}

function createAgyPromptInvocation(prompt) {
  if (Buffer.byteLength(prompt, "utf-8") <= AGY_ARG_PROMPT_MAX_BYTES) {
    return { promptArg: prompt, promptFile: null };
  }

  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-proxy-agy-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  fs.writeFileSync(promptFile, prompt, "utf-8");
  return {
    promptArg: `Read the full prompt from this UTF-8 text file and respond to it exactly as instructed inside the file: ${JSON.stringify(promptFile)}`,
    promptFile,
  };
}

function createAgyArgs(invocation) {
  const args = [];
  if (invocation.promptFile) args.push("--add-dir", path.dirname(invocation.promptFile));
  args.push("--print", invocation.promptArg, "--print-timeout", `${Math.ceil(AGY_TIMEOUT_MS / 1000)}s`);
  return args;
}

function cleanupAgyPromptFile(promptFile) {
  if (!promptFile) return;
  setTimeout(() => {
    try {
      fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
    } catch (err) {
      if (AGY_DEBUG) console.error("[agy] failed to remove prompt file", err.message);
    }
  }, 30_000).unref?.();
}

function runAgyWithPty(prompt, callback) {
  if (!AGY_USE_PTY) return false;
  const invocation = createAgyPromptInvocation(prompt);
  const args = createAgyArgs(invocation);
  console.log("[agy] chat using PTY", AGY_BIN, invocation.promptFile ? "file" : "argv");
  if (AGY_DEBUG) console.log("[agy] pty", AGY_BIN, args.map((arg) => (arg === invocation.promptArg ? "[PROMPT]" : arg)).join(" "));

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
    cleanupAgyPromptFile(invocation.promptFile);
    agyActiveRequests -= 1;
    callback(err);
    return true;
  }

  const output = [];
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    agyActiveRequests -= 1;
    callback(new Error(`agy timed out after ${AGY_TIMEOUT_MS}ms`));
  }, AGY_TIMEOUT_MS + 5000);

  child.onData((data) => output.push(data));
  child.onExit(({ exitCode }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanupAgyPromptFile(invocation.promptFile);
    agyActiveRequests -= 1;
    const text = stripAnsi(output.join(""))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .join("\n")
      .trim();
    if (exitCode !== 0) callback(new Error(text || `agy exited with code ${exitCode}`));
    else if (!text) callback(new Error("agy returned no output"));
    else callback(null, text);
  });
  return true;
}

function runAgy(prompt, model, callback) {
  console.log(`[agy] chat request start; model=${model || AGY_MODEL}; usePty=${AGY_USE_PTY}; bin=${AGY_BIN}; active=${agyActiveRequests}`);
  if (agyActiveRequests >= AGY_MAX_CONCURRENCY) {
    callback(new Error(`Too many active agy requests; AGY_MAX_CONCURRENCY=${AGY_MAX_CONCURRENCY}`));
    return;
  }

  try {
    selectAgyModel(model || AGY_MODEL);
  } catch (err) {
    callback(err);
    return;
  }

  agyActiveRequests += 1;
  if (runAgyWithPty(prompt, callback)) return;
  console.log(`[agy] chat using spawn fallback ${AGY_BIN}`);

  const invocation = createAgyPromptInvocation(prompt);
  const args = createAgyArgs(invocation);
  if (AGY_DEBUG) console.log("[agy] spawn", AGY_BIN, args.map((arg) => (arg === invocation.promptArg ? "[PROMPT]" : arg)).join(" "));

  const child = spawn(AGY_BIN, args, { windowsHide: true, env: process.env });
  const stdout = [];
  const stderr = [];
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGTERM");
    cleanupAgyPromptFile(invocation.promptFile);
    agyActiveRequests -= 1;
    callback(new Error(`agy timed out after ${AGY_TIMEOUT_MS}ms`));
  }, AGY_TIMEOUT_MS + 5000);

  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanupAgyPromptFile(invocation.promptFile);
    agyActiveRequests -= 1;
    callback(err);
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanupAgyPromptFile(invocation.promptFile);
    agyActiveRequests -= 1;
    const out = Buffer.concat(stdout).toString("utf-8").trim();
    const err = Buffer.concat(stderr).toString("utf-8").trim();
    if (AGY_DEBUG && err) console.error("[agy] stderr", err);
    if (code !== 0) callback(new Error(err || `agy exited with code ${code}`));
    else if (!out) callback(new Error("agy returned no output"));
    else callback(null, out);
  });
}

function openAiCompletionResponse(body, text) {
  return {
    id: `chatcmpl-agy-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || AGY_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function streamOpenAiCompletion(res, body, text) {
  const id = `chatcmpl-agy-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || AGY_MODEL;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function renderAgyUi() {
  const base = `http://127.0.0.1:${PROXY_PORT}${AGY_PATH_PREFIX}`;
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
    #terminal { background: #111; color: #eee; min-height: 320px; max-height: 520px; overflow: auto; outline: 2px solid transparent; user-select: text; }
    #terminal:focus { outline-color: #6aa9ff; }
    #links:empty { display: none; }
    #links a { display: block; margin: 4px 0; overflow-wrap: anywhere; }
    .hint { color: #666; }
  </style>
</head>
<body>
  <h1>agy provider</h1>
  <p>This built-in route exposes <code>${base}/v1</code> and wraps <code>agy --print</code>.</p>
  <div class="row"><strong>agy binary:</strong> <code>${escapeHtml(AGY_BIN)}</code></div>
  <div class="row"><strong>terminal mode:</strong> <code>${AGY_USE_PTY ? "PTY / ConPTY" : "plain pipes"}</code></div>
  <div class="row"><strong>setup status:</strong> <span id="status">loading</span></div>
  <div class="row">
    <button onclick="startSetup()">Start interactive agy login/setup</button>
    <button onclick="stopSetup()">Stop setup process</button>
    <button onclick="runTest()">Run OK test</button>
  </div>
  <div class="row"><label>Test prompt</label><input id="prompt" value="Reply with exactly OK"></div>
  <h2>Interactive setup terminal</h2>
  <p class="hint">Click the terminal, then type normally. Select text to copy; output only auto-scrolls if you are already at the bottom. Ctrl+C is forwarded to agy when no text is selected.</p>
  <pre id="terminal" tabindex="0" aria-label="Interactive agy setup terminal"></pre>
  <div id="links" class="row"></div>
  <h2>Test result</h2><pre id="test"></pre>
<script>
const prefixes = Array.from(new Set([
  new URL('.', window.location.href).pathname.replace(/\\/$/, ''),
  '',
  ${JSON.stringify(AGY_PATH_PREFIX)}
]));
let activePrefix = null;
let lastTerminalText = '';
function terminalText(output) {
  return (output || []).map(e => e && e.text ? e.text : '').join('');
}
function renderLinks(urls) {
  const links = document.getElementById('links');
  urls = Array.isArray(urls) ? urls : [];
  links.textContent = '';
  for (const url of urls) {
    const row = document.createElement('div');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = url;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy URL';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(url);
      document.getElementById('test').textContent = 'Copied URL: ' + url;
    };
    row.append(a, copy);
    links.append(row);
  }
}
async function requestJson(prefix, path, options) {
  const response = await fetch(prefix + path, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { ok: response.ok, status: response.status, data, prefix };
}
async function discoverPrefix() {
  const candidates = activePrefix === null ? prefixes : [activePrefix, ...prefixes.filter((prefix) => prefix !== activePrefix)];
  let last = null;
  for (const prefix of candidates) {
    const result = await requestJson(prefix, '/setup/status');
    if (result.ok && result.data && Array.isArray(result.data.output)) {
      activePrefix = prefix;
      return result.data;
    }
    last = result;
  }
  activePrefix = null;
  return { status: 'unreachable', output: [], error: last && last.data };
}
async function json(path, options) {
  if (activePrefix === null) await discoverPrefix();
  const candidates = activePrefix === null ? prefixes : [activePrefix, ...prefixes.filter((prefix) => prefix !== activePrefix)];
  let last = null;
  for (const prefix of candidates) {
    const result = await requestJson(prefix, path, options);
    if (result.ok) {
      activePrefix = prefix;
      return result.data;
    }
    last = result;
  }
  activePrefix = null;
  return last ? last.data : { error: 'request failed' };
}
async function sendTerminalInput(input) {
  const result = await json('/setup/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input })
  });
  if (result && result.error) document.getElementById('test').textContent = JSON.stringify(result, null, 2);
}
function setupTerminalKeyboard() {
  const terminal = document.getElementById('terminal');
  terminal.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      if (String(window.getSelection())) return;
      event.preventDefault();
      sendTerminalInput('\\u0003');
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      sendTerminalInput('\\r');
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      sendTerminalInput('\\u007f');
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      sendTerminalInput('\\t');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      sendTerminalInput('\\u001b');
      return;
    }
    if (event.key === 'ArrowUp') return void sendTerminalInput('\\u001b[A');
    if (event.key === 'ArrowDown') return void sendTerminalInput('\\u001b[B');
    if (event.key === 'ArrowRight') return void sendTerminalInput('\\u001b[C');
    if (event.key === 'ArrowLeft') return void sendTerminalInput('\\u001b[D');
    if (event.key.length === 1) {
      event.preventDefault();
      sendTerminalInput(event.key);
    }
  });
  terminal.addEventListener('paste', (event) => {
    const text = event.clipboardData && event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    sendTerminalInput(text);
  });
}
async function refresh() {
  const data = await discoverPrefix();
  document.getElementById('status').textContent = data.status || 'unreachable';
  const terminal = document.getElementById('terminal');
  const output = Array.isArray(data.output) ? data.output : [];
  const lineBreak = String.fromCharCode(10);
  const nextText = terminalText(output) || (data.status === 'running' ? 'agy setup is running; waiting for terminal output...' + lineBreak : 'Click "Start interactive agy login/setup" to start a terminal.' + lineBreak);
  if (nextText !== lastTerminalText) {
    const wasNearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 24;
    terminal.textContent = nextText;
    renderLinks(data.urls);
    if (wasNearBottom || !lastTerminalText) terminal.scrollTop = terminal.scrollHeight;
    lastTerminalText = nextText;
  }
}
async function startSetup() {
  document.getElementById('status').textContent = 'starting...';
  try {
    const data = await json('/setup/start', { method: 'POST' });
    document.getElementById('test').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    document.getElementById('test').textContent = String(err && err.stack ? err.stack : err);
  }
  await refresh();
}
async function stopSetup() { await json('/setup/stop', { method: 'POST' }); await refresh(); }
async function runTest() {
  document.getElementById('test').textContent = 'running...';
  try {
    const prompt = document.getElementById('prompt').value;
    const data = await json('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ${JSON.stringify(AGY_MODEL)}, messages: [{ role: 'user', content: prompt }] })
    });
    document.getElementById('test').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    document.getElementById('test').textContent = String(err && err.stack ? err.stack : err);
  }
}
setupTerminalKeyboard();
setInterval(refresh, 500);
refresh();
</script>
</body>
</html>`;
}

function handleAgyChatCompletions(req, res) {
  if (!authenticateAgy(req, res)) return;
  readJsonBody(req, res, (body) => {
    const prompt = buildAgyPrompt(body);
    if (!prompt) {
      sendOpenAiError(res, 400, "Request must include messages or prompt");
      return;
    }

    const requestedModel = body.model || AGY_MODEL;
    const finish = (model, text) => {
      console.log(`POST ${AGY_PATH_PREFIX}/v1/chat/completions -> agy ${model} ${text.length} chars`);
      const responseBody = { ...body, model };
      if (body.stream) streamOpenAiCompletion(res, responseBody, text);
      else sendJson(res, 200, openAiCompletionResponse(responseBody, text));
    };

    runAgy(prompt, requestedModel, (err, text) => {
      if (!err) {
        finish(requestedModel, text);
        return;
      }
      if (requestedModel === AGY_MODEL && AGY_SECONDARY_MODEL && AGY_SECONDARY_MODEL !== AGY_MODEL) {
        console.error(`agy request failed on ${requestedModel}; retrying ${AGY_SECONDARY_MODEL}:`, err.message);
        runAgy(prompt, AGY_SECONDARY_MODEL, (fallbackErr, fallbackText) => {
          if (fallbackErr) {
            console.error("agy fallback request failed:", fallbackErr.message);
            sendOpenAiError(res, 502, fallbackErr.message, "provider_error");
            return;
          }
          finish(AGY_SECONDARY_MODEL, fallbackText);
        });
        return;
      }
      console.error("agy request failed:", err.message);
      sendOpenAiError(res, 502, err.message, "provider_error");
    });
  });
}

function normalizeOllamaBaseUrl() {
  const keeperUrl = kaggleOllamaKeeper.getBaseUrl();
  const baseUrl = kaggleOllamaKeeper.enabled ? keeperUrl : keeperUrl || OLLAMA_BASE_URL;
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/$/, "");
    return url;
  } catch (_err) {
    return null;
  }
}

function shouldWakeOllamaKeeper(status, ollamaBase) {
  return status.enabled && !ollamaBase && !status.waking && !status.checking && !status.stopping && status.status !== "stopping";
}

function shouldRetryOllamaLater(status) {
  if (!status.enabled) return false;
  if (status.stopping) return false;
  if (status.waking || status.checking || status.wakeRequested) return true;
  return [
    "missing-or-inaccessible",
    "KernelWorkerStatus.ERROR",
    "KernelWorkerStatus.CANCEL_ACKNOWLEDGED",
    "KernelWorkerStatus.CANCELED",
    "KernelWorkerStatus.CANCELLED",
  ].includes(status.status);
}

function ollamaUnavailableMessage(status) {
  if (!status.enabled) return "Kaggle keeper not enabled; set KAGGLE_OLLAMA_AUTO=1 or set OLLAMA_BASE_URL";
  if (status.stopping || status.status === "stopping") return "Ollama upstream is stopping. Try another provider and retry later.";
  if (status.idle || status.status === "idle" || status.status === "idle_stopped") return "Ollama upstream is idle or stopped; Kaggle keeper wake requested. Retry shortly.";
  if (status.waking || status.checking || status.wakeRequested) return "Ollama upstream is starting. Try another provider and retry shortly.";
  return "Ollama upstream is unavailable; Kaggle keeper wake requested. Retry shortly.";
}

function ollamaUpstreamPath(pathname, search) {
  const suffix = pathname.slice(OLLAMA_PATH_PREFIX.length) || "/";
  return suffix.startsWith("/v1/") ? `${suffix}${search}` : `/v1${suffix}${search}`;
}

function handleOllamaRoute(req, res, parsedReqUrl) {
  if (parsedReqUrl.pathname !== OLLAMA_PATH_PREFIX && !parsedReqUrl.pathname.startsWith(`${OLLAMA_PATH_PREFIX}/`)) return false;

  const isStatusRequest = req.method === "GET" && (parsedReqUrl.pathname === OLLAMA_PATH_PREFIX || parsedReqUrl.pathname === `${OLLAMA_PATH_PREFIX}/`);
  if (parsedReqUrl.pathname === `${OLLAMA_PATH_PREFIX}/callback`) {
    readJsonBody(req, res, (body) => {
      const result = kaggleOllamaKeeper.acceptCallback(req, body);
      if (!result.ok) sendOpenAiError(res, result.status || 400, result.error || "Callback rejected");
      else sendJson(res, 200, { status: "ok", upstream: result.url, model: result.model });
    });
    return true;
  }

  if (!authenticateOllama(req, res)) return true;

  const ollamaBase = normalizeOllamaBaseUrl();
  const status = kaggleOllamaKeeper.getStatus();

  if (isStatusRequest) {
    sendJson(res, 200, {
      status: ollamaBase ? "ok" : status.status || "unavailable",
      baseURL: `http://127.0.0.1:${PROXY_PORT}${OLLAMA_PATH_PREFIX}/v1`,
      upstream: ollamaBase ? `${ollamaBase.origin}${ollamaBase.pathname}` : null,
      model: status.model || OLLAMA_MODEL,
      ngrokSkipBrowserWarning: OLLAMA_NGROK_SKIP_BROWSER_WARNING,
      kaggle: status,
    });
    return true;
  }

  if (!ollamaBase) {
    const shouldWake = shouldWakeOllamaKeeper(status, ollamaBase);
    const shouldRetryLater = shouldWake || shouldRetryOllamaLater(status);
    if (shouldWake) {
      console.log("[ollama] no upstream available; requesting Kaggle keeper wake");
      kaggleOllamaKeeper.wake().catch((err) => console.error("[ollama] Kaggle keeper wake failed:", err.message));
    }
    sendOpenAiError(
      res,
      503,
      ollamaUnavailableMessage(status),
      "provider_error",
      shouldRetryLater ? { "Retry-After": "30" } : {}
    );
    return true;
  }

  const path = `${ollamaBase.pathname}${ollamaUpstreamPath(parsedReqUrl.pathname, parsedReqUrl.search)}`.replace(/\/+/g, "/");
  const headers = {
    ...req.headers,
    host: ollamaBase.host,
    ...INJECTED_HEADERS,
  };
  if (OLLAMA_NGROK_SKIP_BROWSER_WARNING) headers["ngrok-skip-browser-warning"] = "true";
  delete headers["connection"];
  delete headers["proxy-connection"];
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  delete headers["upgrade"];
  delete headers["te"];
  delete headers["trailer"];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["x-forwarded-port"];
  delete headers["x-real-ip"];
  delete headers["x-original-host"];
  delete headers["x-original-url"];
  if (OLLAMA_PROVIDER_API_KEY) delete headers["authorization"];

  const options = {
    hostname: ollamaBase.hostname,
    port: ollamaBase.port || (ollamaBase.protocol === "https:" ? 443 : 80),
    path,
    method: req.method,
    headers,
  };
  const requestModule = ollamaBase.protocol === "https:" ? https : http;

  if (shouldBufferBody(req.method) && req.headers["content-type"]?.includes("application/json")) {
    const chunks = [];
    let bodySize = 0;
    let bodyExceeded = false;
    req.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE && !bodyExceeded) {
        bodyExceeded = true;
        sendOpenAiError(res, 413, "Payload too large");
        return;
      }
      if (!bodyExceeded) chunks.push(chunk);
    });
    req.on("end", () => {
      if (bodyExceeded) return;
      let body = Buffer.concat(chunks);
      body = patchRequestBody(body, req.headers["content-type"]);
      delete options.headers["transfer-encoding"];
      options.headers["content-length"] = body.length;
      debugRequest(options, body, { protocol: ollamaBase.protocol.replace(":", ""), host: ollamaBase.host, port: options.port });
      const proxyReq = requestModule.request(options, (proxyRes) => {
        console.log(`${req.method} ${req.url} -> ${ollamaBase.host}${options.path} ${proxyRes.statusCode}`);
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 500) kaggleOllamaKeeper.recordActivity();
        forwardResponse(proxyRes, res);
      });
      wireHandlers(proxyReq, req, res);
      proxyReq.write(body);
      proxyReq.end();
    });
    return true;
  }

  debugRequest(options, undefined, { protocol: ollamaBase.protocol.replace(":", ""), host: ollamaBase.host, port: options.port });
  const proxyReq = requestModule.request(options, (proxyRes) => {
    console.log(`${req.method} ${req.url} -> ${ollamaBase.host}${options.path} ${proxyRes.statusCode}`);
    if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 500) kaggleOllamaKeeper.recordActivity();
    forwardResponse(proxyRes, res);
  });
  wireHandlers(proxyReq, req, res);
  req.pipe(proxyReq, { end: true });
  return true;
}

function handleAgyRoute(req, res, pathname) {
  const agyPaths = [AGY_PATH_PREFIX, `${AGY_PATH_PREFIX}${AGY_PATH_PREFIX}`];

  if (req.method === "GET" && agyPaths.some((prefix) => pathname === prefix || pathname === `${prefix}/`)) {
    sendHtml(res, 200, renderAgyUi());
    return true;
  }
  if (req.method === "POST" && agyPaths.some((prefix) => pathname === `${prefix}/setup/start`)) {
    sendJson(res, 200, startAgyInteractiveSetup());
    return true;
  }
  if (req.method === "POST" && agyPaths.some((prefix) => pathname === `${prefix}/setup/stop`)) {
    sendJson(res, 200, { stopped: stopAgyInteractiveSetup(), status: agySetupStatus });
    return true;
  }
  if (req.method === "POST" && agyPaths.some((prefix) => pathname === `${prefix}/setup/input`)) {
    readJsonBody(req, res, (body) => {
      const result = writeAgyInteractiveInput(body.input);
      sendJson(res, result.ok ? 200 : 400, result);
    });
    return true;
  }
  if (req.method === "GET" && agyPaths.some((prefix) => pathname === `${prefix}/setup/status`)) {
    const output = agySetupOutput.map((entry) => ({ ...entry, text: browserTerminalText(entry.text) }));
    const urls = extractTerminalUrls(agySetupOutput.map((entry) => entry.text).join(""));
    sendJson(res, 200, { status: agySetupStatus, running: Boolean(agySetupProcess), output, urls });
    return true;
  }
  if (req.method === "GET" && agyPaths.some((prefix) => pathname === `${prefix}/health`)) {
    sendJson(res, 200, { status: "ok", agyBin: AGY_BIN, activeRequests: agyActiveRequests, usePty: AGY_USE_PTY });
    return true;
  }
  if (req.method === "GET" && agyPaths.some((prefix) => pathname === `${prefix}/v1/models`)) {
    if (!authenticateAgy(req, res)) return true;
    sendJson(res, 200, {
      object: "list",
      data: [AGY_MODEL, AGY_SECONDARY_MODEL].map((id) => ({ id, object: "model", created: 0, owned_by: "antigravity" })),
    });
    return true;
  }
  if (req.method === "POST" && agyPaths.some((prefix) => pathname === `${prefix}/v1/chat/completions`)) {
    handleAgyChatCompletions(req, res);
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  if (!req.url || req.url.length > 4096) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad request" }));
    return;
  }

  const parsedReqUrl = new URL(req.url, `http://127.0.0.1:${PROXY_PORT}`);
  if (parsedReqUrl.pathname.includes(AGY_PATH_PREFIX)) {
    console.log(`[agy] incoming ${req.method} ${parsedReqUrl.pathname}`);
  }
  if (parsedReqUrl.pathname === OLLAMA_PATH_PREFIX || parsedReqUrl.pathname.startsWith(`${OLLAMA_PATH_PREFIX}/`)) {
    console.log(`[ollama] incoming ${req.method} ${parsedReqUrl.pathname}`);
  }
  if (handleAgyRoute(req, res, parsedReqUrl.pathname)) return;
  if (handleOllamaRoute(req, res, parsedReqUrl)) return;

  const route = resolveRoute(req.url);
  if (!route) {
    console.log(`[proxy] no route for ${req.method} ${req.url}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No upstream route matched", path: req.url }));
    return;
  }

  const options = buildOptions(req, route);
  const requestModule = getRequestModule(route.protocol);

  // For JSON mutating requests, buffer body to allow patching
  if (shouldBufferBody(req.method) && req.headers["content-type"]?.includes("application/json")) {
    const chunks = [];
    let bodySize = 0;
    let bodyExceeded = false;

    req.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE && !bodyExceeded) {
        bodyExceeded = true;
        console.error("Request body exceeded max size");
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
        }
        return;
      }
      if (!bodyExceeded) chunks.push(chunk);
    });

    req.on("end", () => {
      if (bodyExceeded) return;
      let body = Buffer.concat(chunks);
      body = patchRequestBody(body, req.headers["content-type"]);
      // Remove chunked encoding since we're setting explicit content-length
      delete options.headers["transfer-encoding"];
      options.headers["content-length"] = body.length;

      debugRequest(options, body, route);
      const proxyReq = requestModule.request(options, (proxyRes) => {
        console.log(`${req.method} ${req.url} -> ${route.host}${options.path} ${proxyRes.statusCode}`);
        forwardResponse(proxyRes, res);
      });
      wireHandlers(proxyReq, req, res);
      proxyReq.write(body);
      proxyReq.end();
    });
  } else {
    // Stream-through path for GET/DELETE and non-JSON bodies
    debugRequest(options, undefined, route);
    const proxyReq = requestModule.request(options, (proxyRes) => {
      console.log(`${req.method} ${req.url} -> ${route.host}${options.path} ${proxyRes.statusCode}`);
      forwardResponse(proxyRes, res);
    });
    wireHandlers(proxyReq, req, res);

    // Enforce request body size limit for stream-through
    let bodySize = 0;
    req.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        console.error("Request body exceeded max size");
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
        }
      }
    });

    req.pipe(proxyReq, { end: true });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Error: ${PROXY_BIND}:${PROXY_PORT} is already in use.`);
    console.error(`Try: PROXY_PORT=${PROXY_PORT + 1} node provider-proxy.js`);
    process.exit(1);
  }
  throw err;
});

server.listen(PROXY_PORT, PROXY_BIND, () => {
  const displayHost = PROXY_BIND === "0.0.0.0" ? "127.0.0.1" : PROXY_BIND;
  console.log(`Provider proxy listening on http://${PROXY_BIND}:${PROXY_PORT}`);
  if (PROXY_BIND !== "127.0.0.1") {
    console.log(
      `Warning: bound to ${PROXY_BIND} (not loopback). Ensure the host firewall blocks ${PROXY_PORT}/tcp from untrusted networks.`
    );
  }
  if (DEFAULT_TARGET.host) {
    console.log(`Default target: ${DEFAULT_TARGET.protocol}://${DEFAULT_TARGET.host}:${DEFAULT_TARGET.port}`);
  }
  for (const route of TARGET_ROUTES) {
    const extras = [];
    if (Object.keys(route.headers || {}).length > 0) extras.push("custom headers");
    if (!route.stripPrefix) extras.push("keep prefix");
    console.log(
      `Route ${route.pathPrefix} -> ${route.protocol}://${route.host}:${route.port}` +
        (extras.length > 0 ? ` (${extras.join(", ")})` : "")
    );
  }
  if (Object.keys(INJECTED_HEADERS).length > 0) {
    console.log("Injected headers:");
    for (const [k, v] of Object.entries(INJECTED_HEADERS)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  console.log(`Built-in agy UI: http://${displayHost}:${PROXY_PORT}${AGY_PATH_PREFIX}/`);
  console.log(`Built-in agy OpenAI base URL: http://${displayHost}:${PROXY_PORT}${AGY_PATH_PREFIX}/v1`);
  if (OLLAMA_BASE_URL || kaggleOllamaKeeper.enabled) {
    console.log(`Built-in Ollama OpenAI base URL: http://${displayHost}:${PROXY_PORT}${OLLAMA_PATH_PREFIX}/v1`);
    if (OLLAMA_BASE_URL) console.log(`Built-in Ollama upstream: ${OLLAMA_BASE_URL}`);
    if (kaggleOllamaKeeper.enabled) {
      console.log("Built-in Ollama Kaggle auto-keeper: enabled");
      console.log(`Built-in Ollama Kaggle callback: http://${displayHost}:${PROXY_PORT}${OLLAMA_PATH_PREFIX}/callback`);
    }
    if (OLLAMA_NGROK_SKIP_BROWSER_WARNING) console.log("Built-in Ollama ngrok browser warning bypass header: enabled");
  }
  kaggleOllamaKeeper.start();
  console.log(`Built-in agy binary: ${AGY_BIN}`);
  console.log(`Built-in agy PTY: ${AGY_USE_PTY ? "enabled" : "disabled"}${pty ? "" : " (node-pty not available)"}`);
  if (TARGET_ROUTES.length === 0) {
    console.log(`\nSet in opencode.json:`);
    console.log(`  "baseURL": "http://${displayHost}:${PROXY_PORT}/v1"`);
  } else {
    console.log(`\nSet in opencode.json (example):`);
    for (const route of TARGET_ROUTES) {
      console.log(`  "baseURL": "http://${displayHost}:${PROXY_PORT}${route.pathPrefix}/v1"`);
    }
  }
});
