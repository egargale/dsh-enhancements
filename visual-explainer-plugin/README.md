# visual-explainer-plugin (ad-hoc DSH plugin, scaffold)

Optional companion to the [visual-explainer](../visual-explainer/README.md) skill family in this repo. The skill is the **brain** (workflow, fact-gathering, aesthetics, routing); this plugin is the **deterministic hands and eyes**:

1. **`visual_explainer_render_quick` tool** — renders the skill's quick-mode JSON spec into a complete, self-contained HTML page as a native tool. No `node`/bash step; the model calls it like any other tool; results render as tool-result cards in the session log (replay-safe).
2. **Web Client chat node (`ve-diagram`)** — one business row per delivered diagram: title, path, size, and open-locally guidance, rendered in the chat timeline.

The skill **uses the tool automatically when present and degrades gracefully when absent** (it falls back to `node <skill-dir>/quick/render.mjs`). The plugin therefore never breaks the skill — it only makes quick mode cheaper and its results visible in the GUI.

This is a **reference-quality scaffold** written against the public extension points documented in the [DSH reference](https://deepseek-harness.github.io/deepseek-harness/en/reference/) (tool authoring, conversation-node cookbook). It has **not been compiled or run here** (this repo is a skills repo, not a DSH checkout) — verify the API details marked with "verify" below against your checkout.

## Why a plugin at all?

Evaluated alternatives when porting visual-explainer to DSH:

| Approach | Verdict |
|---|---|
| Skill only | Correct core: the workflow is ~90% model reasoning that a plugin cannot carry. Kept as the primary port. |
| Plugin only | Impossible: plugins are deterministic endpoints; intent detection, git archaeology, and design choices are model work. |
| Skill + plugin (this) | The plugin owns exactly two deterministic gaps: quick rendering (no node dependency) and in-GUI visibility of deliverables. |

The upstream repo has the same layered philosophy (skill + MCP server + quick renderer); in DSH, the MCP server's job is done natively by the `skill` tool + `write` tool, and the deterministic renderer becomes this plugin.

## Structure

```
visual-explainer-plugin/
├── cordis.yml              # Web overlay: --patch mount point (server entry)
├── package.json            # workspace:* deps — build inside the DSH monorepo
├── tsconfig.json
├── scripts/sync-assets.sh  # copy quick renderer from the skill bundle into src/assets
└── src/
    ├── index.ts            # server plugin: registers the render tool
    ├── render-tool.ts      # defineTool: visual_explainer_render_quick
    ├── assets/             # synced from visual-explainer/visual-explainer/quick/
    │   ├── render.mjs      #   (single source of truth — validation + HTML assembly)
    │   ├── base.css
    │   └── schema.json
    └── client/
        └── index.tsx       # Web Client chat node (ConversationNodeDefinition)
```

The renderer logic is **not reimplemented**: `render-tool.ts` imports `validateQuickSpec`/`renderQuickSpec` from the synced `render.mjs`, so validation and HTML output are identical to the skill's quick mode. Run `npm run sync-assets` after updating the skill's `quick/` directory.

## Requirements

- A **run-from-source** DSH checkout ([README](https://github.com/deepseek-ai/deepseek-harness#run-from-source)) with `pnpm` — the plugin uses `workspace:*` dependencies and must be mounted with the development `dsh web` launcher.
- This repository cloned at a stable absolute path (patch paths are absolute).

## Build and mount

### 1. Sync assets (once, or after skill updates)

```bash
cd dsh-enhancements/visual-explainer-plugin
npm run sync-assets
```

### 2. Mount the server-side tool

Edit `cordis.yml` to point `name:` at the absolute path of `src/index.ts`, then from the DSH checkout:

```bash
pnpm dsh web --patch /absolute/path/to/dsh-enhancements/visual-explainer-plugin/cordis.yml
```

Open http://127.0.0.1:3080 and ask: *"render a quick diagram of the auth flow"* (with the visual-explainer skill loaded, quick mode calls the tool). The tool's schema joins the model's tool set automatically.

### 3. Mount the client node (Web bundle)

The chat node is a client plugin and must be **composed into the Web bundle** — the exact composition point depends on your checkout's client plugin loader (see `packages/client/*`; the conversation-node cookbook describes the assembly). After composing, rebuild the Web artifacts and hard-refresh the GUI. The server tool works without this step.

## Verify before trusting (checkout-specific)

- `tool/result` payload field names in `src/client/index.tsx` (`name`, `callId`, `value`) — verify against `packages/core/tools`.
- `defineTool` import path and `ParameterSchemaSpec` shape — verify against `@deepseek-ai/dsh-tools` in your checkout.
- Output writes use `node:fs/promises` relative to the process cwd. A production version should resolve the session workspace root and route writes through the `ctx.fs` seam so sandbox/approval policy applies (the shipped `write` tool is the reference).
- Tests: the DSH repository testing policy applies to any shipped change; add the assembled coverage when moving this scaffold into production.

## Known limitations / future work

- **No true inline preview.** The chat node shows a summary card; an actual iframe preview requires a static-file route or content route in the Web app (not part of this scaffold; noted in the node's copy).
- **Quick mode only.** Full custom HTML pages are generated by the model via the `write` tool — that stays skill-side by design.
- **No PPTX tool.** PPTX export remains a best-effort `node` step in the skill (`pptx/export.mjs`).
- The upstream MCP server is intentionally not ported: DSH's native `skill` + `write` + this tool cover its interface.

## License

Ported from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) by Nico Bailon, MIT © 2025 — the upstream license text is kept verbatim in [`./LICENSE`](LICENSE) as required by the MIT license (MIT/MIT compatible). The repository-level [LICENSE](../LICENSE) covers this plugin's original scaffold code.

