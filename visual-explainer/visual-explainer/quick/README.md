# Quick renderer (DeepSeek Harness edition)

Quick mode moves repeated HTML and CSS out of the agent response. The agent emits a compact JSON spec. `render.mjs` validates it and creates one complete, self-contained HTML document.

Quick mode is opt-in. Use it only for `/generate-web-diagram --quick`, `/diff-review --quick`, `/plan-review --quick`, or `/project-recap --quick`. Use full mode if the requested design does not fit the schema or if validation or rendering fails.

## DSH

**Preferred when the plugin is installed:** if the `visual_explainer_render_quick` tool is available in the session (from the optional `visual-explainer-plugin`, see the repo README), call it with the spec and a filename instead of the local script — no `node` needed.

**Otherwise** save the spec as JSON and run the local renderer:

1. Write the spec with `tools.write({ file_path: '<output-dir>/.<name>.spec.json', content: specJson })` from inside a `run_code` program (default output dir `./diagrams/`).
2. Run via `bash`:

```bash
node <skill-dir>/quick/render.mjs <spec.json> <output.html>
```

`<skill-dir>` is this skill's base directory (the `skill` tool reports it as `resourceBase`). Example:

```bash
node ~/.dsh/skills/visual-explainer/quick/render.mjs diagrams/.auth-flow.spec.json diagrams/auth-flow.html
```

3. Remove the temporary spec file after a successful render (`rm`), then report the HTML path in chat.

If `node` is unavailable or the renderer exits with an error, continue with the normal full HTML workflow.

## Schema

`schema.json` is the authoritative JSON Schema. A spec has a `title`, optional `subtitle` and `summary`, and one or more `sections`. Each section can contain:

- `cards`: compact findings or concepts;
- `table`: columns and string rows;
- `risks`: severity-tagged risk items;
- `files`: paths, details, and change status;
- `steps`: ordered work or timeline items;
- `flow`: nodes and directed edges;
- `callouts`: notes, decisions, or warnings;
- `evidence`: a label, value, and optional source.

All agent text is HTML-escaped. Unknown properties, invalid enum values, bad flow references, and table rows with the wrong column count fail validation.
