#requires -Version 5.1
# Tail logs for the stack
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
docker compose logs -f --tail=100 nginx redis coordinator-prepare k6
