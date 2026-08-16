---
name: research
description: Conduct preliminary research on a topic and generate a research outline (items list + field framework) for deep research.
whenToUse: Use when starting a structured deep-research effort — academic surveys, benchmark reviews, technology or framework comparison, market research, competitor or due-diligence analysis — and an outline is needed before deep investigation.
user-invocable: true
---

# Deep Research — Preliminary Research (DSH edition)

A structured, human-in-the-loop research workflow adapted from Weizhena/Deep-Research-skills to DeepSeek Harness tooling. Run the phases in order: /research → (/research-add-items, /research-add-fields as needed) → /research-deep → /research-report.

## Trigger
`/research <topic>`

## Workflow

### Step 1 — Initial framework from model knowledge
Generate from the topic, using your own knowledge:
- Main research objects/items list in this domain.
- A suggested research-field framework (categories and fields).

Then use `ask_user_question` to confirm:
- Add/remove items?
- Does the field framework meet requirements?

### Step 2 — Web-search supplement
Use `ask_user_question` to ask for a time range (e.g. "last 6 months", "since 2024", "unlimited").

Load the `deep-research-agent` skill for the researcher persona. Launch **one background subagent** (`subagent` tool, background mode) whose prompt is the deep-research-agent content plus the following task prompt, reproduced as faithfully as possible (only replace the {variables}). The subagent searches with AnySearch (anysearch tools); if it lacks them it falls back to the built-in `web_search`.

```
## Task
Research topic: {topic}
Current date: {YYYY-MM-DD}

Based on the following initial framework, supplement latest items and recommended research fields.

## Existing Framework
{step1_output}

## Goals
1. Verify if existing items are missing important objects
2. Supplement items based on missing objects
3. Continue searching for {topic} related items within {time_range} and supplement
4. Supplement new fields

## Output Requirements
Return structured results directly (do not write files):
### Supplementary Items
- item_name: Brief explanation (why it should be added)
### Recommended Supplementary Fields
- field_name: Field description (why this dimension is needed)
### Sources
- [Source1](url1)
```

### Step 3 — Existing fields
Use `ask_user_question` to ask whether the user has an existing field-definition file; if so, `read` and merge it.

### Step 4 — Generate outline (separate files)
Merge {step1_output}, the subagent's supplement, and any user fields. Write two files with the `write` tool:

**outline.yaml** (items + execution config):
- topic: research topic
- items: research objects list (name, category, description)
- execution:
  - batch_size: parallel agents per batch (confirm via `ask_user_question`)
  - items_per_agent: items per agent (confirm via `ask_user_question`)
  - output_dir: results output directory (default `./results`)

**fields.yaml** (field definitions):
- field_categories: category name + fields (name, description, detail_level, required)
- detail_level hierarchy: brief -> moderate -> detailed
- uncertain: reserved field names (auto-filled in the deep phase)

### Step 5 — Save and confirm
- Create the directory `./{topic_slug}/` (slugify the topic).
- Save `outline.yaml` and `fields.yaml` there.
- Show the user for confirmation.

## Output Path
```
{current_working_directory}/{topic_slug}/
  ├── outline.yaml    # items list + execution config
  └── fields.yaml     # field definitions
```

## Follow-up Commands
- `/research-add-items` — supplement items
- `/research-add-fields` — supplement fields
- `/research-deep` — start deep research (workflow + subagents)
- `/research-report` — generate the final markdown report

## DSH tool mapping (upstream -> DSH)
- AskUserQuestion -> `ask_user_question`
- WebSearch/WebFetch -> anysearch `search`/`batch_search`/`extract` (primary; fallback: DSH `web_search`)
- Task / web-search-agent -> `subagent` (background) with the `deep-research-agent` persona
- Bash/Read/Write/Glob -> `bash` / `read` / `write` / `glob`
