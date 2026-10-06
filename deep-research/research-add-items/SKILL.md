---
name: research-add-items
description: Add items (research objects) to an existing research outline.
whenToUse: Use when a research outline already exists and the user wants to add more research objects/items.
user-invocable: true
---

# Research Add Items — Supplement Research Objects (DSH edition, v2)

## DSH tool invocation (Code Mode)
Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here that means `tools.glob`, `tools.read`, `tools.write`, `tools.bash`, `tools.subagent`, `tools.skill`, `tools.ask_user_question`. A bare `read(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/research-add-items`

## Workflow

### Step 1 — Auto-locate outline
Run `tools.glob({ pattern: '*/outline.yaml' })` in the current working directory and `tools.read` it.

### Step 2 — Get supplement sources in parallel
- **A. Ask the user** (via `tools.ask_user_question`): which items to add? Any specific names?
- **B. Web search**: ask whether a web search is wanted; if yes, load the `deep-research-agent` skill (`tools.skill`) and launch one foreground `tools.subagent` (`run_in_background: false`) to find more items for the topic.

### Step 3 — Merge and update
- Append new items to `outline.yaml` (avoid duplicates).
- Display to the user for confirmation.
- Save the updated outline with `tools.write`.

## Output
Updated `{topic}/outline.yaml` (in-place modification).
