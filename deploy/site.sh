#!/usr/bin/env bash
# Build the copy of redo served at mark-schachner.com/redo, put it in the site repo's redo/
# folder, and commit and push it; GitHub Pages does the rest (npm run deploy:site).
#   SITE=path    the site repo (default ~/code/projects/site)
#   SERVER=url   the multiplayer server the page joins (default cuboid, through Tailscale Funnel)
# The page and the server must be the same build, so npm run deploy updates both.
set -euo pipefail
site="${SITE:-$HOME/code/projects/site}"
server="${SERVER:-https://cuboid.tail8d71a5.ts.net}"
cd "$(dirname "$0")/.."

npm install --no-audit --no-fund
npx tsc --noEmit
REDO_BASE=/redo/ VITE_REDO_SERVER="$server" npx vite build --outDir dist-site --emptyOutDir

git -C "$site" pull --ff-only -q
rsync -a --delete dist-site/ "$site/redo/"
git -C "$site" add redo
if git -C "$site" diff --cached --quiet -- redo; then
  echo "mark-schachner.com/redo is already up to date"
  exit 0
fi
git -C "$site" commit -q -m "Deploy redo" -- redo
git -C "$site" push -q
echo "pushed: https://mark-schachner.com/redo/ updates once GitHub Pages rebuilds (a minute or so)"
