#!/usr/bin/env bash
# Link the DSH runtime packages into this plugin's node_modules.
#
# The plugin imports @deepseek-ai/cordis, @deepseek-ai/dsh-tools, and
# @deepseek-ai/dsh-llm as peers: DSH provides them at load time. For local
# typechecking, unit tests, and `dsh headless --patch` runs the bare specifiers
# still have to resolve from this directory, so we symlink them out of an
# existing DSH install instead of duplicating it.
#
# Usage:
#   bash scripts/link-dsh-deps.sh [path-to-dsh-install]
#
# Default install path: the global bun install used by the `dsh` on PATH.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_INSTALL="$(dirname "$(dirname "$(command -v dsh)")")/install/global"
INSTALL_DIR="${1:-$DEFAULT_INSTALL}"

if [[ ! -d "$INSTALL_DIR/node_modules/@deepseek-ai" ]]; then
  echo "error: no @deepseek-ai packages under $INSTALL_DIR/node_modules" >&2
  echo "usage: $0 [path-to-dsh-install]" >&2
  exit 1
fi

SCOPE_DIR="$PLUGIN_DIR/node_modules/@deepseek-ai"
mkdir -p "$SCOPE_DIR"
for pkg in cordis dsh-tools dsh-llm dsh-util-values schemastery dsh-session dsh-agent dsh-web; do
  src="$INSTALL_DIR/node_modules/@deepseek-ai/$pkg"
  [[ -d "$src" ]] || continue
  dest="$SCOPE_DIR/$pkg"
  # `ln -sfn` does NOT replace an existing real directory: it creates the link
  # *inside* it (`.../cordis/cordis`) and the installed package keeps winning
  # resolution while `set -e` reports success. Remove the stale target first,
  # after asserting it is inside this plugin's own node_modules scope.
  case "$dest" in
    "$SCOPE_DIR"/*) ;;
    *) echo "refusing to replace $dest: outside $SCOPE_DIR" >&2; exit 1 ;;
  esac
  if [[ -e "$dest" && ! -L "$dest" ]]; then
    echo "replacing the installed directory $dest with a link to $src"
    rm -rf "$dest"
  fi
  ln -sfnT "$src" "$dest"
  echo "linked @deepseek-ai/$pkg -> $(readlink -f "$dest")"
done

# `schemastery` is a separate scope-adjacent package used by DSH plugins.
if [[ -d "$INSTALL_DIR/node_modules/@deepseek-ai/schemastery" ]]; then
  ln -sfn "$INSTALL_DIR/node_modules/@deepseek-ai/schemastery" "$PLUGIN_DIR/node_modules/schemastery"
  echo "linked schemastery"
fi

echo "done: $PLUGIN_DIR/node_modules"
