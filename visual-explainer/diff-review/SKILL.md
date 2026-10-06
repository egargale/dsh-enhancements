---
name: diff-review
description: Generate a visual HTML diff review — before/after architecture, KPIs, code review, decision log
whenToUse: Triggered by the `/diff-review` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Diff Review (DSH, v2)

## DSH tool invocation (Code Mode)

Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here `tools.skill`, `tools.read`/`tools.glob`/`tools.grep`, `tools.bash`, `tools.write`, and `tools.present`. A bare `skill(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/diff-review [git-ref] [--quick]`

## Steps

1. Run a `run_code` program that calls `await tools.skill({ name: 'visual-explainer' })`. Its result's `resourceBase` (kind: directory) holds the references, templates, and command templates.
2. Follow `commands/diff-review.md` in that skill's directory, with `$@` = the argument text the user typed after the command name (branch, commit, range, PR, `HEAD`, or empty for default `main`).
3. Gather and verify git facts first, then write the complete HTML document to `./diagrams/` with `tools.write`, declare it with `tools.present`, and report the path in chat.
