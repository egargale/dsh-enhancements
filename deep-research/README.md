# DSH Deep Research Enhancement

A complete, human-in-the-loop **deep-research workflow** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) — adapted from [Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills) to DSH-native primitives: **skills, background subagents, the workflow tool, AnySearch web search, and ask_user_question**.

Research a topic end-to-end: **plan → research → refine → verify → validate → report** — with every claim grounded in cited sources and confidence-rated.

## Features

- **Five-command research flow** — `/research` → `/research-add-items` / `/research-add-fields` → `/research-deep` → `/research-report`, plus a reusable researcher persona (`deep-research-agent`).
- **Parallel subagent fan-out** — the deep phase orchestrates one research agent per item via the DSH `workflow` tool; concurrency is bounded by the harness (default `min(16, cores−2)`), total agents per run up to 1000.
- **Plan-first method** — every research child writes 5–10 diverse query variations before searching (STORM / Gemini-collaborative-planning style).
- **Two-pass gap refinement** — round 1 research, then a targeted round-2 child re-searches *only* missing/uncertain fields (`maxRounds: 2`).
- **Verification pass** — an optional QA child cross-checks every claim against its cited sources, resolves conflicts via targeted search, and returns `confidence` + `conflicts` (`verify: true`).
- **AnySearch primary search engine** — `search` / `batch_search` / `extract` (Exa-class, vertical domains via `get_sub_domains`), with DSH `web_search` as automatic fallback when AnySearch tools are unavailable.
- **Validated JSON output** — `validate_json.py` gates every item on field coverage (required fields must be present).
- **Rich markdown reports** — TOC with anchors, comparison table, per-item detailed content with citations, cross-item synthesis, and an uncertainty & confidence summary.
- **Resume + human-in-the-loop** — completed items are skipped on re-run; each batch waits for user approval.
- **No modification of upstream skills** — the original `~/.agents/skills` copies keep working for Claude Code / Codex; this enhancement lives in `~/.dsh/skills`.

## Skills (installed to ~/.dsh/skills/)

| Skill | Role | Invocation |
|---|---|---|
| `research` | Outline generation: items + field framework (human-in-the-loop) | `/research <topic>` + model |
| `research-add-items` | Add research objects to an existing outline | `/research-add-items` |
| `research-add-fields` | Add field definitions to an existing outline | `/research-add-fields` |
| `research-deep` | Deep research: workflow-orchestrated parallel subagents, two-pass refinement, optional verification, validated JSON | `/research-deep` |
| `research-report` | Consolidate JSON results into a markdown report (TOC, comparison, synthesis, confidence) | `/research-report` |
| `deep-research-agent` | Elite web-researcher persona — load it, then use its content as every research subagent's prompt | model |

All are **model-invocable** (appear in the session skill catalog) and **user-invocable** (`/name` in the composer). No `disable-model-invocation` marker is used.

## How it maps to DSH

| Upstream (Claude Code / Codex) | DSH equivalent |
|---|---|
| `AskUserQuestion` | `ask_user_question` tool |
| `WebSearch` / `WebFetch` | anysearch `search`/`batch_search`/`extract` (primary) + DSH `web_search` fallback |
| `Task` / web-search-agent (`agents/*.md`) | `subagent` (background) + `deep-research-agent` skill as the prompt |
| Codex `request_user_input` | `ask_user_question` |
| `python ~/.claude/skills/research/validate_json.py` | `validate_json.py` shipped next to the `research` skill (resolve via the skill base dir) |
| Claude per-batch `Task` fan-out | `workflow` tool with `deep-research.workflow.js` (one call per batch, approval between batches) |

## What's new in v2 — gap closure

Upgrades implemented after researching agentic deep-research architectures (STORM, IterDRL, RhinoInsight, WebWalker, Kimi-Researcher, ResearchAgent, Self-Refine, Agent-R1, Anthropic/OpenAI/Gemini deep research):

- **Plan-first method** — every research child writes a search plan before executing.
- **Two-pass gap refinement** — targeted round-2 re-search for missing/uncertain fields (`maxRounds` 1|2).
- **Verification pass** — QA child cross-checks claims vs sources, resolves conflicts, returns confidence + conflicts (`verify: true`).
- **Context discipline** — concise notes instead of raw search dumps (Agent-R1: less is more).
- **Report synthesis** — comparison table, cross-item synthesis, citations, uncertainty & confidence summary.

## Setup in DSH

### Prerequisites

- A running DSH **web profile** (`dsh web` or `dsh --profile web`) with the `dsh-base` bundle (ships the `workflow` tool, background subagents, `web_search`, and the skill system).
- `python3` + PyYAML (for `validate_json.py` and the generated report script).
- The **anysearch skill** (optional — the primary search engine; `web_search` is the built-in fallback). Install it from [anysearch-ai/anysearch-skill](https://github.com/anysearch-ai/anysearch-skill) — see [Optional: install the anysearch skill](#optional-install-the-anysearch-skill) below.

### Optional: install the anysearch skill

The primary search engine is the **anysearch skill** from
[anysearch-ai/anysearch-skill](https://github.com/anysearch-ai/anysearch-skill) (Apache-2.0).
The workflow falls back to the built-in DSH `web_search` when the anysearch tools
are unavailable, so this step is optional but recommended.

```bash
# latest release: https://github.com/anysearch-ai/anysearch-skill/releases
curl -L -o /tmp/anysearch-skill.zip https://github.com/anysearch-ai/anysearch-skill/archive/refs/tags/v2.1.0.zip
unzip -q /tmp/anysearch-skill.zip -d /tmp/
mkdir -p ~/.agents/skills
mv /tmp/anysearch-skill-* ~/.agents/skills/anysearch   # zip root is anysearch-skill-<ref>
rm /tmp/anysearch-skill.zip
# if your DSH profile reads skills from ~/.dsh/skills (see Setup step 1), also:
# cp -R ~/.agents/skills/anysearch ~/.dsh/skills/
```

- Requires Python 3.6+ with `requests` (`pip install requests` or `pip install -r requirements.txt`); a dependency-free Node.js CLI is also bundled.
- Set `ANYSEARCH_API_KEY` in `.env` or the environment for higher rate limits (anonymous access works with lower limits).
- The free tier has a **daily quota** — when exhausted, children automatically fall back to `web_search`.

### 1. Install / re-sync the skills

**Preferred — via the `skills` CLI (`npx skills`), no clone needed:**

```bash
# preview what this repo contains
npx skills add egargale/dsh-enhancements --list

# install all six deep-research skills, global scope, non-interactive
npx skills add egargale/dsh-enhancements --skill '*' -g -a cline -y
```

The CLI discovers the six skills in this repo (`research`, `research-add-items`,
`research-add-fields`, `research-deep`, `research-report`, `deep-research-agent`).
DSH is not yet one of the CLI's built-in agent targets, so `-a` picks an agent
whose global path is the shared `~/.agents/skills/` home (`cline`, `dexto`,
`warp` and `zed` all map there — any of them work; files are copied, not
symlinked). DSH picks the skills up from that shared home (the `DSH_AGENTS_HOME`
default). If your DSH profile reads skills from `~/.dsh/skills/` instead, copy
them over:

```bash
cp -R ~/.agents/skills/{research,research-add-items,research-add-fields,research-deep,research-report,deep-research-agent} ~/.dsh/skills/
```

**Fallback — manual copy from a checkout:**

```bash
git clone https://github.com/egargale/dsh-enhancements.git
cd dsh-enhancements/deep-research
mkdir -p ~/.dsh/skills
cp -R research research-add-items research-add-fields research-deep research-report deep-research-agent ~/.dsh/skills/
```

Re-run the chosen command after pulling new versions of the source skills to
refresh them.

### 2. Raise the 600-second tool ceiling (recommended for multi-item runs)

Every tool call from a DSH agent runs inside `run_code`, which has a hard
`maxWallMs` ceiling (default **600 000 ms = 10 min**). The `workflow` tool itself
is not capped, but it is invoked *through* run_code — so any research run longer
than 10 minutes is killed at the wrapper. Measured on a 4-core box (concurrency 2):

| Items | ~Runtime (verify on) |
|---|---|
| 1 | 2–4 min |
| 3 | ~15 min |
| 7 | ~42 min |
| 10 | ~57 min |

Raise the ceiling in the profile patch (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: code-runtime
  config:
    maxWallMs: 3600000   # 1 hour
```

The patch layer **hot-reloads live** (no restart needed in current builds — the
change takes effect on the next tool call). If it doesn't for your build, restart
`dsh web`. The session is durable and resumes after a restart.

### 3. Verify

```bash
# skills present?
ls ~/.dsh/skills | sort
```

In the web UI, start a new session: all six skills appear in the
`<available_skills>` catalog, and `/research <topic>` is available in the composer.

## Usage

```
/research "AI Agent Demo 2025"        → outline.yaml + fields.yaml (with your confirmations)
/research-add-items | -fields         → optional refinements
/research-deep                        → batches of parallel researcher subagents
                                       (approval between batches) → results/*.json + verification
/research-report                      → {topic}/report.md
```

Each batch runs the `workflow` tool with `deep-research.workflow.js`:

```js
// args
{
  topic: "…",
  batch: [{ name, category, description, slug }],   // one batch per workflow call
  fieldsText: "<full text of fields.yaml>",
  maxRounds: 2,      // 1 = single pass, 2 = gap refinement
  verify: true       // run the QA/verification pass
}
```

## Search engine

- **Primary — AnySearch (anysearch skill, [anysearch-ai/anysearch-skill](https://github.com/anysearch-ai/anysearch-skill))**: `search` / `batch_search` / `extract`; vertical routing via `get_sub_domains` for academic / finance / legal / health / code / business, etc.
- **Fallback — DSH `web_search`** (DeepSeek native search): used automatically when the anysearch tools are unavailable in a child's context; each search costs a model turn.
- Note: the AnySearch free tier has a **daily quota** — when exhausted, children automatically fall back to `web_search` + direct page fetches (verification notes will say so).

## Runtime requirements

- `python3` + PyYAML.
- `workflow` tool + background subagents (in `dsh-base`). If `workflow` is unavailable, `research-deep` falls back to manual background-subagent batches.
- Optional: the [anysearch skill](https://github.com/anysearch-ai/anysearch-skill) (primary engine, see [install](#optional-install-the-anysearch-skill)) and network access to `api.anysearch.com` / `api.deepseek.com`.

## Files

- `research/SKILL.md`, `research/validate_json.py`
- `research-add-items/SKILL.md`
- `research-add-fields/SKILL.md`
- `research-deep/SKILL.md`, `research-deep/deep-research.workflow.js`
- `research-report/SKILL.md`
- `deep-research-agent/SKILL.md`

## Maintenance & drift

This is a **fork** of the upstream workflow, so upstream updates do not propagate.
After pulling new versions of the source skills, re-run the install command in
Setup step 1 to refresh the skills.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Multi-item run dies at ~10 min | Raise `maxWallMs` (Setup step 2); split batches smaller |
| Children report anysearch quota errors | Wait for quota reset or rely on the `web_search` fallback (already automatic) |
| `workflow` tool unavailable | Use the manual background-subagent fallback in `research-deep` |
| Validation fails (missing required fields) | Re-run the failing items (`research-deep` skips completed ones) |
| Low confidence / conflicts in the report | Expected — that is the verification pass working; re-run flagged items or inspect the conflict notes |
