#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");
const PID_PATH = path.join(ROOT, ".provider-proxy.pid");
const LOG_PATH = path.join(ROOT, ".provider-proxy.log");
const PROXY_SCRIPT = path.join(ROOT, "provider-proxy.js");

// Sync PM2_HOME with the system-wide service registry setting if on Windows
if (process.platform === "win32") {
  try {
    const regResult = spawnSync("reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "PM2_HOME"], { encoding: "utf8", windowsHide: true, timeout: 1000 });
    if (regResult.status === 0) {
      const match = regResult.stdout.match(/PM2_HOME\s+REG_SZ\s+(.*)/);
      if (match) {
        const sysPm2Home = match[1].trim();
        if (sysPm2Home) {
          process.env.PM2_HOME = sysPm2Home;
        }
      }
    }
  } catch (_err) {}
}

const COLOR = process.env.NO_COLOR || process.env.TERM === "dumb" ? false : process.stdout.isTTY;
const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  inverse: "\x1b[7m",
  clear: "\x1b[2J\x1b[H",
  home: "\x1b[H",
  clearDown: "\x1b[J",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};
const c = (name, text) => (COLOR ? `${ansi[name]}${text}${ansi.reset}` : text);

const KEY_HELP = {
  PROXY_PORT: "Local port to bind the proxy server to (default: 9999).",
  PROXY_BIND: "Address to bind (127.0.0.1 for local, 0.0.0.0 for LAN/Docker access).",
  DEBUG_PROXY: "Log redacted upstream request URL, headers, and body summary (1/0).",
  DEBUG_BODY: "Log full request bodies. Requires DEBUG_PROXY=1 (1/0).",
  TARGET_HOST: "Upstream provider hostname (e.g. app.manifest.build).",
  TARGET_PROTOCOL: "Protocol to use for target host (http or https).",
  TARGET_PORT: "Port to use for target host (default: 443 for https).",
  TARGETS: "JSON array of route objects for multi-target proxying.",
  USER_AGENT: "User-Agent header to inject into all upstream requests.",
  EXTRA_HEADERS: "JSON object of additional headers to inject into requests.",
  AGY_PATH_PREFIX: "Path prefix for local agy routes (default: /agy).",
  AGY_BIN: "Path or command for the agy binary (e.g. agy).",
  AGY_MODEL: "Primary model ID returned by models list (default: agy/antigravity).",
  AGY_MODEL_SETTING: "Antigravity settings.json model value for AGY_MODEL.",
  AGY_SECONDARY_MODEL: "Secondary model ID returned by models list (default: agy/antigravity-opus).",
  AGY_SECONDARY_MODEL_SETTING: "Antigravity settings.json model value for AGY_SECONDARY_MODEL.",
  AGY_SETTINGS_PATH: "Optional override for Antigravity CLI settings.json path.",
  AGY_TIMEOUT_MS: "Timeout in milliseconds for agy command executions.",
  AGY_MAX_CONCURRENCY: "Maximum concurrent agy command executions allowed.",
  AGY_PROVIDER_API_KEY: "API key required to access the local /agy endpoints.",
  AGY_USE_PTY: "Use PTY/ConPTY mode for running agy (1/0).",
  AGY_ARG_PROMPT_MAX_BYTES: "Write large prompts to temporary files to avoid OS arg limits.",
  AGY_DEBUG: "Enable debug logging specifically for agy provider backend (1/0).",
  OLLAMA_PATH_PREFIX: "Path prefix for local Ollama routes (default: /ollama).",
  OLLAMA_BASE_URL: "URL of local Ollama instance (default: http://127.0.0.1:11434).",
  OLLAMA_NGROK_SKIP_BROWSER_WARNING: "Skip ngrok's browser intercept warning page for ngrok upstreams (1/0).",
  OLLAMA_PROVIDER_API_KEY: "API key required to access the local /ollama endpoints.",
  OLLAMA_MODEL: "Ollama model ID to route to.",
  OLLAMA_URL_CALLBACK: "Public HTTPS URL for Kaggle notebook callback posts, usually a tunnel to local /ollama/callback.",
  OLLAMA_URL_CALLBACK_TOKEN: "Optional bearer token required by the Kaggle Ollama callback receiver.",
  KAGGLE_OLLAMA_AUTO: "Enable self-healing Kaggle tunnel/Ollama discovery (1/0).",
  KAGGLE_KERNEL_SLUG: "Kaggle kernel slug for remote Ollama server deployment.",
  KAGGLE_KERNEL_PATH: "Local path to the Kaggle Ollama provider directory.",
  KAGGLE_ACCELERATOR: "Accelerator hardware to request on Kaggle (e.g. gpu).",
  KAGGLE_STATUS_POLL_MS: "How often to poll Kaggle kernel status in milliseconds.",
  KAGGLE_HEALTH_POLL_MS: "How often to check remote Ollama instance health.",
  KAGGLE_PUSH_COOLDOWN_MS: "Minimum cooldown time between Kaggle kernel push attempts.",
  KAGGLE_IDLE_SHUTDOWN_MINUTES: "Minutes without Ollama traffic before the Kaggle keeper pauses polling.",
  NGROK_AUTHTOKEN: "Optional ngrok authtoken for ngrok fallback and API discovery.",
};

function drawBox(title, lines, boxWidth) {
  const titleStr = title ? `── ${title} ` : "───";
  const top = c("dim", `┌${titleStr}` + "─".repeat(Math.max(0, boxWidth - titleStr.length - 2)) + "┐");
  const bottom = c("dim", "└" + "─".repeat(boxWidth - 2) + "┘");
  const middle = lines.map((line) => {
    const maxLineLen = Math.max(0, boxWidth - 4);
    let truncatedLine = line;
    if (visibleLength(line) > maxLineLen) {
      truncatedLine = truncateAnsi(line, maxLineLen);
    }
    const rawLen = visibleLength(truncatedLine);
    const pad = " ".repeat(Math.max(0, maxLineLen - rawLen));
    return `${c("dim", "│")} ${truncatedLine}${pad} ${c("dim", "│")}`;
  });
  return [top, ...middle, bottom];
}

function drawColumns(leftLines, rightLines, leftWidth) {
  const w = width();
  const rightWidth = Math.max(0, w - leftWidth - 3); // 3 characters for " │ "
  const maxLines = Math.max(leftLines.length, rightLines.length);
  const out = [];
  for (let i = 0; i < maxLines; i++) {
    let left = leftLines[i] || "";
    let right = rightLines[i] || "";
    
    if (visibleLength(left) > leftWidth) {
      left = truncateAnsi(left, leftWidth);
    }
    if (visibleLength(right) > rightWidth) {
      right = truncateAnsi(right, rightWidth);
    }

    const leftPad = left + " ".repeat(Math.max(0, leftWidth - visibleLength(left)));
    const rightPad = right + " ".repeat(Math.max(0, rightWidth - visibleLength(right)));
    out.push(`${leftPad} ${c("dim", "│")} ${rightPad}`);
  }
  return out;
}

const ENV_KEYS = [
  ["Core", ["PROXY_PORT", "PROXY_BIND", "DEBUG_PROXY", "DEBUG_BODY"]],
  ["Single target", ["TARGET_HOST", "TARGET_PROTOCOL", "TARGET_PORT"]],
  ["Multi-target", ["TARGETS", "USER_AGENT", "EXTRA_HEADERS"]],
  ["Agy", ["AGY_PATH_PREFIX", "AGY_BIN", "AGY_MODEL", "AGY_MODEL_SETTING", "AGY_SECONDARY_MODEL", "AGY_SECONDARY_MODEL_SETTING", "AGY_SETTINGS_PATH", "AGY_TIMEOUT_MS", "AGY_MAX_CONCURRENCY", "AGY_PROVIDER_API_KEY", "AGY_USE_PTY", "AGY_ARG_PROMPT_MAX_BYTES", "AGY_DEBUG"]],
  ["Ollama", ["OLLAMA_PATH_PREFIX", "OLLAMA_BASE_URL", "OLLAMA_NGROK_SKIP_BROWSER_WARNING", "OLLAMA_PROVIDER_API_KEY", "OLLAMA_MODEL"]],
  ["Kaggle keeper", ["KAGGLE_OLLAMA_AUTO", "KAGGLE_KERNEL_SLUG", "KAGGLE_KERNEL_PATH", "KAGGLE_ACCELERATOR", "KAGGLE_STATUS_POLL_MS", "KAGGLE_HEALTH_POLL_MS", "KAGGLE_PUSH_COOLDOWN_MS", "KAGGLE_IDLE_SHUTDOWN_MINUTES", "OLLAMA_URL_CALLBACK", "OLLAMA_URL_CALLBACK_TOKEN", "NGROK_AUTHTOKEN"]],
];
const KNOWN_ENV_KEYS = new Set(ENV_KEYS.flatMap(([, keys]) => keys));

const PRESETS = [
  {
    name: "Local agy provider",
    description: "Run /agy/v1 on 127.0.0.1:9999 with agy on PATH.",
    values: { PROXY_PORT: "9999", PROXY_BIND: "127.0.0.1", AGY_PATH_PREFIX: "/agy", AGY_BIN: "agy", AGY_MODEL: "agy/antigravity", AGY_SECONDARY_MODEL: "agy/antigravity-opus", AGY_ARG_PROMPT_MAX_BYTES: "16000" },
    clear: ["TARGET_HOST", "TARGETS", "OLLAMA_BASE_URL", "KAGGLE_OLLAMA_AUTO"],
  },
  {
    name: "Windows agy over tailnet",
    description: "Bind all interfaces for trusted tailnet peers; protect with firewall/API key.",
    values: { PROXY_PORT: "9999", PROXY_BIND: "0.0.0.0", AGY_PATH_PREFIX: "/agy", AGY_BIN: "agy", AGY_MODEL: "agy/antigravity", AGY_ARG_PROMPT_MAX_BYTES: "16000" },
    clear: ["TARGET_HOST", "TARGETS", "OLLAMA_BASE_URL", "KAGGLE_OLLAMA_AUTO"],
  },
  {
    name: "Manifest cloud target",
    description: "Proxy ordinary OpenAI-compatible traffic to app.manifest.build.",
    values: { PROXY_PORT: "9999", PROXY_BIND: "127.0.0.1", TARGET_HOST: "app.manifest.build", TARGET_PROTOCOL: "https", TARGET_PORT: "443" },
    clear: ["TARGETS"],
  },
  {
    name: "OpenAI + Kimi multi-target",
    description: "Expose /openai/v1 and /kimi/coding/v1 routes.",
    values: { PROXY_PORT: "9999", PROXY_BIND: "127.0.0.1", TARGETS: '[{"pathPrefix":"/openai","host":"api.openai.com"},{"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}}]' },
    clear: ["TARGET_HOST", "TARGET_PROTOCOL", "TARGET_PORT"],
  },
  {
    name: "Manual Ollama URL",
    description: "Expose /ollama/v1 to a local, LAN, tailnet, Cloudflare, or ngrok Ollama URL.",
    values: { PROXY_PORT: "9999", PROXY_BIND: "127.0.0.1", OLLAMA_PATH_PREFIX: "/ollama", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "ollama" },
    clear: ["TARGET_HOST", "TARGETS", "KAGGLE_OLLAMA_AUTO"],
  },
  {
    name: "Kaggle Ollama keeper",
    description: "Enable self-healing Kaggle tunnel/Ollama discovery.",
    values: { PROXY_PORT: "9999", PROXY_BIND: "127.0.0.1", OLLAMA_PATH_PREFIX: "/ollama", OLLAMA_NGROK_SKIP_BROWSER_WARNING: "0", KAGGLE_OLLAMA_AUTO: "1", KAGGLE_KERNEL_PATH: "./kaggle-ollama-provider" },
    clear: ["TARGET_HOST", "TARGETS"],
  },
];

let envLoadError = null;

const app = {
  screen: "dashboard",
  selected: 0,
  message: "",
  env: loadEnv(),
  envError: envLoadError,
  pidInfo: null,
  health: null,
  ollamaHealth: null,
  pm2: null,
  logs: [],
  editorGroup: 0,
  editorKey: 0,
  sandbox: {
    providerIndex: 0,
    customPath: "/v1/chat/completions",
    input: "",
    pathInput: "",
    editingPath: false,
    history: [],
    scroll: 0,
    sending: false,
    cancel: null,
  },
  confirm: null,
  refreshing: false,
  lastUpdated: null,
  git: null,
};

let refreshTimer;
let inputActive = false;
let fullClearNext = true;
let lastFrame = "";
let refreshSeq = 0;
let refreshInFlight = false;
let refreshQueued = false;
let quitting = false;

function parseEnvLine(raw) {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (i >= raw.length || raw[i] === "#") return null;

  const start = i;
  while (i < raw.length && /[A-Za-z0-9_]/.test(raw[i])) i += 1;
  if (i === start) return null;
  const key = raw.slice(start, i);
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (raw[i] !== "=") return null;
  i += 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;

  if (raw[i] === '"') {
    let token = '"';
    i += 1;
    let escaped = false;
    for (; i < raw.length; i += 1) {
      const ch = raw[i];
      token += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        break;
      }
    }
    try {
      return [key, JSON.parse(token)];
    } catch (_err) {
      return [key, token.length >= 2 && token.endsWith('"') ? token.slice(1, -1) : token.slice(1)];
    }
  }

  if (raw[i] === "'") {
    i += 1;
    let value = "";
    for (; i < raw.length; i += 1) {
      if (raw[i] === "'") break;
      value += raw[i];
    }
    return [key, value];
  }

  let value = "";
  let escaped = false;
  for (; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      value += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "#") {
      break;
    } else {
      value += ch;
    }
  }
  return [key, value.trimEnd()];
}

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(raw);
    if (parsed) values[parsed[0]] = parsed[1];
  }
  return values;
}

function quoteEnv(value) {
  if (value == null || value === "") return "";
  const text = String(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function envTemplateText() {
  if (fs.existsSync(ENV_PATH)) return fs.readFileSync(ENV_PATH, "utf8");
  if (fs.existsSync(ENV_EXAMPLE_PATH)) return fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
  return "";
}

function writeEnv(values) {
  const written = new Set();
  const template = envTemplateText();
  const out = [];

  for (const raw of template.split(/\r?\n/)) {
    const parsed = parseEnvLine(raw);
    if (!parsed) {
      out.push(raw);
      continue;
    }
    const key = parsed[0];
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== "") {
      out.push(`${key}=${quoteEnv(values[key])}`);
      written.add(key);
    } else if (KNOWN_ENV_KEYS.has(key)) {
      out.push(`# ${key}=`);
      written.add(key);
    } else {
      out.push(raw);
    }
  }

  const missingKnown = [...KNOWN_ENV_KEYS].filter((key) => Object.prototype.hasOwnProperty.call(values, key) && values[key] !== "" && !written.has(key));
  const extraKeys = Object.keys(values).filter((key) => !KNOWN_ENV_KEYS.has(key) && values[key] !== "" && !written.has(key)).sort();

  if (!template) {
    out.push("# provider-proxy environment");
    out.push("# Managed by provider-proxy-tui.js. Secrets stay local; do not commit this file.");
    out.push("");
  }

  for (const [group, keys] of ENV_KEYS) {
    const groupKeys = keys.filter((key) => missingKnown.includes(key));
    if (!groupKeys.length) continue;
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`# --- ${group} ---`);
    for (const key of groupKeys) {
      out.push(`${key}=${quoteEnv(values[key])}`);
      written.add(key);
    }
  }

  if (extraKeys.length) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push("# --- Other ---");
    for (const key of extraKeys) out.push(`${key}=${quoteEnv(values[key])}`);
  }

  while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") out.pop();
  fs.writeFileSync(ENV_PATH, out.join("\n"), "utf8");
}

function loadEnv() {
  envLoadError = null;
  if (!fs.existsSync(ENV_PATH)) return {};
  try {
    return parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  } catch (err) {
    envLoadError = err.message;
    return {};
  }
}

function ensureEnv() {
  if (fs.existsSync(ENV_PATH)) return false;
  if (fs.existsSync(ENV_EXAMPLE_PATH)) fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  else writeEnv({});
  return true;
}

const OPTIONAL_SECRET_ENV_KEYS = ["AGY_PROVIDER_API_KEY", "OLLAMA_PROVIDER_API_KEY"];

function mergedEnv() {
  const env = { ...process.env, ...app.env };
  for (const key of OPTIONAL_SECRET_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(app.env, key)) delete env[key];
  }
  return env;
}

function pm2CommandEnv() {
  const keep = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
  const env = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.env.PM2_HOME) env.PM2_HOME = process.env.PM2_HOME;
  if (process.env.PM2_SERVICE_PM2_DIR) env.PM2_SERVICE_PM2_DIR = process.env.PM2_SERVICE_PM2_DIR;
  return { ...env, ...app.env };
}

function port() {
  const n = Number(app.env.PROXY_PORT || 9999);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 9999;
}

function bind() {
  return app.env.PROXY_BIND || "127.0.0.1";
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function parsePidFile(text) {
  const trimmed = text.trim();
  if (!trimmed) return { pid: null, raw: trimmed, invalid: true };
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      return { pid: Number(data.pid), startedAt: data.startedAt || null, command: data.command || null, raw: trimmed };
    } catch (_err) {
      return { pid: null, raw: trimmed, invalid: true };
    }
  }
  return { pid: Number(trimmed), raw: trimmed };
}

function readPidInfo({ cleanupStale = false } = {}) {
  if (!fs.existsSync(PID_PATH)) return { mode: "direct", running: false };
  const parsed = parsePidFile(fs.readFileSync(PID_PATH, "utf8"));
  const running = pidAlive(parsed.pid);
  if ((!running || parsed.invalid) && cleanupStale) safeUnlink(PID_PATH);
  return { mode: "direct", pid: parsed.pid, running, stale: !running, invalid: parsed.invalid, startedAt: parsed.startedAt, command: parsed.command };
}

function resolveCommand(name) {
  if (process.platform !== "win32") return name;
  if (/[\\/]/.test(name)) return name;
  try {
    const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 2500 });
    if (result.status !== 0) return name;
    const candidates = (result.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return candidates.find((x) => /\.exe$/i.test(x)) || candidates.find((x) => /\.(cmd|bat)$/i.test(x)) || candidates[0] || name;
  } catch (_err) {
    return name;
  }
}

function commandExists(name) {
  const cmd = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [name] : ["-c", `command -v ${shellQuote(name)}`];
  try {
    const result = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 2500 });
    return result.status === 0;
  } catch (_err) {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function spawnSyncCommand(command, args, options) {
  const resolved = resolveCommand(command);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    return spawnSync(resolved, args, { ...options, shell: true });
  }
  return spawnSync(resolved, args, options);
}

function pm2Status() {
  if (!commandExists("pm2")) return { available: false, running: false };
  let result;
  try {
    result = spawnSyncCommand("pm2", ["jlist"], { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 * 4 });
  } catch (err) {
    return { available: true, running: false, error: err.message };
  }
  if (result.error) return { available: true, running: false, error: result.error.message };
  if (result.status !== 0) return { available: true, running: false, error: (result.stderr || result.stdout || "pm2 status failed").trim() };
  try {
    let cleanStdout = (result.stdout || "").trim();
    const firstBrack = cleanStdout.indexOf("[");
    const lastBrack = cleanStdout.lastIndexOf("]");
    if (firstBrack !== -1 && lastBrack !== -1 && lastBrack > firstBrack) {
      cleanStdout = cleanStdout.slice(firstBrack, lastBrack + 1);
    }
    const apps = JSON.parse(cleanStdout || "[]");
    if (!Array.isArray(apps)) return { available: true, running: false, error: "pm2 jlist returned non-array JSON" };
    const proc = apps.find((p) => p && p.name === "provider-proxy");
    return { available: true, running: proc?.pm2_env?.status === "online", status: proc?.pm2_env?.status || "missing", pid: proc?.pid };
  } catch (err) {
    const snippet = (result.stdout || "").trim().slice(0, 120);
    return { available: true, running: false, error: `pm2 JSON parse failed: ${err.message}${snippet ? ` (${snippet})` : ""}` };
  }
}

function mergeRequestHeaders(pathname, extraHeaders = {}) {
  const headers = {};
  if (pathname.startsWith(app.env.AGY_PATH_PREFIX || "/agy") && app.env.AGY_PROVIDER_API_KEY) {
    headers.authorization = `Bearer ${app.env.AGY_PROVIDER_API_KEY}`;
  }
  if (pathname.startsWith(app.env.OLLAMA_PATH_PREFIX || "/ollama") && app.env.OLLAMA_PROVIDER_API_KEY) {
    headers.authorization = `Bearer ${app.env.OLLAMA_PROVIDER_API_KEY}`;
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (typeof key === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && value !== undefined && value !== null) {
      headers[key.toLowerCase()] = String(value);
    }
  }
  return headers;
}

function requestJson(pathname, timeoutMs = 1500, extraHeaders = {}) {
  return new Promise((resolve) => {
    const headers = mergeRequestHeaders(pathname, extraHeaders);
    const req = http.request({ hostname: "127.0.0.1", port: port(), path: pathname, method: "GET", timeout: timeoutMs, headers }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) chunks.push(chunk);
        else req.destroy(new Error("response too large"));
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(body) });
        } catch (_err) {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: body });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

function postJson(pathname, body, timeoutMs = 60000, extraHeaders = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const headers = mergeRequestHeaders(pathname, {
      "content-type": "application/json",
      "content-length": String(payload.length),
      ...extraHeaders,
    });
    const req = http.request({ hostname: "127.0.0.1", port: port(), path: pathname, method: "POST", timeout: timeoutMs, headers }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024 * 4) chunks.push(chunk);
        else req.destroy(new Error("response too large"));
      });
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, data: JSON.parse(responseBody) });
        } catch (_err) {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, data: responseBody });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
    app.sandbox.cancel = () => req.destroy(new Error("cancelled"));
  });
}

function readLogs() {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const text = fs.readFileSync(LOG_PATH, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-logLineBudget());
  } catch (err) {
    return [`Could not read ${LOG_PATH}: ${err.message}`];
  }
}

function gitSummary() {
  try {
    const head = spawnSync("git", ["log", "--oneline", "-1"], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 2500 });
    const status = spawnSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 2500 });
    if (head.status !== 0) return "not a git checkout";
    const dirty = status.stdout.trim() ? "dirty" : "clean";
    return `${head.stdout.trim()} (${dirty})`;
  } catch (err) {
    return `git unavailable: ${err.message}`;
  }
}

async function refreshStatus() {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }

  const seq = ++refreshSeq;
  refreshInFlight = true;
  app.refreshing = true;
  if (inputActive) render();

  const env = loadEnv();
  const envError = envLoadError;
  const pidInfo = readPidInfo({ cleanupStale: true });
  const pm2 = pm2Status();
  const logs = readLogs();
  const git = app.git || gitSummary();
  const health = await requestJson(`${env.AGY_PATH_PREFIX || "/agy"}/health`);
  const ollamaHeaders = env.OLLAMA_PROVIDER_API_KEY ? { authorization: `Bearer ${env.OLLAMA_PROVIDER_API_KEY}` } : {};
  let ollamaHealth = await requestJson(`${env.OLLAMA_PATH_PREFIX || "/ollama"}/`, 1500, ollamaHeaders);
  if (!ollamaHealth.ok && ollamaHealth.status === 401 && !env.OLLAMA_PROVIDER_API_KEY) {
    ollamaHealth = await requestJson(`${env.OLLAMA_PATH_PREFIX || "/ollama"}/`);
  }

  if (seq === refreshSeq) {
    app.env = env;
    app.envError = envError;
    app.pidInfo = pidInfo;
    app.pm2 = pm2;
    app.logs = logs;
    app.git = git;
    app.health = health;
    app.ollamaHealth = ollamaHealth;
    app.lastUpdated = new Date();
    app.refreshing = false;
    if (inputActive) render();
  }

  refreshInFlight = false;
  if (refreshQueued) {
    refreshQueued = false;
    refreshStatus();
  }
}

function startDirect() {
  ensureEnv();
  app.env = loadEnv();
  const existing = readPidInfo({ cleanupStale: true });
  if (existing.running) return setMessage(`Direct proxy is already running as pid ${existing.pid}.`);
  const out = fs.openSync(LOG_PATH, "a");
  try {
    const child = spawn(process.execPath, [PROXY_SCRIPT], { cwd: ROOT, env: mergedEnv(), detached: true, stdio: ["ignore", out, out], windowsHide: true });
    child.unref();
    fs.writeFileSync(PID_PATH, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), command: `${process.execPath} ${PROXY_SCRIPT}` }, null, 2), "utf8");
    setMessage(`Started direct proxy pid ${child.pid}; logs: ${path.basename(LOG_PATH)}`);
  } catch (err) {
    setMessage(`Start failed: ${err.message}`);
  } finally {
    try { fs.closeSync(out); } catch (_err) {}
  }
  refreshSoon();
}

function stopDirect() {
  const info = readPidInfo();
  if (!info.running) {
    safeUnlink(PID_PATH);
    return setMessage(info.invalid ? "Removed invalid direct pid file." : "Direct proxy is not running; removed stale pid file if present.");
  }
  try {
    process.kill(info.pid, "SIGTERM");
    setMessage(`Stopped direct proxy pid ${info.pid}.`);
    safeUnlink(PID_PATH);
  } catch (err) {
    setMessage(`Stop failed: ${err.message}`);
  }
  refreshSoon();
}

function pm2(args) {
  const result = runPm2(args);
  if (!result) return refreshSoon();
  setPm2Message(args, result);
  refreshSoon();
}

function runPm2(args) {
  try {
    return spawnSyncCommand("pm2", args, { cwd: ROOT, env: pm2CommandEnv(), encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 * 4 });
  } catch (err) {
    setMessage(`pm2 ${args.join(" ")} failed: ${err.message}`);
    return null;
  }
}

function setPm2Message(args, result) {
  const output = (result.stdout || result.stderr || result.error?.message || "").trim();
  const suffix = result.status === 0 ? "" : ` (exit ${result.status ?? "error"})`;
  setMessage((output.split(/\r?\n/).slice(-2).join(" | ") || `pm2 ${args.join(" ")}`) + suffix);
}

function recreatePm2() {
  if (!commandExists("pm2")) return setMessage("pm2 is not on PATH. Install with: npm install -g pm2");
  runPm2(["delete", "provider-proxy"]);
  const result = runPm2(["start", "ecosystem.config.cjs", "--update-env"]);
  if (result) setPm2Message(["start", "ecosystem.config.cjs", "--update-env"], result);
  refreshSoon();
}

function startPm2() {
  recreatePm2();
}

function stopPm2() {
  if (!commandExists("pm2")) return setMessage("pm2 is not on PATH.");
  pm2(["stop", "provider-proxy"]);
}

function restartPm2() {
  recreatePm2();
}

function savePm2() {
  if (!commandExists("pm2")) return setMessage("pm2 is not on PATH.");
  pm2(["save"]);
}

function openUrl(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setMessage(`Opened ${url}`);
  } catch (err) {
    setMessage(`Open failed: ${err.message}`);
  }
}

function safeUnlink(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (_err) {
    return false;
  }
}

function setMessage(message) {
  app.message = message;
  render();
}

function refreshSoon() {
  setTimeout(refreshStatus, 250);
}

function applyPreset(preset) {
  app.env = { ...app.env };
  for (const key of preset.clear || []) delete app.env[key];
  Object.assign(app.env, preset.values);
  writeEnv(app.env);
  setMessage(`Applied preset: ${preset.name}`);
  refreshSoon();
}

function clearRuntimeState() {
  safeUnlink(PID_PATH);
  setMessage("Cleared direct-run pid file. Logs were kept.");
  refreshSoon();
}

function destroyLocalConfig() {
  safeUnlink(ENV_PATH);
  safeUnlink(PID_PATH);
  setMessage("Deleted local .env and direct pid file. Secrets removed from this checkout.");
  refreshSoon();
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0];
}

function formatIdleShutdown(data) {
  const kaggle = data?.kaggle;
  if (!kaggle || typeof kaggle !== "object") return "";
  const minutes = Number(kaggle.idleShutdownMinutes);
  if (!Number.isFinite(minutes)) return "";
  if (minutes <= 0) return "idle shutdown off";
  if (kaggle.stopping || kaggle.status === "stopping") return "idle stopping";
  if (kaggle.idle || kaggle.status === "idle_stopped") return "idle stopped";
  if (!kaggle.lastActivityAt) return `idle ${minutes}m after next activity`;
  const lastActivity = Date.parse(kaggle.lastActivityAt);
  if (!Number.isFinite(lastActivity)) return "";
  const remainingMs = lastActivity + minutes * 60_000 - Date.now();
  const remainingMinutes = Math.max(0, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes <= 0) return "idle shutdown due";
  return `idle ${remainingMinutes}m left`;
}

function statusLine() {
  const direct = app.pidInfo?.running ? c("green", `direct pid ${app.pidInfo.pid}`) : c("dim", app.pidInfo?.stale ? "direct stale pid removed" : "direct stopped");
  const pm2Label = app.pm2?.error ? `error: ${firstLine(app.pm2.error)}` : app.pm2?.status || (app.pm2?.available ? "stopped" : "unavailable");
  const pm2Text = app.pm2?.running ? c("green", `pm2 ${app.pm2.status} pid ${app.pm2.pid || "?"}`) : c("dim", `pm2 ${pm2Label}`);
  const health = app.health?.ok ? c("green", "agy ok") : c("yellow", `agy ${app.health?.error || app.health?.status || "offline"}`);
  const idleText = formatIdleShutdown(app.ollamaHealth?.data);
  const ollamaOk = app.ollamaHealth?.ok && app.ollamaHealth?.data?.status === "ok";
  const ollamaStatus = app.ollamaHealth?.data?.status || app.ollamaHealth?.error || app.ollamaHealth?.status || "offline";
  const ollamaLabel = `ollama ${ollamaOk ? "ok" : ollamaStatus}${idleText ? ` ${idleText}` : ""}`;
  const ollamaColor = ollamaOk ? "green" : (["waking", "checking", "stopping", "idle", "idle_stopped"].includes(ollamaStatus) ? "yellow" : "dim");
  const ollama = c(ollamaColor, ollamaLabel);
  const refreshing = app.refreshing ? c("cyan", "refreshing") : app.lastUpdated ? c("dim", `updated ${app.lastUpdated.toLocaleTimeString()}`) : c("dim", "not refreshed");
  return `${direct}   ${pm2Text}   ${health}   ${ollama}   ${refreshing}`;
}

function baseUrls() {
  const host = bind() === "0.0.0.0" ? "127.0.0.1" : bind();
  const p = port();
  return [
    `proxy:  http://${host}:${p}/v1`,
    `agy:    http://${host}:${p}${app.env.AGY_PATH_PREFIX || "/agy"}/v1`,
    `ollama: http://${host}:${p}${app.env.OLLAMA_PATH_PREFIX || "/ollama"}/v1`,
  ];
}

function width() {
  return Math.min(120, Math.max(40, process.stdout.columns || 80));
}

function height() {
  return Math.max(12, process.stdout.rows || 24);
}

function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

function truncateAnsi(text, max) {
  text = String(text);
  if (visibleLength(text) <= max) return text;
  let out = "";
  let visible = 0;
  for (let i = 0; i < text.length && visible < max - 1; i += 1) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    out += text[i];
    visible += 1;
  }
  return `${out}…${COLOR ? ansi.reset : ""}`;
}

function wrapPlain(text, max) {
  const raw = String(text);
  if (visibleLength(raw) <= max) return [raw];
  const words = raw.split(/(\s+)/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (visibleLength(line + word) > max && line) {
      lines.push(line.trimEnd());
      line = word.trimStart();
    } else {
      line += word;
    }
  }
  if (line) lines.push(line.trimEnd());
  return lines.length ? lines : [raw.slice(0, max)];
}

function fitLines(lines, maxLines, maxWidth) {
  const fitted = [];
  for (const line of lines) {
    if (fitted.length >= maxLines) break;
    fitted.push(truncateAnsi(line, maxWidth));
  }
  if (lines.length > maxLines && fitted.length) fitted[fitted.length - 1] = c("dim", `… ${lines.length - maxLines + 1} more lines`);
  return fitted;
}

function renderFrame(title, body, footer) {
  const w = width();
  const h = height();
  const rule = c("dim", "─".repeat(Math.max(40, Math.min(w, 120))));
  const messageLines = app.message ? wrapPlain(c("yellow", app.message), w).slice(0, 2) : [];
  const header = [c("bold", `provider-proxy TUI — ${title}`), statusLine(), ...messageLines, rule];
  const tail = [rule, footer || "↑/↓ select  Enter run  b back  r refresh  q quit  ? help"];
  const available = Math.max(1, h - header.length - tail.length);
  const fittedBody = fitLines(body, available, w);
  const frame = [...header, ...fittedBody, ...tail].map((line) => truncateAnsi(line, w)).join("\n");

  if (frame === lastFrame) return;
  lastFrame = frame;
  if (process.stdout.isTTY) {
    if (COLOR) process.stdout.write((fullClearNext ? ansi.clear : ansi.home + ansi.clearDown) + ansi.hideCursor + frame);
    else process.stdout.write(`${fullClearNext ? "" : "\n"}${frame}`);
  } else {
    process.stdout.write(`${frame}\n`);
  }
  fullClearNext = false;
}

function frame(title, body, footer) {
  renderFrame(title, body, footer);
}

function menu(items) {
  return items.map((item, i) => `${i === app.selected ? c("inverse", " > ") : "   "}${item.label}${item.detail ? c("dim", ` — ${item.detail}`) : ""}`);
}

// Wide-dashboard visual grouping: items are rendered in this group order,
// so keyboard navigation must follow the same sequence.
const WIDE_DASHBOARD_GROUPS = [
  { title: "SYSTEM & STATUS", ids: [0, 8, 10] },
  { title: "PROVIDER TESTING", ids: [9] },
  { title: "DIRECT RUNNER", ids: [1, 2] },
  { title: "PM2 PROCESS MANAGER", ids: [3, 4, 5] },
  { title: "CONFIGURATION & PRESETS", ids: [6, 7, 11] },
];

function wideDashboardOrder() {
  return WIDE_DASHBOARD_GROUPS.flatMap((g) => g.ids);
}

function dashboardItems() {
  return [
    { label: "Status & endpoints", detail: "health, base URLs, git, node, pm2", action: () => go("status") },
    { label: "Start direct", detail: "node provider-proxy.js in background", action: startDirect },
    { label: "Stop direct", detail: "stop pid from .provider-proxy.pid", action: () => confirm("Stop direct proxy?", stopDirect) },
    { label: "Start with PM2", detail: "recreate app with current .env", action: startPm2 },
    { label: "Stop PM2", detail: "pm2 stop provider-proxy", action: () => confirm("Stop PM2 provider-proxy?", stopPm2) },
    { label: "Restart PM2", detail: "recreate app with current .env", action: restartPm2 },
    { label: "Config editor", detail: "edit .env values", action: () => go("config") },
    { label: "Presets", detail: "create/switch proxy modes", action: () => go("presets") },
    { label: "Setup & checks", detail: "npm install, agy, ollama/kaggle, pm2 save, browser", action: () => go("setup") },
    { label: "Sandbox", detail: "send a test chat to agy, Ollama, or a custom route", action: () => go("sandbox") },
    { label: "Logs", detail: path.basename(LOG_PATH), action: () => go("logs") },
    { label: "Destroy local config", detail: "delete .env and pid file", action: () => confirm("Delete local .env and pid file?", destroyLocalConfig) },
  ];
}

function go(screen) {
  app.screen = screen;
  app.selected = 0;
  render();
}

function renderDashboard() {
  const w = width();
  if (w < 70) {
    frame("Dashboard", menu(dashboardItems()), "↑/↓ select  Enter run  r refresh  q quit  ? help");
  } else {
    const items = dashboardItems();
    const leftLines = [];
    
    // Dynamically decide if we show descriptions in the left menu
    const showMenuDesc = w >= 95;
    const leftWidth = showMenuDesc ? 50 : 25;
    
    for (const group of WIDE_DASHBOARD_GROUPS) {
      leftLines.push(c("bold", c("cyan", `── ${group.title} ──`)));
      for (const idx of group.ids) {
        const item = items[idx];
        if (!item) continue;
        const marker = idx === app.selected ? c("inverse", " > ") : "   ";
        const labelStr = idx === app.selected ? c("bold", item.label) : item.label;
        const desc = (showMenuDesc && item.detail) ? c("dim", ` (${item.detail})`) : "";
        leftLines.push(`${marker}${labelStr}${desc}`);
      }
      leftLines.push("");
    }

    const directLabel = app.pidInfo?.running 
      ? c("green", `Active (PID ${app.pidInfo.pid})`) 
      : c("dim", app.pidInfo?.stale ? "Stale PID removed" : "Stopped");

    const pm2Label = app.pm2?.running 
      ? c("green", `Active (PID ${app.pm2.pid || "?"})`) 
      : app.pm2?.error 
        ? c("red", `Error: ${firstLine(app.pm2.error).slice(0, 20)}`) 
        : c("dim", app.pm2?.available ? "Stopped" : "Unavailable");

    const healthLabel = app.health?.ok
      ? c("green", "OK")
      : c("yellow", `${app.health?.error || app.health?.status || "Offline"}`);
    const ollamaOk = app.ollamaHealth?.ok && app.ollamaHealth?.data?.status === "ok";
    const ollamaStatus = app.ollamaHealth?.data?.status || app.ollamaHealth?.error || app.ollamaHealth?.status || "Offline";
    const ollamaLabel = ollamaOk
      ? c("green", "OK")
      : (["waking", "checking", "stopping", "idle", "idle_stopped"].includes(ollamaStatus) ? c("yellow", ollamaStatus) : c("dim", ollamaStatus));

    const portBind = `${bind()}:${port()}`;
    const bindWarn = bind() === "0.0.0.0" ? c("yellow", " (firewall!)") : "";

    const statusLines = [
      `Direct proxy:  ${directLabel}`,
      `PM2 manager:   ${pm2Label}`,
      `Agy health:    ${healthLabel}`,
      `Ollama health: ${ollamaLabel}`,
      `Port / Bind:   ${portBind}${bindWarn}`,
    ];

    const host = bind() === "0.0.0.0" ? "127.0.0.1" : bind();
    const p = port();
    const endpointsLines = [
      `Proxy:  http://${host}:${p}/v1`,
      `Agy:    http://${host}:${p}${app.env.AGY_PATH_PREFIX || "/agy"}/v1`,
      `Ollama: http://${host}:${p}${app.env.OLLAMA_PATH_PREFIX || "/ollama"}/v1`,
    ];

    const rightWidth = Math.max(0, w - leftWidth - 3);
    
    const rightLines = [
      ...drawBox("SYSTEM STATUS", statusLines, rightWidth),
      "",
      ...drawBox("ENDPOINTS", endpointsLines, rightWidth),
    ];
    
    const bodyLines = drawColumns(leftLines, rightLines, leftWidth);
    frame("Control Panel", bodyLines, "↑/↓ select  Enter run  r refresh  q quit  ? help");
  }
}

function renderStatus() {
  const w = width();
  const runtimeLines = [
    `Cwd:   ${ROOT}`,
    `Node:  ${process.version}`,
    `Port:  ${port()}`,
    `Bind:  ${bind()}${bind() === "0.0.0.0" ? c("yellow", " (firewall req.)") : ""}`,
    `.env:  ${fs.existsSync(ENV_PATH) ? "Present" : "Missing"}${app.envError ? ` (${app.envError})` : ""}`,
  ];

  const host = bind() === "0.0.0.0" ? "127.0.0.1" : bind();
  const p = port();
  const endpointsLines = [
    `Proxy:  http://${host}:${p}/v1`,
    `Agy:    http://${host}:${p}${app.env.AGY_PATH_PREFIX || "/agy"}/v1`,
    `Ollama: http://${host}:${p}${app.env.OLLAMA_PATH_PREFIX || "/ollama"}/v1`,
  ];

  const gitLines = [
    app.git || "Not refreshed",
  ];

  const pm2Err = app.pm2?.error ? firstLine(app.pm2.error).slice(0, 35) : "None";
  const pm2Lines = [
    `Status: ${app.pm2?.available ? app.pm2.status || "Stopped" : "Not installed"}`,
    `PID:    ${app.pm2?.pid || "N/A"}`,
    `Error:  ${pm2Err}`,
  ];

  const healthLines = [
    app.health?.ok
      ? `Agy:    OK ${JSON.stringify(app.health.data).slice(0, 28)}`
      : `Agy:    ${app.health?.error || app.health?.status || "Offline"}`,
    (() => {
      const ollamaOk = app.ollamaHealth?.ok && app.ollamaHealth?.data?.status === "ok";
      return ollamaOk
        ? `Ollama: OK ${ollamaHealthSummary(app.ollamaHealth.data).slice(0, 28)}`
        : `Ollama: ${app.ollamaHealth?.data?.status || app.ollamaHealth?.error || app.ollamaHealth?.status || "Offline"}`;
    })(),
  ];

  let bodyLines = [];
  if (w < 70) {
    bodyLines = [
      ...drawBox("RUNTIME DETAILS", runtimeLines, w - 2),
      "",
      ...drawBox("ENDPOINTS", endpointsLines, w - 2),
      "",
      ...drawBox("PM2 DETAILS", pm2Lines, w - 2),
      "",
      ...drawBox("HEALTH CHECKS", healthLines, w - 2),
      "",
      ...drawBox("GIT STATUS", gitLines, w - 2),
    ];
  } else {
    const leftWidth = Math.min(38, Math.max(32, Math.floor(w * 0.45)));
    const rightWidth = Math.max(0, w - leftWidth - 3);
    const leftBox = [
      ...drawBox("RUNTIME DETAILS", runtimeLines, leftWidth),
      "",
      ...drawBox("GIT STATUS", gitLines, leftWidth),
    ];
    const rightBox = [
      ...drawBox("ENDPOINTS", endpointsLines, rightWidth),
      "",
      ...drawBox("PM2 DETAILS", pm2Lines, rightWidth),
      "",
      ...drawBox("HEALTH CHECKS", healthLines, rightWidth),
    ];
    bodyLines = drawColumns(leftBox, rightBox, leftWidth);
  }
  frame("Status & Endpoints", bodyLines, "b back  r refresh  o open agy UI  q quit");
}

function renderTabs(activeIdx, w) {
  const tabs = ENV_KEYS.map((g, i) => {
    const label = ` ${g[0]} `;
    return i === activeIdx ? c("inverse", label) : c("dim", label);
  });
  const sep = w >= 75 ? " │ " : " ";
  return " " + tabs.join(sep);
}

function renderConfig() {
  const w = width();
  const group = ENV_KEYS[app.editorGroup];
  const key = group[1][app.editorKey];
  const lines = [];

  lines.push(renderTabs(app.editorGroup, w));
  lines.push(c("dim", "═".repeat(w - 2)));
  if (app.envError) lines.push(c("yellow", ` .env warning: ${app.envError}`));
  lines.push("");

  for (let i = 0; i < group[1].length; i += 1) {
    const k = group[1][i];
    const value = app.env[k] ?? "";
    const marker = i === app.editorKey ? c("inverse", " > ") : "   ";
    const secret = /KEY|TOKEN|SECRET|PASSWORD/.test(k) && value ? "********" : value;

    const keyStr = i === app.editorKey ? c("bold", c("green", k.padEnd(30))) : c("cyan", k.padEnd(30));
    const valStr = value ? secret : c("dim", "unset");
    lines.push(`${marker}${keyStr} ${valStr}`);
  }
  lines.push("");

  const helpText = KEY_HELP[key] || "No description available for this environment variable.";
  lines.push(...drawBox("KEY DESCRIPTION", wrapPlain(helpText, w - 6), w - 2));

  frame("Config Editor", lines, "↑/↓ key  Tab group  Enter edit  Delete unset  s save  b back  q quit");
}

function renderPresets() {
  const w = width();
  const preset = PRESETS[app.selected];

  let bodyLines = [];
  if (w < 70) {
    for (let i = 0; i < PRESETS.length; i++) {
      const p = PRESETS[i];
      const marker = i === app.selected ? c("inverse", " > ") : "   ";
      const label = i === app.selected ? c("bold", p.name) : p.name;
      bodyLines.push(`${marker}${label}`);
    }
    bodyLines.push("");
    if (preset) {
      const details = [
        preset.description,
        "",
        c("bold", c("green", "Sets: ") + Object.entries(preset.values).map(([k, v]) => `${k}=${v}`).join(", ")),
      ];
      if (preset.clear && preset.clear.length) {
        details.push(c("bold", c("yellow", "Clears: ") + preset.clear.join(", ")));
      }
      bodyLines.push(...drawBox("PRESET DETAILS", details, w - 2));
    }
  } else {
    const leftWidth = Math.min(32, Math.max(26, Math.floor(w * 0.35)));
    const rightWidth = Math.max(0, w - leftWidth - 3);

    const leftLines = PRESETS.map((p, i) => {
      const marker = i === app.selected ? c("inverse", " > ") : "   ";
      const label = i === app.selected ? c("bold", p.name) : p.name;
      return `${marker}${label}`;
    });

    const rightLines = [];
    if (preset) {
      rightLines.push(c("bold", preset.name));
      rightLines.push(c("dim", preset.description));
      rightLines.push("");
      rightLines.push(c("bold", c("green", "Keys to Set:")));
      for (const [k, v] of Object.entries(preset.values)) {
        rightLines.push(`  ${c("cyan", k.padEnd(24))} = ${v}`);
      }
      if (preset.clear && preset.clear.length) {
        rightLines.push("");
        rightLines.push(c("bold", c("yellow", "Keys to Clear:")));
        rightLines.push(`  ${preset.clear.join(", ")}`);
      }
    }
    const rightBox = drawBox("PRESET DETAILS", rightLines, rightWidth);
    bodyLines = drawColumns(leftLines, rightBox, leftWidth);
  }

  frame("Presets", bodyLines, "↑/↓ select  Enter apply  b back  q quit");
}

function sandboxProviders() {
  const agyPath = `${app.env.AGY_PATH_PREFIX || "/agy"}/v1/chat/completions`;
  return [
    { label: "agy", path: agyPath, model: app.env.AGY_MODEL || "agy/antigravity", fallbackModel: app.env.AGY_SECONDARY_MODEL || "agy/antigravity-opus" },
    { label: "agy opus", path: agyPath, model: app.env.AGY_SECONDARY_MODEL || "agy/antigravity-opus" },
    { label: "Ollama", path: `${app.env.OLLAMA_PATH_PREFIX || "/ollama"}/v1/chat/completions`, model: app.env.OLLAMA_MODEL || "ollama" },
    { label: "Custom", path: app.sandbox.customPath || "/v1/chat/completions", model: app.env.TARGET_MODEL || app.env.OLLAMA_MODEL || app.env.AGY_MODEL || "model" },
  ];
}

function sandboxProvider() {
  return sandboxProviders()[app.sandbox.providerIndex] || sandboxProviders()[0];
}

function normalizeSandboxPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "/v1/chat/completions";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function summarizeChatResult(result, provider) {
  if (!result.ok) {
    const retryAfter = result.headers?.["retry-after"];
    const message = openAiErrorMessage(result.data);
    if (result.status === 503 && retryAfter) {
      return { error: `Notebook waking up, retry in ${retryAfter} seconds...` };
    }
    if (result.status === 503 && provider?.label === "Ollama" && /Kaggle keeper not enabled/i.test(message)) {
      return { error: "Kaggle keeper not enabled; set KAGGLE_OLLAMA_AUTO=1" };
    }
    return { error: result.error || `${result.status || "HTTP error"}: ${message}` };
  }
  const data = result.data;
  if (!data || typeof data !== "object") return { error: firstLine(data || "empty response") };
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text ?? "";
  const usage = data.usage && typeof data.usage === "object" ? data.usage : null;
  return {
    content: String(content || "(empty assistant response)"),
    model: data.model || "unknown model",
    usage: usage ? [
      usage.prompt_tokens != null ? `prompt ${usage.prompt_tokens}` : null,
      usage.completion_tokens != null ? `completion ${usage.completion_tokens}` : null,
      usage.total_tokens != null ? `total ${usage.total_tokens}` : null,
    ].filter(Boolean).join(", ") : "usage unavailable",
  };
}

async function sendSandboxMessage() {
  const sandbox = app.sandbox;
  if (sandbox.sending) return setMessage("Sandbox request already in flight. Press Ctrl+C to cancel it.");
  const text = sandbox.input.trim();
  if (!text) return setMessage("Type a message before sending.");
  const provider = sandboxProvider();
  const entry = { provider: provider.label, path: provider.path, model: provider.model, user: text, assistant: "Waiting for response...", pending: true, at: new Date() };
  sandbox.history.push(entry);
  sandbox.history = sandbox.history.slice(-12);
  sandbox.input = "";
  sandbox.sending = true;
  sandbox.scroll = 0;
  setMessage(`Sending to ${provider.label} at ${provider.path} ...`);
  render();
  let result = await postJson(provider.path, { model: provider.model, messages: [{ role: "user", content: text }], stream: false }, 90000);
  let usedModel = provider.model;
  if (!result.ok && provider.fallbackModel) {
    setMessage(`Sandbox ${provider.label} failed on ${provider.model}; trying ${provider.fallbackModel} ...`);
    render();
    result = await postJson(provider.path, { model: provider.fallbackModel, messages: [{ role: "user", content: text }], stream: false }, 90000);
    usedModel = provider.fallbackModel;
    entry.model = provider.fallbackModel;
  }
  const summary = summarizeChatResult(result, provider);
  entry.pending = false;
  if (summary.error) {
    entry.error = summary.error;
    entry.assistant = "";
    setMessage(`Sandbox ${provider.label} failed: ${summary.error}`);
  } else {
    entry.assistant = summary.content;
    entry.responseModel = summary.model;
    entry.usage = summary.usage;
    setMessage(`Sandbox ${provider.label} OK: ${summary.model}; ${summary.usage}`);
  }
  sandbox.sending = false;
  sandbox.cancel = null;
  render();
}

function cancelSandboxRequest() {
  const sandbox = app.sandbox;
  if (!sandbox.sending) return false;
  const cancel = sandbox.cancel;
  sandbox.sending = false;
  sandbox.cancel = null;
  const last = sandbox.history[sandbox.history.length - 1];
  if (last?.pending) {
    last.pending = false;
    last.error = "cancelled";
    last.assistant = "";
  }
  if (cancel) cancel();
  setMessage("Sandbox request cancelled.");
  render();
  return true;
}

function renderSandbox() {
  const w = width();
  const sandbox = app.sandbox;
  const providers = sandboxProviders();
  const provider = sandboxProvider();
  const tabs = providers.map((p, i) => i === sandbox.providerIndex ? c("inverse", ` ${p.label} `) : c("dim", ` ${p.label} `)).join(" ");
  const body = [
    `${tabs}  ${c("dim", "Tab switch provider")}`,
    `Endpoint: ${provider.path}`,
    `Model:    ${provider.model}`,
  ];
  if (provider.label === "Custom") body.push(`Custom path: ${sandbox.editingPath ? c("inverse", sandbox.pathInput || " ") : sandbox.customPath}  ${c("dim", "p edit")}`);
  body.push(c("dim", "─".repeat(Math.max(10, w - 2))));

  const historyLines = [];
  if (!sandbox.history.length) {
    historyLines.push(c("dim", "No sandbox messages yet. Type a message and press Enter."));
  } else {
    for (const item of sandbox.history) {
      historyLines.push(c("cyan", `You (${item.provider}): `) + item.user);
      if (item.error) historyLines.push(c("red", `Error: ${item.error}`));
      else historyLines.push(c("green", "Assistant: ") + item.assistant);
      if (item.responseModel || item.usage) historyLines.push(c("dim", `Model: ${item.responseModel || item.model}; ${item.usage || "usage unavailable"}`));
      historyLines.push("");
    }
  }
  const wrapped = historyLines.flatMap((line) => wrapPlain(line, Math.max(20, w - 4)));
  const historyBudget = Math.max(3, height() - 12);
  const start = Math.max(0, wrapped.length - historyBudget - sandbox.scroll);
  body.push(...wrapped.slice(start, start + historyBudget));
  if (sandbox.scroll > 0 || wrapped.length > historyBudget) body.push(c("dim", `Scroll ${sandbox.scroll}; ↑/↓ history`));
  body.push(c("dim", "─".repeat(Math.max(10, w - 2))));
  body.push(`${sandbox.sending ? c("yellow", "Sending...") : c("bold", "Message:")} ${sandbox.input}${COLOR ? c("inverse", " ") : "_"}`);
  frame("Provider Sandbox", body, "Tab provider  p custom path  Enter send/save  ↑/↓ scroll  Esc back  Ctrl+C cancel request");
}

function ollamaHealthSummary(data) {
  if (!data || typeof data !== "object") return String(data || "no JSON body");
  const parts = [];
  if (data.status) parts.push(`status ${data.status}`);
  if (data.upstream) parts.push(`upstream ${data.upstream}`);
  if (data.model) parts.push(`model ${data.model}`);
  const kaggle = data.kaggle;
  if (kaggle && typeof kaggle === "object") {
    const kaggleParts = [];
    for (const key of ["enabled", "state", "status", "phase", "baseUrl", "baseURL", "error", "lastError"]) {
      if (kaggle[key] !== undefined && kaggle[key] !== null && kaggle[key] !== "") kaggleParts.push(`${key}=${kaggle[key]}`);
    }
    const idleText = formatIdleShutdown(data);
    if (idleText) kaggleParts.push(idleText);
    if (kaggleParts.length) parts.push(`kaggle ${kaggleParts.slice(0, 5).join(" ")}`);
    else parts.push(`kaggle ${JSON.stringify(kaggle).slice(0, 80)}`);
  }
  return parts.length ? parts.join("; ") : JSON.stringify(data).slice(0, 160);
}

function openAiErrorMessage(data) {
  if (data && typeof data === "object" && data.error) {
    if (typeof data.error === "string") return data.error;
    if (data.error.message) return data.error.message;
  }
  return typeof data === "string" ? firstLine(data) : "request failed";
}

async function checkOllamaKaggle() {
  app.env = loadEnv();
  const prefix = app.env.OLLAMA_PATH_PREFIX || "/ollama";
  const apiKey = app.env.OLLAMA_PROVIDER_API_KEY;
  const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  setMessage(`Checking Ollama/Kaggle at ${prefix}/ ...`);
  let base = await requestJson(`${prefix}/`, 3000);
  if (!base.ok && base.status === 401 && apiKey) {
    base = await requestJson(`${prefix}/`, 3000, authHeaders);
  }
  if (!base.ok) {
    if (base.status === 401) {
      const guidance = apiKey
        ? "Configured OLLAMA_PROVIDER_API_KEY was rejected; update client/provider key or restart after .env edit."
        : "Running proxy requires auth, but .env has no OLLAMA_PROVIDER_API_KEY; restart proxy or set the key.";
      return setMessage(`Ollama/Kaggle check failed: ${guidance}`);
    }
    if (base.status === 503) {
      const errMsg = base.error || openAiErrorMessage(base.data) || "";
      if (/OLLAMA_BASE_URL/i.test(errMsg)) {
        if (app.env.KAGGLE_OLLAMA_AUTO === "1") {
          return setMessage("No OLLAMA_BASE_URL configured. Kaggle keeper is active and will auto-discover once the notebook is running. Use 'Push Kaggle notebook' in Setup to start one.");
        }
        return setMessage("No OLLAMA_BASE_URL configured. Set it for local Ollama, or use 'Push Kaggle notebook' in Setup to get one from Kaggle.");
      }
    }
    const reason = base.error || `${base.status || "HTTP error"}: ${openAiErrorMessage(base.data)}`;
    return setMessage(`Ollama/Kaggle check failed: ${reason}`);
  }

  let message = `Ollama/Kaggle OK: ${ollamaHealthSummary(base.data)}`;

  const models = await requestJson(`${prefix}/v1/models`, 5000, authHeaders);
  if (models.ok) {
    const count = Array.isArray(models.data?.data) ? models.data.data.length : Array.isArray(models.data?.models) ? models.data.models.length : null;
    message += count == null ? "; models check OK" : `; models ${count}`;
  } else if (models.status === 401) {
    const guidance = apiKey
      ? "configured key rejected"
      : "set OLLAMA_PROVIDER_API_KEY and restart";
    message += `; models auth failed: ${guidance}`;
  } else {
    message += `; models check failed: ${models.error || models.status || "unknown"}`;
  }
  setMessage(message);
}

function kaggleKernelPath() {
  const configured = app.env.KAGGLE_KERNEL_PATH || "./kaggle-ollama-provider";
  return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
}

function readKernelMetadata(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (err) {
    return { error: err.message };
  }
}

function hasRealKernelId(metadata) {
  return typeof metadata.id === "string" && /^[^\s/]+\/[^\s/]+$/.test(metadata.id) && !/YOUR_|placeholder|example/i.test(metadata.id);
}

function updateKernelMetadataId(metaPath, slug) {
  const metadata = readKernelMetadata(metaPath);
  if (metadata.error) return { ok: false, message: `kernel-metadata.json invalid: ${metadata.error}` };
  if (hasRealKernelId(metadata)) return { ok: true, id: metadata.id, updated: false };
  if (!slug || !/^[^\s/]+\/[^\s/]+$/.test(slug)) return { ok: true, id: metadata.id || "", updated: false };
  metadata.id = slug;
  delete metadata.id_no;
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { ok: true, id: slug, updated: true };
}

function notebookSourcePath(kernelPath, metadata) {
  const codeFile = typeof metadata.code_file === "string" && metadata.code_file ? metadata.code_file : "ollama-provider-ngrok.ipynb";
  return path.join(kernelPath, codeFile);
}

function readNotebookSource(notebookPath) {
  try {
    const notebook = JSON.parse(fs.readFileSync(notebookPath, "utf8"));
    if (!Array.isArray(notebook.cells)) return { error: "notebook has no cells array" };
    return { notebook };
  } catch (err) {
    return { error: err.message };
  }
}

function sourceToText(source) {
  return Array.isArray(source) ? source.join("") : String(source || "");
}

function injectNotebookEnv(notebookPath, values) {
  const loaded = readNotebookSource(notebookPath);
  if (loaded.error) return { ok: false, message: `notebook invalid: ${loaded.error}` };
  const { notebook } = loaded;
  const keys = Object.keys(values).filter((key) => values[key]);
  if (!keys.length) return { ok: true, updated: false, message: "no callback env configured" };
  const marker = "# provider-proxy injected callback env";
  const lines = [
    "import os",
    marker,
    ...keys.map((key) => `os.environ[${JSON.stringify(key)}] = ${JSON.stringify(String(values[key]))}`),
    "",
  ];
  let cell = notebook.cells.find((candidate) => candidate.cell_type === "code" && sourceToText(candidate.source).includes(marker));
  if (!cell) {
    cell = { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] };
    notebook.cells.splice(1, 0, cell);
  }
  cell.source = lines.map((line) => `${line}\n`);
  fs.writeFileSync(notebookPath, `${JSON.stringify(notebook, null, 1)}\n`, "utf8");
  return { ok: true, updated: true, keys };
}

function pullKaggleNotebook() {
  if (!commandExists("kaggle")) return setMessage("kaggle CLI is not on PATH. Install/configure Kaggle CLI, then retry.");
  const kernelPath = kaggleKernelPath();
  const slug = app.env.KAGGLE_KERNEL_SLUG;
  if (!slug) return setMessage("Set KAGGLE_KERNEL_SLUG before pulling the Kaggle notebook.");
  if (!fs.existsSync(kernelPath)) return setMessage(`KAGGLE_KERNEL_PATH not found: ${app.env.KAGGLE_KERNEL_PATH || "./kaggle-ollama-provider"}`);
  runVisible("kaggle", ["kernels", "pull", slug, "-p", kernelPath, "-m"]);
}

function openKaggleSecretsPage() {
  openUrl("https://www.kaggle.com/settings/account");
  setMessage("Kaggle metadata cannot attach secrets/env vars; NGROK_AUTHTOKEN may fail in CLI-pushed runs. Cloudflare is the auth-free default.");
}

function pushKaggleNotebook() {
  if (!commandExists("kaggle")) return setMessage("kaggle CLI is not on PATH. Install/configure Kaggle CLI, then retry.");
  const kernelPath = kaggleKernelPath();
  if (!app.env.KAGGLE_KERNEL_PATH) return setMessage("Set KAGGLE_KERNEL_PATH first, usually ./kaggle-ollama-provider.");
  if (!fs.existsSync(kernelPath)) return setMessage(`KAGGLE_KERNEL_PATH not found: ${app.env.KAGGLE_KERNEL_PATH}`);
  const metaPath = path.join(kernelPath, "kernel-metadata.json");
  if (!fs.existsSync(metaPath)) return setMessage("KAGGLE_KERNEL_PATH must contain kernel-metadata.json.");
  let metadata = readKernelMetadata(metaPath);
  if (metadata.error) return setMessage(`kernel-metadata.json invalid: ${metadata.error}`);
  const update = updateKernelMetadataId(metaPath, app.env.KAGGLE_KERNEL_SLUG);
  if (!update.ok) return setMessage(update.message);
  metadata = readKernelMetadata(metaPath);
  if (!hasRealKernelId(metadata)) return setMessage("Set KAGGLE_KERNEL_SLUG or kernel-metadata.json id before pushing an existing notebook.");
  const notes = [];
  if (update.updated) notes.push("metadata id set from KAGGLE_KERNEL_SLUG and stale id_no removed");
  const callbackUrl = app.env.OLLAMA_URL_CALLBACK || app.env.KAGGLE_OLLAMA_CALLBACK_URL;
  const callbackToken = app.env.OLLAMA_URL_CALLBACK_TOKEN || app.env.KAGGLE_OLLAMA_CALLBACK_TOKEN;
  if (callbackUrl || callbackToken) {
    const injected = injectNotebookEnv(notebookSourcePath(kernelPath, metadata), {
      OLLAMA_URL_CALLBACK: callbackUrl,
      OLLAMA_URL_CALLBACK_TOKEN: callbackToken,
    });
    if (!injected.ok) return setMessage(injected.message);
    if (injected.updated) notes.push(`callback env injected into notebook (${injected.keys.join(", ")})`);
  }
  notes.push("Cloudflare quick tunnel is default; callback receiver avoids blank Kaggle CLI logs when configured");
  notes.push("ngrok secret is optional only for TUNNEL_PROVIDER=ngrok");
  runVisible("kaggle", ["kernels", "push", "-p", kernelPath], { conflictHint: true, note: `Prepared: ${notes.join("; ")}.` });
}

function extractTunnelUrl(text) {
  const direct = String(text || "").match(/OLLAMA_BASE_URL=(https:\/\/[^\s"'}\\]+)/i);
  if (direct) return direct[1];
  const active = String(text || "").match(/endpoint '(https:\/\/[^']+?\.ngrok-free\.(?:app|dev))' is already online/i);
  if (active) return active[1];
  const anyTunnel = String(text || "").match(/https:\/\/[a-zA-Z0-9.-]+(?:\.trycloudflare\.com|\.ngrok-free\.(?:app|dev))/i);
  return anyTunnel ? anyTunnel[0] : "";
}

function saveOllamaBaseUrl(url) {
  app.env = { ...loadEnv(), OLLAMA_BASE_URL: url };
  writeEnv(app.env);
}

function isPublicCallbackUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false;
    return true;
  } catch (_err) {
    return false;
  }
}

function callbackGuidanceLines() {
  const prefix = app.env.OLLAMA_PATH_PREFIX || "/ollama";
  const callbackUrl = app.env.OLLAMA_URL_CALLBACK || app.env.KAGGLE_OLLAMA_CALLBACK_URL;
  const token = app.env.OLLAMA_URL_CALLBACK_TOKEN || app.env.KAGGLE_OLLAMA_CALLBACK_TOKEN;
  const localUrl = `http://127.0.0.1:${port()}${prefix}/callback`;
  return [
    `Kaggle CLI logs are blank for running committed notebooks; output files publish only after completion.`,
    `New receiver: POST ${localUrl}`,
    isPublicCallbackUrl(callbackUrl)
      ? `Set notebook env OLLAMA_URL_CALLBACK=${callbackUrl}`
      : `Expose the local callback with a public HTTPS tunnel, then set notebook env OLLAMA_URL_CALLBACK=https://...${prefix}/callback.`,
    token
      ? `Set notebook env OLLAMA_URL_CALLBACK_TOKEN to the same local token.`
      : `Optional: set OLLAMA_URL_CALLBACK_TOKEN locally and in the notebook to protect the callback.`,
  ];
}

function discoverKaggleUrlFromLogs() {
  const slug = app.env.KAGGLE_KERNEL_SLUG;
  if (!slug || !commandExists("kaggle")) return "";
  try {
    const result = spawnSyncCommand("kaggle", ["kernels", "logs", slug], { cwd: ROOT, env: mergedEnv(), encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    return extractTunnelUrl(`${result.stdout || ""}\n${result.stderr || ""}`);
  } catch (_err) {
    return "";
  }
}

function discoverKaggleUrlFromOutput() {
  const slug = app.env.KAGGLE_KERNEL_SLUG;
  if (!slug || !commandExists("kaggle")) return "";
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaggle-ollama-output-"));
  try {
    spawnSyncCommand("kaggle", ["kernels", "output", slug, "-p", outDir, "--force", "--file-pattern", "ollama_(?:base_url|provider).*"], { cwd: ROOT, env: mergedEnv(), encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 * 4 });
    for (const file of ["ollama_base_url.txt", "ollama_provider.env"]) {
      const filePath = path.join(outDir, file);
      if (!fs.existsSync(filePath)) continue;
      const url = extractTunnelUrl(fs.readFileSync(filePath, "utf8"));
      if (url) return url;
    }
  } catch (_err) {
    return "";
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  return "";
}

async function discoverKaggleOllamaUrl() {
  app.env = loadEnv();
  const prefix = app.env.OLLAMA_PATH_PREFIX || "/ollama";
  const apiKey = app.env.OLLAMA_PROVIDER_API_KEY;
  const authHeaders = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const deadline = Date.now() + 45000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    setMessage(`Waiting for Kaggle keeper or logs to expose Ollama URL (${attempt}) ...`);
    let base = await requestJson(`${prefix}/`, 3000, authHeaders);
    if (!base.ok && base.status === 401 && apiKey) base = await requestJson(`${prefix}/`, 3000, authHeaders);
    if (base.ok) {
      const upstream = base.data?.upstream || base.data?.kaggle?.upstream;
      if (upstream) saveOllamaBaseUrl(upstream);
      return setMessage(`Kaggle Ollama discovered: ${ollamaHealthSummary(base.data)}${upstream ? "; saved OLLAMA_BASE_URL" : ""}`);
    }
    const logUrl = discoverKaggleUrlFromLogs();
    if (logUrl) {
      saveOllamaBaseUrl(logUrl);
      return setMessage(`Kaggle Ollama URL found in logs and saved: ${logUrl}. Restart proxy to use it.`);
    }
    const outputUrl = discoverKaggleUrlFromOutput();
    if (outputUrl) {
      saveOllamaBaseUrl(outputUrl);
      return setMessage(`Kaggle Ollama URL found in output files and saved: ${outputUrl}. Restart proxy to use it.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  setMessage(callbackGuidanceLines().join(" "));
}

function openKaggleKernelPage() {
  const slug = app.env.KAGGLE_KERNEL_SLUG;
  openUrl(slug ? `https://www.kaggle.com/code/${slug}` : "https://www.kaggle.com/code");
}

function setupPm2Service() {
  suspendInput();
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.clear + ansi.showCursor);
  else console.log("");

  console.log(c("bold", c("cyan", "PM2 Startup Service Configurator & Repair Tool")));
  console.log(c("dim", "─".repeat(width() - 2)));
  console.log("This tool will stop and delete any broken/conflicting PM2 services, configure");
  console.log("system-wide PM2 environment variables, and reinstall the PM2 service wrapper.");
  console.log("");
  console.log(c("yellow", "Please click 'Yes' on the User Account Control (UAC) prompt when it appears..."));
  console.log("");

  const psScript = `
$Host.UI.RawUI.WindowTitle = 'PM2 Startup Service Setup'
Clear-Host
Write-Host '=== PM2 Startup Service Setup ===' -ForegroundColor Cyan
Write-Host ''

Write-Host '[1/5] Stopping and deleting old pm2.exe/PM2 services...' -ForegroundColor Yellow
try { sc.exe stop pm2.exe 2>$null; sc.exe delete pm2.exe 2>$null } catch {}
try { sc.exe stop PM2 2>$null; sc.exe delete PM2 2>$null } catch {}

# Find pm2-service-uninstall.cmd dynamically or use fallback
$uninstallCmd = Get-Command pm2-service-uninstall.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $uninstallCmd) {
  if (Test-Path 'C:\\ProgramData\\npm\\npm\\pm2-service-uninstall.cmd') {
    $uninstallCmd = 'C:\\ProgramData\\npm\\npm\\pm2-service-uninstall.cmd'
  }
}

if ($uninstallCmd) {
  Write-Host "[2/5] Running pm2-service-uninstall from: $uninstallCmd" -ForegroundColor Yellow
  try { & $uninstallCmd --unattended } catch {}
} else {
  Write-Host '[2/5] pm2-service-uninstall.cmd not found, skipping...' -ForegroundColor Yellow
}

Write-Host '[3/5] Creating PM2 directories in C:\\ProgramData\\pm2...' -ForegroundColor Yellow
try {
  New-Item -ItemType Directory -Force 'C:\\ProgramData\\pm2\\home' | Out-Null
  New-Item -ItemType Directory -Force 'C:\\ProgramData\\pm2\\service' | Out-Null
} catch {
  Write-Host 'Failed to create directories!' -ForegroundColor Red
}

# Resolve PM2 and pm2-windows-service paths dynamically before changing services
$npmPrefix = (npm config get prefix 2>$null | Select-Object -First 1)
if ($npmPrefix) { $npmPrefix = $npmPrefix.Trim() }
if (-not $npmPrefix) { $npmPrefix = 'C:\\ProgramData\\npm\\npm' }
$pm2Entry = Join-Path $npmPrefix 'node_modules\\pm2\\index.js'
$serviceModule = Join-Path $npmPrefix 'node_modules\\pm2-windows-service'

if (-not (Test-Path $pm2Entry)) {
  Write-Host "PM2 entrypoint not found: $pm2Entry" -ForegroundColor Red
  throw 'Cannot install PM2 service without global pm2 package.'
}
if (-not (Test-Path $serviceModule)) {
  Write-Host "pm2-windows-service package not found: $serviceModule" -ForegroundColor Red
  throw 'Install pm2-windows-service globally before configuring the startup service.'
}

Write-Host "[4/5] Setting system environment variables (PM2_SERVICE_PM2_DIR=$pm2Entry)..." -ForegroundColor Yellow
[Environment]::SetEnvironmentVariable('PM2_HOME', 'C:\\ProgramData\\pm2\\home', 'Machine')
[Environment]::SetEnvironmentVariable('PM2_SERVICE_PM2_DIR', $pm2Entry, 'Machine')
$env:PM2_HOME = 'C:\\ProgramData\\pm2\\home'
$env:PM2_SERVICE_PM2_DIR = $pm2Entry
Write-Host 'System PM2_HOME set to C:\\ProgramData\\pm2\\home' -ForegroundColor Green
Write-Host "System PM2_SERVICE_PM2_DIR set to $pm2Entry" -ForegroundColor Green

Write-Host '[5/5] Installing new PM2 Windows service without interactive prompts...' -ForegroundColor Yellow
$env:PM2_WINDOWS_SERVICE_MODULE = $serviceModule
$nodeScript = @'
const pm2ws = require(process.env.PM2_WINDOWS_SERVICE_MODULE);
(async () => {
  try { await pm2ws.uninstall(); } catch (_) {}
  await pm2ws.install(undefined, true);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
'@
$nodeScript | node
if ($LASTEXITCODE -ne 0) { throw "pm2-windows-service install failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Verifying installed service and machine environment...' -ForegroundColor Yellow
sc.exe query pm2.exe
sc.exe qc pm2.exe
Write-Host "Machine PM2_HOME=$([Environment]::GetEnvironmentVariable('PM2_HOME', 'Machine'))"
Write-Host "Machine PM2_SERVICE_PM2_DIR=$([Environment]::GetEnvironmentVariable('PM2_SERVICE_PM2_DIR', 'Machine'))"
Write-Host ''
Write-Host 'Setup finished! Press any key to return to provider-proxy TUI...' -ForegroundColor Green
[void]$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
`;

  const tmpdir = os.tmpdir();
  const tempScriptPath = path.join(tmpdir, `pm2-service-setup-${Date.now()}.ps1`);
  fs.writeFileSync(tempScriptPath, psScript, "utf8");

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \\"${tempScriptPath}\\"" -Verb RunAs -Wait`
  ], { stdio: "inherit", windowsHide: true });

  child.on("error", (err) => {
    try { fs.unlinkSync(tempScriptPath); } catch {}
    console.log(`\nFailed to start elevated installer: ${err.message}. Press Enter to return.`);
    waitForReturn();
  });

  child.on("close", (code, signal) => {
    try { fs.unlinkSync(tempScriptPath); } catch {}
    process.env.PM2_HOME = "C:\\ProgramData\\pm2\\home";
    console.log(`\nPM2 Service configuration complete. TUI PM2_HOME is now synchronized.`);
    console.log("Press Enter to return to TUI.");
    waitForReturn();
  });
}

function uninstallPm2Service() {
  suspendInput();
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.clear + ansi.showCursor);
  else console.log("");

  console.log(c("bold", c("cyan", "PM2 Startup Service Uninstaller")));
  console.log(c("dim", "─".repeat(width() - 2)));
  console.log("This tool will stop and uninstall the PM2 Windows service wrapper.");
  console.log("");
  console.log(c("yellow", "Please click 'Yes' on the User Account Control (UAC) prompt when it appears..."));
  console.log("");

  const psScript = `
$Host.UI.RawUI.WindowTitle = 'PM2 Startup Service Uninstallation'
Clear-Host
Write-Host '=== PM2 Startup Service Uninstallation ===' -ForegroundColor Cyan
Write-Host ''

Write-Host '[1/3] Stopping and deleting PM2 Windows service...' -ForegroundColor Yellow
try { sc.exe stop PM2 2>$null; sc.exe delete PM2 2>$null } catch {}
try { sc.exe stop pm2.exe 2>$null; sc.exe delete pm2.exe 2>$null } catch {}

# Find pm2-service-uninstall.cmd dynamically or use fallback
$uninstallCmd = Get-Command pm2-service-uninstall.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $uninstallCmd) {
  if (Test-Path 'C:\\ProgramData\\npm\\npm\\pm2-service-uninstall.cmd') {
    $uninstallCmd = 'C:\\ProgramData\\npm\\npm\\pm2-service-uninstall.cmd'
  }
}

if ($uninstallCmd) {
  Write-Host "[2/3] Running pm2-service-uninstall from: $uninstallCmd" -ForegroundColor Yellow
  try { & $uninstallCmd --unattended } catch {}
} else {
  Write-Host '[2/3] pm2-service-uninstall.cmd not found, skipping...' -ForegroundColor Yellow
}

Write-Host '[3/3] Removing PM2 system environment variables...' -ForegroundColor Yellow
try {
  [Environment]::SetEnvironmentVariable('PM2_HOME', $null, 'Machine')
  [Environment]::SetEnvironmentVariable('PM2_SERVICE_PM2_DIR', $null, 'Machine')
  Write-Host 'System PM2 environment variables cleared.' -ForegroundColor Green
} catch {
  Write-Host 'Failed to clear system environment variables!' -ForegroundColor Red
}

Write-Host ''
Write-Host 'Uninstallation finished! Press any key to return to provider-proxy TUI...' -ForegroundColor Green
[void]$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
`;

  const tmpdir = os.tmpdir();
  const tempScriptPath = path.join(tmpdir, `pm2-service-uninstall-${Date.now()}.ps1`);
  fs.writeFileSync(tempScriptPath, psScript, "utf8");

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \\"${tempScriptPath}\\"" -Verb RunAs -Wait`
  ], { stdio: "inherit", windowsHide: true });

  child.on("error", (err) => {
    try { fs.unlinkSync(tempScriptPath); } catch {}
    console.log(`\nFailed to start elevated uninstaller: ${err.message}. Press Enter to return.`);
    waitForReturn();
  });

  child.on("close", (code, signal) => {
    try { fs.unlinkSync(tempScriptPath); } catch {}
    console.log(`\nPM2 Service successfully uninstalled. Press Enter to return.`);
    waitForReturn();
  });
}

function setupItems() {
  return [
    { label: "Create .env from template", detail: fs.existsSync(ENV_PATH) ? ".env already exists" : "copy .env.example", action: () => setMessage(ensureEnv() ? "Created .env from template." : ".env already exists.") },
    { label: "npm install", detail: "install node-pty and package-lock", action: () => runVisible("npm", ["install"]) },
    { label: "Check agy", detail: "agy --print Reply with OK", action: () => runVisible(app.env.AGY_BIN || "agy", ["--print", "Reply with OK"]) },
    { label: "Check Ollama/Kaggle", detail: `${app.env.OLLAMA_PATH_PREFIX || "/ollama"}/ then models`, action: checkOllamaKaggle },
    { label: "Pull Kaggle notebook", detail: "may overwrite local notebook files", action: () => confirm("Pull Kaggle notebook into KAGGLE_KERNEL_PATH? This may overwrite local notebook files.", pullKaggleNotebook) },
    { label: "Open Kaggle secrets", detail: "optional only for ngrok fallback", action: openKaggleSecretsPage },
    { label: "Push Kaggle notebook", detail: "push/update KAGGLE_KERNEL_PATH", action: pushKaggleNotebook },
    { label: "Discover Kaggle Ollama URL", detail: "wait up to 30s for keeper discovery", action: discoverKaggleOllamaUrl },
    { label: "Open Kaggle kernel page", detail: app.env.KAGGLE_KERNEL_SLUG || "https://www.kaggle.com/code", action: openKaggleKernelPage },
    { label: "Open agy setup UI", detail: `${app.env.AGY_PATH_PREFIX || "/agy"}/`, action: () => openUrl(`http://127.0.0.1:${port()}${app.env.AGY_PATH_PREFIX || "/agy"}/`) },
    { label: "PM2 save", detail: "persist current PM2 process list", action: savePm2 },
    { label: "Configure PM2 Startup Service", detail: "install/repair PM2 Windows service for autostart", action: setupPm2Service },
    { label: "Uninstall PM2 Startup Service", detail: "remove PM2 Windows startup service", action: () => confirm("Uninstall PM2 Startup Service?", uninstallPm2Service) },
    { label: "Clear direct pid state", detail: "does not kill unknown processes", action: clearRuntimeState },
  ];
}

function runVisible(cmd, args, options = {}) {
  suspendInput();
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.clear + ansi.showCursor);
  else console.log("");
  console.log(c("bold", `$ ${cmd} ${args.join(" ")}`));
  if (options.note) console.log(options.note);
  const stdio = options.conflictHint ? ["inherit", "pipe", "pipe"] : "inherit";
  const child = spawn(cmd, args, { cwd: ROOT, env: mergedEnv(), stdio, shell: process.platform === "win32", windowsHide: true });
  const captured = [];
  if (options.conflictHint) {
    child.stdout.on("data", (chunk) => { captured.push(chunk); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { captured.push(chunk); process.stderr.write(chunk); });
  }
  child.on("error", (err) => {
    console.log(`\nFailed to start: ${err.message}. Press Enter to return.`);
    waitForReturn();
  });
  child.on("close", (code, signal) => {
    const output = Buffer.concat(captured).toString("utf8");
    if (options.conflictHint && code !== 0 && /409|Conflict|SaveKernel/i.test(output)) {
      console.log("\nKaggle reported 409 Conflict: this kernel slug already exists.");
      console.log("Run Pull Kaggle notebook, verify KAGGLE_KERNEL_SLUG and kernel-metadata.json id, then push again.");
    }
    console.log(`\nExited with ${signal ? `signal ${signal}` : `code ${code}`}. Press Enter to return.`);
    waitForReturn();
  });
}

function waitForReturn() {
  process.stdin.resume();
  process.stdin.once("data", () => {
    resumeInput();
    refreshStatus();
  });
}

function renderSetup() {
  frame("Setup & checks", menu(setupItems()), "↑/↓ select  Enter run  b back  q quit");
}

function renderLogs() {
  const w = width();
  const lines = app.logs.length 
    ? app.logs.map(line => truncateAnsi(line, w - 6)) 
    : [c("dim", "No logs recorded yet.")];
  
  const coloredLines = lines.map(line => {
    let output = line;
    if (COLOR) {
      output = output.replace(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/g, c("cyan", "$1"));
      output = output.replace(/(\[patch\])/ig, c("magenta", "$1"));
      output = output.replace(/(\[proxy\])/ig, c("blue", "$1"));
      output = output.replace(/(\b(?:error|failed|exception)\b)/ig, c("red", "$1"));
      output = output.replace(/(\b(?:warn|warning)\b)/ig, c("yellow", "$1"));
      output = output.replace(/(\b(?:info|success|ok)\b)/ig, c("green", "$1"));
    }
    return output;
  });
  
  const boxTitle = `LOG WATCHER: ${path.basename(LOG_PATH)}`;
  const body = drawBox(boxTitle, coloredLines, w - 2);
  frame("Logs", body, "b back  r refresh  q quit");
}

function renderHelp() {
  const w = width();
  const helpLines = [
    "Most TUI actions manage local provider-proxy state. Setup actions can explicitly run Kaggle CLI pull/push commands.",
    "",
    "Create: use Presets or Config editor to create .env values.",
    "Start: direct mode writes .provider-proxy.pid and .provider-proxy.log.",
    "PM2: TUI start/restart recreates provider-proxy so stale env is cleared.",
    "Destroy: deletes local .env and pid state only; logs and code remain.",
    "",
    "Non-interactive equivalents:",
    "  node provider-proxy.js",
    "  pm2 delete provider-proxy; pm2 start ecosystem.config.cjs --update-env",
    "  curl http://127.0.0.1:9999/agy/health",
  ];
  const body = drawBox("HELP & USAGE", helpLines.map(x => truncateAnsi(x, w - 6)), w - 2);
  frame("Help", body, "b back  q quit");
}

function renderConfirm() {
  const w = width();
  const body = drawBox("CONFIRMATION", [
    c("yellow", app.confirm.question),
    "",
    "Press y to confirm, n/q/Esc to cancel."
  ], w - 2);
  frame("Confirm", body, "y confirm  n/q/Esc cancel  Ctrl+C quit");
}

function render() {
  if (!process.stdout.isTTY && inputActive) return;
  if (app.confirm) return renderConfirm();
  if (app.screen === "dashboard") return renderDashboard();
  if (app.screen === "status") return renderStatus();
  if (app.screen === "config") return renderConfig();
  if (app.screen === "presets") return renderPresets();
  if (app.screen === "setup") return renderSetup();
  if (app.screen === "sandbox") return renderSandbox();
  if (app.screen === "logs") return renderLogs();
  if (app.screen === "help") return renderHelp();
}

function currentItems() {
  if (app.screen === "dashboard") return dashboardItems();
  if (app.screen === "presets") return PRESETS.map((preset) => ({ action: () => applyPreset(preset) }));
  if (app.screen === "setup") return setupItems();
  return [];
}

function move(delta) {
  if (app.screen === "config") {
    const keys = ENV_KEYS[app.editorGroup][1];
    app.editorKey = Math.max(0, Math.min(keys.length - 1, app.editorKey + delta));
  } else {
    const items = currentItems();
    if (items.length) {
      if (app.screen === "dashboard" && width() >= 70) {
        const order = wideDashboardOrder().filter((idx) => idx >= 0 && idx < items.length);
        const currentPos = order.indexOf(app.selected);
        const fallbackPos = currentPos === -1 ? 0 : currentPos;
        app.selected = order[(fallbackPos + delta + order.length) % order.length];
      } else {
        app.selected = (app.selected + delta + items.length) % items.length;
      }
    }
  }
  render();
}

function confirm(question, action) {
  app.confirm = { question, action };
  render();
}

function promptInput(question, current, callback) {
  suspendInput();
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.showCursor);
  process.stdout.write(`\n${question}${current ? ` [${current}]` : ""}: `);
  const one = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  one.once("line", (answer) => {
    one.close();
    resumeInput();
    callback(answer === "" ? current : answer);
    render();
  });
}

function editSelectedConfig() {
  const key = ENV_KEYS[app.editorGroup][1][app.editorKey];
  promptInput(`Set ${key}`, app.env[key] || "", (value) => {
    if (value === "") delete app.env[key];
    else app.env[key] = value;
    writeEnv(app.env);
    setMessage(`Saved ${key}. Restart proxy to apply.`);
  });
}

function unsetSelectedConfig() {
  const key = ENV_KEYS[app.editorGroup][1][app.editorKey];
  delete app.env[key];
  writeEnv(app.env);
  setMessage(`Unset ${key}. Restart proxy to apply.`);
}

function cycleGroup(delta) {
  app.editorGroup = (app.editorGroup + delta + ENV_KEYS.length) % ENV_KEYS.length;
  app.editorKey = 0;
  render();
}

function handleSandboxKey(str, key = {}) {
  const sandbox = app.sandbox;
  if (key.ctrl && key.name === "c") {
    if (cancelSandboxRequest()) return;
    return quit();
  }
  if (sandbox.editingPath) {
    if (key.name === "return") {
      sandbox.customPath = normalizeSandboxPath(sandbox.pathInput);
      sandbox.editingPath = false;
      return setMessage(`Custom sandbox path set to ${sandbox.customPath}`);
    }
    if (key.name === "escape") {
      sandbox.editingPath = false;
      return render();
    }
    if (key.name === "backspace" || key.name === "delete") {
      sandbox.pathInput = sandbox.pathInput.slice(0, -1);
      return render();
    }
    if (str && !key.ctrl && !key.meta && str >= " ") {
      sandbox.pathInput += str;
      return render();
    }
    return;
  }
  if (key.name === "escape") return go("dashboard");
  if (key.name === "tab") {
    sandbox.providerIndex = (sandbox.providerIndex + (key.shift ? -1 : 1) + sandboxProviders().length) % sandboxProviders().length;
    return render();
  }
  if (key.name === "p") {
    sandbox.providerIndex = sandboxProviders().findIndex((provider) => provider.label === "Custom");
    if (sandbox.providerIndex === -1) sandbox.providerIndex = sandboxProviders().length - 1;
    sandbox.pathInput = sandbox.customPath;
    sandbox.editingPath = true;
    return render();
  }
  if (key.name === "up") {
    sandbox.scroll = Math.min(sandbox.scroll + 1, Math.max(0, sandbox.history.length * 6));
    return render();
  }
  if (key.name === "down") {
    sandbox.scroll = Math.max(0, sandbox.scroll - 1);
    return render();
  }
  if (key.name === "return") return sendSandboxMessage();
  if (key.name === "backspace" || key.name === "delete") {
    sandbox.input = sandbox.input.slice(0, -1);
    return render();
  }
  if (str && !key.ctrl && !key.meta && str >= " ") {
    sandbox.input += str;
    sandbox.scroll = 0;
    return render();
  }
}

function handleKey(str, key = {}) {
  if (app.screen === "sandbox") return handleSandboxKey(str, key);
  if (key.ctrl && key.name === "c") return quit();

  if (app.confirm) {
    if (key.name === "y") {
      const action = app.confirm.action;
      app.confirm = null;
      action();
    } else if (key.name === "n" || key.name === "q" || key.name === "escape") {
      app.confirm = null;
      render();
    }
    return;
  }

  if (key.name === "q") return quit();
  if (key.name === "up") return move(-1);
  if (key.name === "down") return move(1);
  if (key.name === "r") return refreshStatus();
  if (key.name === "?" || key.sequence === "?") return go("help");
  if (key.name === "b" || key.name === "escape") return go("dashboard");
  if (app.screen === "status" && key.name === "o") return openUrl(`http://127.0.0.1:${port()}${app.env.AGY_PATH_PREFIX || "/agy"}/`);
  if (app.screen === "config") {
    if (key.name === "tab") return cycleGroup(key.shift ? -1 : 1);
    if (key.name === "return") return editSelectedConfig();
    if (key.name === "delete" || key.name === "backspace") return unsetSelectedConfig();
    if (key.name === "s") {
      writeEnv(app.env);
      return setMessage("Saved .env. Restart proxy to apply.");
    }
  }
  if (key.name === "return") {
    const item = currentItems()[app.selected];
    if (item?.action) item.action();
  }
}

function suspendInput() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  process.stdin.removeListener("keypress", handleKey);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  inputActive = false;
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.showCursor);
}

function resumeInput() {
  if (inputActive) return;
  inputActive = true;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", handleKey);
  if (!refreshTimer) refreshTimer = setInterval(refreshStatus, 5000);
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.hideCursor);
}

function cleanupTerminal() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  process.stdin.removeListener("keypress", handleKey);
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch (_err) {}
    process.stdin.pause();
  }
  if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.showCursor + ansi.reset + "\n");
  inputActive = false;
}

function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  cleanupTerminal();
  process.exit(code);
}

function nonInteractive() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node provider-proxy-tui.js [--status|--start|--stop|--health|--help]");
    process.exit(0);
  }
  if (args.includes("--status")) {
    console.log(JSON.stringify({ env: { path: ENV_PATH, present: fs.existsSync(ENV_PATH), port: port(), bind: bind() }, direct: readPidInfo(), pm2: pm2Status(), git: gitSummary() }, null, 2));
    process.exit(0);
  }
  if (args.includes("--start")) {
    startDirect();
    process.exit(0);
  }
  if (args.includes("--stop")) {
    stopDirect();
    process.exit(0);
  }
  if (args.includes("--health")) {
    requestJson(`${app.env.AGY_PATH_PREFIX || "/agy"}/health`).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    });
    return true;
  }
  return false;
}

function logFatal(prefix, err) {
  cleanupTerminal();
  console.error(`${prefix}: ${err && err.stack ? err.stack : err}`);
}

function logLineBudget() {
  return Math.max(5, height() - 8);
}

function main() {
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(143));
  process.on("uncaughtException", (err) => {
    logFatal("Uncaught exception", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logFatal("Unhandled rejection", err);
    process.exit(1);
  });
  process.on("exit", () => {
    if (process.stdout.isTTY && COLOR) process.stdout.write(ansi.showCursor + ansi.reset);
  });

  if (nonInteractive()) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") {
    console.log("Interactive TUI requires a TTY. Use --status, --start, --stop, or --health for non-interactive mode.");
    process.exit(1);
  }
  render();
  resumeInput();
  refreshStatus();
}

main();
