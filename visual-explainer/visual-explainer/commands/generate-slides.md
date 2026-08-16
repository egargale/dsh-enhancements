---
description: Generate a slide deck as a self-contained HTML page
skill: visual-explainer
---
Load the visual-explainer skill and generate a slide deck for: $@

If `$@` contains the literal `--pptx` flag, remove that flag from the topic. Generate the HTML slide deck first, then run the best-effort static exporter: `node <skill-dir>/pptx/export.mjs <deck.html> <deck.pptx>` (see `./pptx/README.md` for the `node-html-parser` + `pptxgenjs` dependency setup). If the exporter dependencies are not available, deliver the HTML deck and explain that PPTX export needs those dependencies. Tell the user that the HTML deck remains the source of truth and the PPTX will not preserve animations, reader navigation, responsive layout, custom fonts, live Mermaid/Chart.js/SVG/canvas rendering, or JavaScript behavior.

Before writing HTML, read `./templates/slide-deck.html`, `./references/slide-patterns.md`, and only the shared CSS/library sections needed for the source.

Plan the deck first: inventory the source, map every item to slides, choose a narrative arc, and assign a composition to each slide. Use the 10 slide types and nav chrome from `slide-patterns.md`/`slide-deck.html`, including carousel dots, prev/next, slide count, and keyboard controls. Keep each slide to `100dvh`; split dense content across slides rather than scrolling or dropping content.

Use visual-first slides: diagrams, charts, tables, and SVG accents. DSH has no bundled image generation — do not try to generate images; use CSS gradients and SVG decorations instead. Vary compositions; three centered slides in a row is a smell.

Write the complete HTML deck to `./diagrams/` and report the path in chat.
