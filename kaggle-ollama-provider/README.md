# Kaggle Ollama Provider

Kaggle notebook template that runs Ollama on a Kaggle GPU and exposes it through a public tunnel for the proxy's `/ollama/v1` route.

Cloudflare quick tunnels are the default and require no account, token, or Kaggle secret. ngrok remains an optional fallback if you edit the notebook to use `TUNNEL_PROVIDER=ngrok` and create a Kaggle notebook secret named `NGROK_AUTHTOKEN`.

For full proxy configuration, env variables, TUI usage, and client setup, see the main `README.md`.

## Prerequisites

- Kaggle CLI installed and authenticated locally.
- Kaggle account with notebook internet access and GPU quota.
- No real tokens, tunnel URLs, or account-specific files committed to git.

## One-command setup from Linux/macOS

From the repo root:

```bash
./scripts/setup-kaggle-notebook.sh
```

The script:

1. Reads your Kaggle username from `~/.kaggle/kaggle.json` or `KAGGLE_USERNAME`.
2. Updates `kaggle-ollama-provider/kernel-metadata.json` to `username/ollama-provider-via-ngrok` and removes stale `id_no` values.
3. Pushes the kernel with `kaggle kernels push --accelerator NvidiaTeslaT4`.
4. Waits for `OLLAMA_BASE_URL=https://...trycloudflare.com` or `https://...ngrok-free...` in logs.
5. Writes `KAGGLE_KERNEL_SLUG`, `KAGGLE_KERNEL_PATH`, `KAGGLE_ACCELERATOR`, and `OLLAMA_BASE_URL` to `.env`.

Then start the proxy:

```bash
./scripts/start-proxy.sh
```

Client base URL: `http://127.0.0.1:9999/ollama/v1`.

## TUI setup path

From the repo root:

```bash
npm run tui
```

Use **Setup & checks** to:

1. Pull Kaggle notebook metadata if the slug already exists.
2. Push/update `KAGGLE_KERNEL_PATH`.
3. Discover the Kaggle Ollama URL from the keeper or notebook logs.
4. Check `/ollama/` and `/ollama/v1/models` through the local proxy.

The TUI also includes a sandbox that can send test chat requests to Ollama after the proxy is running. **Open Kaggle secrets** is only needed for the optional ngrok fallback.

## Manual setup

1. Edit `kernel-metadata.json` so `id` is `YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok`.
2. Push the notebook:

   ```bash
   kaggle kernels push -p kaggle-ollama-provider --accelerator NvidiaTeslaT4
   ```

3. Watch logs until the notebook prints `OLLAMA_BASE_URL=https://...trycloudflare.com`:

   ```bash
   kaggle kernels logs YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
   ```

4. Put that URL in `.env`:

   ```dotenv
   OLLAMA_BASE_URL=https://YOUR-CLOUDFLARE-HOST.trycloudflare.com
   OLLAMA_PROVIDER_API_KEY=choose-a-local-client-token
   ```

   For ngrok URLs only, also set `OLLAMA_NGROK_SKIP_BROWSER_WARNING=1`.

5. Start the proxy:

   ```bash
   ./scripts/start-proxy.sh
   ```

## Self-healing mode

For a VPS or long-running host, prefer the keeper so clients use a stable local proxy URL while Kaggle/tunnel URLs change behind it:

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

The keeper checks Kaggle status, discovers Cloudflare or ngrok URLs from logs, follows live logs after pushes to catch the tunnel URL while the notebook enters keepalive, tries output-file discovery as a best-effort fallback for materialized outputs, health-checks `/v1/models`, and re-pushes after terminal failures or unhealthy tunnels.

> Warning: `KAGGLE_OLLAMA_AUTO=1` continuously self-heals. The keeper polls kernel status about every 30 seconds, auto-pushes a new notebook when Kaggle reports `ERROR`, `CANCELLED`, or `CANCELED`, and auto-pushes when the upstream Ollama tunnel is unhealthy. Idle shutdown stops the Kaggle kernel, and the next `/ollama/` request wakes the keeper and may push a fresh notebook. If you manually stop the notebook on Kaggle while the keeper is active and not idle, the keeper will push it again. To stop the cycle, set `KAGGLE_OLLAMA_AUTO=0` in `.env` and restart the proxy, or stop the proxy.

## Idle and wake-on-demand

`KAGGLE_IDLE_SHUTDOWN_MINUTES` defaults to `30`. After that many minutes without successful `/ollama/` traffic, the keeper stops the remote Kaggle notebook and clears its upstream URL. Successful `/ollama/` requests reset the idle timer.

When a later request hits `/ollama/` and no upstream is available, the proxy asks the keeper to wake up, push the notebook if needed, and discover the URL. While this is happening, the proxy returns `503` with `Retry-After: 30`; retry the client request after the keeper has discovered the tunnel.

Set `KAGGLE_IDLE_SHUTDOWN_MINUTES=0` to disable idle shutdown.

## Optional ngrok fallback

Cloudflare is default. To use ngrok instead, edit the notebook environment selection to `TUNNEL_PROVIDER=ngrok`, create a Kaggle notebook secret named `NGROK_AUTHTOKEN`, and set local `.env` `NGROK_AUTHTOKEN` only if you want the keeper to query ngrok's endpoint API. Kaggle metadata cannot attach secrets or arbitrary environment variables; `UserSecretsClient().get_secret()` may fail in CLI-pushed committed runs, which is why Cloudflare is the default.

## Safety checklist

- Do not hardcode tokens in notebook cells.
- Do not commit `.env`, tunnel URLs, Kaggle tokens, ngrok tokens, cookies, or personal account IDs.
- Treat Kaggle sessions and tunnel URLs as disposable; quotas, model availability, and tunnels can change at any time.
