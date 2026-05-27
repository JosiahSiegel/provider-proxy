# Running Gemma 4 on Kaggle with this Ollama provider

## Decision

Running `gemma4:31b` through the current Kaggle Ollama notebook is **not production-feasible on the current Kaggle `NvidiaTeslaT4` target**.

The supported implementation should use:

```bash
OLLAMA_MODEL=gemma4:e4b
KAGGLE_ACCELERATOR=NvidiaTeslaT4
```

`gemma4:31b` can be added only as an explicit experimental probe with low context, long startup timeouts, hardware logging, and automatic fallback to `gemma4:e4b`.

## Why Kaggle offers Gemma 4 31B if it does not fit this setup

Kaggle Models and Kaggle Notebooks are separate things:

- Kaggle Models is a model registry. It can host large model artifacts even when a default free notebook GPU cannot serve them interactively.
- Kaggle Notebooks is the runtime. This project currently requests `NvidiaTeslaT4`, which is a 16 GB VRAM class GPU.
- The Kaggle-hosted `google/gemma-4/transformers/gemma-4-31b-it` artifact is a Transformers model, not an Ollama GGUF model.
- Kaggle model listings often support multiple workflows: offline evaluation, fine-tuning experiments, CPU/GPU offload, multi-GPU environments, and higher-memory environments outside the default notebook shape.

This repo is optimized for a simple committed notebook that runs:

```bash
ollama serve
ollama pull "$OLLAMA_MODEL"
```

That path is different from loading a Kaggle `/transformers/` model with `transformers`, `bitsandbytes`, `accelerate`, and a custom OpenAI-compatible server.

## Feasibility matrix

| Model | Approx local size | Current T4 notebook status | Recommendation |
|---|---:|---|---|
| `gemma4:e4b` | ~9.6 GB | Fits much more safely on 16 GB VRAM | Supported path |
| `gemma4:31b` | ~20 GB | Too large for one 16 GB GPU before KV cache and runtime overhead | Experimental only |
| Kaggle `/transformers/gemma-4-31b-it` | ~46 GB BF16 artifacts | Requires quantization/offload and a different serving stack | Not recommended for this repo path |

Even if `gemma4:31b` partially offloads to CPU, the result is likely too slow for an interactive provider. Long context makes this worse because KV cache memory grows with context length.

## Implementation goal

Add first-class support for the safe Gemma 4 path and a guarded 31B experiment:

1. Default/recommended: `gemma4:e4b` on Kaggle T4 using existing Ollama + tunnel architecture.
2. Experimental: `gemma4:31b` only when `KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=1` is set.
3. The notebook probes GPU memory, logs hardware details, resolves the final model, and falls back when the allocation is too small.
4. The local keeper/proxy can continue forwarding `/ollama/v1` traffic unchanged.

## Environment variables

Add these values to `.env` when using Gemma 4.

### Supported production configuration

```bash
KAGGLE_OLLAMA_AUTO=1
KAGGLE_KERNEL_SLUG=YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
KAGGLE_KERNEL_PATH=./kaggle-ollama-provider
KAGGLE_ACCELERATOR=NvidiaTeslaT4

OLLAMA_MODEL=gemma4:e4b
KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=0
KAGGLE_OLLAMA_FALLBACK_MODEL=gemma4:e4b
OLLAMA_CONTEXT_LENGTH=4096
OLLAMA_FLASH_ATTENTION=1

KAGGLE_STARTUP_TIMEOUT_MINUTES=15
KAGGLE_LOG_FOLLOW_MS=900000
KAGGLE_IDLE_SHUTDOWN_MINUTES=30
```

### Experimental 31B configuration

Use this only when you intentionally want to spend Kaggle runtime testing whether the assigned hardware can run the model.

```bash
KAGGLE_OLLAMA_AUTO=1
KAGGLE_KERNEL_SLUG=YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
KAGGLE_KERNEL_PATH=./kaggle-ollama-provider
KAGGLE_ACCELERATOR=NvidiaTeslaT4

OLLAMA_MODEL=gemma4:31b
KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=1
KAGGLE_OLLAMA_FALLBACK_MODEL=gemma4:e4b
OLLAMA_CONTEXT_LENGTH=2048
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KEEP_ALIVE=5m

KAGGLE_STARTUP_TIMEOUT_MINUTES=45
KAGGLE_LOG_FOLLOW_MS=2700000
KAGGLE_IDLE_SHUTDOWN_MINUTES=30
```

Expected 31B outcomes on T4:

- model pull succeeds but load fails;
- model loads with heavy CPU offload and very slow first token latency;
- notebook times out before a healthy tunnel is discovered;
- tunnel is discovered but real requests are too slow for practical use.

## Notebook changes

Edit `kaggle-ollama-provider/ollama-provider-ngrok.ipynb`.

### 1. Add a GPU probe cell before Ollama starts

Insert this before the existing cell that starts `ollama serve` and pulls the model.

```python
import json
import os
import subprocess
from dataclasses import dataclass

@dataclass
class GpuInfo:
    index: int
    name: str
    total_mb: int
    free_mb: int


def query_gpus():
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception as e:
        print(f"GPU probe failed: {e}")
        return []

    gpus = []
    for line in result.stdout.strip().splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 4:
            continue
        idx, name, total, free = parts
        gpus.append(GpuInfo(int(idx), name, int(total), int(free)))
    return gpus


REQUESTED_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
FALLBACK_MODEL = os.environ.get("KAGGLE_OLLAMA_FALLBACK_MODEL", "gemma4:e4b")
ALLOW_OVERSIZE = os.environ.get("KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL", "0").lower() in {"1", "true", "yes"}

gpus = query_gpus()
print("GPU probe:")
for gpu in gpus:
    print(f"  GPU {gpu.index}: {gpu.name}, total={gpu.total_mb} MiB, free={gpu.free_mb} MiB")

total_vram_mb = sum(gpu.total_mb for gpu in gpus)
max_single_gpu_mb = max([gpu.total_mb for gpu in gpus], default=0)

MODEL = REQUESTED_MODEL
if REQUESTED_MODEL == "gemma4:31b":
    print("Requested gemma4:31b. This is experimental on Kaggle T4.")
    print(f"Detected total_vram_mb={total_vram_mb}, max_single_gpu_mb={max_single_gpu_mb}")

    probably_too_small = max_single_gpu_mb < 22_000 and total_vram_mb < 30_000
    if probably_too_small and not ALLOW_OVERSIZE:
        print(
            f"Refusing gemma4:31b on this GPU allocation. "
            f"Falling back to {FALLBACK_MODEL}. "
            f"Set KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=1 to force a slow/offloaded attempt."
        )
        MODEL = FALLBACK_MODEL
    elif probably_too_small:
        print("Forcing gemma4:31b despite insufficient VRAM. Expect slow CPU offload or failure.")

os.environ["OLLAMA_MODEL_RESOLVED"] = MODEL
print(f"Resolved Ollama model: {MODEL}")

with open("gpu_probe.json", "w", encoding="utf-8") as f:
    json.dump(
        {
            "requested_model": REQUESTED_MODEL,
            "resolved_model": MODEL,
            "fallback_model": FALLBACK_MODEL,
            "allow_oversize": ALLOW_OVERSIZE,
            "gpus": [gpu.__dict__ for gpu in gpus],
            "total_vram_mb": total_vram_mb,
            "max_single_gpu_mb": max_single_gpu_mb,
        },
        f,
        indent=2,
    )
```

### 2. Replace the Ollama startup cell

Replace the existing startup cell:

```python
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
os.environ["OLLAMA_HOST"] = "0.0.0.0"
os.environ["OLLAMA_ORIGINS"] = "*"
subprocess.Popen(["ollama", "serve"])
time.sleep(5)
subprocess.run(["ollama", "pull", MODEL], check=True)
```

with:

```python
import os
import subprocess
import time

MODEL = os.environ.get("OLLAMA_MODEL_RESOLVED") or os.environ.get("OLLAMA_MODEL", "llama3.2")

os.environ["OLLAMA_HOST"] = "0.0.0.0"
os.environ["OLLAMA_ORIGINS"] = "*"
os.environ.setdefault("OLLAMA_CONTEXT_LENGTH", "2048" if MODEL == "gemma4:31b" else "4096")
os.environ.setdefault("OLLAMA_FLASH_ATTENTION", "1")
os.environ.setdefault("OLLAMA_KEEP_ALIVE", "5m")
os.environ.setdefault("OLLAMA_DEBUG", "1")

print(f"Starting Ollama with MODEL={MODEL}")
print(f"OLLAMA_CONTEXT_LENGTH={os.environ.get('OLLAMA_CONTEXT_LENGTH')}")
print(f"OLLAMA_FLASH_ATTENTION={os.environ.get('OLLAMA_FLASH_ATTENTION')}")
print(f"OLLAMA_KEEP_ALIVE={os.environ.get('OLLAMA_KEEP_ALIVE')}")

ollama_proc = subprocess.Popen(["ollama", "serve"])
time.sleep(8)

subprocess.run(["ollama", "pull", MODEL], check=True)

print("Ollama model list:")
subprocess.run(["ollama", "list"], check=False)

print("Ollama ps before warmup:")
subprocess.run(["ollama", "ps"], check=False)
```

### 3. Update tunnel output and callback payload

In the tunnel cell, keep writing `ollama_base_url.txt` and `ollama_provider.env`, but make sure `MODEL` is the resolved model.

Update the callback payload from:

```python
payload = {"url": public_url, "model": MODEL, "provider": tunnel_provider_used or TUNNEL_PROVIDER}
```

to:

```python
payload = {
    "url": public_url,
    "model": MODEL,
    "requestedModel": os.environ.get("OLLAMA_MODEL", MODEL),
    "provider": tunnel_provider_used or TUNNEL_PROVIDER,
}
```

Optionally copy the GPU probe into an output file:

```python
try:
    with open("gpu_probe.json", "r", encoding="utf-8") as src:
        gpu_probe_text = src.read()
    with open("ollama_gpu_probe.json", "w", encoding="utf-8") as dst:
        dst.write(gpu_probe_text)
except Exception as e:
    print(f"Unable to copy gpu_probe.json: {e}")
```

### 4. Replace the warmup health test

Replace the existing health test with a model-aware timeout and short response budget:

```python
import os
import requests
import subprocess

MODEL = os.environ.get("OLLAMA_MODEL_RESOLVED") or os.environ.get("OLLAMA_MODEL", "llama3.2")
timeout = 900 if MODEL == "gemma4:31b" else 300

response = requests.post(
    "http://127.0.0.1:11434/v1/chat/completions",
    json={
        "model": MODEL,
        "stream": False,
        "max_tokens": 8,
        "messages": [{"role": "user", "content": "Reply with exactly KAGGLE_OLLAMA_OK"}],
    },
    timeout=timeout,
)

print(response.status_code)
print(response.text[:1000])

print("Ollama ps after warmup:")
subprocess.run(["ollama", "ps"], check=False)
```

## Keeper and proxy changes

No proxy routing change is required. `provider-proxy.js` forwards `/ollama/v1` to whatever upstream URL the keeper discovers.

Recommended keeper diagnostic improvement in `kaggle-ollama-keeper.js`:

```js
await run("kaggle", [
  "kernels",
  "output",
  kernelSlug,
  "-p",
  outDir,
  "--force",
  "--file-pattern",
  "ollama_(?:base_url|provider|gpu_probe).*|gpu_probe\\.json",
], 120_000);
```

This lets the keeper download `ollama_gpu_probe.json` if the committed run has completed and outputs are available. It is not required for live operation because the callback path already delivers the tunnel URL.

The keeper already exposes the resolved model in `/ollama/` status when the callback sends `model`.

## Running the supported path

1. Configure `.env`:

```bash
KAGGLE_OLLAMA_AUTO=1
KAGGLE_KERNEL_SLUG=YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
KAGGLE_KERNEL_PATH=./kaggle-ollama-provider
KAGGLE_ACCELERATOR=NvidiaTeslaT4
OLLAMA_MODEL=gemma4:e4b
KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=0
KAGGLE_OLLAMA_FALLBACK_MODEL=gemma4:e4b
OLLAMA_CONTEXT_LENGTH=4096
OLLAMA_FLASH_ATTENTION=1
KAGGLE_STARTUP_TIMEOUT_MINUTES=15
KAGGLE_LOG_FOLLOW_MS=900000
```

2. Push or let the keeper push the notebook:

```bash
kaggle kernels push -p ./kaggle-ollama-provider --accelerator NvidiaTeslaT4
```

3. Watch logs:

```bash
kaggle kernels logs -f --interval 5 YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
```

4. Confirm these log lines appear:

```text
GPU probe:
Resolved Ollama model: gemma4:e4b
Starting Ollama with MODEL=gemma4:e4b
OLLAMA_BASE_URL=https://...
Callback status: 200
```

5. Check the local proxy status:

```bash
curl http://127.0.0.1:9999/ollama/
```

6. Send a chat completion through the local proxy:

```bash
curl http://127.0.0.1:9999/ollama/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"gemma4:e4b","stream":false,"messages":[{"role":"user","content":"Reply with exactly OK"}]}'
```

## Running the experimental 31B probe

1. Configure `.env`:

```bash
KAGGLE_OLLAMA_AUTO=1
KAGGLE_KERNEL_SLUG=YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok
KAGGLE_KERNEL_PATH=./kaggle-ollama-provider
KAGGLE_ACCELERATOR=NvidiaTeslaT4
OLLAMA_MODEL=gemma4:31b
KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=1
KAGGLE_OLLAMA_FALLBACK_MODEL=gemma4:e4b
OLLAMA_CONTEXT_LENGTH=2048
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KEEP_ALIVE=5m
KAGGLE_STARTUP_TIMEOUT_MINUTES=45
KAGGLE_LOG_FOLLOW_MS=2700000
```

2. Push the notebook:

```bash
kaggle kernels push -p ./kaggle-ollama-provider --accelerator NvidiaTeslaT4
```

3. Watch for the hardware decision:

```text
Requested gemma4:31b. This is experimental on Kaggle T4.
Detected total_vram_mb=..., max_single_gpu_mb=...
Forcing gemma4:31b despite insufficient VRAM. Expect slow CPU offload or failure.
```

4. If the model loads, check `ollama ps` output in logs. If most of the model is not on GPU or first token latency is excessive, stop using 31B for this workflow.

5. Return to the supported path by setting:

```bash
OLLAMA_MODEL=gemma4:e4b
KAGGLE_OLLAMA_ALLOW_OVERSIZE_MODEL=0
KAGGLE_STARTUP_TIMEOUT_MINUTES=15
KAGGLE_LOG_FOLLOW_MS=900000
```

## Testing unknown Kaggle accelerator shapes

Kaggle's CLI accepts `--accelerator`, but valid machine shape names are server-side and not reliably documented. Do not commit guessed values.

If you want to test whether your account has a better accelerator, do it manually with a private throwaway push:

```bash
kaggle kernels push -p ./kaggle-ollama-provider --accelerator NvidiaTeslaT4
```

Only update `.env` or `kernel-metadata.json` after Kaggle accepts the shape and the notebook logs confirm the actual GPU with `nvidia-smi`.

Do not assume that a Kaggle model page means the notebook has enough VRAM for that model.

## Failure modes and operator response

### `ollama pull gemma4:31b` takes too long

Use longer startup settings only for the experiment:

```bash
KAGGLE_STARTUP_TIMEOUT_MINUTES=45
KAGGLE_LOG_FOLLOW_MS=2700000
```

If it still fails, use `gemma4:e4b`.

### Notebook runs but no upstream URL appears

Check logs for:

```text
Cloudflare attempt 1/3
OLLAMA_BASE_URL=https://...
Callback status: ...
```

If the kernel is running without a URL beyond `KAGGLE_STARTUP_TIMEOUT_MINUTES`, the keeper should stop and re-push.

### Tunnel is healthy but requests are extremely slow

For `gemma4:31b`, this likely means CPU offload. Treat it as expected failure and revert to `gemma4:e4b`.

### T4 reports less free VRAM than expected

The notebook may already have CUDA allocations or runtime overhead. Use the fallback model.

### Kaggle rejects an accelerator

Keep `KAGGLE_ACCELERATOR=NvidiaTeslaT4`. Do not add unverified shape names to the repo.

## Final recommendation

Implement and operate Gemma 4 on Kaggle as:

```bash
OLLAMA_MODEL=gemma4:e4b
```

Treat this as unsupported-by-default:

```bash
OLLAMA_MODEL=gemma4:31b
```

The 31B model is feasible only if Kaggle assigns enough usable GPU memory or if you accept very slow CPU/GPU offload. That is not a reliable target for this repo's self-healing interactive provider workflow.
