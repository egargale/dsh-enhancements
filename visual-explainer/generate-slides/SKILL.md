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

# Generate Slides (DSH, v2)

## DSH tool invocation (Code Mode)

Only `run_code` is callable directly; every other tool is `await tools.<name>({...})` **inside a `run_code` program** — here `tools.skill`, `tools.read`/`tools.glob`/`tools.grep`, `tools.bash`, `tools.write`, and `tools.present`. A bare `skill(...)` / `write(...)` call fails with `unknown tool "…": only run_code is callable directly`.

## Trigger
`/generate-slides <topic> [--pptx]`

## Steps

1. Run a `run_code` program that calls `await tools.skill({ name: 'visual-explainer' })`. Its result's `resourceBase` (kind: directory) holds the references, templates, and command templates.
2. Follow `commands/generate-slides.md` in that skill's directory, with `$@` = the topic text the user typed after the command name.
3. Plan the deck, write the complete HTML deck to `./diagrams/` with `tools.write`, run the PPTX exporter only when `--pptx` was given and dependencies are available (via `tools.bash`), declare the produced files with `tools.present` (1–4 per call), and report the paths in chat.
