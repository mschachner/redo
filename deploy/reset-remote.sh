#!/usr/bin/env bash
# Runs on cuboid (deploy/reset-world.sh copies it there): starts the shared world over from
# the seed in $seed, keeping the old world file.
set -euo pipefail
sudo systemctl stop redo # saves the world first
# Only the redo user can look in /srv/redo/data, so the check needs sudo too.
if sudo test -e /srv/redo/data/world.json; then
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
