# One-time setup of the OpenStack CLI used to manage cloudify.ro / Acvile infrastructure.
# Creates .openstack-venv/ (gitignored) and installs python-openstackclient into it.
#
#   powershell -File scripts/os-setup.ps1
#
# Verify afterwards:
#   .\.openstack-venv\Scripts\openstack.exe --version
#   bash scripts/os.sh token issue

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.openstack-venv'

if (-not (Test-Path $venv)) {
    py -3.13 -m venv $venv          # 3.13: newest interpreter openstackclient 10.x fully supports
}

$py = Join-Path $venv 'Scripts\python.exe'
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet python-openstackclient

& (Join-Path $venv 'Scripts\openstack.exe') --version
