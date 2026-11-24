#!/usr/bin/env bash
# Build redo on this Mac and install it on cuboid as the redo service (npm run deploy).
#   HOST=name   deploy somewhere other than cuboid
#   SEED=words  the seed for the world, if the server doesn't have one yet
# You'll be asked for your sudo password on cuboid.
set -euo pipefail
host="${HOST:-cuboid}"
cd "$(dirname "$0")/.."

npm install --no-audit --no-fund
npm run build
ssh "$host" 'mkdir -p ~/redo-release'
rsync -a --delete dist/ "$host:redo-release/dist/"
rsync -a dist-server/server.mjs deploy/redo.service deploy/install.sh "$host:redo-release/"
ssh -t "$host" "SEED='${SEED:-}' bash ~/redo-release/install.sh"
echo "redo is up at http://$host:8787"
