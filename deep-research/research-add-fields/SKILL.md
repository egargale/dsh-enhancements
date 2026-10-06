---
name: research-add-fields
description: Add field definitions to an existing research outline.
whenToUse: Use when a research outline already exists and the user wants to add more field definitions (dimensions to collect per item).
user-invocable: true
---

# Research Add Fields — Supplement Research Fields (DSH edition, v2)

## DSH tool invocation (Code Mode)
Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here that means `tools.glob`, `tools.read`, `tools.write`, `tools.bash`, `tools.subagent`, `tools.skill`, `tools.ask_user_question`. A bare `read(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/research-add-fields`

## Workflow

### Step 1 — Auto-locate fields file
Run `tools.glob({ pattern: '*/fields.yaml' })` and `tools.read` the existing field definitions.

### Step 2 — Get supplement source
Use `tools.ask_user_question` to let the user choose:
- **A. User direct input**: user provides field names and descriptions.
- **B. Web search**: load the `deep-research-agent` skill (`tools.skill`) and launch a foreground `tools.subagent` (`run_in_background: false`) to search common fields in this domain.

### Step 3 — Display and confirm
- Display the suggested new fields list.
- User confirms which fields to add.
- User specifies each field's category and detail_level.

### Step 4 — Save update
Append confirmed fields to `fields.yaml` and save with `tools.write`.

## Output
Updated `{topic}/fields.yaml` (in-place modification, requires user confirmation).
