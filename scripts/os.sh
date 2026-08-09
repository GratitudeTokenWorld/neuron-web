#!/usr/bin/env bash
# Thin wrapper: source the OpenStack credentials and run the CLI from the local venv.
#
#   ./scripts/os.sh flavor list
#   ./scripts/os.sh server create ...
#
# Requires: lucian.openrc (gitignored) + .openstack-venv (created by scripts/os-setup.ps1).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RC="${OPENRC:-$ROOT/lucian.openrc}"
CLI="$ROOT/.openstack-venv/Scripts/openstack.exe"          # Windows venv layout
[ -x "$CLI" ] || CLI="$ROOT/.openstack-venv/bin/openstack"  # POSIX venv layout

[ -f "$RC" ] || { echo "missing credentials file: $RC" >&2; exit 1; }
[ -x "$CLI" ] || { echo "missing openstack CLI: run scripts/os-setup.ps1 first" >&2; exit 1; }

set -a; source "$RC"; set +a
exec "$CLI" "$@"
