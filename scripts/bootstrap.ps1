#requires -Version 5.1
# Bootstrap: register USER_COUNT users (idempotent). Run once per environment.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[bootstrap.ps1] Bringing up nginx..." -ForegroundColor Cyan
docker compose up -d nginx

Write-Host "[bootstrap.ps1] Building image (cached if no source changes)..." -ForegroundColor Cyan
docker compose --profile bootstrap build bootstrap

Write-Host "[bootstrap.ps1] Running bootstrap..." -ForegroundColor Cyan
docker compose --profile bootstrap run --rm bootstrap
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
  Write-Host "[bootstrap.ps1] FAILED (exit $exitCode)" -ForegroundColor Red
  exit $exitCode
}

Write-Host "[bootstrap.ps1] OK." -ForegroundColor Green
