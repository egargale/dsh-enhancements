---
name: research-add-fields
description: Add field definitions to an existing research outline.
whenToUse: Use when a research outline already exists and the user wants to add more field definitions (dimensions to collect per item).
user-invocable: true
---

# Research Add Fields — Supplement Research Fields (DSH edition)

## Trigger
`/research-add-fields`

## Workflow

### Step 1 — Auto-locate fields file
Use `glob` to find `*/fields.yaml` in the current working directory and `read` the existing field definitions.

### Step 2 — Get supplement source
Use `ask_user_question` to let the user choose:
- **A. User direct input**: user provides field names and descriptions.
- **B. Web search**: load the `deep-research-agent` skill and launch a background `subagent` to search common fields in this domain.

### Step 3 — Display and confirm
- Display the suggested new fields list.
- User confirms which fields to add.
- User specifies each field's category and detail_level.

### Step 4 — Save update
Append confirmed fields to `fields.yaml` and save.

## Output
Updated `{topic}/fields.yaml` (in-place modification, requires user confirmation).
