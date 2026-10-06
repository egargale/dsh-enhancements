---
name: generate-web-diagram
description: Generate a standalone self-contained HTML diagram for any topic (architecture, flow, timeline, matrix, …)
whenToUse: Triggered by the `/generate-web-diagram` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Generate Web Diagram (DSH, v2)

## DSH tool invocation (Code Mode)

Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here `tools.skill`, `tools.read`/`tools.glob`/`tools.grep`, `tools.bash`, `tools.write`, and `tools.present`. A bare `skill(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/generate-web-diagram <topic> [--quick]`

## Steps

1. Run a `run_code` program that calls `await tools.skill({ name: 'visual-explainer' })`. Its result's `resourceBase` (kind: directory) holds the references, templates, and command templates.
2. Follow `commands/generate-web-diagram.md` in that skill's directory, with `$@` = the topic text the user typed after the command name.
3. Use the skill's reference routing and final checklist; write the complete HTML document to `./diagrams/` with `tools.write`, declare it with `tools.present`, and report the path in chat.

Model invocation: when the user asks for a diagram or visual explanation without naming a command, follow this template directly (or route via the core skill).
