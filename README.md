# Provider Proxy

A tiny Node.js proxy for AI-provider routing, header injection, local `agy`, local or remote Ollama, and Kaggle-backed Ollama.

## Features

- Generic reverse proxy via `TARGET_HOST` or `TARGETS`.
- Header injection with `USER_AGENT`, `EXTRA_HEADERS`, and per-route `headers`.
- JSON body patches for common OpenAI-compatible provider issues.
- Built-in `/agy/v1` OpenAI-compatible wrapper around local `agy --print`.
- Built-in `/ollama/v1` OpenAI-compatible proxy to local, LAN, tailnet, Cloudflare, ngrok, or Kaggle Ollama.
- Kaggle self-healing keeper: discovers Cloudflare or ngrok tunnel URLs, health-checks Ollama, stops the notebook when unused, wakes on demand, and re-pushes failed notebooks.
- Loopback bind by default; proxy-chain headers stripped; request body limit is 10MB.

## Quickstart

Copy the env template once, edit only what your mode needs, then run the matching launcher.

```bash
cp .env.example .env
```

For guided setup and lifecycle management, run the built-in TUI:

```bash
npm run tui
```

The TUI can create/edit `.env`, apply route/provider presets, start/stop direct Node runs, manage the PM2 process, run health checks, show local logs, open setup URLs, send sandbox chat requests to `agy`, Ollama, or a custom route, and manage Kaggle notebook setup: pull/push notebook metadata, discover the Cloudflare/ngrok tunnel URL, open the optional Kaggle secrets page for ngrok fallback, and open the kernel page.

Non-interactive equivalents are available with `npm run status`, `npm run health`, `node provider-proxy-tui.js --start`, and `node provider-proxy-tui.js --stop`.

### Generic reverse proxy

Edit `.env`:

```dotenv
TARGET_HOST=app.manifest.build
# TARGET_PROTOCOL=https
# TARGET_PORT=443
```

Run:

```bash
./scripts/start-proxy.sh
```

Client base URL: `http://127.0.0.1:9999/v1`.

### Multi-target proxy

Edit `.env`:

```dotenv
TARGETS='[{"pathPrefix":"/kimi","host":"api.kimi.com","headers":{"x-app":"cli"}},{"pathPrefix":"/openai","host":"api.openai.com"}]'
```

Run:

```bash
./scripts/start-proxy.sh
```

Client base URLs: `http://127.0.0.1:9999/kimi/v1`, `http://127.0.0.1:9999/openai/v1`.

### Local `/agy` provider

Install optional PTY support once:

```bash
npm install
```

Run:

```bash
./scripts/start-proxy.sh
```

Open `http://127.0.0.1:9999/agy/`, complete setup, then use base URL `http://127.0.0.1:9999/agy/v1` and model `agy/antigravity`. If non-local clients can reach the proxy, set `AGY_PROVIDER_API_KEY` and send it as a bearer token from clients.

### Local or manual `/ollama` proxy

Edit `.env`:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_PROVIDER_API_KEY=choose-a-local-client-token
```

Run:

```bash
./scripts/start-proxy.sh
```

Client base URL: `http://127.0.0.1:9999/ollama/v1`. `OLLAMA_PROVIDER_API_KEY` is a local shared secret required by proxy clients and stripped before forwarding upstream.

### Kaggle Ollama prerequisites

Before any Kaggle setup path:

1. Install and authenticate the Kaggle CLI locally.
2. Keep real tokens, tunnel URLs, Kaggle credentials, and account-specific files out of git.
3. Optional ngrok fallback only: create a Kaggle notebook secret named `NGROK_AUTHTOKEN` and set `TUNNEL_PROVIDER=ngrok` in the notebook.

See `kaggle-ollama-provider/README.md` for notebook-focused details.

### Windows Kaggle Ollama, manual tunnel URL

After the Kaggle notebook prints `OLLAMA_BASE_URL=...`, run:

```powershell
.\scripts\start-kaggle-ollama-provider.ps1 -OllamaBaseUrl "https://YOUR-CLOUDFLARE-HOST.trycloudflare.com" -ProviderApiKey "choose-a-local-client-token"
```

Client base URL: `http://127.0.0.1:9999/ollama/v1`.

### Windows Kaggle Ollama, auto-read URL from logs

```powershell
.\scripts\start-kaggle-ollama-provider-auto.ps1 -KernelSlug "YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok" -ProviderApiKey "choose-a-local-client-token"
```

The script waits for `OLLAMA_BASE_URL=...` in Kaggle logs, then starts the proxy.

### Linux/macOS Kaggle notebook setup

```bash
./scripts/setup-kaggle-notebook.sh
```

The script updates `kaggle-ollama-provider/kernel-metadata.json`, removes stale `id_no` values, pushes the kernel, waits for the Cloudflare/ngrok tunnel URL, and writes `OLLAMA_BASE_URL` to `.env`.

### VPS self-healing Kaggle Ollama

Edit `.env`:

```dotenv
KAGGLE_OLLAMA_AUTO=1
KAGGLE_KERNEL_SLUG=YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
KAGGLE_KERNEL_PATH=./kaggle-ollama-provider
OLLAMA_PROVIDER_API_KEY=choose-a-local-client-token
# KAGGLE_IDLE_SHUTDOWN_MINUTES=30
```

Run:

```bash
./scripts/start-proxy.sh
```

Point Manifest or another OpenAI-compatible client at the stable proxy URL, not the temporary Cloudflare/ngrok tunnel URL: `http://127.0.0.1:9999/ollama/v1`.

> Warning: `KAGGLE_OLLAMA_AUTO=1` is intentionally persistent. The keeper polls Kaggle status about every 30 seconds, re-pushes when the kernel is `ERROR`, `CANCELLED`, or `CANCELED`, and re-pushes when the discovered tunnel/Ollama upstream is unhealthy. Idle shutdown stops the Kaggle kernel, and the next `/ollama/` request wakes the keeper and may push a fresh notebook. If you manually stop the notebook on Kaggle while the keeper is active and not idle, the keeper will push it again. To stop the cycle, set `KAGGLE_OLLAMA_AUTO=0` in `.env` and restart the proxy, or stop the proxy. This self-healing behavior is useful in production but can surprise you during debugging.

Idle behavior: when `KAGGLE_IDLE_SHUTDOWN_MINUTES` is greater than `0` (default `30`), the keeper stops the remote Kaggle notebook and clears its upstream URL after that many minutes without successful `/ollama/` traffic. A later `/ollama/` request wakes the keeper, triggers a push if needed, and starts URL discovery. While waking, the proxy returns `503` with `Retry-After: 30`. Successful `/ollama/` requests reset the idle timer.

## Environment variables

`.env.example` is the full commented reference. Supported variables:

| Variable | Default | Purpose |
|---|---:|---|
| `PROXY_PORT` | `9999` | Local proxy port. |
| `PROXY_BIND` | `127.0.0.1` | Bind address; use `0.0.0.0` only for trusted non-loopback clients and firewall it. |
| `DEBUG_PROXY` | `0` | Log redacted upstream URL, headers, and body summary. |
| `DEBUG_BODY` | `0` | With `DEBUG_PROXY=1`, log full request bodies; may expose secrets. |
| `TARGET_HOST` | unset | Single upstream host. |
| `TARGET_PROTOCOL` | `https` | Single-target protocol: `https` or `http`. |
| `TARGET_PORT` | protocol default | Single-target upstream port. |
| `TARGETS` | unset | JSON route array for multi-target mode. |
| `USER_AGENT` | unset | Injected User-Agent. |
| `EXTRA_HEADERS` | unset | JSON headers injected into all upstream requests. |
| `AGY_PATH_PREFIX` | `/agy` | Built-in `agy` route prefix. |
| `AGY_BIN` | `agy` | CLI binary or absolute path to `agy`. |
| `AGY_MODEL` | `agy/antigravity` | Model ID returned by `/agy/v1/models`. |
| `AGY_TIMEOUT_MS` | `300000` | Per-request `agy` timeout. |
| `AGY_MAX_CONCURRENCY` | `1` | Max concurrent `agy` subprocesses. |
| `AGY_PROVIDER_API_KEY` | unset | Optional local shared secret required by `/agy/v1` clients. |
| `AGY_USE_PTY` | auto | Set `0` to force plain pipes instead of PTY/ConPTY. |
| `AGY_ARG_PROMPT_MAX_BYTES` | `16000` | Larger prompts are written to a temp file and passed by reference. |
| `AGY_DEBUG` | `0` | Log `agy` subprocess diagnostics. |
| `AGY_PORT` | `9996` | Standalone `agy-provider.js` port; not used by `provider-proxy.js`. |
| `OLLAMA_PATH_PREFIX` | `/ollama` | Built-in Ollama route prefix. |
| `OLLAMA_BASE_URL` | unset | Manual Ollama upstream URL, including Cloudflare or ngrok tunnel URLs. |
| `OLLAMA_NGROK_SKIP_BROWSER_WARNING` | `0` | Add ngrok browser-warning bypass header for ngrok upstreams only. |
| `OLLAMA_PROVIDER_API_KEY` | unset | Optional local shared secret required by `/ollama/v1` clients; stripped before upstream. |
| `OLLAMA_MODEL` | `ollama` | Informational model label returned by `GET /ollama/`. |
| `KAGGLE_OLLAMA_AUTO` | `0` | Enable Kaggle keeper auto-restart and discovery. |
| `OLLAMA_KAGGLE_AUTO` | `0` | Backward-compatible alias for `KAGGLE_OLLAMA_AUTO`. |
| `KAGGLE_KERNEL_SLUG` | example slug | Kaggle notebook slug. |
| `KAGGLE_OLLAMA_KERNEL_SLUG` | unset | Backward-compatible alias for `KAGGLE_KERNEL_SLUG`. |
| `KAGGLE_KERNEL_PATH` | `./kaggle-ollama-provider` | Local notebook folder for `kaggle kernels push`. |
| `KAGGLE_OLLAMA_KERNEL_PATH` | unset | Backward-compatible alias for `KAGGLE_KERNEL_PATH`. |
| `KAGGLE_ACCELERATOR` | `NvidiaTeslaT4` | Accelerator passed to `kaggle kernels push --accelerator`. |
| `KAGGLE_OLLAMA_ACCELERATOR` | unset | Backward-compatible alias for `KAGGLE_ACCELERATOR`. |
| `KAGGLE_STATUS_POLL_MS` | `30000` | Kaggle kernel status poll interval. |
| `KAGGLE_HEALTH_POLL_MS` | `60000` | Ollama `/v1/models` health-check interval. |
| `KAGGLE_PUSH_COOLDOWN_MS` | `300000` | Minimum delay between automatic pushes. |
| `KAGGLE_LOG_FOLLOW_MS` | `600000` | After pushing, follow live Kaggle logs this long to capture the tunnel URL. |
| `KAGGLE_IDLE_SHUTDOWN_MINUTES` | `30` | Minutes without successful `/ollama/` traffic before stopping the Kaggle notebook; set `0` to disable. |
| `NGROK_AUTHTOKEN` | unset | Optional local ngrok token for ngrok fallback/API discovery; Cloudflare quick tunnels do not need it. |

## Public-safety checklist

- Do not commit real API keys, ngrok tokens, Kaggle tokens, tunnel URLs, cookies, or personal account IDs.
- Keep `PROXY_BIND=127.0.0.1` unless Docker, Tailscale, or another trusted peer must reach it; firewall any widened bind.
- Keep `/agy`, `/ollama`, and setup UIs private; set `AGY_PROVIDER_API_KEY` or `OLLAMA_PROVIDER_API_KEY` when non-local clients can connect.

## Files

| File | Purpose |
|---|---|
| `provider-proxy.js` | Main proxy plus built-in `/agy` and `/ollama` routes. |
| `provider-proxy-tui.js` | Dependency-free terminal UI for config, lifecycle, sandbox, setup checks, Kaggle notebook management, health, and logs. |
| `kaggle-ollama-keeper.js` | Self-healing Kaggle/Ollama keeper used by `KAGGLE_OLLAMA_AUTO=1`. |
| `agy-provider.js` | Optional standalone `agy --print` OpenAI-compatible provider. |
| `.env.example` | Commented env reference and source of truth for env vars. |
| `.gitignore` | Local secret/output exclusions. |
| `package.json` | npm scripts and optional `node-pty` dependency. |
| `package-lock.json` | Locked npm dependency graph. |
| `scripts/start-proxy.sh` | Linux/macOS launcher that reads `.env`. |
| `scripts/setup-kaggle-notebook.sh` | Linux/macOS Kaggle notebook setup and `.env` updater. |
| `scripts/start-kaggle-ollama-provider.ps1` | Windows manual Kaggle tunnel/Ollama launcher. |
| `scripts/start-kaggle-ollama-provider-auto.ps1` | Windows launcher that reads Kaggle logs for the tunnel URL. |
| `kaggle-ollama-provider/` | Kaggle notebook template for GPU-backed Ollama through Cloudflare or ngrok. |
| `kaggle-kernel-init-check/` | Small Kaggle kernel init-check metadata fixture/helper directory. |
| `manifest-kaggle-ollama.provider.example.json` | Example Manifest provider values. |
| `ecosystem.config.cjs` | PM2 config for Windows `/agy` hosting over Tailscale. |
| `run.sh` | Convenience run script. |

## Architecture

Request order:

1. `/agy/*` is handled locally and invokes `agy --print`.
2. `/ollama/*` proxies to `OLLAMA_BASE_URL` or the Kaggle keeper's discovered URL. If no upstream is available and the keeper is enabled, the request triggers wake-on-demand and receives `503 Retry-After: 30` while discovery runs.
3. Other requests resolve against `TARGETS` or `TARGET_HOST`.
4. JSON mutating requests are buffered, patched, and forwarded with explicit `Content-Length`; other requests stream through.
5. Upstream responses stream back with hop-by-hop headers removed.

Kaggle keeper loop:

1. Poll Kaggle kernel status on `KAGGLE_STATUS_POLL_MS`.
2. Discover `OLLAMA_BASE_URL=...` from Kaggle logs, including a live `logs -f` capture after pushes; output-file discovery is best-effort for materialized outputs.
3. Health-check Ollama on `KAGGLE_HEALTH_POLL_MS`.
4. Re-push after terminal kernel failures or unhealthy tunnels, subject to `KAGGLE_PUSH_COOLDOWN_MS`.
5. Stop the remote Kaggle notebook after `KAGGLE_IDLE_SHUTDOWN_MINUTES` without successful `/ollama/` traffic, then wake and push if needed on the next `/ollama/` request.

Placement examples:

- Client → proxy → provider: point the client at `http://127.0.0.1:9999/v1`.
- Manifest → proxy → provider: point only Manifest's provider config at the proxy.
- Docker client → host proxy: use `host.docker.internal`; on Linux this usually requires `PROXY_BIND=0.0.0.0` plus firewall rules.
