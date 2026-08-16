#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_report.py - consolidate deep-research item JSON results into a single
markdown report (report.md).

Shipped with the `research-report` skill (DSH edition, v2). Implements the
report contract defined in SKILL.md:

  1. Table of contents with anchor links + user-selected summary fields
  2. Comparison table (rows = items, columns = summary fields + Name)
  3. Detailed content grouped by field category, with citations next to claims
  4. Cross-item synthesis (patterns, differences, contradictions)
  5. Uncertainty & confidence summary (uncertain/missing fields, verification)

Usage:
  python3 generate_report.py [results_dir] [--fields fields.yaml]
      [--summary-fields f1,f2,...] [--out report.md]

- results_dir defaults to the directory containing this script, so
  `python3 {topic}/generate_report.py` works when the script lives next to the
  item JSONs (the standard layout).
- --summary-fields: fields shown in the TOC and comparison table (comma
  separated). Default: auto-detect short/numeric fields present in the JSONs.
- --fields: fields.yaml path (auto-discovered near the results if omitted).
- --out: report file name (default report.md inside results_dir).

Item JSON conventions (from the deep-research workflow):
  {slug}.json                  - item research result (flat or category-nested)
  {slug}.verification.json     - optional verification metadata:
                                 confidence (high/medium/low), conflicts,
                                 notes.
Reserved item keys: name, item, category, description, slug, uncertain,
missing, sources, citations, verification, failed.
"""

import argparse
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

# ---------------------------------------------------------------------------
# Bilingual category mapping (CN/EN): canonical display name -> accepted keys.
# fields.yaml categories are merged in on top (see build_category_mapping).
# ---------------------------------------------------------------------------
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

UNCERTAIN_MARK = "[uncertain]"
OTHER_CATEGORY = "Other Info"

# Keys that are metadata, never report fields.
RESERVED_KEYS = {
    "name", "item", "category", "description", "slug",
    "uncertain", "missing", "sources", "citations", "verification", "failed",
    "_source_file",
}

# Preferred summary fields for TOC / comparison table (in display order).
PREFERRED_SUMMARY_FIELDS = [
    "release_date", "github_stars", "google_scholar_cites", "swe_bench_score",
    "user_scale", "valuation", "price", "score",
]


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def slugify(text):
    """GitHub-style anchor: lowercase, spaces -> '-', strip punctuation."""
    s = str(text).strip().lower()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff _-]", "", s)
    s = s.replace(" ", "-")
    return s


def fmt_value(value, depth=0):
    """Format a JSON value as markdown text (spec: complex value formatting).

    - list of dicts (key_events, funding_history): one line per dict, kv with
      ' | '
    - normal list: short lists joined with ', ', long lists with line breaks
    - nested dict: recursive, entries joined with '; ' / line breaks
    - long strings (> 100 chars): blockquote
    """
    indent = "  " * depth
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        if UNCERTAIN_MARK in value:
            return value
        if len(value) > 100:
            return "\n".join("> " + line for line in value.splitlines() or [value])
        return value
    if isinstance(value, dict):
        parts = []
        for k, v in value.items():
            if v is None or (isinstance(v, str) and not v.strip()):
                continue
            parts.append("%s%s: %s" % (indent, k, fmt_value(v, depth + 1)))
        return "\n".join(parts) if len(parts) > 1 else (parts[0] if parts else "")
    if isinstance(value, list):
        if not value:
            return ""
        if all(isinstance(x, dict) for x in value):
            lines = []
            for entry in value:
                kv = " | ".join("%s: %s" % (k, fmt_value(v, 0)) for k, v in entry.items() if v not in (None, ""))
                if kv:
                    lines.append(kv)
            return "\n".join(lines)
        items = [fmt_value(x, depth) for x in value]
        if sum(len(x) for x in items) <= 60:
            return ", ".join(x for x in items if x)
        return "\n".join("- %s" % x for x in items if x)
    return str(value)


def compact(value):
    """Single-line rendering for TOC / comparison-table cells."""
    text = fmt_value(value)
    return " ".join(line.strip() for line in text.splitlines() if line.strip())[:80]


def load_fields_yaml(fields_path):
    """Return (category_by_field, ordered_categories) from fields.yaml."""
    category_by_field, ordered = {}, []
    if fields_path is None or not fields_path.exists() or yaml is None:
        return category_by_field, ordered
    try:
        with fields_path.open(encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:  # pragma: no cover
        print("[WARN] could not parse %s: %s" % (fields_path, exc))
        return category_by_field, ordered
    for cat in data.get("field_categories", []) or []:
        cat_name = cat.get("category", "") or ""
        if cat_name and cat_name not in ordered:
            ordered.append(cat_name)
        for field in cat.get("fields", []) or []:
            fname = field.get("name", "") if isinstance(field, dict) else str(field)
            if fname and cat_name:
                category_by_field[fname] = cat_name
    return category_by_field, ordered


def build_category_mapping(fields_yaml):
    """Canonical display name -> alias keys; fields.yaml categories win."""
    mapping = OrderedDict()
    for canonical, keys in CATEGORY_MAPPING.items():
        mapping[canonical] = list(keys)
    cat_by_field, ordered = load_fields_yaml(fields_yaml)
    for canonical in ordered:  # keep fields.yaml order first
        mapping.pop(canonical, None)
        mapping[canonical] = [canonical]
    alias_to_canonical = {}
    for canonical, keys in mapping.items():
        for k in keys:
            alias_to_canonical[k] = canonical
    for field, canonical in cat_by_field.items():  # field -> category override
        alias_to_canonical.setdefault(field, canonical)
        if canonical not in mapping:
            mapping[canonical] = [canonical]
    return mapping, alias_to_canonical


# ---------------------------------------------------------------------------
# Item parsing
# ---------------------------------------------------------------------------

def item_name(data, slug):
    for key in ("name", "item"):
        if isinstance(data.get(key), str) and data[key].strip():
            return data[key].strip()
    return slug.replace("_", " ").replace("-", " ").title()


def is_uncertain(field, value, data):
    if value is None or (isinstance(value, str) and not value.strip()):
        return True
    if isinstance(value, str) and UNCERTAIN_MARK in value:
        return True
    if field in (data.get("uncertain") or []):
        return True
    return False


def collect_fields(data, alias_to_canonical):
    """Collect (category, field, value) for flat and nested JSON.

    Lookup order (spec): top level -> category mapping key -> traverse nested
    dicts. Fields not attributable to a category land in "Other Info".
    """
    collected = OrderedDict()  # category -> OrderedDict(field -> value)

    def put(category, field, value):
        if field in RESERVED_KEYS:
            return
        if is_uncertain(field, value, data):
            return  # skipped in detailed content; surfaced in uncertainty summary
        collected.setdefault(category, OrderedDict())[field] = value

    def walk(obj, category):
        for k, v in obj.items():
            if k in RESERVED_KEYS:
                continue
            canonical = alias_to_canonical.get(k)
            if canonical and isinstance(v, dict):
                for fk, fv in v.items():
                    put(canonical, fk, fv)
            elif isinstance(v, dict):
                walk(v, category)
            elif canonical:
                put(canonical, k, v)
            else:
                put(category, k, v)

    walk(data, OTHER_CATEGORY)
    return collected


def load_items(results_dir):
    """Return list of (slug, data, verification) sorted by filename."""
    items = []
    for json_path in sorted(Path(results_dir).glob("*.json")):
        if json_path.name.endswith(".verification.json"):
            continue
        try:
            with json_path.open(encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            print("[WARN] could not read %s: %s" % (json_path, exc))
            continue
        slug = json_path.stem
        verification = {}
        vpath = json_path.with_name(slug + ".verification.json")
        if vpath.exists():
            try:
                with vpath.open(encoding="utf-8") as f:
                    verification = json.load(f) or {}
            except Exception:
                verification = {}
        items.append((slug, data, verification))
    return items


def detect_summary_fields(items, alias_to_canonical):
    """Auto-detect short/numeric fields present in at least two items."""
    present = {}
    for _, data, _ in items:
        for k, v in data.items():
            if k in RESERVED_KEYS or isinstance(v, (dict, list)):
                continue
            if is_uncertain(k, v, data):
                continue
            present.setdefault(k, []).append(compact(v))
    candidates = []
    for name in PREFERRED_SUMMARY_FIELDS + sorted(present):
        if name in present and len(present[name]) >= 2:
            candidates.append(name)
    return candidates[:5]


# ---------------------------------------------------------------------------
# Report sections
# ---------------------------------------------------------------------------

def sources_markdown(data):
    """Numbered source list from item's `sources`."""
    sources = data.get("sources") or []
    if not sources:
        return ""
    lines = []
    for i, s in enumerate(sources, 1):
        if isinstance(s, dict):
            url = s.get("url", "")
            note = s.get("title") or s.get("note") or ""
            lines.append("[%d] %s%s" % (i, url, (" \u2014 " + note) if note else ""))
        else:
            lines.append("[%d] %s" % (i, s))
    return "\n".join(lines)


def field_citations(field, data):
    """Inline citation markers for a field when the JSON carries a per-field
    `citations` map (field name -> list of sources). Otherwise empty."""
    citations = data.get("citations") or {}
    if isinstance(citations, dict) and field in citations:
        refs = citations[field]
        if isinstance(refs, list) and refs:
            sources = data.get("sources") or []
            indices = []
            for r in refs:
                try:
                    indices.append(sources.index(r) + 1)
                except ValueError:
                    indices.append(len(sources) + 1)
            return " " + "".join("[%d]" % i for i in indices)
    return ""


def render_toc(items, summary_fields):
    lines = ["# Table of Contents", ""]
    for idx, (slug, data, _) in enumerate(items, 1):
        name = item_name(data, slug)
        parts = ["%d. [%s](#%s)" % (idx, name, slugify(name))]
        extra = []
        for f in summary_fields:
            if f in data:
                extra.append("%s: %s" % (f, compact(data[f])))
        if data.get("failed"):
            extra.append("(research failed)")
        if extra:
            parts.append(" - " + " | ".join(extra))
        lines.append("".join(parts))
    return "\n".join(lines) + "\n"


def render_comparison(items, summary_fields):
    header = ["Name"] + list(summary_fields)
    rows = []
    for slug, data, _ in items:
        name = item_name(data, slug)
        row = [name]
        for f in summary_fields:
            v = data.get(f)
            row.append(compact(v) if v is not None and not is_uncertain(f, v, data) else "—")
        rows.append(row)
    widths = [max(len(r[i]) for r in [header] + rows) for i in range(len(header))]
    out = ["# Comparison", ""]
    out.append("| " + " | ".join(h.ljust(widths[i]) for i, h in enumerate(header)) + " |")
    out.append("| " + " | ".join("-" * widths[i] for i in range(len(header))) + " |")
    for row in rows:
        out.append("| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(row)) + " |")
    return "\n".join(out) + "\n"


def render_details(items, alias_to_canonical):
    out = ["# Detailed Content", ""]
    for slug, data, _ in items:
        name = item_name(data, slug)
        out.append("## %s" % name)
        out.append("")
        if data.get("failed"):
            out.append("> Research failed for this item (no results).")
            out.append("")
            continue
        fields = collect_fields(data, alias_to_canonical)
        if not fields:
            out.append("_No reportable fields (all values uncertain or empty)._")
            out.append("")
        for category, entries in fields.items():
            out.append("### %s" % category)
            out.append("")
            for field, value in entries.items():
                rendered = fmt_value(value)
                if not rendered:
                    continue
                if "\n" in rendered:
                    out.append("**%s**" % field)
                    out.append("")
                    out.append(rendered)
                else:
                    out.append("- **%s**: %s%s" % (field, rendered, field_citations(field, data)))
            out.append("")
        src = sources_markdown(data)
        if src:
            out.append("**Sources**")
            out.append("")
            out.append(src)
            out.append("")
    return "\n".join(out) + "\n"


def render_synthesis(items, summary_fields):
    out = ["# Cross-Item Synthesis", ""]
    if not items:
        out.append("_No items to synthesize._")
        return "\n".join(out) + "\n"
    out.append("## Summary-field comparison")
    out.append("")
    for f in summary_fields:
        vals = []
        for slug, data, _ in items:
            if f in data and not is_uncertain(f, data[f], data):
                vals.append("%s: %s" % (item_name(data, slug), compact(data[f])))
        if vals:
            out.append("- **%s** \u2014 %s" % (f, "; ".join(vals)))
    out.append("")
    out.append("## Category coverage")
    out.append("")
    coverage = OrderedDict()
    for slug, data, _ in items:
        for cat in collect_fields(data, {}):
            coverage.setdefault(cat, []).append(item_name(data, slug))
    for cat, names in coverage.items():
        out.append("- **%s** \u2014 present in %d/%d item(s)%s" % (
            cat, len(names), len(items), (": " + ", ".join(names)) if len(names) < len(items) else ""))
    out.append("")
    conflicts = []
    for slug, data, verification in items:
        for c in verification.get("conflicts") or []:
            conflicts.append("%s: %s" % (item_name(data, slug), c))
    if conflicts:
        out.append("## Contradictions (from verification)")
        out.append("")
        for c in conflicts:
            out.append("- %s" % c)
        out.append("")
    else:
        out.append("No source contradictions were recorded in the verification metadata.")
        out.append("")
    return "\n".join(out) + "\n"


def render_uncertainty(items):
    out = ["# Uncertainty & Confidence", ""]
    for slug, data, verification in items:
        name = item_name(data, slug)
        out.append("## %s" % name)
        out.append("")
        uncertain_fields = list(data.get("uncertain") or [])
        seen = set(uncertain_fields)
        for k, v in data.items():
            if k not in RESERVED_KEYS and isinstance(v, str) and UNCERTAIN_MARK in v and k not in seen:
                uncertain_fields.append(k)
                seen.add(k)
        if uncertain_fields:
            out.append("**Uncertain fields**:")
            out.append("")
            for f in uncertain_fields:
                out.append("- %s" % f)
            out.append("")
        missing = data.get("missing") or []
        if missing:
            out.append("**Missing fields**:")
            out.append("")
            for f in missing:
                out.append("- %s" % f)
            out.append("")
        conf = verification.get("confidence")
        if conf:
            out.append("**Verification confidence**: %s" % conf)
        conflicts = verification.get("conflicts") or []
        if conflicts:
            out.append("**Conflicts**:")
            out.append("")
            for c in conflicts:
                out.append("- %s" % c)
            out.append("")
        notes = verification.get("notes")
        if notes:
            out.append("**Verification notes**: %s" % (notes if isinstance(notes, str) else "; ".join(notes)))
        if not (uncertain_fields or missing or conf or conflicts or notes):
            out.append("_No uncertainty flags; verification metadata absent._")
        out.append("")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate the consolidated deep-research markdown report")
    parser.add_argument("results_dir", nargs="?", default=None,
                        help="Directory with item JSONs (default: this script's directory)")
    parser.add_argument("--fields", "-f", default=None, help="Path to fields.yaml (auto-discovered if omitted)")
    parser.add_argument("--summary-fields", "-s", default=None,
                        help="Comma-separated fields for TOC + comparison table (default: auto-detect)")
    parser.add_argument("--out", "-o", default="report.md", help="Report filename (default: report.md)")
    args = parser.parse_args()

    results_dir = Path(args.results_dir) if args.results_dir else Path(__file__).resolve().parent
    if not results_dir.is_dir():
        print("[ERROR] results dir not found: %s" % results_dir)
        sys.exit(1)

    fields_path = Path(args.fields) if args.fields else None
    if fields_path is None:
        for candidate in (results_dir / "fields.yaml", results_dir.parent / "fields.yaml", Path.cwd() / "fields.yaml"):
            if candidate.exists():
                fields_path = candidate
                break

    mapping, alias_to_canonical = build_category_mapping(fields_path)
    items = load_items(results_dir)
    if not items:
        print("[ERROR] no item JSONs found in %s" % results_dir)
        sys.exit(1)

    summary_fields = [f.strip() for f in (args.summary_fields or "").split(",") if f.strip()]
    if not summary_fields:
        summary_fields = detect_summary_fields(items, alias_to_canonical)
        print("[INFO] auto-detected summary fields: %s" % (", ".join(summary_fields) or "none"))

    sections = [
        render_toc(items, summary_fields),
        render_comparison(items, summary_fields),
        render_details(items, alias_to_canonical),
        render_synthesis(items, summary_fields),
        render_uncertainty(items),
    ]
    report_path = results_dir / args.out
    report_path.write_text("\n".join(sections), encoding="utf-8")

    print("Report written: %s" % report_path)
    print("Items: %d | Summary fields: %s" % (len(items), ", ".join(summary_fields) or "none"))
    if fields_path:
        print("fields.yaml: %s" % fields_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
