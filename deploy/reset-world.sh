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
cd "$(dirname "$0")/.."
# The steps run from a file copied over first, so sudo has the terminal to ask for a password.
ssh "$host" 'mkdir -p ~/redo-release'
rsync -a deploy/reset-remote.sh "$host:redo-release/"
ssh -t "$host" "seed='$seed' bash ~/redo-release/reset-remote.sh"
