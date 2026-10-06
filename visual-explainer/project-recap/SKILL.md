---
name: project-recap
description: Generate a visual project recap for context switching back to a repo
whenToUse: Triggered by the `/project-recap` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Project Recap (DSH, v2)

## DSH tool invocation (Code Mode)

Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here `tools.skill`, `tools.read`/`tools.glob`/`tools.grep`, `tools.bash`, `tools.write`, and `tools.present`. A bare `skill(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/project-recap [--quick]`

## Steps

1. Run a `run_code` program that calls `await tools.skill({ name: 'visual-explainer' })`. Its result's `resourceBase` (kind: directory) holds the references, templates, and command templates.
2. Follow `commands/project-recap.md` in that skill's directory.
3. Scan git history and project files first, then write the complete HTML document to `./diagrams/` with `tools.write`, declare it with `tools.present`, and report the path in chat.
