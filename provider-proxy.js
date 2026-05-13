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
//   USER_AGENT       User-Agent header to inject (optional)
//   EXTRA_HEADERS    JSON object of extra headers to inject (optional)
//                    e.g. EXTRA_HEADERS='{"x-app":"cli","x-custom":"value"}'

const http = require("http");
const https = require("https");

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "9999", 10);
const PROXY_BIND = process.env.PROXY_BIND || "127.0.0.1";
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const DEBUG_PROXY = process.env.DEBUG_PROXY === "1";
const DEBUG_BODY = process.env.DEBUG_BODY === "1";

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
  console.error("Error: Either TARGET_HOST or TARGETS environment variable is required.");
  console.error("  Example: TARGET_HOST=app.manifest.build node provider-proxy.js");
  process.exit(1);
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

const server = http.createServer((req, res) => {
  if (!req.url || req.url.length > 4096) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad request" }));
    return;
  }

  const route = resolveRoute(req.url);
  if (!route) {
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
  if (TARGET_ROUTES.length === 0) {
    console.log(`\nSet in opencode.json:`);
    console.log(`  "baseURL": "http://127.0.0.1:${PROXY_PORT}/v1"`);
  } else {
    console.log(`\nSet in opencode.json (example):`);
    for (const route of TARGET_ROUTES) {
      console.log(`  "baseURL": "http://127.0.0.1:${PROXY_PORT}${route.pathPrefix}/v1"`);
    }
  }
});
