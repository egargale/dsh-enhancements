---
name: research-report
description: Summarize deep-research JSON results into a single markdown report — comparison table, cross-item synthesis, uncertainty and confidence summary, citations per section.
whenToUse: Use after /research-deep has produced per-item JSON results (and verification metadata), when the user wants the final consolidated markdown report.
user-invocable: true
---

# Research Report — Summary Report (DSH edition, v2)

## Trigger
`/research-report`

## Workflow

### Step 1 — Locate results
Use `glob` to find `*/outline.yaml`; `read` the topic and the execution `output_dir` config. List the JSON results and any `*.verification.json` metadata in `{output_dir}`.

### Step 2 — Scan optional summary fields
Read all JSON results and extract fields suitable for a table of contents and comparison table (numeric/short metrics), e.g.: github_stars, google_scholar_cites, swe_bench_score, user_scale, valuation, release_date, price.
Use `ask_user_question` to ask the user:
- Which fields to display in the TOC and comparison table besides the item name?
- Provide dynamic options built from the actual fields found in the JSONs.

### Step 3 — Use the shipped report script
The conversion script ships with this skill — `generate_report.py` in **this skill's directory** (find it relative to the skill base directory via `glob`). Copy it into `{topic}/` (or run it directly from the skill dir, passing the results directory). The script implements:
- Read all JSON from the output_dir, fields.yaml, and verification metadata (`*.verification.json` when present).
- Cover every field value from each JSON; skip fields whose value contains `[uncertain]` or that are listed in the item's `uncertain` array.
- Support BOTH flat JSON (fields at top level) and nested JSON (fields grouped under category dicts). Field lookup order: top level -> category mapping key -> traverse nested dicts.
- Bilingual category mapping (CN/EN) so fields.yaml names and JSON keys resolve either way:
```python
CATEGORY_MAPPING = {
    "Basic Info": ["basic_info", "Basic Info", "基本信息"],
    "Technical Features": ["technical_features", "technical_characteristics", "Technical Features", "技术特性"],
    "Performance Metrics": ["performance_metrics", "performance", "Performance Metrics", "性能指标"],
    "Milestone Significance": ["milestone_significance", "milestones", "Milestone Significance", "里程碑意义"],
    "Business Info": ["business_info", "commercial_info", "Business Info", "商业信息"],
    "Competition & Ecosystem": ["competition_ecosystem", "competition", "Competition & Ecosystem", "竞争与生态"],
    "History": ["history", "History", "历史"],
    "Market Positioning": ["market_positioning", "market", "Market Positioning", "市场定位"],
}
```
- Report structure (save to `{topic}/report.md`):
  1. **Table of contents** with anchor links; each item shows the user-selected summary fields, e.g. `1. [GitHub Copilot](#github-copilot) - Stars: 10k | Score: 85%`
  2. **Comparison table**: rows = items, columns = the user-selected summary fields (plus Name); values from the JSONs.
  3. **Detailed content** grouped by field category, per item, with inline citations from each item's `sources` placed next to the claims they support.
  4. **Cross-item synthesis**: patterns across items, notable differences, and any contradictions found in verification metadata.
  5. **Uncertainty & confidence summary**: per item — uncertain fields, `[uncertain]` values, verification confidence (high/medium/low) and conflicts.

### Step 4 — Run and deliver
Run the script (from `{topic}/`, or point it at the results dir):
```
python3 {topic}/generate_report.py --summary-fields <f1,f2,...>
```
Omit `--summary-fields` to auto-detect fields present across items. Confirm `{topic}/report.md` was produced; show the user a preview.

## Output
`{topic}/report.md`
