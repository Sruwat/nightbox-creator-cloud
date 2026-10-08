param(
  [switch]$Bots
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "appcode\nightbox\backend"
$Telegram = Join-Path $Root "appcode\nightbox\telegram-bots"
$Logs = Join-Path $Root ".local-logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Test-Port([int]$Port) {
  return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-LocalProcess([string]$Name, [string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  $stdout = Join-Path $Logs "$Name.out.log"
  $stderr = Join-Path $Logs "$Name.err.log"
  Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden | Out-Null
}

if (-not (Test-Port 3000)) {
  Start-LocalProcess "backend" "node" @("server.js") $Backend
}
if (-not (Test-Port 4173)) {
  Start-LocalProcess "web" "npm.cmd" @("run", "dev:web", "--", "--host", "127.0.0.1") $Root
}
if (-not (Test-Port 4174)) {
  Start-LocalProcess "admin" "npm.cmd" @("run", "dev:admin", "--", "--host", "127.0.0.1") $Root
}

if ($Bots) {
  $envFile = Join-Path $Telegram ".env"
  if (-not (Test-Path $envFile)) {
    throw "Telegram .env is missing. Copy .env.example and configure bot tokens first."
  }
  $tokenNames = @(
    "TELEGRAM_BOT_TOKEN_UPLOAD",
    "TELEGRAM_BOT_TOKEN_CONVERT",
    "TELEGRAM_BOT_TOKEN_HIDER",
    "TELEGRAM_BOT_TOKEN_MAIN",
    "TELEGRAM_BOT_TOKEN_VIDEOS_UPLOAD",
    "TELEGRAM_BOT_TOKEN_TERABOX",
    "TELEGRAM_BOT_TOKEN_DISKWALA",
    "TELEGRAM_BOT_TOKEN_FLEZIN",
    "TELEGRAM_BOT_TOKEN_VIDBUNKER"
  )
  $configured = Get-Content $envFile | Where-Object {
    $line = $_
    $tokenNames | Where-Object { $line -match "^$($_)=\S+" }
  }
  if (-not $configured) {
    throw "No Telegram bot token is configured in $envFile"
  }
  Start-LocalProcess "telegram-upload" "python" @("upload_bot.py") $Telegram
}

Start-Sleep -Seconds 2
Write-Output "NightBox local services:"
Write-Output "  Website: http://127.0.0.1:4173"
Write-Output "  Admin:   http://127.0.0.1:4174/admin/login"
Write-Output "  Backend: http://127.0.0.1:3000/health"
if ($Bots) { Write-Output "  Telegram upload bot: started when its token is configured" }
