---
name: research-deep
description: Deep-research every item in a research outline using DSH Code Mode run_code orchestration and parallel subagents — plan-first method, two-pass gap refinement, optional verification, validated JSON per item.
whenToUse: Use after /research has produced outline.yaml and fields.yaml, when the user wants each research object investigated in depth.
user-invocable: true
---

# Research Deep — Deep Research (DSH edition, v3)

## DSH API (Code Mode / `ptc`) — read first

The shipped **`ptc`** agent preset runs agents in **Code Mode** and disables the `workflow` tool (`tool-workflow` and `workflow-ptc`). `run_code` is the only tool callable directly, and it *is* the orchestrator: one program fans out parallel foreground subagents. Every other tool is reached as `await tools.<name>({...})` **inside** that program:

| Need | Call (inside `run_code`) |
|---|---|
| locate / read files | `await tools.glob({ pattern: '*/outline.yaml' })`, `await tools.read({ file_path })` |
| run one research child | `await tools.subagent({ description, prompt, run_in_background: false })` |
| persist a result | `await tools.write({ file_path, content })` |
| run the validator | `await tools.bash({ command, description })` |
| load the persona skill | `await tools.skill({ name: 'deep-research-agent' })` |
| ask the user | `await tools.ask_user_question({ questions: [{ id, question, header, options }] })` |

A bare `subagent(...)` / `write(...)` call is rejected with `unknown tool "…": only run_code is callable directly`.

A foreground `tools.subagent` returns `{ kind: 'foreground', runId, output: [{ type: 'text', text }, …] }`; the child's answer is the joined `text` blocks. The `ptc` preset configures `backgroundMode: continuable`, so an omitted or `true` `run_in_background` starts a background child and returns no result — **always pass `run_in_background: false`** when the program must parse the answer.

## Workflow

### Step 1 — Auto-locate outline
Run `tools.glob({ pattern: '*/outline.yaml' })`; `tools.read` the items list and the execution config (batch_size, items_per_agent, output_dir).

### Step 2 — Resume check
List the JSON files already in the output directory. Skip items whose `{slug}.json` exists (and their `{slug}.verification.json` when `verify` is on).

### Step 3 — Batch orchestration (human-in-the-loop)
1. `tools.read` `fields.yaml` (next to the outline) and the orchestration template `deep-research.run-code.js` in **this skill's directory** (find it relative to the skill base directory via `tools.glob`).
2. Approve the batch with the user (`tools.ask_user_question`), then write **one `run_code` program per batch**:
   - Start from the template body, replace its INPUTS block (`topic`, `outlineDir`, `batch`, `maxRounds`, `verify`), and submit the whole program as `run_code`'s `code`. The program reads `fields.yaml` itself, so no large string needs escaping.
   - `slug` is the item name slugified (spaces → `_`, special characters removed). `batch` is `[{ name, category, description, slug }]`.
   - `batch_size` comes from the outline's execution config; keep a batch at or below the harness sub-call concurrency so children actually overlap.
   - Legacy alternative (native preset only): `workflow` with `meta` + the `deep-research.workflow.js` body and the same `args`.
3. The program, per item, runs round 1 → round 2 → optional verify and persists `{output_dir}/{slug}.json` + `{output_dir}/{slug}.verification.json` with `tools.write`.
4. Read the program's return value for per-item status; re-run failed items in the next batch.

**What each child does**
- **Round 1 (plan-first)** — loads the `deep-research-agent` skill, writes a 5–10 query plan, searches with AnySearch MCP tools / the anysearch skill CLI / native `tools.web_search`, evaluates coverage against every field, and returns `{item, json, uncertain, missing, sources, notes, confidence}`.
- **Round 2 (gap refinement)** — targeted searches for ONLY the missing/uncertain fields, returns the full merged view (when `maxRounds: 2`).
- **Verify (optional)** — a QA child cross-checks each claim against its cited sources, resolves conflicts via targeted search, and returns corrected JSON plus `verification: {confidence, conflicts, notes}`.

A child failure or unparseable answer yields `{item, ok: false, error}` for that item only; the rest of the batch still completes.

### Step 4 — Validate
Run the validator shipped with the `research` skill (find `validate_json.py` relative to its skill base directory) inside a `run_code` program:
```
await tools.bash({ command: 'python3 <skill-dir>/validate_json.py -f {topic}/fields.yaml -j {output_dir}/*.json', description: 'Validate research JSON' })
```
An item is complete only when validation passes (all required fields present). Repair gaps with follow-up children as needed. Also review each `{slug}.verification.json`: items with `confidence: low` or non-empty `conflicts` should be flagged (and optionally re-run).

### Step 5 — Summary
After all batches complete, report:
- Completion count and rounds used per item
- Failed / uncertain-marked / missing-field items
- Verification: low-confidence items and source conflicts
- Output directory

## Agent config
- Background execution: yes (`run_code` programs with child subagents)
- Resume support: yes (skip completed JSONs)
- Human-in-the-loop: approve each batch before it runs

## Fallback (native preset, `workflow` enabled)
If the agent preset leaves the `workflow` tool enabled (for example **standard**, not **ptc**), you may pass `deep-research.workflow.js` to `workflow` with the `meta` block and `args: { topic, batch, fieldsText, maxRounds, verify }` instead of the run_code program. The `ptc` preset disables `workflow`, so the run_code path is the default there. The manual-subagent fallback below also works without either orchestration tool.

## Fallback (no orchestration tool)
If neither `run_code` orchestration nor `workflow` is workable, spawn research `subagent`s directly (background, then collect) with the same discipline: per item launch a child whose prompt is the `deep-research-agent` content + the per-item task, review gaps, launch a targeted second child for missing/uncertain fields, then a verify child; write JSONs, validate, and ask before the next batch.
