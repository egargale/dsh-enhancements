// DSH workflow script v2: deep-research batch with plan-first method,
// two-pass gap refinement and optional verification. Consumed by the workflow tool.
// No fs/network here — the child agents do the work.
// args: { topic, batch: [{name, category, description, slug}], fieldsText,
//         maxRounds?: 1|2 (default 2), verify?: boolean (default false) }

const topic = args.topic || "research topic";
const batch = Array.isArray(args.batch) ? args.batch : [];
const fieldsText = args.fieldsText || "";
const maxRounds = args.maxRounds === 1 ? 1 : 2;
const doVerify = args.verify === true;

function mergeDeep(a, b) {
  const out = {};
  const aKeys = a && typeof a === "object" ? Object.keys(a) : [];
  const bKeys = b && typeof b === "object" ? Object.keys(b) : [];
  for (const k of aKeys) out[k] = a[k];
  for (const k of bKeys) {
    const av = a ? a[k] : undefined;
    const bv = b[k];
    if (bv !== null && typeof bv === "object" && !Array.isArray(bv) &&
        av !== null && typeof av === "object" && !Array.isArray(av)) {
      out[k] = mergeDeep(av, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}
function unionSources(a, b) {
  const seen = {};
  const out = [];
  for (const s of (a || [])) if (!seen[s]) { seen[s] = 1; out.push(s); }
  for (const s of (b || [])) if (!seen[s]) { seen[s] = 1; out.push(s); }
  return out;
}

const baseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    item: { type: "string" },
    json: { type: "object" },
    uncertain: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["item", "json"],
};
const gapSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    item: { type: "string" },
    json: { type: "object" },
    uncertain: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["item", "json"],
};
const verifySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    item: { type: "string" },
    json: { type: "object" },
    verification: {
      type: "object",
      properties: {
        confidence: { type: "string" },
        conflicts: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
    },
  },
  required: ["item", "json", "verification"],
};

function itemBlock(item) {
  return "name: " + item.name + "\n" +
         "category: " + (item.category || "n/a") + "\n" +
         "description: " + (item.description || "");
}

function round1Prompt(item) {
  return "You are an elite web researcher (deep-research-agent persona). Research the item below for the topic '" +
    topic + "' and return structured JSON.\n\n" +
    "## Item\n" + itemBlock(item) + "\n\n" +
    "## Field definitions (from fields.yaml)\n" + fieldsText + "\n\n" +
    "## Method (follow in order)\n" +
    "1. PLAN: before searching, write 5-10 diverse query variations (official/primary sources, comparisons, data and metrics, community/discussion, regional or niche angles). Keep the list in your notes.\n" +
    "2. SEARCH: use the anysearch search/batch_search tools (general queries; call get_sub_domains first for vertical domains like academic/finance/legal). If anysearch tools are unavailable, use the built-in web_search tool instead. Fetch full pages with anysearch extract when snippets are thin.\n" +
    "3. EVALUATE: compare gathered facts against EVERY field defined above. Identify missing fields and values you cannot verify.\n" +
    "4. OUTPUT: return the JSON object. Values you cannot verify: write [uncertain] and add the field name to the uncertain array. Fields with no information at all: add to the missing array. Keep values in English.\n\n" +
    "## Context discipline\n" +
    "Keep notes concise (a running bullet list of queries run, key facts, sources). Do NOT append raw search dumps to context.\n\n" +
    "## Output shape\n" +
    '{"item": "<slug>", "json": {<all field values, flat or nested by category>}, "uncertain": ["<field names left [uncertain]>"], "missing": ["<field names with no info>"], "sources": ["<url1>"], "notes": "<concise notes>"}';
}

function round2Prompt(item, missing, uncertain) {
  const gaps = [];
  for (const f of (missing || [])) gaps.push(f + " (missing)");
  for (const f of (uncertain || [])) gaps.push(f + " (uncertain)");
  return "You previously researched this item and left gaps. Targeted re-research ONLY the listed gaps, then return updated values.\n\n" +
    "## Item\n" + itemBlock(item) + "\n\n" +
    "## Fields still missing or uncertain\n" + (gaps.length ? gaps.join("\n") : "none") + "\n\n" +
    "## Field definitions (from fields.yaml)\n" + fieldsText + "\n\n" +
    "## Method\n" +
    "1. For EACH gap, run targeted searches (anysearch search/batch_search, fallback web_search) and extract the relevant pages.\n" +
    "2. Fill only the gap fields. Leave [uncertain] and add to the uncertain array if still unverifiable.\n" +
    "3. Return the FULL updated json (merged view), the remaining uncertain and missing arrays, and new sources.\n\n" +
    "## Output shape\n" +
    '{"item": "<slug>", "json": {<full merged view>}, "uncertain": ["..."], "missing": ["..."], "sources": ["<url>"]}';
}

function verifyPrompt(item, json, sources) {
  return "You are a research QA agent. Verify the item's JSON claims against its cited sources.\n\n" +
    "## Item\n" + itemBlock(item) + "\n\n" +
    "## JSON to verify\n" + JSON.stringify(json) + "\n\n" +
    "## Cited sources\n" + (sources && sources.length ? sources.join("\n") : "(none)") + "\n\n" +
    "## Method\n" +
    "1. For each claim, check it against the cited sources. If a claim is unsupported by its source, correct it or mark [uncertain].\n" +
    "2. If sources conflict on a fact, run additional targeted searches to resolve; report the conflict.\n" +
    "3. Do not invent sources; do not invent facts.\n\n" +
    "## Output shape\n" +
    '{"item": "<slug>", "json": {<corrected values>}, "verification": {"confidence": "high|medium|low", "conflicts": ["..."], "notes": "..."}}';
}

phase("deep-research-batch");
log("batch size: " + batch.length + ", maxRounds: " + maxRounds + ", verify: " + doVerify);

const results = await parallel(
  batch.map(function (item) {
    return async function () {
      phase("round-1");
      const r1 = await agent(round1Prompt(item), { label: item.slug + "-r1", schema: baseSchema });
      if (r1 === null) return { item: item.slug, failed: true, reason: "round-1 research agent failed" };

      let json = r1.json || {};
      let uncertain = Array.isArray(r1.uncertain) ? r1.uncertain : [];
      let missing = Array.isArray(r1.missing) ? r1.missing : [];
      let sources = Array.isArray(r1.sources) ? r1.sources : [];
      let roundsUsed = 1;

      if (maxRounds >= 2 && (missing.length > 0 || uncertain.length > 0)) {
        phase("round-2");
        const r2 = await agent(round2Prompt(item, missing, uncertain), { label: item.slug + "-r2", schema: gapSchema });
        if (r2 !== null) {
          json = mergeDeep(json, r2.json || {});
          uncertain = Array.isArray(r2.uncertain) ? r2.uncertain : uncertain;
          missing = Array.isArray(r2.missing) ? r2.missing : missing;
          sources = unionSources(sources, r2.sources);
          roundsUsed = 2;
        }
      }

      let verification = null;
      if (doVerify) {
        phase("verify");
        const rv = await agent(verifyPrompt(item, json, sources), { label: item.slug + "-verify", schema: verifySchema });
        if (rv !== null) {
          if (rv.json) json = mergeDeep(json, rv.json);
          verification = rv.verification || null;
        }
      }

      log(item.slug + ": rounds=" + roundsUsed + ", uncertain=" + uncertain.length + ", missing=" + missing.length + ", sources=" + sources.length);
      return { item: item.slug, ok: true, roundsUsed: roundsUsed, json: json, uncertain: uncertain, missing: missing, sources: sources, verification: verification };
    };
  })
);

const failed = results.filter(function (r) { return r && r.failed; });
log("batch finished: " + (results.length - failed.length) + "/" + results.length + " ok");
return {
  topic: topic,
  batch: batch.map(function (b) { return b.slug; }),
  results: results,
  failedCount: failed.length,
};
