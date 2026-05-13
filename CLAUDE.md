# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a lightweight, single-file Node.js reverse proxy (`provider-proxy.js`) for routing AI client requests through a local header/body patching layer before they reach an upstream provider. It is used with OpenCode when a client cannot pass provider-required headers directly, or when an upstream provider needs small request-body compatibility fixes.

The proxy uses only Node.js built-in modules (`http`, `https`) — no `npm install` is required to run it.

## Running the Proxy

There is no build step, test suite, or linter. Start the proxy directly:

```bash
node provider-proxy.js
```

Required: either `TARGET_HOST` or `TARGETS`.

**Single-target mode:**
- `TARGET_HOST` — upstream provider hostname (e.g. `app.manifest.build`)
- `TARGET_PROTOCOL` — `https` (default) or `http`
- `TARGET_PORT` — upstream port (default: 443 for https, 80 for http)

**Multi-target mode:**
- `TARGETS` — JSON array of route objects. Each route needs `pathPrefix` and `host`, and optionally `protocol`, `port`, `headers`, and `stripPrefix` (default `true`).
  ```bash
  TARGETS='[{"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}}]' node provider-proxy.js
  ```

Common optional environment variables:
- `PROXY_PORT` — local port to bind (default: `9999`)
- `PROXY_BIND` — local address to bind (default: `127.0.0.1`). Set to `0.0.0.0` only when the proxy must be reachable from a Docker bridge (the Linux `host.docker.internal` case) or another non-loopback peer. The host firewall then becomes the only barrier — keep `PROXY_PORT/tcp` blocked from the public internet.
- `USER_AGENT` — User-Agent header to inject into all requests
- `EXTRA_HEADERS` — JSON object of additional headers to inject into all requests
- `DEBUG_PROXY=1` — log redacted upstream request URL, headers, and body summary
- `DEBUG_BODY=1` — log full request body (requires `DEBUG_PROXY=1`)

### Common Launch Examples

**Mode A: OpenCode → Proxy → Cloud Manifest**
```bash
TARGET_HOST=app.manifest.build node provider-proxy.js
```

**Mode A: OpenCode → Proxy → Local Manifest**
```bash
TARGET_HOST=localhost TARGET_PROTOCOL=http TARGET_PORT=2099 node provider-proxy.js
```

**Mode B: Manifest → Proxy → Provider (e.g. Kimi)**
```bash
TARGET_HOST=api.kimi.com \
  TARGET_PROTOCOL=https \
  TARGET_PORT=443 \
  PROXY_PORT=9997 \
  USER_AGENT='claude-cli/2.1.139 (external, cli)' \
  EXTRA_HEADERS='{"x-app":"cli"}' \
  node provider-proxy.js
```

**Multi-target: Proxy → Multiple Providers**
```bash
TARGETS='[
  {"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}},
  {"pathPrefix":"/openai","host":"api.openai.com"}
]' \
PROXY_PORT=9999 \
node provider-proxy.js
```
OpenCode then points at `http://127.0.0.1:9999/kimi/v1` or `http://127.0.0.1:9999/openai/v1`.

## Architecture

`provider-proxy.js` implements a stateless reverse proxy with two code paths:

1. **Buffered + patched path** — for `POST`/`PUT`/`PATCH` requests with `application/json` bodies. The proxy buffers the body, applies provider-specific patches, then forwards with an explicit `Content-Length`.
2. **Stream-through path** — for `GET`/`DELETE` and non-JSON bodies. The request is piped directly to the upstream without modification.

### Request Pipeline

1. `resolveRoute(reqPath)` — matches the request URL against `TARGET_ROUTES` by `pathPrefix`. Falls back to `DEFAULT_TARGET` (from `TARGET_HOST`) if no route matches. Returns `404` when neither is configured.
2. `buildOptions(req, route)` — parses the incoming URL, strips the matched `pathPrefix` if `stripPrefix` is enabled, copies headers, injects `INJECTED_HEADERS` (global) merged with `route.headers` (per-route), strips hop-by-hop headers, and sets `host` to `route.host`.
3. `patchRequestBody(bodyBuf, contentType)` — mutates JSON bodies to fix known provider issues:
   - Injects `"reasoning_content": ""` into assistant messages when `thinking` is enabled.
   - Removes unsupported JSON Schema keywords from `tools` (`exclusiveMinimum`, `exclusiveMaximum`, `$ref`, `ref`, `$schema`, `additionalProperties`) for Gemini compatibility.
4. `forwardResponse(proxyRes, res)` — pipes the upstream response back to the client, stripping hop-by-hop headers.

The protocol module (`http` vs `https`) is selected per-request via `getRequestModule(route.protocol)`, so different routes can use different protocols.

### Security / Hardening

- Defaults to binding `127.0.0.1` only. `PROXY_BIND` can widen this (e.g. `0.0.0.0` so a Linux Docker container can reach the host via `host.docker.internal`); when overridden, the proxy logs a warning at startup and the host firewall becomes the only barrier to remote access.
- Strips proxy-chain headers (`x-forwarded-*`, `x-real-ip`, etc.) before forwarding.
- Limits request body size to 10MB.
- Handles client disconnects (`req.on('aborted')`) to prevent upstream resource leaks.

## Files

| File | Purpose |
|------|---------|
| `provider-proxy.js` | The proxy server — configurable via environment variables |
| `opencode.json` | Example OpenCode provider config pointing at the local proxy |

## Adding New Body Patches

To add a new provider-specific fix, edit `patchRequestBody()` in `provider-proxy.js`. Parse the JSON body, mutate it in place, set `modified = true`, and return a new `Buffer.from(JSON.stringify(obj), "utf-8")` if changes were made. Log patches with `console.log("[patch] ...")` for visibility.
