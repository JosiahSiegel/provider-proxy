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

## Auto-patching

The proxy automatically fixes known provider-specific request body issues:

| Error | Patch Applied |
|-------|--------------|
| `thinking is enabled but reasoning_content is missing in assistant tool call message` | Injects `"reasoning_content": ""` into assistant messages when `thinking` is present |
| Gemini `Invalid JSON payload received. Unknown name "exclusiveMinimum"` / `"ref"` in tool schemas | Removes unsupported JSON Schema keywords from `tools` (`exclusiveMinimum`, `exclusiveMaximum`, `$ref`, `ref`, `$schema`, `additionalProperties`) |

More patches can be added to `patchRequestBody()` in `provider-proxy.js`.

## Files

| File | Purpose |
|------|---------|
| `provider-proxy.js` | Generic proxy — configurable target host and headers via environment variables |
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
| `PROXY_BIND` | No | `127.0.0.1` | Local bind address. Set to `0.0.0.0` (or a specific docker bridge IP) when a Linux Docker container must reach the proxy via `host.docker.internal`. Loopback-only is the safe default — widening it exposes the port to anything the host firewall lets in. |
| `USER_AGENT` | No | — | User-Agent header to inject |
| `EXTRA_HEADERS` | No | — | JSON object of additional headers to inject |
| `DEBUG_PROXY` | No | — | Set to `1` to log redacted upstream request URL, headers, and body summary |
| `DEBUG_BODY` | No | — | Set to `1` with `DEBUG_PROXY=1` to log full request body; may include sensitive data |

\* Either `TARGET_HOST` or `TARGETS` is required.

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
- The proxy uses only Node.js built-in modules — no `npm install` required
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
| `Error: Either TARGET_HOST or TARGETS environment variable is required` | Set `TARGET_HOST` or `TARGETS` before starting the proxy |
| Provider still rejects request | Check proxy logs, injected headers, and provider-specific requirements |
| Port already in use | Set `PROXY_PORT` to a different port and update your config |
| Body patch not applied | Confirm request is JSON and uses `POST`, `PUT`, or `PATCH` |
| Manifest can't reach proxy on `127.0.0.1` | Manifest may be in Docker — use `host.docker.internal` instead |
| Container gets `Connection refused` on `host.docker.internal:<PROXY_PORT>` (Linux) | Proxy is bound loopback-only. Set `PROXY_BIND=0.0.0.0` and re-block the port at the host firewall. |

## Security

- Binds to `127.0.0.1` by default; `PROXY_BIND` can widen this when a Docker bridge needs access. Whenever `PROXY_BIND` is not loopback, the host firewall is the only barrier — block the proxy port from public interfaces.
- Forwards only to configured targets (`TARGET_HOST` or routes in `TARGETS`)
- Strips proxy-chain headers (`x-forwarded-*`, `x-real-ip`, etc.) before forwarding
- Limits request body size to 10MB
- Handles client disconnects to prevent upstream resource leaks
