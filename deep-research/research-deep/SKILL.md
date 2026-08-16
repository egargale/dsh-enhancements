---
name: research-deep
description: Deep-research every item in a research outline using DSH workflow orchestration and parallel background subagents — plan-first method, two-pass gap refinement, optional verification, validated JSON per item.
whenToUse: Use after /research has produced outline.yaml and fields.yaml, when the user wants each research object investigated in depth.
user-invocable: true
---

# Research Deep — Deep Research (DSH edition, v2)

## Trigger
`/research-deep`

## Workflow

### Step 1 — Auto-locate outline
Use `glob` to find `*/outline.yaml`; `read` the items list and the execution config (batch_size, items_per_agent, output_dir).

### Step 2 — Resume check
- List existing JSON files in the output directory (default `./results`).
- Skip already-completed items (and their `{slug}.verification.json` when present).

### Step 3 — Workflow orchestration (per batch, human-in-the-loop)
1. `read` `fields.yaml` (next to the outline) and the orchestration script `deep-research.workflow.js` in **this skill's directory** (find it relative to the skill base directory via `glob`).
2. Call the `workflow` tool **once per batch**, awaiting user approval between batches:
   - `script`: the content of `deep-research.workflow.js`
   - `meta`: { name: "deep-research", description: "Deep research of outline items via parallel subagents", whenToUse: "deep-research batch", phases: [{ title: "deep-research-batch", detail: "One batch of items researched in parallel" }, { title: "round-1", detail: "Initial research" }, { title: "round-2", detail: "Gap refinement" }, { title: "verify", detail: "Source verification" }] }
   - `args`: { topic, batch: [{ name, category, description, slug }], fieldsText, maxRounds: 2, verify: true } — fieldsText is the full text of `fields.yaml`; slug is the item name slugified (spaces -> `_`, special chars removed); maxRounds 1|2 (default 2); verify true runs the QA pass.
3. For each returned result, `write`:
   - `{output_dir}/{slug}.json` — the (refined, possibly verified) item JSON
   - `{output_dir}/{slug}.verification.json` — verification metadata when `verify: true` (confidence, conflicts, notes)

**What the script does per item**
- **Round 1 (plan-first)**: the child writes a search plan (5-10 diverse queries), searches with AnySearch (anysearch `search`/`batch_search`/`extract`; fallback DSH `web_search`), evaluates coverage against every field, and returns JSON + `uncertain` + `missing` + sources + concise notes.
- **Round 2 (gap refinement)**: if any field is missing or uncertain, a second child runs targeted searches ONLY for those gaps and returns an updated merged JSON.
- **Verify (optional)**: a QA child cross-checks each claim against its cited sources, resolves conflicts via targeted search, and returns corrected JSON + `verification: {confidence, conflicts, notes}`.

A failed child yields `failed: true` — re-run those items in the next batch.

### Step 4 — Validate
Run the validation script shipped with this skill (find `validate_json.py` relative to the skill base directory):
```
python3 <skill-dir>/validate_json.py -f {topic}/fields.yaml -j {output_dir}/*.json
```
An item is only complete when validation passes (all required fields present). Repair gaps with follow-up subagents as needed. Also review `{slug}.verification.json`: items with `confidence: low` or non-empty `conflicts` should be flagged in the summary (and optionally re-run).

### Step 5 — Summary
After all batches complete, report:
- Completion count; rounds used per item
- Failed / uncertain-marked / missing-field items
- Verification: low-confidence items and source conflicts
- Output directory

## Agent config
- Background execution: yes (`subagent` background mode / workflow child agents)
- Resume support: yes (skip completed JSONs)
- Human-in-the-loop: approve each batch before it runs

## Fallback (no workflow tool)
If the `workflow` tool is unavailable, spawn research subagents manually with the same discipline: per item launch a background `subagent` (prompt = `deep-research-agent` content + per-item task with the plan-first method), review gaps, launch a targeted second subagent for missing/uncertain fields, then a verify subagent; write JSONs, validate, then ask before the next batch.
