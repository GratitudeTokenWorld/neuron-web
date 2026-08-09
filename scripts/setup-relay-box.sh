#!/bin/bash
# Provision a fresh Ubuntu box (26.04 preferred) as a Neuron super-node relay (archive + attester).
#
# Run ON the box (as root, or a sudoer):
#   curl -fsSL https://raw.githubusercontent.com/GratitudeTokenWorld/neuron-web/main/scripts/setup-relay-box.sh | sudo bash
# or copy it over:
#   scp -i ~/.ssh/neuron-ops scripts/setup-relay-box.sh ubuntu@<IP>:/tmp/ && ssh -i ~/.ssh/neuron-ops ubuntu@<IP> "sudo bash /tmp/setup-relay-box.sh"
#
# After BOTH boxes run this, federate them (each must list the other):
#   ssh box1:  echo 'export PEER_RELAYS=/ip4/<IP2>/tcp/9091/p2p/<peerId2>' >> ~/.relay-env
#   ssh box2:  echo 'export PEER_RELAYS=/ip4/<IP1>/tcp/9091/p2p/<peerId1>' >> ~/.relay-env
#   on each :  source ~/.relay-env && pm2 restart neuron-relay --update-env
# (peerIds: curl http://<IP>:9092/relay-info)
#
# Idempotent: safe to re-run. The relay runs as the invoking non-root user
# (default: ubuntu) under pm2; identity/state lives in ~/neuron-web/.relay-*.json.
set -euo pipefail

RELAY_USER="${RELAY_USER:-ubuntu}"
RELAY_HOME="$(getent passwd "$RELAY_USER" | cut -d: -f6)"
REPO_DIR="$RELAY_HOME/neuron-web"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl ca-certificates

# Node 26 = newest release line (LTS from Oct 2026). Rule: newest patched Node,
# 0 high/critical vulns on the boxes. NOT 25 (odd line, EOL mid-2026, unpatched).
# libp2p v3 / tsx need >=20, so 24 LTS is the fallback if 26 ever misbehaves.
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 26 ]; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
  apt-get install -y nodejs
  npm install -g pm2   # global modules don't survive the nodejs package swap
fi
npm install -g pm2

# file-descriptor headroom for libp2p (SUPERNODE.md → Operational hardening #3)
grep -q "nofile  65535" /etc/security/limits.conf || cat >> /etc/security/limits.conf <<EOF
$RELAY_USER  soft  nofile  65535
$RELAY_USER  hard  nofile  65535
EOF

# clone / update + install as the relay user.
# checkout -- package-lock.json first: a locally-rewritten lockfile silently
# aborts `git pull` (bit us 2026-08-09); `npm ci` instead of `npm install` so the
# lockfile is never rewritten on the box (exact reproducible tree, prunes removed deps).
if [ ! -d "$REPO_DIR/.git" ]; then
  sudo -u "$RELAY_USER" -H git clone https://github.com/GratitudeTokenWorld/neuron-web.git "$REPO_DIR"
else
  sudo -u "$RELAY_USER" -H git -C "$REPO_DIR" checkout -- package-lock.json 2>/dev/null || true
  sudo -u "$RELAY_USER" -H git -C "$REPO_DIR" pull --ff-only
fi
cd "$REPO_DIR"
sudo -u "$RELAY_USER" -H npm ci

# relay env: PEER_RELAYS is added to ~/.relay-env AFTER both boxes exist
# (needs the other box's peerId). Sourced by .profile so pm2 inherits it.
sudo -u "$RELAY_USER" -H bash -c "touch $RELAY_HOME/.relay-env"
sudo -u "$RELAY_USER" -H grep -q '.relay-env' "$RELAY_HOME/.profile" || \
  sudo -u "$RELAY_USER" -H bash -c "echo '[ -f ~/.relay-env ] && . ~/.relay-env' >> $RELAY_HOME/.profile"

# start under pm2 + survive reboot (2 GB box → 1.5G leak backstop)
sudo -u "$RELAY_USER" -H bash -c "cd $REPO_DIR && . $RELAY_HOME/.relay-env; RELAY_MAX_MEMORY=1500M pm2 start ecosystem.config.cjs || pm2 restart neuron-relay --update-env; pm2 save"
env PATH="$PATH" pm2 startup systemd -u "$RELAY_USER" --hp "$RELAY_HOME" | tail -1 | bash || true

# log rotation backstop (SUPERNODE.md → Operational hardening #1)
sudo -u "$RELAY_USER" -H pm2 install pm2-logrotate || true
sudo -u "$RELAY_USER" -H pm2 set pm2-logrotate:max_size 50M
sudo -u "$RELAY_USER" -H pm2 set pm2-logrotate:retain 10
sudo -u "$RELAY_USER" -H pm2 set pm2-logrotate:compress true

echo "── relay up ──"
sleep 3
curl -s http://localhost:9092/relay-info || true
echo
echo "peerId + multiaddrs above. Open ports 9090-9092/tcp (+22) in the cloud firewall."
