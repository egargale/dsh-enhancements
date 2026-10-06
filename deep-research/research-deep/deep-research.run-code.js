// DSH /research-deep orchestration template — Code Mode / `ptc` agent preset.
//
// HOW TO USE
//   This file is a TEMPLATE for the `code` argument of the `run_code` tool, NOT a
//   Node script. The main agent reads it, replaces the INPUTS block below, and
//   submits the whole program as run_code's `code` string. `tools.*` exists only
//   inside such a program.
//
// WHY NOT THE workflow TOOL
//   The shipped `ptc` agent preset disables `tool-workflow` (and `workflow-ptc`).
//   run_code is the orchestrator: it fans out parallel foreground subagents with
//   `tools.subagent({ ..., run_in_background: false })` and persists results with
//   `tools.write`. On a native profile where the workflow tool IS enabled, the
//   legacy `deep-research.workflow.js` path remains an alternative.
//
// Per item the program runs the same phases the workflow script did:
//   round 1 (plan-first) -> round 2 (gaps only) -> optional verify -> write files.

// ── INPUTS (replace this block each batch; the rest is reusable) ─────────────
const topic = "TOPIC";                          // e.g. "AI Agent Demo 2025"
const outlineDir = "TOPIC_SLUG";                 // e.g. "ai-agent-demo-2025"
const outputDir = outlineDir + "/results";       // execution.output_dir
const fieldsPath = outlineDir + "/fields.yaml";  // full fields.yaml text is read at run time
const batch = [
  // { name: "Item name", category: "Category", description: "why it matters", slug: "item_name" },
];
const maxRounds = 2;   // 1 = single pass, 2 = targeted gap refinement
const verify = true;   // run the QA/verification pass
// ─────────────────────────────────────────────────────────────────────────────

// fields.yaml is read here (not embedded) so backticks/newlines cannot break the program.
const fieldsRes = await tools.read({ file_path: fieldsPath });
const fieldsText = fieldsRes.lines.map((l) => l.text).join("\n");

const PERSONA_SKILL = "deep-research-agent";

function itemBlock(item) {
  return "name: " + item.name + "\n" +
         "category: " + (item.category || "n/a") + "\n" +
         "description: " + (item.description || "");
}

// Every child starts by loading the shared researcher persona skill itself, so the
// persona lives in one place. Children run in Code Mode too.
function childHeader() {
  return "You are an elite web researcher running as a research child.\n" +
    "FIRST load your persona and method: run a `run_code` program that does " +
    "`return await tools.skill({ name: \"" + PERSONA_SKILL + "\" })`, read it, and follow it " +
    "(plan-first, AnySearch/native web_search, Code Mode tool calls).\n" +
    "Return ONLY the requested JSON object — no prose, no code fences around the whole object.";
}

function round1Prompt(item) {
  return childHeader() + "\n\n" +
    "## Topic\n" + topic + "\n\n" +
    "## Item\n" + itemBlock(item) + "\n\n" +
    "## Field definitions (from fields.yaml)\n" + fieldsText + "\n\n" +
    "## Method\n" +
    "1. PLAN: before searching, write 5-10 diverse query variations (official/primary, comparisons, data and metrics, community/discussion, regional or niche).\n" +
    "2. SEARCH: AnySearch MCP tools when present (batch_search; get_sub_domains first for vertical domains), else the anysearch skill CLI, else tools.web_search({ queries: [...] }). Fetch thin pages with extract / tools.web_fetch.\n" +
    "3. EVALUATE: compare facts against EVERY field above; list missing fields and unverifiable values.\n" +
    "4. OUTPUT: the JSON object below. Unverifiable values: write [uncertain] and add the field name to `uncertain`. Fields with no information: add to `missing`. Values in English.\n\n" +
    "## Output shape\n" +
    '{"item":"<slug>","json":{<all field values, flat or nested by category>},"uncertain":["<field names left [uncertain]>"],"missing":["<field names with no info>"],"sources":["<url1>"],"notes":"<concise notes>","confidence":"high|medium|low"}';
}

function round2Prompt(item, json, uncertain, missing) {
  const gaps = [];
  for (const f of (missing || [])) gaps.push(f + " (missing)");
  for (const f of (uncertain || [])) gaps.push(f + " (uncertain)");
  return childHeader() + "\n\n" +
    "You previously researched this item and left gaps. Targeted re-research ONLY the listed gaps, then return the FULL updated view.\n\n" +
    "## Topic\n" + topic + "\n\n" +
    "## Item\n" + itemBlock(item) + "\n\n" +
    "## Current JSON\n" + JSON.stringify(json) + "\n\n" +
    "## Fields still missing or uncertain\n" + (gaps.length ? gaps.join("\n") : "none") + "\n\n" +
    "## Field definitions (from fields.yaml)\n" + fieldsText + "\n\n" +
    "## Method\n" +
    "1. For EACH gap run targeted searches (AnySearch batch_search, anysearch skill CLI, or tools.web_search) and extract the relevant pages.\n" +
    "2. Fill only the gap fields; keep [uncertain] and add to `uncertain` if still unverifiable.\n" +
    "3. Return the FULL merged json plus remaining uncertain/missing and new sources.\n\n" +
    "## Output shape\n" +
    '{"item":"<slug>","json":{<full merged view>},"uncertain":["..."],"missing":["..."],"sources":["<url>"],"confidence":"high|medium|low"}';
}

function verifyPrompt(item, json, sources) {
  return childHeader() + "\n\n" +
    "You are the research QA child. Verify the item's JSON claims against its cited sources.\n\n" +
    "## Topic\n" + topic + "\n\n" +
    "## Item\n" + itemBlock(item) + "\n\n" +
    "## JSON to verify\n" + JSON.stringify(json) + "\n\n" +
    "## Cited sources\n" + (sources && sources.length ? sources.join("\n") : "(none)") + "\n\n" +
    "## Method\n" +
    "1. For each claim, check it against the cited sources; if unsupported, correct it or mark [uncertain].\n" +
    "2. If sources conflict, run targeted searches to resolve; report the conflict.\n" +
    "3. Do not invent sources or facts.\n\n" +
    "## Output shape\n" +
    '{"item":"<slug>","json":{<corrected values>},"verification":{"confidence":"high|medium|low","conflicts":["..."],"notes":"..."}}';
}

// Foreground subagent result: { kind: 'foreground', runId, output: [{type:'text', text}, ...] }.
function extractText(res) {
  if (res && Array.isArray(res.output)) {
    return res.output.filter((b) => b && b.type === "text").map((b) => b.text).join("");
  }
  return typeof res === "string" ? res : "";
}

function parseJson(text) {
  const cleaned = String(text).replace(/```json/gi, "```").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("child returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function mergeDeep(a, b) {
  const out = {};
  const av = a && typeof a === "object" && !Array.isArray(a) ? a : {};
  const bv = b && typeof b === "object" && !Array.isArray(b) ? b : {};
  for (const k of Object.keys(av)) out[k] = av[k];
  for (const k of Object.keys(bv)) {
    const x = av[k], y = bv[k];
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      out[k] = mergeDeep(x, y);
    } else {
      out[k] = y;
    }
  }
  return out;
}

function unionSources(a, b) {
  const seen = {}, out = [];
  for (const s of (a || []).concat(b || [])) if (s && !seen[s]) { seen[s] = 1; out.push(s); }
  return out;
}

async function askChild(description, prompt) {
  const res = await tools.subagent({ description, prompt, run_in_background: false });
  return parseJson(extractText(res));
}

async function research(item) {
  const slug = item.slug || item.name || "item";
  let r1;
  try {
    r1 = await askChild("research " + slug, round1Prompt(item));
  } catch (e) {
    return { item: slug, ok: false, error: String(e && e.message ? e.message : e) };
  }

  let json = r1.json || {};
  let uncertain = Array.isArray(r1.uncertain) ? r1.uncertain : [];
  let missing = Array.isArray(r1.missing) ? r1.missing : [];
  let sources = Array.isArray(r1.sources) ? r1.sources : [];
  let confidence = typeof r1.confidence === "string" ? r1.confidence : undefined;
  let roundsUsed = 1;

  if (maxRounds >= 2 && (missing.length > 0 || uncertain.length > 0)) {
    try {
      const r2 = await askChild("refine " + slug, round2Prompt(item, json, uncertain, missing));
      json = mergeDeep(json, r2.json || {});
      if (Array.isArray(r2.uncertain)) uncertain = r2.uncertain;
      if (Array.isArray(r2.missing)) missing = r2.missing;
      sources = unionSources(sources, r2.sources);
      if (typeof r2.confidence === "string") confidence = r2.confidence;
      roundsUsed = 2;
    } catch (e) {
      // keep round-1 values; the item is still written and validation will flag gaps
    }
  }

  let verification = null;
  if (verify) {
    try {
      const rv = await askChild("verify " + slug, verifyPrompt(item, json, sources));
      if (rv.json) json = mergeDeep(json, rv.json);
      verification = rv.verification || null;
    } catch (e) {
      verification = { confidence: "low", conflicts: [], notes: "verification child failed: " + String(e && e.message ? e.message : e) };
    }
  }

  await tools.write({ file_path: outputDir + "/" + slug + ".json", content: JSON.stringify(json, null, 2) });
  if (verification) {
    await tools.write({ file_path: outputDir + "/" + slug + ".verification.json", content: JSON.stringify(verification, null, 2) });
  }

  return {
    item: slug,
    ok: true,
    roundsUsed,
    confidence,
    uncertain,
    missing,
    sources: sources.length,
    verification,
  };
}

const results = await Promise.all(batch.map((item) => research(item)));
const completed = results.filter((r) => r && r.ok).length;
return {
  topic,
  outputDir,
  batchSize: batch.length,
  completed,
  failed: batch.length - completed,
  results,
};
