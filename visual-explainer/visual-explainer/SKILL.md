---
name: visual-explainer
description: Generate beautiful, self-contained HTML pages that visually explain systems, code changes, plans, data, and technical concepts. Use when the user asks for a diagram, architecture overview, diff or plan review, project recap, comparison table, slide deck, or any visual explanation of technical content. Also use proactively when about to render a complex ASCII table (4+ rows or 3+ columns) — present it as a styled HTML page instead.
whenToUse: Requests for diagrams, architecture overviews, /diff-review, /plan-review, /project-recap, /fact-check, /generate-slides, /generate-visual-plan, /generate-web-diagram, or any tabular data with 4+ rows or 3+ columns that would be painful to read in chat.
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  version: "0.9.0-dsh"
  upstream: https://github.com/nicobailon/visual-explainer
---

# Visual Explainer (DeepSeek Harness edition)

Generate self-contained HTML pages that explain systems, code changes, plans, data, and technical concepts visually. Use this skill for diagram requests, architecture overviews, diff/plan reviews, project recaps, comparison tables, slide decks, and any visual explanation. Never fall back to ASCII art when this skill applies.

## Trigger and delivery rules

- Prefer an HTML page over terminal ASCII when the output is inherently visual.
- If a table would have 4+ rows or 3+ columns, render it as HTML and give only a short chat summary.
- **Output location (DSH):** write files to `./diagrams/` relative to the session working directory (or the explicit path the user gives). Use descriptive filenames, e.g. `diff-review-auth-flow.html`. The `write` tool creates parent directories; if a directory is missing, create it with `mkdir -p` via `bash` when the write fails.
- **Delivery (DSH):** DSH runs inside a sandboxed workspace and cannot open a browser on your behalf. After writing, report the file's path in chat (absolute or workspace-relative) and one line on what the page contains. The user opens the file locally; the page must stand alone.
- Generate a Markdown companion only when the user explicitly asks for AI-readable output or a source brief. Keep HTML as the final visual output; Markdown is a companion, never the source for HTML. Write `<name>.md` beside `<name>.html` when possible, and ask before replacing an existing companion file.
- The final page must be a complete self-contained HTML document: embedded CSS, a self-contained favicon, and any needed JS. No external files, no build step.

## Commands

This skill ships seven command templates. When the user invokes one of these (as `/command` in the DSH composer, or phrased in natural language), load the matching template from `./commands/` in this skill's directory and follow it:

| Command | Template |
|---|---|
| `/generate-web-diagram <topic>` | `./commands/generate-web-diagram.md` |
| `/generate-visual-plan <topic>` | `./commands/generate-visual-plan.md` |
| `/generate-slides <topic> [--pptx]` | `./commands/generate-slides.md` |
| `/diff-review [ref] [--quick]` | `./commands/diff-review.md` |
| `/plan-review <plan> [--quick]` | `./commands/plan-review.md` |
| `/project-recap [--quick]` | `./commands/project-recap.md` |
| `/fact-check [file]` | `./commands/fact-check.md` |

The argument the user typed after the command name is `$@` inside the template. Each command skill is also catalogued separately and loads this skill first — loading the command template without this skill is never enough.

## Working with this skill's files (DSH)

All relative paths in this skill (`./references/...`, `./templates/...`, `./commands/...`, `./quick/...`, `./pptx/...`) resolve against **this skill's base directory**, reported by the `skill` tool as `resourceBase` (kind: directory). Read reference and template files with the `read` tool before generating — don't memorize them, read them fresh each time. If you need to locate them, use `glob` from the base directory.

## Quick mode

Quick mode is opt-in. Use it only when `--quick` appears on `/generate-web-diagram`, `/diff-review`, `/plan-review`, or `/project-recap`. Default and all other prompt behavior remains full HTML generation.

For quick mode, read `./quick/README.md` and `./quick/schema.json`. Gather and verify the same source facts as full mode, but emit the compact JSON spec. In DSH:

1. Compose the spec JSON.
2. **If the optional `visual-explainer-plugin` is installed**, call the `visual_explainer_render_quick` tool with the spec, a descriptive filename, and an optional output directory (default `./diagrams/`) — it validates, renders, and writes the HTML deterministically. **Otherwise**, write the spec with the `write` tool to `<output-dir>/.<name>.spec.json` and run `node <skill-dir>/quick/render.mjs <spec.json> <output.html>` via `bash` (`<skill-dir>` is this skill's base directory).
3. Remove the temporary spec file after a successful render (unless the user wants it kept), then report the HTML path.

If the plugin tool is absent, `node` is unavailable, the spec does not validate, or rendering errors, fall back to the normal full HTML workflow. Do not use quick mode for slides, fact-check, visual plans, PPTX, themes, or updates.

## Reference routing

Read only the references needed for the current output:

| Need | Read |
|---|---|
| Text-heavy architecture/cards | `./templates/architecture.html` |
| Mermaid flowcharts, sequence, ER, state, class, C4, data flow | `./templates/mermaid-flowchart.html`, Mermaid sections in `./references/libraries.md` |
| Data tables, comparisons, audits | `./templates/data-table.html` |
| Slide decks | `./templates/slide-deck.html`, `./references/slide-patterns.md` |
| CSS layout, overflow, depth, collapsibles, SVG connectors | `./references/css-patterns.md` |
| Pages with 4+ major sections | `./references/responsive-nav.md` |
| Switchable themes or fonts, or a named palette (Dracula, Nord, Gruvbox…) | `./references/themes.md` |
| Prose-heavy pages | "Prose Page Elements" in `css-patterns.md`, typography sections in `libraries.md` |

## Choose the representation

| Content | Default representation |
|---|---|
| Flowchart, pipeline, state machine, decision tree | Mermaid |
| Sequence, ER/schema, class, C4, topology-focused architecture | Mermaid |
| Text-heavy architecture, module internals, implementation plans | CSS grid cards, optionally with a Mermaid overview |
| 15+ element architecture | Hybrid: small Mermaid overview + CSS detail cards |
| Comparison/audit/status matrix | Semantic HTML `<table>` |
| Timeline/roadmap | CSS timeline |
| Dashboard/metrics | CSS grid + charts/KPIs |
| Slide deck | `100dvh` slides using slide template patterns |

## Mermaid invariants

- Use `theme: 'base'` with custom `themeVariables` matching the page palette.
- For complex diagrams use ELK layout when available.
- Never use bare `<pre class="mermaid">`.
- Use the canonical `diagram-shell` pattern from `templates/mermaid-flowchart.html`: `.diagram-shell` > `.mermaid-wrap` > `.zoom-controls` + `.mermaid-viewport` > `.mermaid-canvas`.
- Every Mermaid diagram needs zoom in/out/reset/expand controls, Ctrl/Cmd+scroll zoom, drag panning, and click-to-expand.
- Prefer `flowchart TD` for complex diagrams. Use `LR` only for simple 3–4 node linear flows.
- Use `<br/>` in quoted flowchart labels. Do not use escaped `\n` labels.
- Never define page-level `.node`; Mermaid uses it internally. Use namespaced page classes such as `.ve-card`.
- For 15+ elements, do not cram everything into one Mermaid diagram. Use the hybrid overview + cards pattern.

## Layout and style invariants

- Use semantic HTML where it helps accessibility and copy/paste: `<table>`, headings, lists, `<details>`, captions.
- Use CSS custom properties for palette: `--bg`, `--surface`, `--border`, `--text`, `--text-dim`, and 3–5 accents.
- Commit to one palette and one font pair. Add a runtime picker only when the user asks to switch themes or fonts, or names a prebuilt palette; see `./references/themes.md`.
- Pick a clear aesthetic direction before writing: blueprint, editorial, paper/ink, terminal, IDE-inspired, or data-dense.
- Avoid generic defaults: no body font that is only Inter, Roboto, Arial, Helvetica, or system-ui; no violet/fuchsia Tailwind-default accents as the main palette (`#8b5cf6`, `#7c3aed`, `#a78bfa`, `#d946ef`); no cyan+magenta+purple neon dashboard; no gradient-mesh blobs.
- Good font pair families: DM Sans + Fira Code; Instrument Serif + JetBrains Mono; IBM Plex Sans + IBM Plex Mono; Bricolage Grotesque + JetBrains Mono; Plus Jakarta Sans + Azeret Mono.
- Load every font weight the CSS uses, including mono labels. Do not rely on faux-bold for 500, 600, or 700 weights.
- Good accent directions: terracotta+sage, teal+slate, rose+cranberry, amber+emerald, deep blue+gold.
- Prevent overflow: `min-width: 0` on grid/flex children, `overflow-wrap: break-word` for long text, and scroll containers for wide tables/code.
- Do not set `display: flex` directly on `<li>` when list markers matter.
- Use depth sparingly: hero/elevated only for primary sections; flat/recessed for reference material.
- Use entrance/hover animation only when it clarifies hierarchy. Respect `prefers-reduced-motion`. Do not use continuous glow, pulse, or breathing effects on static content.
- Support both light and dark themes via CSS custom properties and `prefers-color-scheme` (primary aesthetic in `:root`, alternate in the media query).

## Generated images (DSH)

The upstream skill optionally embeds AI-generated images via surf-cli/Gemini. **DSH has no bundled image generation tool** — do not attempt to generate images. Degrade gracefully: use CSS gradients, SVG decorations, and iconography instead, and never error on a missing image tool. Pages must stand on CSS, typography, and diagrams alone. A comment like `<!-- no image generation in DSH; CSS/SVG fallback used -->` is welcome but optional.

## Slide deck mode

Use slides only when explicitly requested or when a command asks for slides. Slides are a different medium, not a paginated article. If the user explicitly asks for PPTX or passes `--pptx` to `/generate-slides`, generate the HTML deck first, then use the best-effort static exporter in `./pptx/export.mjs` (see `./pptx/README.md` for dependency setup). If the exporter dependencies are not available, deliver the HTML deck and explain the missing export dependency path. State that HTML remains the source of truth and PPTX does not preserve animations, reader navigation, responsive layout, custom fonts, live Mermaid/Chart.js/SVG/canvas rendering, or JavaScript behavior.

Slides rules:

- Each slide is one viewport (`100dvh`) with no page-level scrolling.
- Use larger type, fewer objects per slide, varied compositions, and visible navigation.
- Include slide nav chrome from `slide-deck.html`: prev/next controls, slide count with reading percent, keyboard navigation, expandable reader rail, outline/help overlays, `#slide-N` deep links, and resume state.
- Before writing HTML, inventory the source and map every source item to slides.
- Do not drop content to fit a fixed slide count. Add slides instead.
- Use the 10 slide types from `slide-patterns.md`: Title, Section Divider, Content, Split, Diagram, Dashboard, Table, Code, Quote, Full-Bleed.

## Fact-gathering discipline

For review commands (diff-review, plan-review, project-recap, fact-check), gather and verify every claim against the actual code and git history before generating HTML:

- Run the relevant `git` commands via `bash` (diff stats, name-status, log, show).
- Read all changed/referenced files in full with the `read` tool; use `grep`/`glob` to find patterns and dependents.
- Build a structured fact sheet of every quantitative figure, symbol name, and behavior claim you will present, each with its source (command output or `file:line`). Do not deviate from it during generation; mark unverifiable claims as uncertain rather than stating them as fact.
- If the work was done earlier in this session, mine the conversation for decisions and rationale; for committed work, read commit messages and PR descriptions.

## Final checklist

Before delivery, verify:

- complete HTML document written to the requested path with a descriptive filename;
- no console errors when opened (run JS errors past you before delivering);
- no horizontal overflow at normal desktop width;
- fonts load with fallbacks;
- page has a self-contained favicon;
- tables preserve rows/columns and wrap long text;
- Mermaid diagrams use `diagram-shell` with zoom/pan/expand;
- a runtime picker, if present, swaps palette and font variables and re-renders every diagram;
- slides fit one viewport, include reader rail plus outline/help navigation, and preserve source coverage; if PPTX was requested, the static `.pptx` was generated after the HTML deck and its fidelity limits were stated;
- visual hierarchy makes the main idea obvious in the first viewport;
- styling would still be recognizable if compared against a generic dark/violet template;
- the file path was reported in chat (DSH cannot open browsers for you);
- if requested, the Markdown companion is a concise source brief that matches the delivered HTML without becoming its source of truth.

## Attribution

Upstream: [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) by Nico Bailon — MIT © 2025 (license text retained in the skill repository at `visual-explainer/LICENSE`). This skill is a DeepSeek Harness port; the upstream copyright notice is preserved as required by the MIT license.
