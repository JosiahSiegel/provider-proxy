param(
  [string]$KernelSlug = "YOUR_KAGGLE_USERNAME/ollama-provider-via-ngrok",
  [string]$ProviderApiKey = "choose-a-local-client-token",
  [int]$ProxyPort = 9999,
  [string]$ProxyBind = "127.0.0.1",
  [int]$MaxWaitSeconds = 600,
  [int]$PollSeconds = 10
)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$proxy = Join-Path $root "provider-proxy.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required but was not found on PATH."
}
if (-not (Get-Command kaggle -ErrorAction SilentlyContinue)) {
  throw "Kaggle CLI is required but was not found on PATH."
}
if (-not (Test-Path $proxy)) {
  throw "provider-proxy.js not found at $proxy"
}
if ($KernelSlug -like "YOUR_KAGGLE_USERNAME/*") {
  throw "Pass your real Kaggle slug with -KernelSlug 'username/ollama-provider-via-ngrok'."
}

function Get-TunnelUrlFromText {
  param([string]$Text)
  $patterns = @(
    'OLLAMA_BASE_URL=(https://[^\s"''}]+)',
    '(https://[a-zA-Z0-9.-]+(?:\.trycloudflare\.com|\.ngrok-free\.(?:app|dev)))'
  )
  foreach ($pattern in $patterns) {
    if ($Text -match $pattern) { return $Matches[1] }
  }
  return $null
}

Write-Host "Waiting for Kaggle kernel URL: $KernelSlug" -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
$ollamaUrl = $null

while ((Get-Date) -lt $deadline) {
  $statusText = (& kaggle kernels status $KernelSlug 2>&1) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to run 'kaggle kernels status'. Check Kaggle CLI authentication.`n$statusText"
  }

  $status = if ($statusText -match 'status "([^"]+)"') { $Matches[1] } else { "unknown" }
  Write-Host "$(Get-Date -Format 'HH:mm:ss') kernel status: $status" -ForegroundColor Yellow

  if ($status -in @("KernelWorkerStatus.ERROR", "KernelWorkerStatus.CANCEL_ACKNOWLEDGED", "KernelWorkerStatus.CANCELED")) {
    $finalLogs = (& kaggle kernels logs $KernelSlug 2>&1) -join "`n"
    Write-Host $finalLogs
    throw "Kaggle kernel ended with status $status."
  }

  $logs = (& kaggle kernels logs $KernelSlug 2>&1) -join "`n"
  $ollamaUrl = Get-TunnelUrlFromText $logs
  if ($ollamaUrl) { break }

  Start-Sleep -Seconds $PollSeconds
}

if (-not $ollamaUrl) {
  throw "Timed out waiting for OLLAMA_BASE_URL in Kaggle logs."
}

$env:OLLAMA_BASE_URL = $ollamaUrl.TrimEnd('/')
$env:OLLAMA_NGROK_SKIP_BROWSER_WARNING = if ($env:OLLAMA_BASE_URL -match '\.ngrok-free\.(app|dev)$') { "1" } else { "0" }
$env:OLLAMA_PROVIDER_API_KEY = $ProviderApiKey
$env:PROXY_PORT = [string]$ProxyPort
$env:PROXY_BIND = $ProxyBind

Write-Host "Found Ollama upstream: $env:OLLAMA_BASE_URL" -ForegroundColor Green
Write-Host "Starting provider proxy..." -ForegroundColor Cyan
Write-Host "Client base URL: http://127.0.0.1:$ProxyPort/ollama/v1"
Write-Host "Client API key: $ProviderApiKey"

node $proxy
