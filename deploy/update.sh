#!/usr/bin/env bash
# Updates the caster on the VM to the latest version in the repo. Keeps the config, logins and history.
#   cd ~/Connect-NTRIP && bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo rsync -a --delete --exclude node_modules --exclude data caster/ /opt/connect-ntrip/caster/
(cd /opt/connect-ntrip/caster && sudo npm install --omit=dev --no-audit --no-fund --silent)
sudo systemctl restart connect-ntrip
sleep 2
if systemctl is-active --quiet connect-ntrip; then
  echo "Caster updated and running."
else
  echo "The caster did not start. Last log lines:"
  sudo journalctl -u connect-ntrip -n 30 --no-pager
  exit 1
fi
