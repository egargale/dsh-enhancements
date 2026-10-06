# gpt-researcher-plugin

A DeepSeek Harness (DSH) plugin that ports
[assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) — the
autonomous web-research agent — into native harness tools, in TypeScript.

Ask your session to *"research X and write me a report"* and the model calls
`gptr_research`; the plugin plans sub-queries, searches, scrapes, compresses the
context, and writes a cited report, writing the artifact into the workspace. It
can also run deep (recursive) research, the multi-agent editorial pipeline, quick
searches, standalone report writing, and configuration introspection.

The port is faithful where it matters and explicit where it is not: prompt
templates are byte-compared against the Python originals, the pipeline shape
(planner → retrievers → scrapers → context compression → writer) is preserved,
upstream's quirks and failure ladders are reproduced (and pinned by tests), and
every deviation is marked `// DEVIATION:` in the code with the reason.

---

## Tools

| Tool | Upstream equivalent | What it does |
|---|---|---|
| `gptr_research` | `GPTResearcher.conduct_research()` + `write_report()` | Full pipeline for `research_report`, `resource_report`, `outline_report`, `custom_report`, `detailed_report` |
| `gptr_deep_research` | `ReportType.DeepResearch` / `DeepResearchSkill` | Recursive breadth/depth research; returns the report **and** the research trace (queries, learnings, follow-up questions, sources) |
| `gptr_multi_agent_research` | `multi_agents/` | Orchestrator → editor → per-section researcher/reviewer/reviser → publisher |
| `gptr_quick_search` | `quick_search()` | Search + optional summary, no scraping |
| `gptr_write_report` | `write_report(ext_context=…)` | Write from a context string and/or supplied URLs |
| `gptr_search_sources` | retriever layer | Raw multi-retriever search, returns sources |
| `gptr_get_subtopics` | `get_subtopics()` | Section planning for a report |
| `gptr_capabilities` | — | Which retrievers/scrapers/embeddings are usable right now, and which env vars are missing |

Every tool's result is a canonical JSON value validated against its declared
output schema, plus a rendered markdown/text view for the model. Research tools
also write `<outputDir>/<timestamp>_<slug>.md` and a `.sources.json` sidecar, so
a report is a workspace artifact rather than only a chat message.

---

## Install and mount

Requirements: a DSH install (`dsh` on `PATH`), Node ≥ 22, network access for
search/scraping.

```bash
cd gpt-researcher-plugin
npm install                 # installs TypeScript and links the DSH peer packages
npm run build               # emits dist/index.js
npm run test:unit           # 190+ offline unit tests
npm test                    # unit + integration (all offline, faked seams)
npm run smoke               # boots DSH headless and calls the real tools
```

`npm install` runs `scripts/link-dsh-deps.sh`, which symlinks
`@deepseek-ai/*` out of an existing DSH install so the plugin's peer imports
resolve without duplicating the harness. Pass an explicit install path if the
default is wrong: `bash scripts/link-dsh-deps.sh /path/to/dsh-install`.

Mount it with a patch overlay (edit `name:` in [`cordis.yml`](cordis.yml) to the
absolute path of `dist/index.js`):

```bash
# Materialise the machine-neutral mount file (it ships with a placeholder):
sed "s#__ENTRY__#$PWD/dist/index.js#" cordis.yml > /tmp/gptr.patch.yml

# GUI session
dsh web --patch /tmp/gptr.patch.yml

# one-shot, for a smoke check
dsh headless --patch /tmp/gptr.patch.yml \
  "Use gptr_research to research the DeepSeek Harness and write a short report"
```

To mount it permanently, insert the same entry into
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`.

### Configuration

Every field is optional; the defaults give a working stack that needs no new API
key (the deployment's own search provider plus a built-in HTML scraper).

```yaml
- insert:
    - id: gpt-researcher
      name: '/absolute/path/to/gpt-researcher-plugin/dist/index.js'
      config:
        retriever: dsh_web        # dsh_web uses ctx.web (no new key)
        scraper: bs               # built-in HTML extractor
        embedding: local:hash     # deterministic lexical embeddings (no key)
        memoryBackend: memory     # or `local` to persist to disk
        outputDir: gptr-reports
        writeArtifacts: true
        tone: Objective
        reportFormat: APA
        language: english
        totalWords: 1200
        maxSearchResultsPerQuery: 5
        maxIterations: 3
        curateSources: false
        deepResearchBreadth: 3
        deepResearchDepth: 2
        deepResearchConcurrency: 4
        writeArtifacts: true
        # Fetch policy: private/loopback/link-local destinations are refused.
        # Set true only to research internal hosts deliberately.
        allowPrivateHosts: false
        # Model routing: omit to use the session's selected model for every tier.
        provider: deepseek-official
        fastModel: deepseek-flash
        smartModel: deepseek-flash
        strategicModel: deepseek-flash
        maxTokens: 4096
        timeoutMs: 120000
```

Upstream configuration also works, and its precedence is:

```
upstream DEFAULT_CONFIG → plugin stack defaults → CONFIG_PATH file → environment → explicit plugin config / tool arguments
```

The middle layer is the plugin's own keyless stack (`dsh_web`, `bs`,
`local:hash`) so a bare mount needs no credentials; anything a deployment sets —
in `config.json` or in the environment (`RETRIEVER=tavily`,
`MAX_ITERATIONS=8`, `TOTAL_WORDS=3000`, `TIMEOUT_MS=45000`, …) — wins over it.
`src/config.ts` is a port of `config/config.py` + `config/variables/default.py`.

### Fetch policy (SSRF guard)

The URLs this plugin fetches are ultimately model-controlled: the `source_urls`
tool argument, every link harvested from a search result or a scraped page, and
`document_urls`. By default the plugin refuses anything that is not a public
`http(s)` destination:

- non-http(s) schemes (`data:`, `file:`, `javascript:`) are rejected;
- loopback, RFC1918, link-local (`169.254.0.0/16`, cloud metadata), CGNAT,
  ULA and multicast addresses are rejected, including IPv4-mapped IPv6 and the
  decimal/hex/octal spellings the URL parser normalises;
- `localhost`, `*.localhost`, `*.internal`, `*.local` and `*.home.arpa` names are
  rejected;
- redirects are followed **manually**, re-validating every hop, so a public URL
  that 302s to an internal address cannot slip through;
- `query_domains` values that are not plain hostnames are dropped before they
  reach a provider's `site:` query syntax.

Set `allowPrivateHosts: true` (plugin config) to research internal hosts on
purpose. The policy is applied at the retrieval boundary, not on the shared HTTP
seam, because the embedding providers legitimately default to
`http://localhost:1234` and `http://localhost:11434`.

### Credentials

Retrievers and scrapers that need a key read it from the environment and fail
with the exact variable name when it is missing — call `gptr_capabilities` to
see the current state.

| Kind | Keyless | Keyed (env var) |
|---|---|---|
| Retrievers | `dsh_web`, `duckduckgo`, `google`, `searx`, `arxiv`, `semantic_scholar`, `pubmed_central` | `tavily` (`TAVILY_API_KEY`), `exa`, `brave`, `serper`, `searchapi`, `serpapi`, `bing`, `bocha`, `xquik`, `getxapi`, `custom` |
| Scrapers | `bs`, `dsh_web`, `exa`/`pdf`/`arxiv` per URL | `firecrawl` (`FIRECRAWL_API_KEY`), `tavily_extract` (`TAVILY_API_KEY`) |
| Embeddings | `local`, `ollama`, `custom` | `openai` (`OPENAI_API_KEY`), `azure_openai` |
| Vector stores | `memory`, `local` | — |

---

## Architecture

The engine is I/O-free by construction: it receives an `EngineDeps` bundle
(`llm`, `http`, `env`, `log`, `progress`, `signal`) and never imports a provider
SDK, reads `process.env` for credentials, or writes to stdout. Everything
harness-specific lives under `src/dsh/`.

```
src/
├── index.ts                  # plugin entry: inject ['tools'], registers 8 tools
├── agent.ts                  # GptResearcher — port of gpt_researcher/agent.py
├── config.ts                 # port of config/config.py + variables/default.py
├── prompts.ts                # port of prompts.py (verbatim, Python-verified)
├── types.ts                  # report types, tones, sources, data model
├── deps.ts  runtime.ts       # injected seams
├── actions/                  # agent-creator, query-processing, report-generation, retrieval
├── skills/                   # researcher, writer, context-manager, browser, curator, deep-research
├── report-type/              # detailed-report (upstream backend/report_type/)
├── multi-agents/             # orchestrator + the seven agents of the LangGraph flow
├── retrievers/               # 18 retrievers behind one registry
├── scraper/                  # HTML extractor + scrapers behind one registry
├── embeddings/ vector_store/ # provider registries
├── memory/                   # Memory facade + recursive text splitter
├── context/                  # compression (embeddings filter + fast path)
├── document/                 # local/online/azure/documents loaders
├── llm/                      # tiered chat client + one-shot call helper
├── tools/                    # the DSH tool definitions and shared plumbing
├── dsh/                      # ctx.llm adapter, plugin config, session wiring
└── utils/                    # json repair, markdown, costs, workers, subtopics, text
```

Four design choices are worth naming:

1. **The harness is the agent loop, and it is the only model path.** Upstream owns
   its own LLM calls end to end (provider SDKs, `OPENAI_API_KEY`, its own request
   layer). Here every completion goes through `ctx.llm.stream()`: the plugin
   imports no provider SDK, dials no chat/messages endpoint, and never reads a
   model credential. The session's routed model (`session.requestHeader().config`,
   falling back to the agent's options) becomes the FAST/SMART/STRATEGIC route, so
   a research run uses the model the user picked — and a provider that is not
   registered in the harness is rejected by DSH (`NO_ADAPTER`), not silently
   dialled elsewhere. Upstream's `FAST_LLM=openai:…` defaults are still parsed for
   config compatibility but are never used to route a call.
   The only direct HTTP calls the plugin makes are to *data* providers that
   upstream also owns — search backends and embedding endpoints — and the default
   mount uses none of them (`dsh_web` via `ctx.web`, `bs`, `local:hash`).
2. **Progress is deferred context.** Upstream streams progress over a websocket;
   this port forwards it as DSH deferred-context messages, so research progress is
   durable in the session log and visible in the UI without interrupting the model.
3. **Optional capabilities.** `ctx.llm` and `ctx.web` are read through
   `ctx.reflect.get`, so the plugin mounts even in a deployment without a web
   seam — and `gptr_capabilities` says so instead of failing at call time.
4. **Safety rails the upstream project does not have.** Private/internal URLs
   are refused by default (see the fetch policy above), redirects are validated
   hop by hop, deep-research `breadth`/`depth`/`concurrency` are clamped
   (10 / 4 / 16) however the model asks, and a run that gathers no sources
   **abstains** with an explicit message instead of asking the model to invent an
   uncited report.
5. **Model failures are exceptions, not empty answers.** The harness reports a
   failed call as an `error` *finish chunk* in the stream (that is how
   `NO_ADAPTER`, auth, and rate-limit failures arrive), so the adapter checks the
   finish reason and throws with the harness's own code and message. Without that
   translation a hard failure would look like a successful empty completion and
   the caller would read "no report text" instead of "no adapter registered for
   provider X".

---

## Testing

Three layers, all runnable offline except the last:

| Layer | Command | What it proves |
|---|---|---|
| Unit | `npm run test:unit` | Prompts (transcribed verbatim, verified out-of-band), retrievers (request shapes + parsing against fixtures), HTML extraction (incl. malformed-page timing), document loaders, embeddings, vector stores incl. dimension mismatch, memory/chunking, compression boundaries, config precedence/env coercion, the fetch policy, concurrency primitives, deep research, multi-agent agents, mount patches |
| Integration | `npm run test:integration` | The **real engine** end to end with every seam faked: full research pipeline, curation (incl. wrong-shape JSON), the planning fallback ladder, URL-only research, scrape dedupe, cancellation mid-run, detailed report, multi-agent pipeline, and every DSH tool (schema-validated results, artifacts on disk, throttled progress) |
| Smoke (real harness) | `npm run smoke` (`GPTR_SMOKE_FULL=1` for the full pipeline) | `dsh headless` boots with the plugin mounted, the model calls the tools, and real results come back |

`npm test` runs the first two (286 tests at the time of writing). Two bugs found by review are worth
recording because they show what the tests now pin:

- cordis rejects undeclared service access (`cannot get property "web" without
  inject`), which is why the plugin reads optional services through
  `ctx.reflect.get`;
- `gptr_search_sources` passed `EngineDeps` where a `RetrieverContext` was
  required, so `config.timeoutMs` was `undefined` and every real search aborted
  after ~2 ms. The test that covered it passed only because its fake resolved in
  a microtask and ignored the abort signal; the fakes now honour signals and
  model latency.

---

## Fidelity: what matches, what differs

**Matches (mechanically verified).** `prompts.py` renderings were diffed against
the real Python module for 41 cases covering every conditional branch: 40
byte-identical, the one exception being the documented `asText` rendering of a
non-string context. The multi-agent prompt builders were verified the same way
(14/14 renderings identical). Report types, tone values, report sources, the
full default config table, the retriever/scraper/embedding/vector-store name
sets, the deep-research breadth/depth recursion, `curate_sources`' strict-JSON
behaviour with its return-the-original-data fallback, the `COMPRESSION_THRESHOLD`
fast path, and the seed-search-uses-`retrievers[0]` rule are all preserved.

**Safety and robustness deltas from upstream** (all marked in code): the fetch
policy above; a bounded deep-research fan-out; progress messages throttled to one
per milestone step per run (upstream streams every event to a websocket; here each
one would become a session message); one search instead of two for a summarised
quick search; a loud dimension-mismatch error from the vector store instead of a
silently truncated comparison; string-aware JSON repair that cannot rewrite
quoted content; and an explicit abstention when no sources were gathered where
upstream asks the model to write the report anyway.

**One upstream defect is fixed, not preserved.** `process_research_results` split
`Learning [url]: text` on the *first* colon — the one inside `https:` — so every
deep-research learning came back as `//host/path]: text` and that corrupted text
flowed into the report. The port keeps the documented format and takes the text
after the `[citation]` group; reverting to upstream's exact behaviour is a
one-line change at the marked site.

**Deliberate differences**, each also marked in code:

- **No MCP client.** A DSH deployment reaches MCP servers natively through
  `dsh-mcp-client`, so the plugin does not re-implement an MCP transport. The
  `mcp` retriever name is therefore absent; upstream's MCP prompts are still
  ported.
- **LangGraph is replaced by a sequential driver** with the same node order and
  the same conditional review/revision loop, bounded explicitly (LangGraph
  bounded it only via its recursion limit).
- **Server-backed vector stores and several LLM/embedding providers are not
  bundled.** Requesting one fails with a message naming the working options
  rather than pretending to work.
- **The browser scraper (`browser`) is not bundled** — no fake headless
  automation; it throws and points at `bs`/`dsh_web`.
- **PDF extraction is best-effort** for uncompressed content streams;
  compressed/encrypted PDFs fail loudly.
- **Image handling** keeps upstream's prompt block and progress events but
  dedupes images by URL rather than by image bytes (no extra round-trip), and
  image *generation* is not ported (it needs a Google API key and is off by
  default upstream).
- **Cost accounting** prefers the provider's reported token usage and falls back
  to a character-based estimate (no tokeniser is bundled), reported as an
  estimate in every result.
- **`pretty_print_docs`** follows the real upstream body
  (`Source:`/`Title:`/`Content:` blocks) rather than a simplified join.

## License and attribution

This plugin is a **TypeScript port** of
[assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher),
which is licensed under the **Apache License 2.0** (© Assaf Elovic and
contributors). The upstream license text ships verbatim as
[`LICENSE`](LICENSE), and [`NOTICE`](NOTICE) records the modifications as
Apache-2.0 §4(b) requires: what was translated, what was restructured for the
host, what was reduced in scope, and which upstream defect was fixed.

Original plugin code in this directory (the DSH tool layer, the harness
adapters, and the tests) is covered by the repository-level
[LICENSE](../LICENSE) (MIT). Apache-2.0 and MIT are compatible in this
direction: the ported work stays under Apache-2.0 terms, the original work under
MIT.
