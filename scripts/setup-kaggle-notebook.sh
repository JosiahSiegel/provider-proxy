#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KERNEL_DIR="${KAGGLE_KERNEL_PATH:-$ROOT_DIR/kaggle-ollama-provider}"
METADATA_FILE="$KERNEL_DIR/kernel-metadata.json"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
KERNEL_TITLE="${KAGGLE_KERNEL_TITLE:-Ollama Provider via ngrok}"
KERNEL_SLUG_NAME="${KAGGLE_KERNEL_SLUG_NAME:-ollama-provider-via-ngrok}"
KAGGLE_USERNAME="${KAGGLE_USERNAME:-}"
KERNEL_SLUG="${KAGGLE_KERNEL_SLUG:-}"
ACCELERATOR="${KAGGLE_ACCELERATOR:-NvidiaTeslaT4}"
MAX_WAIT_SECONDS="${KAGGLE_SETUP_MAX_WAIT_SECONDS:-600}"
POLL_SECONDS="${KAGGLE_SETUP_POLL_SECONDS:-10}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required but was not found on PATH." >&2
    exit 1
  fi
}

json_string() {
  python -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

upsert_env() {
  local key="$1"
  local value="$2"
  touch "$ENV_FILE"
  if grep -Eq "^#?${key}=" "$ENV_FILE"; then
    local tmp
    tmp="$(mktemp)"
    awk -v key="$key" -v value="$value" 'BEGIN{done=0} $0 ~ "^#?" key "=" {print key "=" value; done=1; next} {print} END{if(!done) print key "=" value}' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

extract_url() {
  python -c 'import re,sys; text=sys.stdin.read(); m=re.search(r"OLLAMA_BASE_URL=(https://[^\s\"'"'"'}]+)", text, re.I) or re.search(r"https://[A-Za-z0-9.-]+(?:\.(?:trycloudflare|ngrok-free\.(?:app|dev)|ngrok\.(?:app|dev)|ngrok\.io|serveo\.net|localtunnel\.me|lhr\.life))", text, re.I); print(m.group(1) if m and m.lastindex else (m.group(0) if m else ""))'
}

require_command python
require_command kaggle

if [[ -z "$KAGGLE_USERNAME" ]]; then
  KAGGLE_USERNAME="$(python - <<'PY'
import json, os
for path in [os.path.expanduser('~/.kaggle/kaggle.json')]:
    try:
        with open(path, encoding='utf-8') as f:
            print(json.load(f).get('username', ''))
            raise SystemExit
    except FileNotFoundError:
        pass
print('')
PY
)"
fi

if [[ -z "$KAGGLE_USERNAME" ]]; then
  echo "Error: set KAGGLE_USERNAME or authenticate Kaggle CLI with ~/.kaggle/kaggle.json." >&2
  exit 1
fi

if [[ -z "$KERNEL_SLUG" ]]; then
  KERNEL_SLUG="$KAGGLE_USERNAME/$KERNEL_SLUG_NAME"
fi

if [[ ! -f "$METADATA_FILE" ]]; then
  echo "Error: metadata file not found: $METADATA_FILE" >&2
  exit 1
fi

python - "$METADATA_FILE" "$KERNEL_SLUG" "$KERNEL_TITLE" <<'PY'
import json, sys
path, slug, title = sys.argv[1:4]
with open(path, encoding='utf-8') as f:
    data = json.load(f)
data['id'] = slug
data.pop('id_no', None)
data['title'] = title
data['code_file'] = data.get('code_file') or 'ollama-provider-ngrok.ipynb'
data['language'] = data.get('language') or 'python'
data['kernel_type'] = data.get('kernel_type') or 'notebook'
data['is_private'] = True
data['enable_gpu'] = True
data['enable_internet'] = True
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PY

echo "Pushing Kaggle kernel: $KERNEL_SLUG"
kaggle kernels push -p "$KERNEL_DIR" --accelerator "$ACCELERATOR"

upsert_env KAGGLE_KERNEL_SLUG "$KERNEL_SLUG"
upsert_env KAGGLE_KERNEL_PATH "$KERNEL_DIR"
upsert_env KAGGLE_ACCELERATOR "$ACCELERATOR"
upsert_env OLLAMA_NGROK_SKIP_BROWSER_WARNING "0"

echo "Waiting for OLLAMA_BASE_URL in Kaggle logs..."
start_ts="$(date +%s)"
while true; do
  now_ts="$(date +%s)"
  if (( now_ts - start_ts > MAX_WAIT_SECONDS )); then
    echo "Timed out waiting for tunnel URL. Check: kaggle kernels logs $KERNEL_SLUG" >&2
    exit 1
  fi

  logs="$(kaggle kernels logs "$KERNEL_SLUG" 2>/dev/null || true)"
  url="$(printf '%s' "$logs" | extract_url)"
  if [[ -n "$url" ]]; then
    echo "Found Ollama upstream: $url"
    upsert_env OLLAMA_BASE_URL "$url"
    if [[ "$url" =~ \.ngrok-free\.(app|dev)$ ]]; then
      upsert_env OLLAMA_NGROK_SKIP_BROWSER_WARNING "1"
    else
      upsert_env OLLAMA_NGROK_SKIP_BROWSER_WARNING "0"
    fi
    echo "Updated $ENV_FILE"
    echo "Next: ./scripts/start-proxy.sh"
    exit 0
  fi

  printf '.'
  sleep "$POLL_SECONDS"
done
