---
name: plan-review
description: Compare an implementation plan against the current codebase as a visual HTML review
whenToUse: Triggered by the `/plan-review` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Plan Review (DSH)

## Trigger
`/plan-review <plan-path-or-text> [--quick]`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/plan-review.md` in that skill's directory, with `$@` = the plan path or plan text the user typed after the command name.
3. Verify the plan against the code first, then write the complete HTML document to `./diagrams/` and report the path in chat.
