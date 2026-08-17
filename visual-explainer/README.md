# Visual Explainer for DeepSeek Harness

A complete, DSH-native port of [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) (MIT, © 2025 Nico Bailon): a skill that turns complex terminal output into **beautiful, self-contained HTML pages** — diagrams, architecture overviews, diff/plan reviews, project recaps, comparison tables, and slide decks.

Instead of ASCII art and box-drawing tables, the agent generates a single `.html` file with real typography, dark/light themes, and interactive Mermaid diagrams (zoom, pan, expand) — no build step, no dependencies beyond a browser.

## Author & attribution

- **Upstream author:** [Nico Bailon](https://github.com/nicobailon) — [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer), MIT © 2025. This folder is a port of that skill, not an official fork.
- **Port author:** Enrico Gargale (`egargale`) — DSH-native adaptation (workflow, delivery, tooling).
- **Licensing:** the upstream MIT license is preserved verbatim in [`./LICENSE`](LICENSE) — a sub-license covering the ported material, as required by the MIT license. MIT ↔ MIT is fully compatible: the port adds no restrictions. This repo's own additions are covered by the repository-level [LICENSE](../LICENSE).

## Features

- **One core skill + seven command skills** — `visual-explainer` (the workflow engine, model-invocable) plus `/generate-web-diagram`, `/generate-visual-plan`, `/generate-slides`, `/diff-review`, `/plan-review`, `/project-recap`, `/fact-check` as user-invocable composer commands.
- **Proactive table rendering** — when about to dump a table with 4+ rows or 3+ columns, the agent renders an HTML page instead of ASCII.
- **11 diagram representations with routing** — Mermaid (flowchart, sequence, ER, state, class, C4, mind map), CSS Grid cards, semantic HTML tables, CSS timelines, Chart.js dashboards, slide decks.
- **Mermaid deep theming** — `theme: 'base'` + custom `themeVariables`, ELK layout, hand-drawn mode, canonical `diagram-shell` with zoom/pan/expand controls on every diagram.
- **9+ aesthetic directions** — blueprint, editorial, paper/ink, terminal, IDE-inspired, data-dense, named palettes (Dracula, Nord, Gruvbox…) via `references/themes.md`, with explicit anti-defaults (no Inter-only, no violet/neon crutches).
- **Quick mode** — compact JSON spec rendered deterministically by `quick/render.mjs` (schema-validated; tested in this repo) or by the optional plugin tool `visual_explainer_render_quick`.
- **Best-effort PPTX export** — `/generate-slides --pptx` produces a static `.pptx` after the HTML deck (`pptx/export.mjs`).
- **Fact-gathering discipline** — review commands build a verified fact sheet (git + `file:line` evidence) before any HTML is written; nothing is invented.

## Skills (installed to `~/.dsh/skills/`)

| Skill | Role | Invocation |
|---|---|---|
| `visual-explainer` | Core workflow engine: representation routing, Mermaid/style invariants, quick mode, slide mode, final checklist | model (loaded first by every command) |
| `generate-web-diagram` | Standalone HTML diagram for any topic | `/generate-web-diagram <topic> [--quick]` |
| `generate-visual-plan` | Visual implementation plan (goal, design, phases, file map, risks, test plan) | `/generate-visual-plan <topic>` |
| `generate-slides` | Self-contained HTML slide deck (`100dvh` slides, reader rail, keyboard nav) | `/generate-slides <topic> [--pptx]` |
| `diff-review` | Visual diff review: before/after architecture, KPI dashboard, Good/Bad/Ugly review, decision log | `/diff-review [ref] [--quick]` |
| `plan-review` | Plan vs. codebase: accuracy verdict, current/planned architecture, gap/risk matrix, decision | `/plan-review <plan> [--quick]` |
| `project-recap` | Context-switch snapshot: architecture, recent activity, cognitive debt, next steps | `/project-recap [--quick]` |
| `fact-check` | Verify a generated document against actual code and git history | `/fact-check [file]` |

All are **model-invocable** (appear in the session skill catalog) and **user-invocable** (`/name` in the composer). No `disable-model-invocation` marker is used.

## How it maps to DSH

| Upstream (Claude Code / Pi / Cursor) | DSH equivalent |
|---|---|
| `~/.agent/diagrams/` output dir | `./diagrams/` in the session workspace (sandbox-friendly; honored by the `write` tool) |
| `open` / browser launch after render | No browser auto-open in DSH — the agent reports the file path in chat; pages are self-contained and openable anywhere |
| Slash commands via Claude Code `commands/` | User-invocable skills (`/diff-review` … in the DSH composer), each loading the core skill first |
| Pi `visual_explainer.prepare/render` tool | The `write` tool + the skill workflow (no harness-specific render API) |
| Pi `render_quick` action | `quick/render.mjs` via `bash` (needs `node`), or the optional `visual_explainer_render_quick` plugin tool when installed |
| surf-cli + Gemini image generation | **Not ported** — DSH has no bundled image generation; slides/pages degrade to CSS gradients + inline SVG (never error) |
| MCP server (`mcp/server.mjs`) | **Not ported** — DSH's native `skill` + `write` tools replace the render-tool interface; see [visual-explainer-plugin](../visual-explainer-plugin) for the deterministic-render alternative |
| Claude Code plugin packaging (`.claude-plugin`, `extension.ts`, `configs/`) | **Not ported** — not applicable to DSH profiles |
| `visual-explainer-pptx` binary | `node <skill-dir>/pptx/export.mjs` (deps installed on demand into a scratch dir) |

The core design principle is preserved from upstream: **the skill degrades gracefully** — if the plugin tool, `node`, or PPTX dependencies are missing, the agent falls back to full HTML generation via the `write` tool.

## Setup in DSH

### Prerequisites

- A running DSH **web profile** (`dsh web` or `dsh --profile web`) with the `dsh-base` bundle (ships the skill system, `write`/`bash`, and the `skill` tool).
- A browser to open the generated HTML files (DSH itself does not render them inline).
- Optional: `node` >= 18 for quick mode and PPTX export; the optional plugin (below) removes the `node` requirement for quick mode.

### 1. Install / re-sync the skills

**Preferred — via the `skills` CLI (`npx skills`), no clone needed:**

```bash
# preview what this repo contains
npx skills add egargale/dsh-enhancements --list

# install all eight visual-explainer skills, global scope, non-interactive
npx skills add egargale/dsh-enhancements --skill '*' -g -a cline -y
```

The CLI discovers the eight skills in this repo (`visual-explainer`, `generate-web-diagram`, `generate-visual-plan`, `generate-slides`, `diff-review`, `plan-review`, `project-recap`, `fact-check`). DSH is not yet one of the CLI's built-in agent targets, so `-a` picks an agent whose global path is the shared `~/.agents/skills/` home (`cline`, `dexto`, `warp` and `zed` all map there — any of them work; files are copied, not symlinked). DSH picks the skills up from that shared home (the `DSH_AGENTS_HOME` default). If your DSH profile reads skills from `~/.dsh/skills/` instead, copy them over:

```bash
cp -R ~/.agents/skills/{visual-explainer,generate-web-diagram,generate-visual-plan,generate-slides,diff-review,plan-review,project-recap,fact-check} ~/.dsh/skills/
```

**Fallback — manual copy from a checkout:**

```bash
git clone https://github.com/egargale/dsh-enhancements.git
cd dsh-enhancements/visual-explainer
mkdir -p ~/.dsh/skills
cp -R visual-explainer generate-web-diagram generate-visual-plan generate-slides diff-review plan-review project-recap fact-check ~/.dsh/skills/
```

The skill bundle (`visual-explainer/`) contains everything the commands need — references, templates, commands, quick renderer, PPTX exporter — so all eight must be copied together. Re-run the chosen command after pulling new versions to refresh.

### 2. Optional: install the `visual-explainer-plugin`

The ad-hoc DSH plugin (see [../visual-explainer-plugin](../visual-explainer-plugin/README.md)) registers a deterministic `visual_explainer_render_quick` tool (spec → HTML, no `node` needed) and a Web Client chat node that shows a delivered-diagram card. Build it against a DSH source checkout and mount with `pnpm dsh web --patch ./visual-explainer-plugin/cordis.yml`. The skill uses it automatically when present and degrades gracefully when absent.

### 3. Verify

```bash
ls ~/.dsh/skills | sort
```

In the web UI, start a new session: all eight skills appear in the `<available_skills>` catalog, and `/diff-review`, `/generate-web-diagram`, etc. are available in the composer.

## Usage

```
/diff-review                    -> visual diff review vs main (also: <ref>, abc123..def456, #42, HEAD)
/plan-review ~/docs/plan.md     -> plan vs codebase with risk matrix
/project-recap                  -> context-switch snapshot of this repo
/generate-web-diagram "auth"    -> standalone HTML diagram
/generate-visual-plan "feature X" -> visual implementation plan
/generate-slides "demo" --pptx  -> HTML deck (+ best-effort .pptx)
/fact-check diagrams/foo.html   -> verify claims against code + git
```

Output lands in `./diagrams/` (relative to the session working directory). The agent reports the path in chat — open the file in any browser; Mermaid diagrams include zoom/pan/expand controls.

## Files

- `visual-explainer/SKILL.md` — core workflow engine (routing, invariants, quick mode, checklist)
- `visual-explainer/commands/*.md` — the seven command templates
- `visual-explainer/references/` — `css-patterns.md`, `libraries.md` (Mermaid/Chart.js/fonts), `responsive-nav.md`, `slide-patterns.md`, `themes.md` (named palettes + runtime picker)
- `visual-explainer/templates/` — `architecture.html`, `data-table.html`, `mermaid-flowchart.html`, `slide-deck.html`
- `visual-explainer/quick/` — `render.mjs` + `schema.json` + `base.css` (schema-validated quick renderer)
- `visual-explainer/pptx/` — `export.mjs` best-effort PPTX exporter
- `{generate-web-diagram,generate-visual-plan,generate-slides,diff-review,plan-review,project-recap,fact-check}/SKILL.md` — user-invocable command skills

## Maintenance & drift

This is a **port** of the upstream skill, so upstream updates do not propagate automatically. The upstream repo (master) is the source of truth for aesthetic patterns; when it changes, re-apply the DSH deltas: output dir (`./diagrams/`), delivery (report path, no browser), quick mode (node script / plugin tool), no image generation, no MCP layer.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Generated page doesn't open / no path reported | The agent must report the file path in chat; open `diagrams/<name>.html` locally |
| Quick mode fails (`node` missing) | Install the plugin (Setup step 2) or use full mode (no `--quick`) |
| PPTX export fails | Install `node-html-parser` + `pptxgenjs` into a scratch dir (see `pptx/README.md`) and run from there; otherwise the HTML deck is the deliverable |
| Mermaid diagram doesn't render | Check the `diagram-shell` pattern and `theme: 'base'` + `themeVariables`; bare `<pre class="mermaid">` is forbidden |
| Skills don't appear in the catalog | Confirm the eight directories are directly under the skills root (nested `**/SKILL.md` discovery is not supported) |

## License

Ported from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) by Nico Bailon, MIT © 2025 — the upstream license text is kept verbatim in [`./LICENSE`](LICENSE) as required by the MIT license (MIT/MIT compatible; see [Author & attribution](#author--attribution)). The repository-level [LICENSE](../LICENSE) covers this folder's DSH-specific additions.

