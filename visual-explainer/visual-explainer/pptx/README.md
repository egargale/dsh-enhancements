# Best-effort PPTX export (DeepSeek Harness edition)

`export.mjs` converts a generated visual-explainer HTML slide deck into a static `.pptx` file.

The HTML deck remains the source of truth. This exporter is intentionally best-effort and supports simple decks with `<section class="slide">` elements. It extracts slide titles, short text, bullets, simple tables, code blocks, and Mermaid source placeholders.

It does not preserve:

- animations or transitions;
- reader rail, outline, help, deep links, or resume state;
- responsive layout;
- custom web fonts;
- live Mermaid rendering, Chart.js, SVG, canvas, or JavaScript behavior.

## Usage in DSH

Dependencies (`node-html-parser`, `pptxgenjs`) are NOT bundled. Install them once into a scratch directory (do not pollute the project):

```bash
mkdir -p /tmp/ve-pptx-deps && cd /tmp/ve-pptx-deps
npm init -y >/dev/null && npm install node-html-parser pptxgenjs --no-audit --no-fund
```

Then run the exporter from that directory so the imports resolve:

```bash
cd /tmp/ve-pptx-deps && node <skill-dir>/pptx/export.mjs <deck.html> <deck.pptx>
```

`<skill-dir>` is this skill's base directory (the `skill` tool reports it as `resourceBase`). If you omit the output path, the exporter writes beside the input with a `.pptx` suffix.

If the dependencies are not available, deliver the HTML deck and explain that PPTX export needs them. Use the HTML output for final fidelity; use the `.pptx` as a portable static handoff when a presentation file is required.
