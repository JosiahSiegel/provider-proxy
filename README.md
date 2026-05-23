# Generic Provider Proxy for OpenCode

A lightweight Node.js reverse proxy for routing AI client requests through a local header/body patching layer before they reach an upstream provider.

Use it when a client cannot pass provider-required headers directly, or when an upstream provider needs small request-body compatibility fixes.

## How It Works

The proxy sits between a client and an upstream provider, injecting headers and patching JSON bodies before forwarding:

```
Client -> 127.0.0.1:<PROXY_PORT> (proxy) -> Upstream provider
```

The proxy can:

- Inject custom request headers
- Strip hop-by-hop/proxy-chain headers
- Patch JSON request bodies before forwarding
- Forward responses unchanged
- Serve a built-in OpenAI-compatible `agy` route under `/agy` for local Antigravity CLI access

## Placement Modes

You can place the proxy on **either leg** of the request chain, depending on which outbound request you need to intercept.

### Mode A: Client → Proxy → Provider

The proxy sits between your client (OpenCode) and the provider (or Manifest):

```
OpenCode -> proxy:9999 -> app.manifest.build -> provider
```

Use this when OpenCode itself isn't sending headers the provider requires.

### Mode B: Manifest → Proxy → Provider

The proxy sits between Manifest and the final provider:

```
OpenCode -> Manifest -> proxy:9997 -> api.kimi.com
```

Use this when **Manifest's outbound request** to the provider is what's being rejected — e.g. provider gates on coding-agent fingerprints that Manifest doesn't send. OpenCode continues to point at Manifest normally; only Manifest's provider config points at the proxy.

**Docker networking note:** If Manifest runs in Docker and the proxy runs on your host, Manifest must use `host.docker.internal` instead of `127.0.0.1` to reach the proxy. On Linux this also requires `PROXY_BIND=0.0.0.0` (the default loopback bind refuses connections from the Docker bridge) and an `extra_hosts: ["host.docker.internal:host-gateway"]` entry on the consuming container. Lock the proxy port down at the host firewall when doing this — `0.0.0.0` listens on every interface.

## Multi-Target Routing

Instead of a single `TARGET_HOST`, you can route requests to different upstream providers based on URL path prefix using the `TARGETS` environment variable.

```bash
TARGETS='[
  {"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}},
  {"pathPrefix":"/openai","host":"api.openai.com"}
]' \
PROXY_PORT=9999 \
node provider-proxy.js
```

Each route object supports:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `pathPrefix` | **Yes** | — | URL path prefix to match, e.g. `/kimi` |
| `host` | **Yes** | — | Upstream hostname |
| `protocol` | No | `https` | `https` or `http` |
| `port` | No | 443/80 | Upstream port |
| `headers` | No | — | JSON object of additional headers injected **only** for this route |
| `stripPrefix` | No | `true` | Remove the matched prefix before forwarding to the upstream |

**Routing behavior:**

- Requests to `/kimi/v1/chat/completions` are forwarded to `api.kimi.com/v1/chat/completions` (prefix stripped).
- Unmatched paths fall back to `TARGET_HOST` if it is set; otherwise they return `404`.
- Global `USER_AGENT` and `EXTRA_HEADERS` are injected into **all** requests. Route-specific `headers` are merged on top.

**OpenCode configuration with routes:**

```json
{
  "provider": {
    "kimi": {
      "name": "Kimi",
      "options": {
        "npm": "@ai-sdk/openai-compatible",
        "baseURL": "http://127.0.0.1:9999/kimi/v1"
      }
    }
  }
}
```

## Gemini, Antigravity, and `agy` Integration Notes

These notes summarize current integration findings for using Google Gemini, Google Antigravity, or the `agy` CLI with Manifest and this proxy. They are intended as implementation context, not as a decision to include or exclude any option.

### Product surfaces

| Surface | Integration shape | Auth observed/documented | Notes |
|---------|-------------------|--------------------------|-------|
| Gemini Developer API | HTTPS API | API key from Google AI Studio | Public API surface at `generativelanguage.googleapis.com`; separate from consumer Gemini app subscription limits |
| Gemini OpenAI-compatible API | OpenAI-compatible HTTPS API | `Authorization: Bearer <GEMINI_API_KEY>` | Base URL: `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Vertex AI Gemini | HTTPS API | Google Cloud IAM / ADC / service account | Enterprise Google Cloud surface at `aiplatform.googleapis.com` |
| Google Antigravity / `agy` | Local CLI | Google OAuth persisted locally | No documented official API-key auth or official local HTTP server mode found during research |
| Official Gemini CLI (`gemini`) | Local CLI / headless stdout | Google OAuth, Gemini API key, or Vertex credentials | Separate from `agy`; not an OpenAI-compatible local HTTP provider by default |

### Manifest integration paths

Manifest supports provider configuration directly for Google Gemini API keys. For that path, this proxy is not necessarily required: Manifest can store the Gemini provider key and route requests itself.

This proxy can still be placed in either supported mode when header injection, request patching, route multiplexing, or local observability is useful:

- **Client → Proxy → Manifest**: use when the client needs request shaping before reaching Manifest.
- **Manifest → Proxy → Gemini/OpenAI-compatible provider**: use when Manifest should target a local compatibility layer or when provider-bound requests need headers or body patches.

### Gemini OpenAI-compatible endpoint via proxy

Google's Gemini API includes an OpenAI-compatible endpoint that can be targeted by OpenAI-compatible clients or gateways:

```text
https://generativelanguage.googleapis.com/v1beta/openai/
```

A proxy route can forward OpenAI-style requests to that endpoint while injecting the Gemini API key:

```bash
TARGET_HOST=generativelanguage.googleapis.com \
  TARGET_PROTOCOL=https \
  PROXY_PORT=9998 \
  EXTRA_HEADERS='{"Authorization":"Bearer YOUR_GEMINI_API_KEY"}' \
  node provider-proxy.js
```

Use a client base URL that preserves the `/v1beta/openai` path, for example with multi-target routing:

```bash
TARGETS='[
  {"pathPrefix":"/gemini-openai","host":"generativelanguage.googleapis.com","headers":{"Authorization":"Bearer YOUR_GEMINI_API_KEY"}}
]' \
PROXY_PORT=9999 \
node provider-proxy.js
```

Then point the client or Manifest custom provider base URL at:

```text
http://127.0.0.1:9999/gemini-openai/v1beta/openai
```

### `agy` / Antigravity CLI integration considerations

Current research found `agy` behaves as a local CLI authenticated through Google OAuth and local credential storage. The Antigravity site is:

```text
https://antigravity.google/
```

For subprocess-based integration, the local adapter must run as the same OS user that installed and authenticated `agy`, because the OAuth session is tied to that user's local credential store. If the adapter runs as a different account, such as `NT AUTHORITY\\SYSTEM`, install Antigravity/`agy` and complete login for that account too, or run the adapter under the already-authenticated user account.

No official Antigravity-provided API-key mode, custom endpoint mode, or OpenAI-compatible HTTP server mode was found. The `/agy` route in this repo is a local subprocess-backed compatibility facade, not an official Antigravity server mode.

Possible integration approaches, each with different tradeoffs:

| Approach | Shape | Considerations |
|----------|-------|----------------|
| Subprocess adapter | HTTP server calls `agy --print` / equivalent and converts responses | Preserves local OAuth session, but requires request/response translation, process management, timeout handling, concurrency control, and streaming design |
| OAuth-backed provider adapter | Implement a provider adapter that obtains and refreshes OAuth tokens through a documented flow | Depends on availability of documented OAuth scopes/endpoints for the target backend |
| Third-party Antigravity proxy | Run an existing community proxy that exposes Anthropic/OpenAI-compatible endpoints | May rely on reverse-engineered behavior; validate maintenance status, security posture, and provider terms before use |
| Direct Gemini API provider | Use Google AI Studio API key or Vertex AI credentials | Uses documented API surfaces; quotas and billing follow Gemini API or Vertex AI rather than the consumer Antigravity/AI Pro subscription |

### Built-in `agy` route

`provider-proxy.js` includes a built-in OpenAI-compatible `agy` route. It invokes `agy --print` for each chat request and can coexist with normal reverse-proxy routes on the same port.

Install optional dependencies once, then run the proxy from a terminal where `agy --print` works:

```bash
npm install
```

```powershell
node D:\repos\provider-proxy\provider-proxy.js
```

The built-in endpoints are:

| Endpoint | Purpose |
|----------|---------|
| `GET /agy/` | Browser UI for setup and testing |
| `GET /agy/health` | Basic adapter health check |
| `GET /agy/v1/models` | Returns the configured synthetic model ID |
| `POST /agy/v1/chat/completions` | Accepts OpenAI-compatible chat requests and returns OpenAI-compatible responses |

Use this OpenAI-compatible base URL from the host:

```text
http://127.0.0.1:9999/agy/v1
```

If Manifest runs in Docker, use:

```text
http://host.docker.internal:9999/agy/v1
```

The UI starts the interactive `agy` process from the same account running the proxy and shows captured output. On a VPS, access the UI over your private network, for example `http://<vps-tailnet-name>:9999/agy/`, and complete the Google login URL/code shown by `agy`. The OAuth session is stored for the OS user running `provider-proxy`; if systemd or `./stack autostart` runs the proxy as a different user, authenticate `agy` for that user too. After login, use the UI's OK test before pointing Manifest at the route.

When publishing the setup UI through Tailscale Serve, prefer a private tailnet-only route. If Serve path-mounting causes requests to arrive as `/agy/agy/...`, the built-in route tolerates both direct `/agy/...` and duplicated `/agy/agy/...` forms.

`provider-proxy.js` is the primary integrated path for `agy` because it lets the browser UI, `/agy/v1` provider endpoint, and normal reverse-proxy routes share one port. `agy-provider.js` remains available as a standalone server if you want to run the `agy` adapter on its own port. Its default base URL is `http://127.0.0.1:9996/v1`.

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGY_PATH_PREFIX` | `/agy` | Built-in route prefix when using `provider-proxy.js` |
| `AGY_PORT` | `9996` | Local adapter port when using standalone `agy-provider.js` |
| `AGY_BIN` | User-profile `agy.exe` if present, then SYSTEM-profile `agy.exe`, otherwise `agy` | CLI binary to execute |
| `AGY_MODEL` | `agy/antigravity` | Model ID returned to clients |
| `AGY_TIMEOUT_MS` | `300000` | Per-request timeout |
| `AGY_MAX_CONCURRENCY` | `1` | Maximum concurrent `agy` subprocesses |
| `AGY_PROVIDER_API_KEY` | unset | Optional bearer token required from clients |
| `AGY_USE_PTY` | enabled when `node-pty` is installed | Set to `0` to force plain `child_process.spawn` |
| `AGY_ARG_PROMPT_MAX_BYTES` | `16000` | Prompts above this size are written to a temporary file so `agy --print` receives a short argv prompt and avoids OS argument-length limits |
| `AGY_DEBUG` | unset | Set to `1` for subprocess diagnostics |

Example with an explicit binary path:

```powershell
$env:AGY_BIN = "C:\Path\To\agy.exe"
node D:\repos\provider-proxy\agy-provider.js
```

Manifest or any OpenAI-compatible client can then use:

```text
Base URL: http://127.0.0.1:9999/agy/v1
Model: agy/antigravity
```

The adapter is intentionally subprocess-based. It does not extract OAuth tokens, reverse-engineer Cloud Code APIs, or require API keys for Antigravity. It relies on the same local `agy` session that works in the terminal running the adapter.

On Windows, `agy` may require a real terminal instead of plain stdio pipes. This adapter uses `node-pty`/ConPTY when available so `agy` behaves like it does in PowerShell. If model calls hang with plain subprocess output, keep PTY mode enabled.

### Industry-standard gateway patterns

Common multi-provider gateway designs include:

- **Provider-owned gateway credentials**: the gateway owns upstream API keys and exposes its own client keys.
- **BYOK**: users provide upstream provider API keys, which the gateway stores and uses per request.
- **OAuth authorization code with PKCE**: desktop or CLI login opens a browser and stores refresh credentials locally or in a trusted backend.
- **OAuth device authorization grant**: headless login flow where the user authorizes on another device.
- **OpenAI-compatible facade**: gateway exposes `/v1/chat/completions`, `/v1/responses`, or `/v1/messages` while translating to provider-native APIs.
- **Provider-native adapter**: gateway maps directly to each upstream provider's native request and streaming format.

For `agy`, the main open question is whether a supported provider-facing API contract exists beyond the local CLI. If not, an adapter would need to treat `agy` as a subprocess rather than a normal HTTP upstream.

## Auto-patching

The proxy automatically fixes known provider-specific request body issues:

| Error | Patch Applied |
|-------|--------------|
| `thinking is enabled but reasoning_content is missing in assistant tool call message` | Injects `"reasoning_content": ""` into assistant messages when `thinking` is present |
| Gemini `Invalid JSON payload received. Unknown name "exclusiveMinimum"` / `"ref"` in tool schemas | Removes unsupported JSON Schema keywords from `tools` (`exclusiveMinimum`, `exclusiveMaximum`, `$ref`, `ref`, `$schema`, `additionalProperties`) |
| OpenAI-compatible providers reject Anthropic-style `thinking` | Removes the top-level `thinking` request field |

More patches can be added to `patchRequestBody()` in `provider-proxy.js`.

## Files

| File | Purpose |
|------|---------|
| `provider-proxy.js` | Generic reverse proxy plus integrated `/agy` OpenAI-compatible local provider route |
| `agy-provider.js` | Optional standalone OpenAI-compatible local provider that wraps `agy --print` |
| `package.json` | Optional dependencies, including `node-pty` for PTY/ConPTY-backed `agy` support |
| `package-lock.json` | Locked dependency graph for reproducible `npm install` in submodule deployments |
| `opencode.json` | Example OpenCode provider config pointing at the local proxy |

## Usage

### 1. Set environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TARGET_HOST` | **Yes*** | — | Upstream provider hostname, e.g. `app.manifest.build` |
| `TARGET_PORT` | No | 443 for https / 80 for http | Upstream port |
| `TARGET_PROTOCOL` | No | `https` | `https` or `http` |
| `TARGETS` | No | — | JSON array of route objects for multi-target routing (see below) |
| `PROXY_PORT` | No | `9999` | Local port for the proxy |
| `PROXY_BIND` | No | `127.0.0.1` | Local bind address. Set to `0.0.0.0` or a specific Docker bridge IP only when a Linux Docker container must reach the proxy via `host.docker.internal`. Widening it exposes the port to anything the host firewall lets in. |
| `USER_AGENT` | No | — | User-Agent header to inject |
| `EXTRA_HEADERS` | No | — | JSON object of additional headers to inject |
| `DEBUG_PROXY` | No | — | Set to `1` to log redacted upstream request URL, headers, and body summary |
| `DEBUG_BODY` | No | — | Set to `1` with `DEBUG_PROXY=1` to log full request body; may include sensitive data |

\* Either `TARGET_HOST` or `TARGETS` is required for upstream reverse-proxy routes. Built-in routes such as `/agy` can run without either.

### 2. Start the proxy

#### Mode A: OpenCode → Proxy → Manifest

**Cloud Manifest:**

```bash
TARGET_HOST=app.manifest.build node provider-proxy.js
```

OpenCode points at the proxy:

```json
"baseURL": "http://127.0.0.1:9999/v1"
```

**Local Manifest:**

Use this when Manifest runs locally at `http://localhost:2099`:

```bash
TARGET_HOST=localhost TARGET_PROTOCOL=http TARGET_PORT=2099 node provider-proxy.js
```

OpenCode still points at the proxy, which forwards to local Manifest:

```text
OpenCode -> 127.0.0.1:9999 proxy -> localhost:2099 Manifest -> provider
```

#### Mode B: Manifest → Proxy → Provider

Use this when the provider rejects Manifest's outbound request (not OpenCode's). Start the proxy targeting the provider directly:

```bash
TARGET_HOST=api.kimi.com \
  TARGET_PROTOCOL=https \
  TARGET_PORT=443 \
  PROXY_PORT=9997 \
  USER_AGENT='claude-cli/2.1.139 (external, cli)' \
  EXTRA_HEADERS='{"x-app":"cli"}' \
  node provider-proxy.js
```

**In Manifest**, set the provider's Base URL to point at the proxy. If Manifest runs in Docker, use `host.docker.internal`:

```
http://host.docker.internal:9997/coding/v1
```

If Manifest runs natively (no Docker), use `localhost`:

```
http://127.0.0.1:9997/coding/v1
```

**OpenCode does not change.** It continues to point at Manifest normally:

```text
OpenCode -> localhost:2099 Manifest -> host.docker.internal:9997 proxy -> api.kimi.com
```

### 3. Configure OpenCode

**For Mode A** (proxy between OpenCode and Manifest), point `baseURL` at the proxy:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "manifest": {
      "name": "Manifest",
      "options": {
        "npm": "@ai-sdk/openai-compatible",
        "baseURL": "http://127.0.0.1:9999/v1"
      },
      "models": {
        "auto": {
          "name": "Manifest Auto"
        }
      }
    }
  }
}
```

**For Mode B** (proxy between Manifest and provider), OpenCode points at Manifest directly — no change needed.

### 4. Restart OpenCode

OpenCode must be restarted to pick up any `baseURL` changes.

## Windows Notes

Assume Git Bash on Windows.

- **Node.js** must be installed and available in PATH
- Reverse-proxy-only use can run with Node.js built-in modules; PTY-backed `agy` support requires installed dependencies so `node-pty` is available
- If port 9999 is taken, set `PROXY_PORT=8888` and update your client config

**Mode A examples:**

```bash
# Cloud Manifest
TARGET_HOST=app.manifest.build node provider-proxy.js

# Local Manifest
TARGET_HOST=localhost TARGET_PROTOCOL=http TARGET_PORT=2099 node provider-proxy.js

# With custom headers
TARGET_HOST=app.manifest.build \
  USER_AGENT="custom-agent/1.0" \
  EXTRA_HEADERS='{"x-app":"cli"}' \
  node provider-proxy.js
```

**Mode B example (Kimi through Manifest):**

```bash
TARGET_HOST=api.kimi.com \
  TARGET_PROTOCOL=https \
  TARGET_PORT=443 \
  PROXY_PORT=9997 \
  USER_AGENT='claude-cli/2.1.139 (external, cli)' \
  EXTRA_HEADERS='{"x-app":"cli"}' \
  node provider-proxy.js
```

Then in Manifest set the Kimi provider Base URL to `http://host.docker.internal:9997/coding/v1` (Docker) or `http://127.0.0.1:9997/coding/v1` (native).

**Multi-target example:**

```bash
TARGETS='[
  {"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}},
  {"pathPrefix":"/openai","host":"api.openai.com"}
]' \
PROXY_PORT=9999 \
node provider-proxy.js
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `ECONNREFUSED 127.0.0.1:9999` | Start the proxy (`node provider-proxy.js`) |
| No upstream proxy route works | Set `TARGET_HOST` or `TARGETS`, or use a built-in route such as `/agy` |
| Provider still rejects request | Check proxy logs, injected headers, and provider-specific requirements |
| Port already in use | Set `PROXY_PORT` to a different port and update your config |
| Body patch not applied | Confirm request is JSON and uses `POST`, `PUT`, or `PATCH` |
| Manifest can't reach proxy on `127.0.0.1` | Manifest may be in Docker — use `host.docker.internal` instead |
| Container gets `Connection refused` on `host.docker.internal:<PROXY_PORT>` (Linux) | Proxy is bound loopback-only. Set `PROXY_BIND=0.0.0.0` and re-block the port at the host firewall. |
| Container gets `curl: (28) Connection timed out` (Linux + UFW) | UFW is dropping the SYN from the compose network. Allow the subnet and insert the allow rule above the public deny. |
| `/agy/v1/chat/completions` hangs or returns no output | Confirm `agy --print "Reply with OK"` works in the same terminal/account running the proxy |
| `/agy` PTY mode is unavailable | Run `npm install` in this repo so `node-pty` is installed, or set `AGY_USE_PTY=0` to force plain pipes |

## Security

- Binds to `127.0.0.1` by default; `PROXY_BIND` can widen this when a Docker bridge needs access. Whenever `PROXY_BIND` is not loopback, the host firewall is the only barrier — block the proxy port from public interfaces.
- Keep `/agy` private to localhost or a trusted tailnet. Do not expose the setup UI through public Funnel or other unauthenticated internet ingress.
- Set `AGY_PROVIDER_API_KEY` if non-local clients can reach `/agy/v1`.
- Forwards only to configured targets (`TARGET_HOST` or routes in `TARGETS`) and built-in local routes such as `/agy`
- Strips proxy-chain headers (`x-forwarded-*`, `x-real-ip`, etc.) before forwarding
- Limits request body size to 10MB
- Handles client disconnects to prevent upstream resource leaks
