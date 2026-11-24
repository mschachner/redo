#!/usr/bin/env bash
# Start the shared world on cuboid over from a new seed (npm run reset-world -- SEED).
#   HOST=name   a server other than cuboid
# The current world (everyone's changes and kept states) is set aside in /srv/redo/data as
# world-<date>.json, not deleted; to go back, stop the server and move it back to world.json.
# You'll be asked for your sudo password on cuboid.
set -euo pipefail
host="${HOST:-cuboid}"
seed="${1:-}"
if [[ ! "$seed" =~ ^[a-z]+(-[a-z]+)*$ ]]; then
  echo "usage: npm run reset-world -- some-kebab-case-seed" >&2
  exit 1
fi
ssh -t "$host" "seed='$seed' bash -s" <<'REMOTE'
set -euo pipefail
sudo systemctl stop redo # saves the world first
if [[ -e /srv/redo/data/world.json ]]; then
  kept="/srv/redo/data/world-$(date +%Y%m%d-%H%M%S).json"
  sudo mv /srv/redo/data/world.json "$kept"
  echo "old world kept as $kept"
fi
# The seed goes in /etc/default/redo, beside any other settings there (like PASSWORD).
sudo touch /etc/default/redo
sudo sed -i '/^SEED=/d' /etc/default/redo
echo "SEED=$seed" | sudo tee -a /etc/default/redo >/dev/null
sudo systemctl start redo
sleep 2
systemctl is-active redo
journalctl -u redo -n 2 --no-pager -o cat
REMOTE
