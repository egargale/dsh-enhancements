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

# Generate Web Diagram (DSH)

## Trigger
`/generate-web-diagram <topic> [--quick]`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/generate-web-diagram.md` in that skill's directory, with `$@` = the topic text the user typed after the command name.
3. Use the skill's reference routing and final checklist; write the complete HTML document to `./diagrams/` and report the path in chat.

Model invocation: when the user asks for a diagram or visual explanation without naming a command, follow this template directly (or route via the core skill).
