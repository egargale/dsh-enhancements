---
name: fact-check
description: Verify a generated document (HTML or MD) against actual code and git history
whenToUse: Triggered by the `/fact-check` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Fact Check (DSH, v2)

## DSH tool invocation (Code Mode)

Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here `tools.skill`, `tools.read`/`tools.glob`/`tools.grep`, `tools.bash`, `tools.write`, and `tools.present`. A bare `skill(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/fact-check [file]`

## Steps

1. Run a `run_code` program that calls `await tools.skill({ name: 'visual-explainer' })`. Its result's `resourceBase` (kind: directory) holds the references, templates, and command templates.
2. Follow `commands/fact-check.md` in that skill's directory, with `$@` = the document path the user typed after the command name (or empty for the most recent `./diagrams/*.html`).
3. Verify every claim against source and git history, correct errors in place with `tools.write`, declare the corrected file with `tools.present`, and report the path in chat.
