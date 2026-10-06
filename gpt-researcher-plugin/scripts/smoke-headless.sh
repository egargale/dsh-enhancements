#!/usr/bin/env bash
# End-to-end smoke test: boot DSH headless with this plugin mounted and make the
# model actually call its tools.
#
#   bash scripts/smoke-headless.sh                     # capabilities + quick search
#   GPTR_SMOKE_FULL=1 bash scripts/smoke-headless.sh    # also a full gptr_research run
#
# This is the only test that proves the plugin loads in a real harness process,
# registers its tools with the live tool registry, and reaches a real model and
# the deployment's real search provider. It runs headless with `--json` so the
# assertions read the actual tool results rather than the model's summary.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ENTRY="$PLUGIN_DIR/dist/index.js"
PATCH_TEMPLATE="$PLUGIN_DIR/test/dsh/smoke-headless.patch.yml"
WORK_DIR="${GPTR_SMOKE_DIR:-$PLUGIN_DIR/.smoke}"

if [[ ! -f "$DIST_ENTRY" ]]; then
  echo "error: $DIST_ENTRY is missing — run: npm run build" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
# `&` and `#` are special in a sed replacement, so escape them (a home directory
# containing `&` used to leave the placeholder in place and fail confusingly).
escape_sed() { printf '%s' "$1" | sed -e 's/[&#\\]/\\&/g'; }
sed -e "s#__ENTRY__#$(escape_sed "$DIST_ENTRY")#" \
  -e "s#__OUTPUT_DIR__#$(escape_sed "$WORK_DIR/reports")#" \
  "$PATCH_TEMPLATE" > "$WORK_DIR/smoke.patch.yml"
if grep -q '__ENTRY__\|__OUTPUT_DIR__' "$WORK_DIR/smoke.patch.yml"; then
  echo "error: could not substitute the smoke patch placeholders" >&2
  exit 1
fi

# Run one headless task and print the NDJSON run events. stderr is captured into
# the event stream so an auth/provider failure is visible instead of surfacing
# only as "missing: <string>".
run_dsh() {
  local task="$1"
  ( cd "$WORK_DIR" && dsh --profile headless --patch "$WORK_DIR/smoke.patch.yml" --json "$task" 2>&1 )
}

fail=0
check() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "  ok   $label"
  else
    echo "  FAIL $label (missing: $needle)" >&2
    fail=1
  fi
}

echo "== 1/3 gptr_capabilities (no extra model tokens, no network) =="
out="$(run_dsh "Call the gptr_capabilities tool with no arguments, then reply with just 'SMOKE_CAPS_DONE'." || true)"
check "gptr_capabilities was called" "$out" '"tool":"gptr_capabilities"'
check "the call completed" "$out" '"status":"completed"'
check "capabilities listed usable retrievers" "$out" 'usable retrievers:'
check "the deployment search provider is usable" "$out" 'dsh_web'
check "the turn finished" "$out" 'SMOKE_CAPS_DONE'

echo "== 2/3 gptr_quick_search (one real search through the deployment provider) =="
out="$(run_dsh "Use the gptr_quick_search tool with query \"DeepSeek Harness\" and max_results 3 and aggregated_summary false, then reply with just 'SMOKE_SEARCH_DONE'." || true)"
check "gptr_quick_search was called" "$out" '"tool":"gptr_quick_search"'
check "the search returned sources" "$out" 'Sources ('
check "the turn finished" "$out" 'SMOKE_SEARCH_DONE'

if [[ "${GPTR_SMOKE_FULL:-0}" == "1" ]]; then
  echo "== 3/3 gptr_research (full pipeline: plan, search, scrape, compress, write) =="
  out="$(run_dsh "Use the gptr_research tool with query \"What is the DeepSeek Harness?\", max_iterations 1 and total_words 200, then reply with just 'SMOKE_RESEARCH_DONE'." || true)"
  check "gptr_research was called" "$out" '"tool":"gptr_research"'
  check "a report artifact was written" "$out" 'report written to'
  check "the turn finished" "$out" 'SMOKE_RESEARCH_DONE'
else
  echo "== 3/3 skipped (set GPTR_SMOKE_FULL=1 to run the full gptr_research pipeline) =="
fi

if [[ "$fail" == "0" ]]; then
  echo "SMOKE TEST PASSED"
else
  echo "SMOKE TEST FAILED" >&2
  exit 1
fi
