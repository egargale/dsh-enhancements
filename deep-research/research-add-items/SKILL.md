---
name: research-add-items
description: Add items (research objects) to an existing research outline.
whenToUse: Use when a research outline already exists and the user wants to add more research objects/items.
user-invocable: true
---

# Research Add Items — Supplement Research Objects (DSH edition)

## Trigger
`/research-add-items`

## Workflow

### Step 1 — Auto-locate outline
Use `glob` to find `*/outline.yaml` in the current working directory and `read` it.

### Step 2 — Get supplement sources in parallel
- **A. Ask the user** (via `ask_user_question`): which items to add? Any specific names?
- **B. Web search**: ask whether a web search is wanted; if yes, load the `deep-research-agent` skill and launch one background `subagent` to find more items for the topic.

### Step 3 — Merge and update
- Append new items to `outline.yaml` (avoid duplicates).
- Display to the user for confirmation.
- Save the updated outline.

## Output
Updated `{topic}/outline.yaml` (in-place modification).
