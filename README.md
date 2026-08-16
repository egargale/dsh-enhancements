# dsh-enhancements

Enhancements for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): skill families and optional plugins — deep research (skills + subagents + workflow tool) and visual explanation (self-contained HTML diagrams and reviews).

- `deep-research/` — research skills and workflow, adapted from [Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills). See `deep-research/README.md`.
- `visual-explainer/` — visual-explainer skill family (HTML diagrams, diff/plan reviews, slide decks, comparison tables), ported from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer). See `visual-explainer/README.md`.
- `visual-explainer-plugin/` — optional ad-hoc DSH plugin: deterministic quick-render tool (`visual_explainer_render_quick`) + Web Client chat node, built against a DSH source checkout. See `visual-explainer-plugin/README.md`.

## License

MIT — see [LICENSE](LICENSE). Adapted from [Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills), which is MIT-licensed (© 2026 Lan Zheng), and ported from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer), which is MIT-licensed (© 2025 Nico Bailon); the upstream copyright notices are retained as required by the MIT license.