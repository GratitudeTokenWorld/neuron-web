<#
.SYNOPSIS
  PowerShell twin of scripts/os.sh — source the OpenStack credentials and run
  the CLI from the local venv.

.DESCRIPTION
  PowerShell is this repo's primary shell, and `os.sh` needs bash. On a Windows
  box without a WSL distro, `./scripts/os.sh …` runs NOTHING AND SAYS NOTHING —
  PowerShell has no handler for a .sh file — while `bash scripts/os.sh …`
  resolves to WSL's bash and dies with `execvpe(/bin/bash) failed`. Three
  security-group rules were silently not created that way (2026-08-16).

  Same contract as os.sh: reads lucian.openrc (gitignored) and execs the venv's
  openstack.exe with whatever arguments you pass.

.EXAMPLE
  .\scripts\os.ps1 server list

.EXAMPLE
  .\scripts\os.ps1 security group rule create --ingress --protocol udp `
    --dst-port 3478:3478 --remote-ip 0.0.0.0/0 neuron-relay
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$rc = if ($env:OPENRC) { $env:OPENRC } else { Join-Path $root 'lucian.openrc' }
$cli = Join-Path $root '.openstack-venv\Scripts\openstack.exe'

if (-not (Test-Path $rc)) {
  Write-Error "missing credentials file: $rc"
}
if (-not (Test-Path $cli)) {
  Write-Error "missing openstack CLI: run scripts/os-setup.ps1 first"
}

# lucian.openrc is a shell file of `export NAME=value` lines. Parse rather than
# invoke it — quotes are stripped, and nothing else in it is executed.
foreach ($line in Get-Content $rc) {
  if ($line -match '^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and (
          ($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$($Matches[1])" -Value $value
  }
}

if (-not $Args -or $Args.Count -eq 0) {
  Write-Host 'usage: .\scripts\os.ps1 <openstack args…>   e.g.  .\scripts\os.ps1 server list'
  exit 1
}

& $cli @Args
exit $LASTEXITCODE
