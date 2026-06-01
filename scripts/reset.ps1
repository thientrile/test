#requires -Version 5.1
# Cleanup: drop test bookkeeping + (optionally) real user/room rows.
# Pass -DryRun to preview without deleting.

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$args = @()
if ($DryRun) {
  Write-Host "[reset.ps1] DRY RUN — no deletes" -ForegroundColor Yellow
  $args = @('--dry')
}

docker compose --profile reset build reset

docker compose --profile reset run --rm reset node scripts/reset.js @args
exit $LASTEXITCODE
