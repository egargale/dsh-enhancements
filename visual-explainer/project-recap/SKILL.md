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

# Project Recap (DSH)

## Trigger
`/project-recap [--quick]`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/project-recap.md` in that skill's directory.
3. Scan git history and project files first, then write the complete HTML document to `./diagrams/` and report the path in chat.
