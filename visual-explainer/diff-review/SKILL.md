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

# Diff Review (DSH)

## Trigger
`/diff-review [git-ref] [--quick]`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/diff-review.md` in that skill's directory, with `$@` = the argument text the user typed after the command name (branch, commit, range, PR, `HEAD`, or empty for default `main`).
3. Gather and verify git facts first, then write the complete HTML document to `./diagrams/` and report the path in chat.
