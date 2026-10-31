#!/usr/bin/env bash
# One-time setup for an Ubuntu 22.04/24.04 VM. Run from the repo root as a sudo-capable user:
#   sudo DOMAIN=caster.example.com bash deploy/setup-ubuntu.sh
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN to the caster DNS name, e.g. DOMAIN=caster.example.com}"
NTRIP_PORT="${NTRIP_PORT:-2101}"

echo "==> Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v2[2-9]* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy (TLS reverse proxy for the dashboard)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "==> Service user and folders"
apt-get install -y rsync
id ntrip >/dev/null 2>&1 || useradd --system --home /var/lib/connect-ntrip --shell /usr/sbin/nologin ntrip
mkdir -p /opt/connect-ntrip /etc/connect-ntrip /var/lib/connect-ntrip
rsync -a --delete --exclude node_modules --exclude data caster/ /opt/connect-ntrip/caster/
(cd /opt/connect-ntrip/caster && npm install --omit=dev --no-audit --no-fund)
if [[ ! -f /etc/connect-ntrip/config.json ]]; then
  sed "s/caster.example.com/${DOMAIN}/" caster/config.example.json > /etc/connect-ntrip/config.json
  echo "    Created /etc/connect-ntrip/config.json: EDIT the source passwords and adminEmails before going live."
fi
chown -R ntrip:ntrip /var/lib/connect-ntrip
chown root:ntrip /etc/connect-ntrip/config.json && chmod 640 /etc/connect-ntrip/config.json

echo "==> systemd"
cp deploy/connect-ntrip.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now connect-ntrip

echo "==> Caddy site"
sed "s/caster.example.com/${DOMAIN}/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall (ufw)"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow "${NTRIP_PORT}/tcp"
  ufw --force enable
fi

echo
echo "Done. Also open TCP ${NTRIP_PORT}, 80 and 443 in your cloud provider's network security group."
echo "Check:  systemctl status connect-ntrip   |   journalctl -u connect-ntrip -f"
echo "Dashboard health: https://${DOMAIN}/api/health"
