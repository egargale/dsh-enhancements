#!/usr/bin/env bash
# sync-skills.sh — re-sync DSH skills into \$DSH_HOME/skills (default: ~/.dsh/skills)
#
# Manages two sets of skills in the user-dsh skill root:
#
#   1. deep-research enhancement — copied from ./deep-research (this repo)
#      (research, research-add-items, research-add-fields, research-deep,
#       research-report, deep-research-agent) — copied verbatim.
#
#   2. Matt Pocock skill shadows — copied from \$DSH_AGENTS_HOME/skills with the
#      `disable-model-invocation: true` frontmatter marker STRIPPED, so the
#      copies become model-invocable in DSH without ever touching the originals
#      (which keep working for Claude Code / Codex / other agents).
#
# Only the dirs listed below are ever created/removed in the destination —
# unrelated skill dirs are left alone.
#
# Usage:
#   ./sync-skills.sh                 sync both sets
#   ./sync-skills.sh --deep          only the deep-research set
#   ./sync-skills.sh --matt          only the Matt shadows
#   ./sync-skills.sh --dry-run       print what would change, write nothing
#   ./sync-skills.sh --help
#
# Env: DSH_HOME (default ~/.dsh), DSH_AGENTS_HOME (default ~/.agents)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deep-research"
AGENTS_HOME="${DSH_AGENTS_HOME:-$HOME/.agents}"
DEST="${DSH_HOME:-$HOME/.dsh}/skills"

DEEP_SKILLS=(research research-add-items research-add-fields research-deep research-report deep-research-agent)
MATT_SKILLS=(ask-matt grill-me grill-with-docs handoff implement improve-codebase-architecture loop-me setup-matt-pocock-skills teach to-spec to-tickets triage wayfinder)

do_deep=false
do_matt=false
dry=false

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deep) do_deep=true; shift ;;
    --matt) do_matt=true; shift ;;
    --dry-run|-n) dry=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ $do_deep == false && $do_matt == false ]]; then do_deep=true; do_matt=true; fi

echo "target root: $DEST"

copy_dir() { # src dst
  local src="$1" dst="$2"
  if [[ ! -f "$src/SKILL.md" ]]; then
    echo "  [skip] missing source: $src"
    return 1
  fi
  if [[ $dry == true ]]; then
    echo "  [dry] would replace $dst"
    return 0
  fi
  rm -rf "$dst"
  cp -R "$src" "$dst"
  echo "  [ok]   $dst"
}

strip_model_marker() { # dst (SKILL.md path inside the copied dir)
  local f="$1/SKILL.md"
  if [[ $dry == true ]]; then return 0; fi
  if grep -q '^disable-model-invocation:' "$f"; then
    sed -i '/^disable-model-invocation:/d' "$f"
    echo "  [strip] $f"
  fi
}

if [[ $do_deep == true ]]; then
  echo "== deep-research enhancement (from $REPO_DIR)"
  [[ -d "$REPO_DIR" ]] || { echo "ERROR: repo skills dir not found: $REPO_DIR" >&2; exit 1; }
  for s in "${DEEP_SKILLS[@]}"; do
    copy_dir "$REPO_DIR/$s" "$DEST/$s"
  done
fi

if [[ $do_matt == true ]]; then
  echo "== Matt Pocock shadows (from $AGENTS_HOME/skills, marker stripped)"
  [[ -d "$AGENTS_HOME/skills" ]] || { echo "ERROR: agents skills dir not found: $AGENTS_HOME/skills" >&2; exit 1; }
  for s in "${MATT_SKILLS[@]}"; do
    if copy_dir "$AGENTS_HOME/skills/$s" "$DEST/$s"; then
      strip_model_marker "$DEST/$s"
    fi
  done
fi

echo
echo "== verification"
missing=0
for s in "${DEEP_SKILLS[@]}" "${MATT_SKILLS[@]}"; do
  if [[ ! -f "$DEST/$s/SKILL.md" ]]; then
    echo "  [MISSING] $s" >&2; missing=1
  fi
done
if [[ $dry == false ]]; then
  leftover=$(grep -l '^disable-model-invocation:' "$DEST"/*/SKILL.md 2>/dev/null | wc -l | tr -d ' ')
  echo "  skills with leftover marker: $leftover"
fi
[[ $missing == 0 ]] && echo "  all managed skills present in $DEST"
echo
echo "DSH picks up skill changes without a restart (watched roots, live catalog refresh);"
echo "start a new session to see the updated <available_skills> catalog."
