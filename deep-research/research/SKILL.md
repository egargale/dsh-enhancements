---
name: research
description: Conduct preliminary research on a topic and generate a research outline (items list + field framework) for deep research.
whenToUse: Use when starting a structured deep-research effort — academic surveys, benchmark reviews, technology or framework comparison, market research, competitor or due-diligence analysis — and an outline is needed before deep investigation.
user-invocable: true
---

# Deep Research — Preliminary Research (DSH edition, v2)

A structured, human-in-the-loop research workflow adapted from Weizhena/Deep-Research-skills to DeepSeek Harness tooling. Run the phases in order: /research → (/research-add-items, /research-add-fields as needed) → /research-deep → /research-report.

## DSH tool invocation (Code Mode) — read first

DSH runs agents in **Code Mode**: the only tool callable directly is `run_code`; every other tool is reached as `await tools.<name>({...})` **inside a `run_code` program**. This skill's steps below name the `tools.*` form. A bare `write(...)` call fails with `unknown tool "write": only run_code is callable directly`.

Used here: `tools.glob`, `tools.read`, `tools.write`, `tools.bash`, `tools.skill`, `tools.subagent`, `tools.ask_user_question`.

## Trigger
`/research <topic>`

## Workflow

### Step 1 — Initial framework from model knowledge
Generate from the topic, using your own knowledge:
- Main research objects/items list in this domain.
- A suggested research-field framework (categories and fields).

Then call `tools.ask_user_question` to confirm:
- Add/remove items?
- Does the field framework meet requirements?

### Step 2 — Web-search supplement
Call `tools.ask_user_question` to ask for a time range (e.g. "last 6 months", "since 2024", "unlimited").

Load the `deep-research-agent` skill (`await tools.skill({ name: 'deep-research-agent' })`) for the researcher persona, then run **one `run_code` program** that launches a single foreground research child:

```js
const res = await tools.subagent({
  description: 'supplement research framework',
  prompt: persona + "\n\n" + taskPrompt,   // persona = the loaded skill text
  run_in_background: false,                   // REQUIRED: the ptc preset defaults to continuable/background
})
const text = (res.output || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
return text
```

The child searches with AnySearch (MCP tools when present, else the anysearch skill CLI); if it lacks them it falls back to native `tools.web_search`. Task prompt (reproduce faithfully, only replace the {variables}):

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
Use `tools.ask_user_question` to ask whether the user has an existing field-definition file; if so, `tools.read` and merge it.

### Step 4 — Generate outline (separate files)
Merge {step1_output}, the subagent's supplement, and any user fields. Write two files with `tools.write` (inside `run_code`):

**outline.yaml** (items + execution config):
- topic: research topic
- items: research objects list (name, category, description)
- execution:
  - batch_size: parallel agents per batch (confirm via `tools.ask_user_question`)
  - items_per_agent: items per agent (confirm via `tools.ask_user_question`)
  - output_dir: results output directory (default `./results`)

**fields.yaml** (field definitions):
- field_categories: category name + fields (name, description, detail_level, required)
- detail_level hierarchy: brief -> moderate -> detailed
- uncertain: reserved field names (auto-filled in the deep phase)

### Step 5 — Save and confirm
- Create the directory `./{topic_slug}/` (slugify the topic). `tools.write` creates parent directories; `tools.bash({ command: 'mkdir -p {topic_slug}' })` also works.
- Save `outline.yaml` and `fields.yaml` there with `tools.write`.
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
- `/research-deep` — start deep research (run_code + parallel subagents)
- `/research-report` — generate the final markdown report

## DSH tool mapping (upstream -> DSH)
- AskUserQuestion -> `tools.ask_user_question` (inside `run_code`)
- WebSearch/WebFetch -> AnySearch MCP tools / anysearch skill CLI (primary); native `tools.web_search` / `tools.web_fetch` (fallback)
- Task / web-search-agent -> `tools.subagent` (foreground, `run_in_background: false`) with the `deep-research-agent` persona
- Bash/Read/Write/Glob -> `tools.bash` / `tools.read` / `tools.write` / `tools.glob`
