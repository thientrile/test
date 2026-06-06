#requires -Version 5.1
# k6 load test on Docker — no local k6 needed.
#
#   prepare (room + users.csv + room.json) → k6 run → build report → open HTML
#
# Modes (set $env:MODE):
#   rate (default)  — constant-arrival-rate RATE msg/s for DURATION. Đo kết quả
#                     thực tế: % tin gửi thành công + độ trễ giao tin ở tải thật.
#   burst           — USER_COUNT VUs send a message at the SAME instant
#                     (đánh giá sức chịu tải đỉnh khi N người gửi cùng lúc).
#
# "Gửi thành công" = nhận message:upsert echo ≤ DELIVER_WINDOW_MS (giống FE).
#
# Examples:
#   .\scripts\run-test.ps1                                  # rate, từ .env
#   $env:MODE='rate'; $env:RATE=50; $env:DURATION='60s'; .\scripts\run-test.ps1
#   $env:MODE='burst'; $env:USER_COUNT=500; .\scripts\run-test.ps1  # burst đỉnh

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$Mode    = if ($env:MODE)       { $env:MODE }       else { 'rate' }
$RunId   = Get-Date -Format 'yyyyMMdd-HHmmss'
$report  = Join-Path $root 'k6\reports\index.html'

# Per-run env forwarded into the k6 container (only those that are set on the
# host; otherwise the value in .env applies via env_file).
$k6Env = @('-e', "MODE=$Mode", '-e', "RUN_ID=$RunId")
foreach ($v in 'USER_COUNT','RAMP_DURATION','CONNECT_MARGIN_MS','THINK_AFTER_GO','MSGS_PER_VU','MSG_INTERVAL_MS','RATE','DURATION','PRE_VUS','MAX_VUS','SEND_EVENT','DELIVER_WINDOW_MS','REQUEST_ACK') {
  $val = [Environment]::GetEnvironmentVariable($v)
  if ($val) { $k6Env += @('-e', "$v=$val") }
}

# Prepare-only toggles (docker compose run doesn't inherit host env — forward).
$prepEnv = @()
foreach ($v in 'REFRESH_TOKENS','FRESH_ROOM','REFRESH_CONCURRENCY','ROOM_SIZE','ROOM_CONCURRENCY','USER_COUNT') {
  $val = [Environment]::GetEnvironmentVariable($v)
  if ($val) { $prepEnv += @('-e', "$v=$val") }
}

Write-Host "[run-test] mode=$Mode runId=$RunId" -ForegroundColor Cyan

Write-Host "[run-test] up nginx + redis..." -ForegroundColor Cyan
docker compose up -d nginx redis

Write-Host "[run-test] build node image (prepare/report)..." -ForegroundColor Cyan
docker compose --profile test build coordinator-prepare

Write-Host "[run-test] prepare (room + k6/users.csv + k6/room.json)..." -ForegroundColor Cyan
docker compose --profile test run --rm @prepEnv coordinator-prepare
if ($LASTEXITCODE -ne 0) {
  Write-Host "[run-test] prepare failed (exit=$LASTEXITCODE), aborting." -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host "[run-test] k6 run ($Mode)..." -ForegroundColor Cyan
docker compose --profile test run --rm @k6Env k6
$exitCode = $LASTEXITCODE
Write-Host "[run-test] k6 finished (exit=$exitCode)" -ForegroundColor Cyan

Write-Host "[run-test] build HTML report..." -ForegroundColor Cyan
docker compose --profile test run --rm coordinator-prepare node scripts/build-report.js

if (Test-Path $report) {
  Write-Host "[run-test] opening $report" -ForegroundColor Green
  Start-Process $report
} else {
  Write-Host "[run-test] report not found at $report" -ForegroundColor Yellow
}

Write-Host "[run-test] cleaning up one-off containers (nginx/redis stay up)..." -ForegroundColor Cyan
docker compose --profile test rm -fsv k6 coordinator-prepare 2>$null | Out-Null

exit $exitCode
