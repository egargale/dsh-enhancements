---
description: Generate a visual project recap for context switching
skill: visual-explainer
---
Load the visual-explainer skill and generate a self-contained HTML project recap.

## Quick mode

Only use quick mode when `$@` contains the literal `--quick` flag. Remove the flag before interpreting any recap arguments. Complete the same project research and verification below, then read `./quick/README.md` and `./quick/schema.json` and express the recap as a compact spec. Write the spec with the `write` tool to `./diagrams/.<name>.spec.json`, run `node <skill-dir>/quick/render.mjs <spec.json> <output.html>` via `bash` (or call the `visual_explainer_render_quick` tool when the optional plugin is installed), remove the spec file after success, and report the HTML path. If the recap does not fit the schema, validation fails, rendering errors, or `node` is unavailable, generate complete HTML and use the normal render flow. Without `--quick`, preserve full HTML behavior.

## Data gathering before HTML

Read project identity files (README, changelog, package/build files), top-level tree (`glob`), current git status, recent commits, unmerged/stale branches, TODO/FIXME in recent files, and key entry points/source files. Focus on what a returning developer needs to rebuild the mental model.

## Verify before generating

Cite command output or file:line evidence for project state, module/function/type names, recent activity, current blockers, and next-step claims. Do not fabricate momentum or rationale.

## Required page sections

1. Project identity: what this repo is, stack, entry points.
2. Architecture snapshot: Mermaid or hybrid diagram of current conceptual modules.
3. Recent activity: grouped narrative, not raw log.
4. Current state: uncommitted work, branches, TODOs, known blockers.
5. Mental model map: key modules, data flow, command/test/deploy paths.
6. Risks and cognitive debt: hotspots and gotchas.
7. Useful commands and files.
8. Likely next steps, based only on evidence.

Use responsive nav. Use compact reference tables for file maps and commands. Follow the skill's Mermaid, overflow, and delivery rules.

Write the complete HTML document to `./diagrams/` and report the path in chat.
