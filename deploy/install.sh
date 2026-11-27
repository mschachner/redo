#!/usr/bin/env bash
# Runs on cuboid (deploy/cuboid.sh copies it there with the build): installs the build in
# ~/redo-release as the redo service. The first run also installs Node, makes the redo
# system user and /srv/redo, and enables the service. The world in /srv/redo/data is
# never touched.
set -euo pipefail
release="$HOME/redo-release"

if ! PATH=/usr/local/bin:/usr/bin command -v node >/dev/null; then
  echo "== installing Node"
  sudo apt-get update -q
  sudo apt-get install -y -q nodejs
fi

if ! id redo >/dev/null 2>&1; then
  echo "== making the redo user"
  sudo useradd --system --home-dir /srv/redo --no-create-home --shell /usr/sbin/nologin redo
fi
sudo install -d -m 755 /srv/redo
sudo install -d -m 750 -o redo -g redo /srv/redo/data

# A seed given to the deploy is kept for the server's first start, if there's no world yet.
# (Only the redo user can look in /srv/redo/data, so the check needs sudo.)
if [[ -n "${SEED:-}" ]] && ! sudo test -e /srv/redo/data/world.json; then
  sudo touch /etc/default/redo
  sudo sed -i '/^SEED=/d' /etc/default/redo
  echo "SEED=$SEED" | sudo tee -a /etc/default/redo >/dev/null
fi

echo "== installing the build"
sudo rsync -a --delete "$release/dist/" /srv/redo/dist/
sudo install -m 644 "$release/server.mjs" /srv/redo/server.mjs
sudo install -m 644 "$release/redo.service" /etc/systemd/system/redo.service
sudo systemctl daemon-reload
sudo systemctl enable --quiet redo
sudo systemctl restart redo

# The server is reached from outside at https://redo.mark-schachner.com, through Caddy and
# the Cloudflare tunnel on cuboid (set up outside this repo).

sleep 2
systemctl is-active redo
journalctl -u redo -n 4 --no-pager -o cat
