---
description: Generate a standalone HTML diagram
skill: visual-explainer
---
Load the visual-explainer skill and generate an HTML visual explainer for: $@

If `$@` contains the literal `--quick` flag, remove that flag from the topic, read `./quick/README.md` and `./quick/schema.json` (relative to the skill base directory), and emit a compact JSON spec instead of HTML. Write the spec with `tools.write({ file_path: './diagrams/.<name>.spec.json', content: … })` (inside `run_code`), run `node <skill-dir>/quick/render.mjs <spec.json> <output.html>` via `tools.bash(...)` (or call the `visual_explainer_render_quick` tool when the optional plugin is installed), remove the spec file after success, and report the HTML path. If the topic does not fit the schema, validation fails, rendering errors, or `node` is unavailable, continue with the full HTML workflow below. Without `--quick`, do not use quick mode.

Use the skill's reference routing and final checklist. Pick a representation that fits the topic: Mermaid for connected flows/topologies; CSS cards for text-heavy explanations; tables for matrices; timelines for linear history.

Write the complete HTML document to `./diagrams/` with a descriptive filename. DSH cannot open a browser: report the file path in chat with a one-line summary.
