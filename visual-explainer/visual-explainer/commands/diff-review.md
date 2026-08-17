---
description: Generate a visual HTML diff review — before/after architecture comparison with code review analysis
skill: visual-explainer
---
Load the visual-explainer skill and generate a self-contained HTML diff review.

## Quick mode

Only use quick mode when `$@` contains the literal `--quick` flag. Remove the flag before scope detection. Complete the same evidence gathering and verification below, then read `./quick/README.md` and `./quick/schema.json` and express the review as a compact spec. Write the spec with `tools.write({ file_path: './diagrams/.<name>.spec.json', content: … })` (inside `run_code`), run `node <skill-dir>/quick/render.mjs <spec.json> <output.html>` via `tools.bash(...)` (or call the `visual_explainer_render_quick` tool when the optional plugin is installed), remove the spec file after success, and report the HTML path. If the review does not fit the schema, validation fails, rendering errors, or `node` is unavailable, generate complete HTML and use the normal render flow. Without `--quick`, preserve full HTML behavior.

## Scope detection

Interpret `$@` as a branch, commit, range, PR, or `HEAD`:
- Branch name (e.g. `main`, `develop`): working tree vs that branch
- Commit hash: that specific commit's diff (`git show <hash>`)
- `HEAD`: uncommitted changes only (`git diff` and `git diff --staged`)
- PR number (e.g. `#42`): `gh pr diff 42` when `gh` is available
- Range (e.g. `abc123..def456`): diff between two commits
- No argument: default to `main` (or `master` if `main` doesn't exist)

## Data gathering before HTML

Run the relevant `git` commands via `bash` for: diff stats, name-status, changed files, line counts, public API/type/function changes, added/removed files, docs/changelog changes, tests touched, dependencies/config changes. Read changed files in full plus surrounding code paths needed to validate behavior. If reviewing committed work, read commit messages. If this session created the work, use the conversation and any progress notes for rationale.

## Source verification

Before generating, know and cite:
- exact changed files and line-count scope;
- each function/type/module name referenced;
- before/after behavior for important changes;
- likely coupling and test impact.

Use file paths, command outputs, or file:line evidence. Do not invent rationale or code paths. Build the structured fact sheet from the skill's fact-gathering discipline and don't deviate from it.

## Required page sections

1. Executive summary: intuition (why these changes exist), problem solved, factual scope.
2. KPI dashboard: lines added/removed, files changed, new modules, test counts, housekeeping (CHANGELOG/docs updated?) with badges.
3. File map: full tree, color-coded new/modified/deleted; compact, `<details>` if long.
4. Architecture impact: Mermaid or hybrid diagram when relationships matter.
5. Before/after behavior: side-by-side visual comparison per major area of change.
6. Flow diagrams: Mermaid flowchart/sequence/state for new lifecycles or pipelines.
7. Risk review: correctness, tests, API compatibility, security/privacy, performance, maintainability.
8. Coupling map: dependencies, hidden coupling, migration/release concerns.
9. Code review: structured Good/Bad/Ugly cards with specific file:line references; "None found" when a category is empty.
10. Decision log: styled cards with Decision / Rationale / Alternatives rejected / Confidence.
11. Review recommendation: merge/readiness, blockers, follow-ups.

Use diff color language consistently: red removed/before, green added/after, amber modified/risk, blue neutral context. Use responsive section navigation for 4+ sections. Follow the skill's Mermaid and overflow rules.

Write the complete HTML document to `./diagrams/` and report the path in chat.
