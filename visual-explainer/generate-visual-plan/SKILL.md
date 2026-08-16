---
name: generate-visual-plan
description: Generate a visual implementation plan as a self-contained HTML page
whenToUse: Triggered by the `/generate-visual-plan` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Generate Visual Plan (DSH)

## Trigger
`/generate-visual-plan <topic>`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/generate-visual-plan.md` in that skill's directory, with `$@` = the topic text the user typed after the command name.
3. Research the repo first, then write the complete HTML document to `./diagrams/` and report the path in chat.
