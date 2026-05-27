param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://')]
  [string]$OllamaBaseUrl,

  [string]$ProviderApiKey = "choose-a-local-client-token",
  [int]$ProxyPort = 9999,
  [string]$ProxyBind = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$proxy = Join-Path $root "provider-proxy.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required but was not found on PATH."
}
if (-not (Test-Path $proxy)) {
  throw "provider-proxy.js not found at $proxy"
}

$env:OLLAMA_BASE_URL = $OllamaBaseUrl.TrimEnd('/')
$env:OLLAMA_NGROK_SKIP_BROWSER_WARNING = if ($env:OLLAMA_BASE_URL -match '\.ngrok-free\.(app|dev)$') { "1" } else { "0" }
$env:OLLAMA_PROVIDER_API_KEY = $ProviderApiKey
$env:PROXY_PORT = [string]$ProxyPort
$env:PROXY_BIND = $ProxyBind

Write-Host "Starting provider proxy for Ollama..." -ForegroundColor Cyan
Write-Host "Upstream Ollama: $env:OLLAMA_BASE_URL"
Write-Host "Client base URL: http://127.0.0.1:$ProxyPort/ollama/v1"
Write-Host "Client API key: $ProviderApiKey"

node $proxy
