#!/usr/bin/env bash
# OSWALD periodic update — sync fork with upstream pob-web + pack new PoE2 releases.
# Run by oswald-update.timer (weekly). Safe to run manually. Fails = keep current version.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
LOG() { echo "[$(date -Iseconds)] $*"; }

LOG "=== OSWALD update start ==="

# 1. Sync fork branches with upstream pob-web
git fetch upstream
git checkout main
git merge --ff-only upstream/main && git push origin main || LOG "main: nothing to fast-forward or push failed"
git checkout oswald
if ! git merge --no-edit main; then
  git merge --abort
  LOG "ERROR: merge conflict with upstream — resolve manually"; exit 1
fi

# 2. Check latest PoE2 release upstream
LATEST=$(gh api repos/PathOfBuildingCommunity/PathOfBuilding-PoE2/releases/latest --jq .tag_name)
LOG "latest PoE2 release: $LATEST"

# 3. Pack if we don't have it yet
if [ ! -d "packages/packer/r2/games/poe2/versions/$LATEST" ]; then
  LOG "packing $LATEST"
  mise run install
  mise run pack --game poe2 --tag "$LATEST"
  # add to version.json manifest if upstream bot hasn't yet
  if ! grep -q "\"$LATEST\"" version.json; then
    node -e '
      const fs = require("fs");
      const [tag] = process.argv.slice(1);
      const v = JSON.parse(fs.readFileSync("version.json", "utf8"));
      v.poe2.head = tag;
      v.poe2.versions.unshift({ value: tag, date: new Date().toISOString() });
      fs.writeFileSync("version.json", JSON.stringify(v, null, 2));
    ' "$LATEST"
    LOG "version.json: added $LATEST as head"
  fi
fi

# 4. Rebuild + restart if anything changed since last build
mise run install
mise run driver:build
OSWALD_ASSET_PREFIX=/pack mise run web:build
systemctl --user restart oswald
LOG "=== OSWALD update done — serving $LATEST ==="
