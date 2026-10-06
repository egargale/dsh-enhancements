# dsh-enhancements

Enhancements for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): skill families and optional plugins — deep research (skills + subagents + workflow tool) and visual explanation (self-contained HTML diagrams and reviews).

- `deep-research/` — research skills and workflow, adapted from [Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills). See `deep-research/README.md`.
- `visual-explainer/` — visual-explainer skill family (HTML diagrams, diff/plan reviews, slide decks, comparison tables), ported from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer). See `visual-explainer/README.md`.
- `visual-explainer-plugin/` — optional ad-hoc DSH plugin: deterministic quick-render tool (`visual_explainer_render_quick`) + Web Client chat node, built against a DSH source checkout. See `visual-explainer-plugin/README.md`.
- `gpt-researcher-plugin/` — DSH plugin: a tested TypeScript port of [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) as native tools (full research pipeline, deep research, the multi-agent editorial flow, retrievers, scrapers, context compression). Ships 193 unit/integration tests plus a real headless smoke test. See `gpt-researcher-plugin/README.md`.
- `gpt-researcher-analysis/` — the analysis artifact behind that port: a 2 900-line implementation-ready spec of upstream, with verbatim prompts and the discrepancies found while porting. See `gpt-researcher-analysis/SPEC.md`.

## License

MIT — see [LICENSE](LICENSE). Adapted from [Weizhena/Deep-Research-skills](https://github.com/Weizhena/Deep-Research-skills), which is MIT-licensed (© 2026 Lan Zheng), and ported from [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer), which is MIT-licensed (© 2025 Nico Bailon); the upstream copyright notices are retained as required by the MIT license. The visual-explainer port additionally ships the upstream MIT text verbatim as a sub-license at `visual-explainer/LICENSE` and `visual-explainer-plugin/LICENSE`.

`gpt-researcher-plugin/` ports [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher), which is **Apache-2.0** (© Assaf Elovic and contributors). It ships that license verbatim at `gpt-researcher-plugin/LICENSE` and records its modifications in `gpt-researcher-plugin/NOTICE` as Apache-2.0 §4(b) requires; the ported work remains under Apache-2.0 terms.