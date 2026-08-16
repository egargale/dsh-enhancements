---
name: generate-slides
description: Generate a slide deck as a self-contained HTML page (optionally export to PPTX)
whenToUse: Triggered by the `/generate-slides` command in the DSH composer or by a matching natural-language request.
user-invocable: true
license: MIT
metadata:
  author: nicobailon (DeepSeek Harness port)
  upstream: https://github.com/nicobailon/visual-explainer
---

# Generate Slides (DSH)

## Trigger
`/generate-slides <topic> [--pptx]`

## Steps

1. Load the `visual-explainer` skill (call the `skill` tool with name `visual-explainer`). Its base directory (`resourceBase`) holds the references, templates, and command templates.
2. Follow `commands/generate-slides.md` in that skill's directory, with `$@` = the topic text the user typed after the command name.
3. Plan the deck, write the complete HTML deck to `./diagrams/`, run the PPTX exporter only when `--pptx` was given and dependencies are available, and report the path in chat.
