#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

load_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required but was not found on PATH." >&2
    exit 1
  fi
}

mode_summary() {
  local modes=()
  [[ -n "${TARGETS:-}" ]] && modes+=("multi-target proxy")
  [[ -n "${TARGET_HOST:-}" ]] && modes+=("single-target proxy")
  [[ -n "${OLLAMA_BASE_URL:-}" ]] && modes+=("/ollama manual upstream")
  if [[ "${KAGGLE_OLLAMA_AUTO:-}" == "1" || "${KAGGLE_OLLAMA_AUTO:-}" == "true" || "${OLLAMA_KAGGLE_AUTO:-}" == "1" || "${OLLAMA_KAGGLE_AUTO:-}" == "true" ]]; then
    modes+=("/ollama Kaggle keeper")
  fi
  modes+=("/agy built-in")
  printf '%s' "${modes[*]}"
}

load_env "$ENV_FILE"
require_command node

cd "$ROOT_DIR"

echo "provider-proxy root: $ROOT_DIR"
if [[ -f "$ENV_FILE" ]]; then
  echo "loaded env: $ENV_FILE"
else
  echo "no .env found; starting built-in routes only unless env is already set"
fi

echo "detected mode(s): $(mode_summary)"
echo "local URLs:"
echo "  agy:    http://${PROXY_BIND:-127.0.0.1}:${PROXY_PORT:-9999}${AGY_PATH_PREFIX:-/agy}/v1"
echo "  ollama: http://${PROXY_BIND:-127.0.0.1}:${PROXY_PORT:-9999}${OLLAMA_PATH_PREFIX:-/ollama}/v1"

exec node provider-proxy.js
