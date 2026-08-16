#!/usr/bin/env bash
# Copy the quick-mode renderer assets from the skill bundle into this plugin.
# Run after updating the skill's quick/ directory.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../../visual-explainer/visual-explainer/quick" && pwd)"
DST="$(cd "$(dirname "$0")/.." && pwd)/src/assets"
cp "$SRC/render.mjs" "$SRC/base.css" "$SRC/schema.json" "$DST/"
echo "synced quick assets from $SRC to $DST"
