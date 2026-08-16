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

# Fact Check (DSH)

## Trigger
`/fact-check [file]`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/fact-check.md` in that skill's directory, with `$@` = the document path the user typed after the command name (or empty for the most recent `./diagrams/*.html`).
3. Verify every claim against source and git history, correct errors in place, and report the path in chat.
