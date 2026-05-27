const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const DEFAULT_KERNEL_SLUG = "YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok";
const DEFAULT_ACCELERATOR = "NvidiaTeslaT4";
const STATUS_POLL_MS = 30_000;
const HEALTH_POLL_MS = 60_000;
const PUSH_COOLDOWN_MS = 5 * 60_000;
const NGROK_API_URL = "https://api.ngrok.com/endpoints";

function boolEnv(name) {
  return process.env[name] === "1" || process.env[name]?.toLowerCase() === "true";
}

function intEnv(name, fallback) {
  if (process.env[name] == null || process.env[name] === "") return fallback;
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_err) {
    return {};
  }
}

function writeState(filePath, state) {
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (_err) {
    // best effort
  }
}

function createKaggleOllamaKeeper() {
  const enabled = boolEnv("KAGGLE_OLLAMA_AUTO") || boolEnv("OLLAMA_KAGGLE_AUTO");
  const kernelSlug = process.env.KAGGLE_KERNEL_SLUG || process.env.KAGGLE_OLLAMA_KERNEL_SLUG || DEFAULT_KERNEL_SLUG;
  const kernelPath = process.env.KAGGLE_KERNEL_PATH || process.env.KAGGLE_OLLAMA_KERNEL_PATH || "./kaggle-ollama-provider";
  const accelerator = process.env.KAGGLE_ACCELERATOR || process.env.KAGGLE_OLLAMA_ACCELERATOR || DEFAULT_ACCELERATOR;
  const statusPollMs = intEnv("KAGGLE_STATUS_POLL_MS", STATUS_POLL_MS);
  const healthPollMs = intEnv("KAGGLE_HEALTH_POLL_MS", HEALTH_POLL_MS);
  const pushCooldownMs = intEnv("KAGGLE_PUSH_COOLDOWN_MS", PUSH_COOLDOWN_MS);
  const idleShutdownMs = intEnv("KAGGLE_IDLE_SHUTDOWN_MINUTES", 30) * 60_000;
  const logFollowMs = intEnv("KAGGLE_LOG_FOLLOW_MS", 10 * 60_000);
  const startupTimeoutMs = intEnv("KAGGLE_STARTUP_TIMEOUT_MINUTES", 10) * 60_000;
  const ngrokAuthtoken = process.env.NGROK_AUTHTOKEN || "";
  const callbackToken = process.env.OLLAMA_URL_CALLBACK_TOKEN || process.env.KAGGLE_OLLAMA_CALLBACK_TOKEN || "";
  const statePath = path.resolve(process.env.KAGGLE_OLLAMA_STATE_FILE || ".kaggle-ollama-keeper-state.json");
  const persistedState = readState(statePath);
  const persistedLastActivityAt = Number(persistedState.lastActivityAt || 0);
  const persistedLastPushAt = Number(persistedState.lastPushAt || 0);
  const persistedMissingUrlSince = Number(persistedState.missingUrlSince || 0);
  let lastPushedCallbackUrl = persistedState.lastPushedCallbackUrl || "";

  let currentUrl = process.env.OLLAMA_BASE_URL || "";
  let currentModel = process.env.OLLAMA_MODEL || "";
  let lastError = null;
  let lastStatus = "idle";
  let lastCallbackAt = null;
  let running = false;
  let checking = false;
  let lastPushAt = Number.isFinite(persistedLastPushAt) ? persistedLastPushAt : 0;
  let lastActivityAt = Number.isFinite(persistedLastActivityAt) ? persistedLastActivityAt : 0;
  let idle = false;
  let stopping = false;
  let waking = false;
  let wakeRequested = false;
  let timer = null;
  let consecutiveHealthFailures = 0;
  let ngrokProcess = null;
  let localNgrokUrl = "";
  let missingUrlSince = Number.isFinite(persistedMissingUrlSince) ? persistedMissingUrlSince : 0;

  function log(message) {
    console.log(`[kaggle-ollama] ${message}`);
  }

  function run(command, args, timeoutMs = 120_000, onOutput = null) {
    return new Promise((resolve) => {
      const executable = process.platform === "win32" && command === "kaggle" ? "kaggle.exe" : command;
      const child = spawn(executable, args, {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
      }, timeoutMs);

      child.stdout.on("data", (data) => {
        const text = data.toString("utf8");
        stdout += text;
        if (onOutput && onOutput(text) === true && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          resolve({ code: 0, stdout, stderr });
        }
      });
      child.stderr.on("data", (data) => {
        const text = data.toString("utf8");
        stderr += text;
        if (onOutput && onOutput(text) === true && !settled) {
          settled = true;
          clearTimeout(timeout);
          child.kill();
          resolve({ code: 0, stdout, stderr });
        }
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ code: 1, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ code, stdout, stderr });
      });
    });
  }

  function extractStatus(output) {
    const match = output.match(/status "([^"]+)"/);
    return match ? match[1] : "unknown";
  }

  function extractUrl(output) {
    const direct = output.match(/OLLAMA_BASE_URL=(https:\/\/[^\s"'}\\]+)/i);
    if (direct) return direct[1];
    const active = output.match(/endpoint '(https:\/\/[^']+?\.ngrok-free\.(?:app|dev))' is already online/i);
    if (active) return active[1];
    const anyTunnel = output.match(/https:\/\/[a-zA-Z0-9.-]+(?:\.ngrok-free\.(?:app|dev)|\.trycloudflare\.com)/i);
    return anyTunnel ? anyTunnel[0] : "";
  }

  function httpJson(url, headers = {}, timeoutMs = 30_000) {
    return new Promise((resolve) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_err) {
        resolve(null);
        return;
      }

      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request(
        parsed,
        { method: "GET", timeout: timeoutMs, headers },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch (_err) {
              resolve(null);
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.on("error", () => resolve(null));
      req.end();
    });
  }

  async function queryLocalNgrokTunnels() {
    const ports = [4040, 4041, 4042, 4043, 4044, 4045];
    for (const p of ports) {
      const tunnels = await httpJson(`http://127.0.0.1:${p}/api/tunnels`, {}, 1000);
      if (tunnels && Array.isArray(tunnels.tunnels)) {
        return { tunnels: tunnels.tunnels, port: p };
      }
    }
    return null;
  }

  async function discoverNgrokEndpoint() {
    if (!ngrokAuthtoken) return "";
    const data = await httpJson(NGROK_API_URL, {
      authorization: `Bearer ${ngrokAuthtoken}`,
      "ngrok-version": "2",
    });
    if (!data || !Array.isArray(data.endpoints)) return "";
    for (const endpoint of data.endpoints) {
      const url = endpoint.public_url || endpoint.url;
      if (!url || !/\.ngrok-free\.(app|dev)$/i.test(new URL(url).hostname)) continue;
      if (await healthCheck(url)) return url;
    }
    return "";
  }

  function acceptCallback(req, body) {
    if (!enabled) return { ok: false, status: 404, error: "Kaggle keeper not enabled" };
    if (req.method !== "POST") return { ok: false, status: 405, error: "Method not allowed" };
    if (callbackToken && req.headers.authorization !== `Bearer ${callbackToken}`) {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
    const discoveredUrl = extractUrl(body?.url || body?.baseUrl || body?.baseURL || body?.OLLAMA_BASE_URL || "");
    if (!discoveredUrl) return { ok: false, status: 400, error: "Callback body must include a Cloudflare or ngrok HTTPS url" };
    currentUrl = discoveredUrl;
    currentModel = body?.model || body?.OLLAMA_MODEL || currentModel;
    lastCallbackAt = new Date().toISOString();
    lastError = null;
    lastStatus = "callback_received";
    recordActivity();
    log(`discovered Ollama upstream from callback ${currentUrl}${currentModel ? ` model=${currentModel}` : ""}`);
    return { ok: true, status: 200, url: currentUrl, model: currentModel || null };
  }

  function healthCheck(url) {
    return new Promise((resolve) => {
      let parsed;
      try {
        parsed = new URL("/v1/models", url);
      } catch (_err) {
        resolve(false);
        return;
      }

      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.request(
        parsed,
        {
          method: "GET",
          timeout: 30_000,
          headers: { "ngrok-skip-browser-warning": "true" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 500);
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  }

  async function discoverOutputUrl() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaggle-ollama-output-"));
    try {
      await run("kaggle", ["kernels", "output", kernelSlug, "-p", outDir, "--force", "--file-pattern", "ollama_(?:base_url|provider).*"], 120_000);
      for (const file of ["ollama_base_url.txt", "ollama_provider.env"]) {
        const filePath = path.join(outDir, file);
        if (!fs.existsSync(filePath)) continue;
        const discoveredUrl = extractUrl(fs.readFileSync(filePath, "utf8"));
        if (discoveredUrl) return discoveredUrl;
      }
    } catch (_err) {
      return "";
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    return "";
  }

  async function followLogsForUrl(reason) {
    if (!logFollowMs) return false;
    log(`following Kaggle logs after ${reason} for up to ${Math.round(logFollowMs / 1000)}s`);
    let buffer = "";
    await run("kaggle", ["kernels", "logs", "-f", "--interval", "5", kernelSlug], logFollowMs, (text) => {
      buffer += text;
      const discoveredUrl = extractUrl(buffer);
      if (discoveredUrl) {
        if (discoveredUrl !== currentUrl) {
          currentUrl = discoveredUrl;
          log(`discovered Ollama upstream from live Kaggle logs ${currentUrl}`);
        }
        return true;
      }
    });
    return Boolean(currentUrl);
  }

  function persistActivity() {
    writeState(statePath, { lastActivityAt, lastPushedCallbackUrl, lastPushAt, missingUrlSince });
  }

  function resetIdleClock() {
    lastActivityAt = Date.now();
    persistActivity();
    idle = false;
  }

  async function pushKernel(reason) {
    const now = Date.now();
    if (now - lastPushAt < pushCooldownMs) {
      log(`skip push after ${reason}; cooldown is active`);
      return false;
    }
    lastPushAt = now;
    resetIdleClock();

    const isDynamicNgrok = process.env.OLLAMA_URL_CALLBACK && (process.env.OLLAMA_URL_CALLBACK.includes(".ngrok-free.dev") || process.env.OLLAMA_URL_CALLBACK.includes(".ngrok-free.app"));
    if ((!process.env.OLLAMA_URL_CALLBACK || isDynamicNgrok) && ngrokAuthtoken) {
      await startLocalNgrok();
    }

    const finalCallbackUrl = process.env.OLLAMA_URL_CALLBACK || "";
    const finalCallbackToken = process.env.OLLAMA_URL_CALLBACK_TOKEN || process.env.KAGGLE_OLLAMA_CALLBACK_TOKEN || "";
    if (finalCallbackUrl) {
      injectCallbackEnvIntoNotebook(finalCallbackUrl, finalCallbackToken);
    }

    log(`pushing Kaggle kernel after ${reason}`);
    const result = await run("kaggle", ["kernels", "push", "-p", kernelPath, "--accelerator", accelerator], 10 * 60_000);
    if (result.code !== 0) {
      lastError = `push failed: ${result.stderr || result.stdout}`.trim();
      log(lastError);
      return false;
    }
    log("kernel push accepted");
    lastPushedCallbackUrl = finalCallbackUrl;
    persistActivity();
    followLogsForUrl("push");
    return true;
  }

  function execFileAsync(command, args, options) {
    return new Promise((resolve) => {
      const executable = process.platform === "win32" && command === "kaggle" ? "kaggle.exe" : command;
      execFile(executable, args, options, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
      });
    });
  }

  function isTerminalStatus(status) {
    return [
      "KernelWorkerStatus.ERROR",
      "KernelWorkerStatus.CANCEL_ACKNOWLEDGED",
      "KernelWorkerStatus.CANCELED",
      "KernelWorkerStatus.CANCELLED",
      "KernelWorkerStatus.COMPLETE",
    ].includes(status);
  }

  async function stopRemoteKernel(reason) {
    log(`stopping remote Kaggle kernel after ${reason}`);
    const result = await execFileAsync("kaggle", ["kernels", "delete", "-y", kernelSlug], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      timeout: 120_000,
    });
    if (!result.err) {
      log("remote Kaggle kernel stop (delete) requested");
      return true;
    }

    const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
    const stdout = result.stdout ? result.stdout.toString("utf8").trim() : "";
    const detail = stderr || stdout || result.err.message;
    log(`warning: failed to stop remote Kaggle kernel: ${detail}`);
    return false;
  }

  function injectCallbackEnvIntoNotebook(callbackUrl, callbackToken) {
    try {
      const metaPath = path.join(kernelPath, "kernel-metadata.json");
      if (!fs.existsSync(metaPath)) return;
      const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const codeFile = typeof metadata.code_file === "string" && metadata.code_file ? metadata.code_file : "ollama-provider-ngrok.ipynb";
      const notebookPath = path.join(kernelPath, codeFile);
      if (!fs.existsSync(notebookPath)) return;

      const notebook = JSON.parse(fs.readFileSync(notebookPath, "utf8"));
      if (!Array.isArray(notebook.cells)) return;

      const marker = "# provider-proxy injected callback env";
      const lines = [
        "import os",
        marker,
        `os.environ["OLLAMA_URL_CALLBACK"] = ${JSON.stringify(callbackUrl)}`,
        `os.environ["OLLAMA_URL_CALLBACK_TOKEN"] = ${JSON.stringify(callbackToken)}`,
        "",
      ];

      const sourceToText = (src) => Array.isArray(src) ? src.join("") : String(src || "");

      let cell = notebook.cells.find((candidate) => candidate.cell_type === "code" && sourceToText(candidate.source).includes(marker));
      if (!cell) {
        cell = { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] };
        notebook.cells.splice(1, 0, cell);
      }
      cell.source = lines.map((line) => `${line}\n`);
      fs.writeFileSync(notebookPath, `${JSON.stringify(notebook, null, 1)}\n`, "utf8");
      log(`callback env injected into notebook cell (${callbackUrl})`);
    } catch (err) {
      log(`warning: failed to inject callback env into notebook: ${err.message}`);
    }
  }

  function startLocalNgrok() {
    return new Promise((resolve) => {
      if (!ngrokAuthtoken) {
        resolve();
        return;
      }
      if (ngrokProcess) {
        resolve();
        return;
      }

      const proxyPort = intEnv("PROXY_PORT", 9999);
      queryLocalNgrokTunnels().then((result) => {
        if (result && Array.isArray(result.tunnels)) {
          const matched = result.tunnels.find((t) => t.config && t.config.addr && t.config.addr.endsWith(String(proxyPort)));
          if (matched && matched.public_url) {
            localNgrokUrl = matched.public_url;
            const prefix = process.env.OLLAMA_PATH_PREFIX || "/ollama";
            const finalCallbackUrl = localNgrokUrl.replace(/\/$/, "") + `${prefix}/callback`;
            process.env.OLLAMA_URL_CALLBACK = finalCallbackUrl;
            log(`using existing local ngrok tunnel (port ${result.port}): ${localNgrokUrl} -> callback: ${finalCallbackUrl}`);
            resolve();
            return;
          }
        }

        log("starting local ngrok tunnel to expose callback...");
        const args = ["http", String(proxyPort), "--log=stdout"];
        const child = spawn("ngrok.exe", args, {
          env: { ...process.env, NGROK_AUTHTOKEN: ngrokAuthtoken },
          windowsHide: true,
        });
        ngrokProcess = child;

        child.on("error", (err) => {
          log(`failed to start local ngrok: ${err.message}`);
          resolve();
        });

        child.on("close", (code) => {
          log(`local ngrok process exited with code ${code}`);
          ngrokProcess = null;
        });

        let attempts = 0;
        const pollInterval = setInterval(async () => {
          attempts++;
          if (attempts > 30 || localNgrokUrl) {
            clearInterval(pollInterval);
            resolve();
            return;
          }
          try {
            const result = await queryLocalNgrokTunnels();
            if (result && Array.isArray(result.tunnels) && result.tunnels.length > 0) {
              const publicUrl = result.tunnels[0].public_url;
              if (publicUrl) {
                localNgrokUrl = publicUrl;
                const prefix = process.env.OLLAMA_PATH_PREFIX || "/ollama";
                const finalCallbackUrl = localNgrokUrl.replace(/\/$/, "") + `${prefix}/callback`;
                process.env.OLLAMA_URL_CALLBACK = finalCallbackUrl;
                log(`local ngrok tunnel established: ${localNgrokUrl} -> callback: ${finalCallbackUrl}`);

                try {
                  const envPath = path.join(__dirname, ".env");
                  if (fs.existsSync(envPath)) {
                    let envText = fs.readFileSync(envPath, "utf8");
                    const callbackRegex = /^(?:#\s*)?OLLAMA_URL_CALLBACK\s*=\s*.*$/m;
                    if (callbackRegex.test(envText)) {
                      envText = envText.replace(callbackRegex, `OLLAMA_URL_CALLBACK=${finalCallbackUrl}`);
                    } else {
                      envText += `\nOLLAMA_URL_CALLBACK=${finalCallbackUrl}\n`;
                    }
                    fs.writeFileSync(envPath, envText, "utf8");
                    log(`updated OLLAMA_URL_CALLBACK in .env`);
                  }
                } catch (e) {
                  log(`warning: failed to write OLLAMA_URL_CALLBACK to .env: ${e.message}`);
                }

                clearInterval(pollInterval);
                resolve();
              }
            }
          } catch (err) {
            // ignore
          }
        }, 1000);
      }).catch((_err) => {
        resolve();
      });
    });
  }

  async function refresh({ force = false } = {}) {
    if (!enabled || checking) return;
    const idleForMs = lastActivityAt ? Date.now() - lastActivityAt : 0;
    if (!force && currentUrl && lastActivityAt && idleShutdownMs > 0 && idleForMs >= idleShutdownMs) {
      if (!idle) {
        log(`idle for ${Math.round(idleForMs / 60_000)}m; stopping remote Kaggle kernel and clearing upstream`);
        lastStatus = "stopping";
        idle = true;
        stopping = true;
        currentUrl = "";
        await stopRemoteKernel("idle timeout");
        stopping = false;
      }
      idle = true;
      currentUrl = "";
      lastStatus = "idle_stopped";
      return;
    }
    checking = true;
    try {
      if (force) idle = false;
      // Prefer ngrok's API because Kaggle CLI logs can lag behind interactive runs.
      const ngrokUrl = await discoverNgrokEndpoint();
      if (ngrokUrl && ngrokUrl !== currentUrl) {
        currentUrl = ngrokUrl;
        log(`discovered Ollama upstream from ngrok API ${currentUrl}`);
      }

      // Fall back to Kaggle logs before deciding to re-push.
      if (!currentUrl) {
        const logsResult = await run("kaggle", ["kernels", "logs", kernelSlug]);
        const logs = `${logsResult.stdout}\n${logsResult.stderr}`;
        const discoveredUrl = extractUrl(logs);
        if (discoveredUrl && discoveredUrl !== currentUrl) {
          currentUrl = discoveredUrl;
          log(`discovered Ollama upstream from Kaggle logs ${currentUrl}`);
        }
      }

      if (!currentUrl) {
        const outputUrl = await discoverOutputUrl();
        if (outputUrl && outputUrl !== currentUrl) {
          currentUrl = outputUrl;
          log(`discovered Ollama upstream from Kaggle output files ${currentUrl}`);
        }
      }

      // If we have a URL, health-check it before anything else.
      if (currentUrl) {
        const ok = await healthCheck(currentUrl);
        if (ok) {
          lastError = null;
          if (missingUrlSince !== 0) {
            missingUrlSince = 0;
            persistActivity();
          }
          consecutiveHealthFailures = 0;
          return; // tunnel is healthy, no action needed
        }
        consecutiveHealthFailures++;
        log(`health check failed for ${currentUrl} (consecutive failures: ${consecutiveHealthFailures})`);
        if (consecutiveHealthFailures >= 3) {
          log(`persistent health failure detected for ${currentUrl}; clearing active URL.`);
          const staleUrl = currentUrl;
          currentUrl = "";
          consecutiveHealthFailures = 0;

          // Get kernel status to see if it is running/active
          const statusResult = await run("kaggle", ["kernels", "status", kernelSlug]);
          let status = "unknown";
          if (statusResult.code === 0) {
            status = extractStatus(statusResult.stdout || statusResult.stderr);
          }

          if (!isTerminalStatus(status)) {
            log(`kernel is in active state "${status}" but upstream ${staleUrl} is dead. Stopping and re-pushing.`);
            await stopRemoteKernel("persistent health failure");
            await pushKernel("persistent health failure");
            return;
          }
        }
      }

      // No healthy tunnel — check kernel status and re-push if needed.
      const statusResult = await run("kaggle", ["kernels", "status", kernelSlug]);
      if (statusResult.code !== 0) {
        lastStatus = "missing-or-inaccessible";
        lastError = (statusResult.stderr || statusResult.stdout || "status failed").trim();
        await pushKernel("status check failed");
        return;
      }

      lastStatus = extractStatus(statusResult.stdout || statusResult.stderr);

      // Check if callback URL has changed or is unknown while kernel is active and we have no upstream URL
      const activeCallbackUrl = process.env.OLLAMA_URL_CALLBACK || "";
      if (
        !isTerminalStatus(lastStatus) &&
        !currentUrl &&
        activeCallbackUrl &&
        activeCallbackUrl !== lastPushedCallbackUrl
      ) {
        log(`callback URL mismatch (pushed: "${lastPushedCallbackUrl}", active: "${activeCallbackUrl}") while kernel is active (${lastStatus}) without upstream. stopping and re-pushing.`);
        await stopRemoteKernel("callback URL mismatch");
        currentUrl = "";
        await pushKernel("callback URL mismatch");
        return;
      }


      // Re-push if the kernel is in a terminal state and tunnel is down.
      if (isTerminalStatus(lastStatus)) {
        await pushKernel(lastStatus);
      } else if (!currentUrl) {
        if (!missingUrlSince) {
          missingUrlSince = Date.now();
          persistActivity();
        }
        const missingUrlForMs = Date.now() - missingUrlSince;
        lastError = `kernel running (${lastStatus}) but no upstream URL discovered yet`;
        log(lastError);
        if (startupTimeoutMs > 0 && missingUrlForMs >= startupTimeoutMs) {
          log(`kernel running without URL for ${Math.round(missingUrlForMs / 60_000)}m; stopping and re-pushing.`);
          await stopRemoteKernel("startup timeout");
          currentUrl = "";
          missingUrlSince = 0;
          persistActivity();
          await pushKernel("startup timeout");
          return;
        }
      } else {
        if (missingUrlSince !== 0) {
          missingUrlSince = 0;
          persistActivity();
        }
        lastError = `health check failed for ${currentUrl}; kernel state ${lastStatus}`;
        log(lastError);
      }
    } catch (err) {
      lastError = err.message;
      log(`refresh failed: ${err.message}`);
    } finally {
      checking = false;
    }
  }

  async function start() {
    if (!enabled || running) return;
    running = true;
    log(`enabled for ${kernelSlug}; polling every ${statusPollMs}ms`);
    const isDynamicNgrok = process.env.OLLAMA_URL_CALLBACK && (process.env.OLLAMA_URL_CALLBACK.includes(".ngrok-free.dev") || process.env.OLLAMA_URL_CALLBACK.includes(".ngrok-free.app"));
    if ((!process.env.OLLAMA_URL_CALLBACK || isDynamicNgrok) && ngrokAuthtoken) {
      await startLocalNgrok();
    }
    refresh();
    timer = setInterval(refresh, Math.min(statusPollMs, healthPollMs));
  }

  function getBaseUrl() {
    return idle ? "" : currentUrl || "";
  }

  function recordActivity() {
    lastActivityAt = Date.now();
    persistActivity();
    if (idle && !stopping) {
      idle = false;
      log("activity received; leaving idle state");
    }
  }

  async function wake() {
    if (!enabled) return false;
    recordActivity();
    wakeRequested = true;
    if (waking) return true;
    waking = true;
    try {
      while (wakeRequested) {
        wakeRequested = false;
        if (checking) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          wakeRequested = true;
          continue;
        }
        await refresh({ force: true });
        if (!currentUrl) await pushKernel("wake requested");
      }
      return true;
    } finally {
      waking = false;
    }
  }

  function getStatus() {
    return {
      enabled,
      running,
      kernelSlug,
      kernelPath,
      accelerator,
      ngrokApiDiscovery: Boolean(ngrokAuthtoken),
      status: stopping ? "stopping" : idle ? "idle" : lastStatus,
      upstream: idle || stopping ? null : currentUrl || null,
      model: currentModel || null,
      callbackEnabled: true,
      callbackTokenRequired: Boolean(callbackToken),
      lastCallbackAt,
      error: lastError,
      checking,
      idle,
      stopping,
      waking,
      wakeRequested,
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
      idleShutdownMinutes: Math.round(idleShutdownMs / 60_000),
      logFollowSeconds: Math.round(logFollowMs / 1000),
    };
  }

  function stop() {
    if (timer) clearInterval(timer);
    running = false;
    timer = null;
    if (ngrokProcess) {
      log("stopping local ngrok tunnel...");
      try {
        ngrokProcess.kill();
      } catch (err) {
        log(`error stopping local ngrok: ${err.message}`);
      }
      ngrokProcess = null;
      localNgrokUrl = "";
    }
  }

  return { enabled, start, stop, refresh, getBaseUrl, getStatus, recordActivity, wake, acceptCallback };
}

module.exports = { createKaggleOllamaKeeper };
