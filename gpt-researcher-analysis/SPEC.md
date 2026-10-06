# GPT Researcher (`assafelovic/gpt-researcher`) — Implementation-Ready Spec for a TypeScript Port

> **Provenance and status.** This document is the analysis artifact behind
> [`../gpt-researcher-plugin/`](../gpt-researcher-plugin), the DSH plugin that ports the
> project. It was written against a local checkout of upstream `master`
> (Apache-2.0), which is **not vendored here** (24 MB of third-party source);
> re-create it with:
>
> ```bash
> curl -sSL https://codeload.github.com/assafelovic/gpt-researcher/tar.gz/refs/heads/master \
>   | tar xz -C gpt-researcher-analysis/ && mv gpt-researcher-analysis/gpt-researcher-master \
>   gpt-researcher-analysis/upstream
> ```
>
> Quotes below are held to be verbatim from that checkout. Where the plugin
> deviates from what is described here — and every deviation is deliberate — the
> code carries a `DEVIATION` comment and
> [`../gpt-researcher-plugin/NOTICE`](../gpt-researcher-plugin/NOTICE) lists it.
> Two sections here are known to describe a *different upstream revision*
> (§8.2/8.3, deep research JSON parsing) and were superseded by the checkout
> during implementation; the plugin follows the checkout.

**Source of truth:** local checkout of upstream `master` at
`/home/enrico/src/dsh-enhancements/gpt-researcher-analysis/upstream/src/`
(repo root contains `gpt_researcher/`, `multi_agents/`, `multi_agents_ag2/`, `mcp-server/`, `backend/`, `docs/`, `tests/`).

Everything quoted below is copied verbatim from those files. File paths are relative to the repo root
unless stated otherwise. Where the task brief named files that do not exist upstream, this document
records the real file and flags the discrepancy in §12 (Gaps).

Version-level facts that matter for a port:

* Python **3.11+** (README says 3.11; MCP docs say 3.10+).
* Deep-learning-free: it is an *orchestration* layer over LangChain LLM/embedding/vectorstore/loader
  adapters plus `requests`-based search APIs and HTML scrapers.
* Report types use the string enum `ReportType`; `DeepResearch`'s value is `"deep"`, not `"deep_research"`.
* `MMR` / `max_marginal_relevance_search` **does not appear anywhere** in `gpt_researcher/` or `backend/`
  (verified by grep). Relevance selection is done with an `EmbeddingsFilter` similarity threshold
  (see §6.3), not MMR. There is also no "tavily context" API usage — Tavily appears only as (a) the
  default *retriever* (`TavilySearch`) and (b) an optional *scraper* (`tavily_extract`).

---

## 0. Repository map (files actually present)

```
src/
├── gpt_researcher/
│   ├── __init__.py                 # `from .agent import GPTResearcher`; __all__ = ['GPTResearcher']
│   ├── agent.py                    # GPTResearcher (739 lines)
│   ├── prompts.py                  # PromptFamily + Granite families + factories (903 lines)
│   ├── actions/
│   │   ├── __init__.py             # re-exports
│   │   ├── agent_creator.py        # choose_agent / handle_json_error / extract_json_with_regex
│   │   ├── markdown_processing.py  # extract_headers / extract_sections / table_of_contents / add_references
│   │   ├── query_processing.py     # get_search_results / generate_sub_queries / plan_research_outline
│   │   ├── report_generation.py    # generate_report, write_report_introduction, write_conclusion, summarize_url, generate_draft_section_titles
│   │   ├── retriever.py            # get_retriever / get_retrievers / get_default_retriever   (NOT "retrieval.py")
│   │   ├── utils.py                # stream_output / safe_send_json / calculate_cost / update_cost / create_cost_callback
│   │   ├── web_scraping.py         # scrape_urls / filter_urls / extract_main_content / process_scraped_data
│   │   └── (NO research.py — web search lives in skills/researcher.py)
│   ├── config/
│   │   ├── __init__.py
│   │   ├── config.py               # Config class (312 lines)
│   │   └── variables/{__init__,base,default}.py, test_local.json
│   ├── context/{__init__,compression,retriever}.py
│   ├── document/{__init__,azure_document_loader,document,langchain_document,online_document}.py
│   ├── llm_provider/{__init__,generic/base,image/*}.py
│   ├── mcp/{__init__,client,research,streaming,tool_selector}.py + README.md
│   ├── memory/{__init__,embeddings}.py
│   ├── retrievers/<17 dirs>/ + utils.py + __init__.py
│   ├── scraper/<7 dirs>/ + scraper.py + utils.py + __init__.py
│   ├── skills/{browser,context_manager,curator,deep_research,image_generator,researcher,writer}.py
│   ├── utils/{costs,enum,llm,logger,logging_config,rate_limiter,tools,validators,workers}.py
│   └── vector_store/{__init__,vector_store}.py
├── multi_agents/                   # LangGraph STORM-style flow
├── multi_agents_ag2/               # AG2 variant (orchestrator + editor only)
├── mcp-server/README.md            # stub: server moved to github.com/assafelovic/gptr-mcp
├── backend/                        # FastAPI app, WebSocket manager, report_type runners
├── docs/docs/gpt-researcher/mcp-server/{getting-started,advanced-usage,claude-integration}.md
└── tests/                          # 20 files incl. report-types.py, test_quick_search.py, test_mcp.py
```

---

## 1. End-to-end control flow for `conduct_research()` + `write_report()`

### 1.1 `GPTResearcher.__init__` — exact signature

```python
class GPTResearcher:
    def __init__(
        self,
        query: str,
        report_type: str = ReportType.ResearchReport.value,   # "research_report"
        report_format: str = "markdown",
        report_source: str = ReportSource.Web.value,          # "web"
        tone: Tone = Tone.Objective,
        source_urls: list[str] | None = None,
        document_urls: list[str] | None = None,
        complement_source_urls: bool = False,
        query_domains: list[str] | None = None,
        documents=None,
        vector_store=None,
        vector_store_filter=None,
        config_path=None,
        websocket=None,
        agent=None,
        role=None,
        parent_query: str = "",
        subtopics: list | None = None,
        visited_urls: set | None = None,
        verbose: bool = True,
        context=None,
        headers: dict | None = None,
        max_subtopics: int = 5,
        log_handler=None,
        prompt_family: str | None = None,
        mcp_configs: list[dict] | None = None,
        mcp_max_iterations: int | None = None,
        mcp_strategy: str | None = None,
        **kwargs
    ):
```

Body (verbatim, abridged to assignments):

```python
        self.kwargs = kwargs
        self.query = query
        self.report_type = report_type
        self.cfg = Config(config_path)
        self.cfg.set_verbose(verbose)
        self.report_source = report_source if report_source else getattr(self.cfg, 'report_source', None)
        self.report_format = report_format
        self.max_subtopics = max_subtopics
        self.tone = tone if isinstance(tone, Tone) else Tone.Objective
        self.source_urls = source_urls
        self.document_urls = document_urls
        self.complement_source_urls = complement_source_urls
        self.query_domains = query_domains or []
        self.research_sources = []   # list of scraped sources incl. title, content, images
        self.research_images = []    # list of selected research images
        self.documents = documents
        self.vector_store = VectorStoreWrapper(vector_store) if vector_store else None
        self.vector_store_filter = vector_store_filter
        self.websocket = websocket
        self.agent = agent
        self.role = role
        self.parent_query = parent_query
        self.subtopics = subtopics or []
        self.visited_urls = visited_urls or set()
        self.verbose = verbose
        self.context = context or []
        self.headers = headers or {}
        self.research_costs = 0.0
        self.step_costs: dict[str, float] = {}
        self._current_step: str = "general"
        self.log_handler = log_handler
        self.prompt_family = get_prompt_family(prompt_family or self.cfg.prompt_family, self.cfg)

        self.mcp_configs = mcp_configs
        if mcp_configs:
            self._process_mcp_configs(mcp_configs)

        self.retrievers = get_retrievers(self.headers, self.cfg)
        self.memory = Memory(
            self.cfg.embedding_provider, self.cfg.embedding_model, **self.cfg.embedding_kwargs
        )

        self.encoding = kwargs.get('encoding', 'utf-8')
        self.kwargs.pop('encoding', None)   # never forwarded to LLM calls

        self.research_conductor: ResearchConductor = ResearchConductor(self)
        self.report_generator: ReportGenerator = ReportGenerator(self)
        self.context_manager: ContextManager = ContextManager(self)
        self.scraper_manager: BrowserManager = BrowserManager(self)
        self.source_curator: SourceCurator = SourceCurator(self)
        self.deep_researcher: Optional[DeepResearchSkill] = None
        if report_type == ReportType.DeepResearch.value:      # "deep"
            self.deep_researcher = DeepResearchSkill(self)

        self.image_generator: Optional[ImageGenerator] = ImageGenerator(self)
        self.available_images: list = []
        self._research_id: str = ""

        self.mcp_strategy = self._resolve_mcp_strategy(mcp_strategy, mcp_max_iterations)
```

`_resolve_mcp_strategy` priority: (1) `mcp_strategy` param — accepts `"fast"|"deep"|"disabled"`,
maps deprecated `"optimized"→"fast"`, `"comprehensive"→"deep"`, else warns and uses `"fast"`;
(2) `mcp_max_iterations` — `0→"disabled"`, `1→"fast"`, `-1→"deep"`, anything else → `"fast"`;
(3) `cfg.mcp_strategy`; (4) default `"fast"`.

`_process_mcp_configs(mcp_configs)` mutates `self.cfg.retrievers` (deliberately **not** `os.environ`,
"fixes issue #1676 – process-level env pollution"): appends `"mcp"` to the current list, or sets
`cfg.retrievers = ["mcp"]` if empty.

`BrowserManager.__init__` builds one `WorkerPool(researcher.cfg.max_scraper_workers,
researcher.cfg.scraper_rate_limit_delay)` — i.e. **one shared thread pool + one global rate limiter per
researcher**, and `SCRAPER_RATE_LIMIT_DELAY` is enforced process-globally by a singleton
(`utils/rate_limiter.py`).

### 1.2 `conduct_research()` — top-level

```python
    async def conduct_research(self, on_progress=None):
        await self._log_event("research", step="start", details={...})

        # Handle deep research separately
        if self.report_type == ReportType.DeepResearch.value and self.deep_researcher:
            self._current_step = "deep_research"
            return await self._handle_deep_research(on_progress)

        if not (self.agent and self.role):
            self._current_step = "agent_selection"
            await self._log_event("action", action="choose_agent")
            self.agent, self.role = await choose_agent(
                query=self.query, cfg=self.cfg, parent_query=self.parent_query,
                cost_callback=self.add_costs, headers=self.headers,
                prompt_family=self.prompt_family, **self.kwargs,
            )
            await self._log_event("action", action="agent_selected", details={...})

        self._current_step = "research"
        self.context = await self.research_conductor.conduct_research()

        # Pre-generate images if enabled (BEFORE report writing for better UX)
        self.available_images = []
        if self.image_generator and self.image_generator.is_enabled():
            context_str = "\n\n".join(self.context) if isinstance(self.context, list) else str(self.context)
            self.available_images = await self.image_generator.plan_and_generate_images(
                context=context_str, query=self.query, research_id=self._generate_research_id(),
            )
        return self.context
```

### 1.3 Numbered control flow — LLM calls, order, prompts, state

Assumptions for the canonical path: `report_type="research_report"`, `report_source="web"`,
`curate_sources=False`, no MCP, no images. Steps marked **[LLM]** are model calls.

**Phase A — agent selection**

1. `conduct_research()` checks `self.agent and self.role`. If either is falsy, calls
   `choose_agent(query, cfg, parent_query, cost_callback, headers, prompt_family, **kwargs)`.
2. **[LLM #1 — agent selection]** `actions/agent_creator.py::choose_agent`:
   ```python
   query = f"{parent_query} - {query}" if parent_query else f"{query}"
   response = await create_chat_completion(
       model=cfg.smart_llm_model,
       messages=[
           {"role": "system", "content": f"{prompt_family.auto_agent_instructions()}"},
           {"role": "user",   "content": f"task: {query}"},
       ],
       temperature=0.15,
       llm_provider=cfg.smart_llm_provider,
       llm_kwargs=cfg.llm_kwargs,
       cost_callback=cost_callback,
       **kwargs
   )
   agent_dict = json.loads(response)
   return agent_dict["server"], agent_dict["agent_role_prompt"]
   ```
   Prompt text quoted in §1.6.1. Failure path: `handle_json_error(response)` → `json_repair.loads`
   → regex `r"{.*?}"` (DOTALL) → hardcoded fallback
   `("Default Agent", "You are an AI critical thinker research assistant. Your sole purpose is to write well written, critically acclaimed, objective and structured reports on given text.")`.
   State written: `self.agent`, `self.role`. Step label `_current_step = "agent_selection"`.
3. `_current_step = "research"`; delegates to `ResearchConductor.conduct_research()`.

**Phase B — `ResearchConductor.conduct_research()` source dispatch**

4. `visited_urls` is **not cleared** (comment: shared with parent researcher for detailed reports).
5. Re-checks agent/role (again calls `choose_agent` if unset).
6. Dispatch on source (see §11.2 for full `report_source` semantics):
   * `self.researcher.source_urls` → `_get_context_by_urls(source_urls)`; if `complement_source_urls`
     also `_get_context_by_web_search(query, [], query_domains)` and `research_data += ' '.join(...)`.
   * `ReportSource.Web` → `_get_context_by_web_search(query, [], query_domains)`.
   * `ReportSource.Local` → `DocumentLoader(cfg.doc_path).load()`; optional `vector_store.load(docs)`;
     `_get_context_by_web_search(query, document_data, query_domains)`.
   * `ReportSource.Hybrid` → `OnlineDocumentLoader(document_urls).load()` if `document_urls` else
     `DocumentLoader(cfg.doc_path).load()`; optional vector store load; then **concurrently**
     ```python
     docs_context, web_context = await asyncio.gather(
         self._get_context_by_web_search(query, document_data, query_domains),
         self._get_context_by_web_search(query, [], query_domains),
     )
     research_data = self.researcher.prompt_family.join_local_web_documents(docs_context, web_context)
     ```
   * `ReportSource.Azure` → `AzureDocumentLoader(container_name=os.getenv("AZURE_CONTAINER_NAME"),
     connection_string=os.getenv("AZURE_CONNECTION_STRING")).load()` → `DocumentLoader(files).load()` →
     `_get_context_by_web_search(...)`.
   * `ReportSource.LangChainDocuments` → `LangChainDocumentLoader(documents).load()`; optional vector
     store load; `_get_context_by_web_search(...)`.
   * `ReportSource.LangChainVectorStore` → `_get_context_by_vectorstore(query, vector_store_filter)`.
7. `self.researcher.context = research_data`; if `cfg.curate_sources` → `source_curator.curate_sources(research_data)`
   (see §11.5).
8. Verbose: stream `research_step_finalized` with `Total Research Costs: ${get_costs()}`.

**Phase C — `_get_context_by_web_search(query, scraped_data, query_domains)`**

9. Split `self.researcher.retrievers` into `mcp_retrievers` (`"mcpretriever" in r.__name__.lower()`)
   and non-MCP. Under `self._mcp_cache_lock`, if MCP retrievers exist and cache is `None`:
   `disabled` → skip; `fast` → run `_execute_mcp_research_for_queries([query], mcp_retrievers)` once and
   cache; `deep` → defer to per-sub-query execution; unknown → treat as `fast`.
10. `sub_queries = await self.plan_research(query, query_domains)`.
11. **Sub-query planning internals** (`plan_research`):
    a. `stream_output("logs","planning_research", f"🌐 Browsing the web to learn more about the task: {query}...", websocket)`
    b. `search_results = await get_search_results(query, self.researcher.retrievers[0], query_domains,
       researcher=self.researcher, max_results=self.researcher.cfg.max_search_results_per_query)`
       — note: **only `retrievers[0]`** is used for the seed search.
    c. `stream_output(..., "🤔 Planning the research strategy and subtasks...")`
    d. `plan_research_outline(query, search_results, agent_role_prompt=role, cfg, parent_query,
       report_type, cost_callback, retriever_names=[r.__name__ for r in retrievers], **kwargs)`
       → if MCP is the **only** retriever, return `[query]` and skip the LLM entirely; else
       `generate_sub_queries(...)`.
12. **[LLM #2 — sub-query generation]** `generate_sub_queries` builds
    `prompt_family.generate_search_queries_prompt(query, parent_query, report_type,
    max_iterations=cfg.max_iterations or 3, context=context)` and calls with the **strategic** LLM:
    ```python
    response = await create_chat_completion(
        model=cfg.strategic_llm_model,
        messages=[{"role": "user", "content": gen_queries_prompt}],
        llm_provider=cfg.strategic_llm_provider,
        max_tokens=None,
        llm_kwargs=cfg.llm_kwargs,
        reasoning_effort=ReasoningEfforts.Medium.value,   # "medium"
        cost_callback=cost_callback, **kwargs)
    return json_repair.loads(response)
    ```
    Failure ladder (verbatim behaviour): (i) strategic + `max_tokens=None`; (ii) on exception retry
    strategic + `max_tokens=cfg.strategic_token_limit`; (iii) on exception fall back to
    `smart_llm_model` with `temperature=cfg.temperature`, `max_tokens=cfg.smart_token_limit`.
    No `reasoning_effort` on the smart fallback.
13. `if self.researcher.report_type != "subtopic_report": sub_queries.append(query)`.
14. Verbose: stream `subqueries` with the list, `output_log=True`, `metadata=sub_queries`.
15. `context = await asyncio.gather(*[self._process_sub_query(sq, scraped_data, query_domains) for sq in sub_queries])`;
    drop empty entries, `" ".join(context)`; on exception log and return `[]`.

**Phase D — per sub-query `_process_sub_query`**

16. If `scraped_data` empty → `_scrape_data_by_urls(sub_query, query_domains)`, which:
    a. `_search_relevant_source_urls(sub_query, query_domains)` — loops over **all** non-MCP retriever
       classes:
       ```python
       retriever = retriever_class(query, query_domains=query_domains)
       search_results = await asyncio.to_thread(
           retriever.search, max_results=self.researcher.cfg.max_search_results_per_query)
       for result in search_results:
           url = result.get("href") or result.get("url")
           raw_content = result.get("raw_content")
           if url and raw_content and len(raw_content) > 100:
               prefetched_content.append({"url": url, "raw_content": raw_content})
               self.researcher.add_research_sources([{"url": url}])
           elif url:
               new_search_urls.append(url)
       ```
       Rationale comment: *"Only raw_content signals that a retriever already fetched the full page.
       body is snippet-sized text for most web retrievers and still needs scraping."*
       Then `new_search_urls = await self._get_new_urls(new_search_urls)` (dedupe against
       `visited_urls`, add to it, stream `added_source_url`) and `random.shuffle(new_search_urls)`.
    b. Verbose: `stream_output("logs","researching","🤔 Researching for relevant information across multiple sources...\n")`.
    c. `scraped_content = await self.researcher.scraper_manager.browse_urls(new_search_urls)`
       (see §5); `scraped_content.extend(prefetched_content)`;
       `if self.researcher.vector_store: self.researcher.vector_store.load(scraped_content)`.
17. If `scraped_data` non-empty:
    `web_context = await context_manager.get_similar_content_by_query(sub_query, scraped_data)`.
18. **[LLM #3+N — embedding filter, not a chat call]** Internally
    `ContextCompressor.async_get_context(query, max_results=10, cost_callback=add_costs)`:
    * Fast path if `sum(len(doc['raw_content'])) < COMPRESSION_THRESHOLD` (env, default `8000`)
      **and** `len(documents) <= max_results` → build `Document(page_content=..., metadata=doc)` and
      return `prompt_family.pretty_print_docs(direct_docs, max_results)`; **no embedding call, no cost**.
    * Otherwise build `ContextualCompressionRetriever(base_compressor=DocumentCompressorPipeline(
      [RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100), EmbeddingsFilter(embeddings,
      similarity_threshold)]), base_retriever=SearchAPIRetriever(pages=documents))`, charge
      `estimate_embedding_cost(model=OPENAI_EMBEDDING_MODEL, docs=documents)`, then
      `await asyncio.to_thread(compressed_docs.invoke, query, **kwargs)` and pretty-print.
    * `similarity_threshold` = `getattr(cfg, "similarity_threshold", None)` passed from the caller;
      `ContextCompressor.__init__` itself reads `os.environ.get("SIMILARITY_THRESHOLD", 0.35)` into
      `self.similarity_threshold` — **the constructor argument is shadowed**, so the env/default value wins.
      (`Config` sets `cfg.similarity_threshold = 0.42` from `DEFAULT_CONFIG`, but it is not forwarded.)
19. If MCP retrievers exist: strategy `disabled` → nothing; `fast` + cache present →
   `mcp_context = self._mcp_results_cache.copy()`; `deep` → `_execute_mcp_research_for_queries([sub_query], mcp_retrievers)`;
   else fallback per-sub-query execution.
20. `combined_context = self._combine_mcp_and_web_context(mcp_context, web_context, sub_query)`:
    web context first, then MCP entries joined by `"\n\n---\n\n"`, each formatted as
    `f"{content.strip()}{citation}"` where
    `citation = f"\n\n*Source: {title} ({url})*"` unless `url` is falsy/`mcp://llm_analysis`, in which case
    `f"\n\n*Source: {title}*"`.
21. Verbose: `context_combined` summary; else `subquery_context_not_found`.

**Phase E — report writing**

22. `write_report(existing_headers=[], relevant_written_contents=[], ext_context=None, custom_prompt="")`:
    ```python
    has_available_images = bool(self.available_images)
    self._current_step = "report_writing"
    report = await self.report_generator.write_report(
        existing_headers=existing_headers,
        relevant_written_contents=relevant_written_contents,
        ext_context=ext_context or self.context,
        custom_prompt=custom_prompt,
        available_images=self.available_images,
    )
    return report
    ```
23. `ReportGenerator.write_report` first streams selected images if any
    (`stream_output("images","selected_images", json.dumps(images), websocket, True, images)`), then:
    ```python
    context = ext_context or self.researcher.context
    _ctx = "\n".join(context) if isinstance(context, list) else str(context or "")
    if not _ctx.strip():
        return (
            f'I could not gather any source material for "{self.researcher.query}". '
            "No sources were retrieved (searches may have returned nothing or been "
            "blocked), so I am not able to produce a reliable, sourced report."
        )
    ```
    **This abstain guard is important to port** — it prevents a cited-looking hallucinated report when
    every retriever returned empty.
24. `report_params` = `{"query", "agent_role_prompt" (= cfg.agent_role or role), "report_type",
    "report_source", "tone", "websocket", "cfg", "headers"}` + `context`, `custom_prompt`,
    `available_images`, `cost_callback=researcher.add_costs`; for `report_type == "subtopic_report"`
    also `main_topic=parent_query`, `existing_headers`, `relevant_written_contents`.
25. **[LLM — final report]** `actions/report_generation.py::generate_report`:
    ```python
    generate_prompt = get_prompt_by_report_type(report_type, prompt_family)
    if report_type == "subtopic_report":
        content = f"{generate_prompt(query, existing_headers, relevant_written_contents, main_topic, context, report_format=cfg.report_format, tone=tone, total_words=cfg.total_words, language=cfg.language)}"
    elif custom_prompt:
        content = f"{custom_prompt}\n\nContext: {context}"
    else:
        content = f"{generate_prompt(query, context, report_source, report_format=cfg.report_format, tone=tone, total_words=cfg.total_words, language=cfg.language)}"
    # optional AVAILABLE IMAGES block appended (see §11.7)
    report = await create_chat_completion(
        model=cfg.smart_llm_model,
        messages=[{"role": "system", "content": f"{agent_role_prompt}"},
                  {"role": "user",   "content": content}],
        temperature=0.35, llm_provider=cfg.smart_llm_provider, stream=True,
        websocket=websocket, max_tokens=cfg.smart_token_limit,
        llm_kwargs=cfg.llm_kwargs, cost_callback=cost_callback, **kwargs)
    ```
    On exception it retries once with **both** system and user concatenated into a single user message
    (`f"{agent_role_prompt}\n\n{content}"`); on second failure prints `Error in generate_report: {e}`
    and returns `""`.

**Phase F — optional section-level methods** (used by the detailed-report runner, §9.4)

26. `write_introduction()` → `write_report_introduction`: smart LLM, `temperature=0.25`, `stream=True`,
    `max_tokens=cfg.smart_token_limit`, messages `[system=agent_role_prompt, user=generate_report_introduction(question, research_summary=context, language=cfg.language)]`
    (note: `report_format` defaults to `"apa"` here and is not threaded from cfg).
27. `get_subtopics()` → `utils/llm.py::construct_subtopics`: LangChain
    `PromptTemplate(generate_subtopics_prompt(), input_variables=["task","data","subtopics","max_subtopics"],
    partial_variables={"format_instructions": PydanticOutputParser(Subtopics).get_format_instructions()})`
    piped into the provider's `llm` (smart model; `reasoning_effort="high"` when the model is in
    `SUPPORT_REASONING_EFFORT_MODELS`, else `temperature=cfg.temperature`, `max_tokens=cfg.smart_token_limit`)
    → `Subtopics` pydantic object. On exception returns the input `subtopics` list unchanged.
28. `get_draft_section_titles(current_subtopic)` → `generate_draft_section_titles`: smart LLM,
    `temperature=0.25`, `stream=True`, **`websocket=None`** (hardcoded, so no streaming),
    `max_tokens=cfg.smart_token_limit`, prompt `generate_draft_titles_prompt(current_subtopic, query, context)`,
    result `.split("\n")`.
29. `get_similar_written_contents_by_draft_section_titles(...)` → `ContextManager`; embeds
    `[current_subtopic] + draft_section_titles` in parallel and unions the per-query results
    (`WrittenContentCompressor`, `similarity_threshold=0.5`), truncated to `max_results`.
30. `write_report_conclusion(report_body)` → `write_conclusion`: smart LLM, `temperature=0.25`, `stream=True`.

### 1.4 `quick_search()`

```python
    async def quick_search(self, query: str, query_domains: list[str] = None, aggregated_summary: bool = False) -> list[Any] | str:
        search_results = await get_search_results(query, self.retrievers[0], query_domains=query_domains)

        if not aggregated_summary:
            return search_results

        context = ""
        for i, result in enumerate(search_results, 1):
            context += f"[{i}] {result.get('title', '')}: {result.get('content', '')} ({result.get('url', '')})\n\n"

        prompt = self.prompt_family.generate_quick_summary_prompt(query, context)

        summary = await create_chat_completion(
            model=self.cfg.smart_llm_model,
            messages=[{"role": "user", "content": prompt}],
            llm_provider=self.cfg.smart_llm_provider,
            max_tokens=self.cfg.smart_token_limit,
            llm_kwargs=self.cfg.llm_kwargs,
            cost_callback=self.add_costs
        )
        return summary
```

Notes for the port: `quick_search` uses **only `retrievers[0]`**, does **not** pass
`max_results` (so the retriever default applies), and reads `title`/`content`/`url` keys — which most
retrievers do not emit (they emit `href`/`body`). `aggregated_summary=True` therefore depends on the
retriever's key naming; `tests/test_quick_search.py` covers it.

### 1.5 Helper/utility surface on `GPTResearcher`

`get_subtopics`, `get_draft_section_titles`, `get_similar_written_contents_by_draft_section_titles`,
`get_research_images(top_k=10)`, `add_research_images(images)`, `get_research_sources()`,
`add_research_sources(sources)`, `add_references(report_markdown, visited_urls)`,
`extract_headers(markdown_text)`, `extract_sections(markdown_text)`, `table_of_contents(markdown_text)`,
`get_source_urls()`, `get_research_context()`, `get_costs()`, `get_step_costs()`, `set_verbose(v)`,
`add_costs(cost)`, `_generate_research_id()` (`f"research_{md5(f'{query}_{time.time()}').hexdigest()[:12]}"`),
`_log_event(event_type, **kwargs)`.

`add_costs` (verbatim):

```python
    def add_costs(self, cost: float) -> None:
        if not isinstance(cost, (float, int)):
            raise ValueError("Cost must be an integer or float")
        self.research_costs += cost
        step = self._current_step
        self.step_costs[step] = self.step_costs.get(step, 0.0) + cost
        if self.log_handler:
            self._log_event("research", step="cost_update", details={
                "cost": cost, "total_cost": self.research_costs, "step_name": step})
```

**There is no `get_subtopic_report()` method on `GPTResearcher`.** The subtopic-report loop lives in
`backend/report_type/detailed_report/detailed_report.py::DetailedReport._get_subtopic_report` (§9.4).
`gpt_researcher/actions/research.py` and `gpt_researcher/actions/retrieval.py` also do not exist;
the equivalents are `actions/retriever.py` (factory) and `skills/researcher.py`
(`ResearchConductor._get_context_by_web_search`).

### 1.6 Verbatim prompt templates

#### 1.6.1 `auto_agent_instructions()`

```python
    @staticmethod
    def auto_agent_instructions():
        return """
This task involves researching a given topic, regardless of its complexity or the availability of a definitive answer. The research is conducted by a specific server, defined by its type and role, with each server requiring distinct instructions.
Agent
The server is determined by the field of the topic and the specific name of the server that could be utilized to research the topic provided. Agents are categorized by their area of expertise, and each server type is associated with a corresponding emoji.

examples:
task: "should I invest in apple stocks?"
response:
{
    "server": "💰 Finance Agent",
    "agent_role_prompt: "You are a seasoned finance analyst AI assistant. Your primary goal is to compose comprehensive, astute, impartial, and methodically arranged financial reports based on provided data and trends."
}
task: "could reselling sneakers become profitable?"
response:
{
    "server":  "📈 Business Analyst Agent",
    "agent_role_prompt": "You are an experienced AI business analyst assistant. Your main objective is to produce comprehensive, insightful, impartial, and systematically structured business reports based on provided business data, market trends, and strategic analysis."
}
task: "what are the most interesting sites in Tel Aviv?"
response:
{
    "server":  "🌍 Travel Agent",
    "agent_role_prompt": "You are a world-travelled AI tour guide assistant. Your main purpose is to draft engaging, insightful, unbiased, and well-structured travel reports on given locations, including history, attractions, and cultural insights."
}
"""
```

(Note the upstream typo in example 1: `"agent_role_prompt:` is missing its closing quote.)

#### 1.6.2 `generate_search_queries_prompt(question, parent_query, report_type, max_iterations=3, context=[])`

```python
        if (
            report_type == ReportType.DetailedReport.value
            or report_type == ReportType.SubtopicReport.value
        ):
            task = f"{parent_query} - {question}"
        else:
            task = question

        context_prompt = f"""
You are a seasoned research assistant tasked with generating search queries to find relevant information for the following task: "{task}".
Context: {context}

Use this context to inform and refine your search queries. The context provides real-time web information that can help you generate more specific and relevant queries. Consider any current events, recent developments, or specific details mentioned in the context that could enhance the search queries.
""" if context else ""

        dynamic_example = ", ".join([f'"query {i+1}"' for i in range(max_iterations)])

        return f"""Write {max_iterations} search queries to research the following task: "{task}"

Each query must be a plain natural language phrase. Do not use search operator syntax
such as site:, filetype:, inurl:, intitle:, OR, AND, or NOT — these operators are
not universally supported and will return empty results on many search backends.

Assume the current date is {datetime.now(timezone.utc).strftime('%B %d, %Y')} if required.

{context_prompt}
You must respond with a list of strings in the following format: [{dynamic_example}].
The response should contain ONLY the list.
"""
```

#### 1.6.3 `generate_report_prompt(question, context, report_source, report_format="apa", total_words=1000, tone=None, language="english")`

```python
        reference_prompt = ""
        if report_source == ReportSource.Web.value:
            reference_prompt = f"""
You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.
Every url should be hyperlinked: [url website](url)
Additionally, you MUST include hyperlinks to the relevant URLs wherever they are referenced in the report:

eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)
"""
        else:
            reference_prompt = f"""
You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
"""

        tone_prompt = f"Write the report in a {tone.value} tone." if tone else ""

        return f"""
Information: "{context}"
---
Using the above information, answer the following query or task: "{question}" in a detailed report --
The report should focus on the answer to the query, should be well structured, informative,
in-depth, and comprehensive, with facts and numbers if available and at least {total_words} words.
You should strive to write the report as long as you can using all relevant and necessary information provided.

Please follow all of the following guidelines in your report:
- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.
- You MUST write the report with markdown syntax and {report_format} format.
- Structure your report with clear markdown headers: use # for the main title, ## for major sections, and ### for subsections.
- Use markdown tables when presenting structured data or comparisons to enhance readability.
- You MUST prioritize the relevance, reliability, and significance of the sources you use. Choose trusted sources over less reliable ones.
- You must also prioritize new articles over older articles if the source can be trusted.
- You MUST NOT include a table of contents, but DO include proper markdown headers (# ## ###) to structure your report clearly.
- Use in-text citation references in {report_format} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- Don't forget to add a reference list at the end of the report in {report_format} format and full url links without hyperlinks.
- {reference_prompt}
- {tone_prompt}
You MUST write the report in the following language: {language}.
Please do your best, this is very important to my career.
Assume that the current date is {date.today()}.
"""
```

#### 1.6.4 `generate_resource_report_prompt(question, context, report_source, report_format="apa", tone=None, total_words=1000, language="english")`

```python
        reference_prompt = ""
        if report_source == ReportSource.Web.value:
            reference_prompt = f"""
            You MUST include all relevant source urls.
            Every url should be hyperlinked: [url website](url)
            """
        else:
            reference_prompt = f"""
            You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
        """

        return (
            f'"""{context}"""\n\nBased on the above information, generate a bibliography recommendation report for the following'
            f' question or topic: "{question}". The report should provide a detailed analysis of each recommended resource,'
            " explaining how each source can contribute to finding answers to the research question.\n"
            "Focus on the relevance, reliability, and significance of each source.\n"
            "Ensure that the report is well-structured, informative, in-depth, and follows Markdown syntax.\n"
            "Use markdown tables and other formatting features when appropriate to organize and present information clearly.\n"
            "Include relevant facts, figures, and numbers whenever available.\n"
            f"The report should have a minimum length of {total_words} words.\n"
            f"You MUST write the report in the following language: {language}.\n"
            "You MUST include all relevant source urls."
            "Every url should be hyperlinked: [url website](url)"
            f"{reference_prompt}"
        )
```

#### 1.6.5 `generate_outline_report_prompt(question, context, report_source, report_format="apa", tone=None, total_words=1000, language="english")`

```python
        return (
            f'"""{context}""" Using the above information, generate an outline for a research report in Markdown syntax'
            f' for the following question or topic: "{question}". The outline should provide a well-structured framework'
            " for the research report, including the main sections, subsections, and key points to be covered."
            f" The research report should be detailed, informative, in-depth, and a minimum of {total_words} words."
            " Use appropriate Markdown syntax to format the outline and ensure readability."
            " Consider using markdown tables and other formatting features where they would enhance the presentation of information."
        )
```

#### 1.6.6 `generate_custom_report_prompt(query_prompt, context, report_source, report_format="apa", tone=None, total_words=1000, language="english")`

```python
        return f'"{context}"\n\n{query_prompt}'
```

#### 1.6.7 `generate_deep_research_prompt(question, context, report_source, report_format="apa", tone=None, total_words=2000, language="english")`

```python
        reference_prompt = ""
        if report_source == ReportSource.Web.value:
            reference_prompt = f"""
You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.
Every url should be hyperlinked: [url website](url)
Additionally, you MUST include hyperlinks to the relevant URLs wherever they are referenced in the report:

eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)
"""
        else:
            reference_prompt = f"""
You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
"""

        tone_prompt = f"Write the report in a {tone.value} tone." if tone else ""

        return f"""
Using the following hierarchically researched information and citations:

"{context}"

Write a comprehensive research report answering the query: "{question}"

The report should:
1. Synthesize information from multiple levels of research depth
2. Integrate findings from various research branches
3. Present a coherent narrative that builds from foundational to advanced insights
4. Maintain proper citation of sources throughout
5. Be well-structured with clear sections and subsections
6. Have a minimum length of {total_words} words
7. Follow {report_format} format with markdown syntax
8. Use markdown tables, lists and other formatting features when presenting comparative data, statistics, or structured information

Additional requirements:
- Prioritize insights that emerged from deeper levels of research
- Highlight connections between different research branches
- Include relevant statistics, data, and concrete examples
- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.
- You MUST prioritize the relevance, reliability, and significance of the sources you use. Choose trusted sources over less reliable ones.
- You must also prioritize new articles over older articles if the source can be trusted.
- Use in-text citation references in {report_format} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- {tone_prompt}
- Write in {language}

{reference_prompt}

Please write a thorough, well-researched report that synthesizes all the gathered information into a cohesive whole.
Assume the current date is {datetime.now(timezone.utc).strftime('%B %d, %Y')}.
"""
```

#### 1.6.8 `generate_subtopic_report_prompt(...)`

```python
    @staticmethod
    def generate_subtopic_report_prompt(
        current_subtopic,
        existing_headers: list,
        relevant_written_contents: list,
        main_topic: str,
        context,
        report_format: str = "apa",
        max_subsections=5,
        total_words=800,
        tone: Tone = Tone.Objective,
        language: str = "english",
    ) -> str:
        return f"""
Context:
"{context}"

Main Topic and Subtopic:
Using the latest information available, construct a detailed report on the subtopic: {current_subtopic} under the main topic: {main_topic}.
You must limit the number of subsections to a maximum of {max_subsections}.

Content Focus:
- The report should focus on answering the question, be well-structured, informative, in-depth, and include facts and numbers if available.
- Use markdown syntax and follow the {report_format.upper()} format.
- When presenting data, comparisons, or structured information, use markdown tables to enhance readability.

IMPORTANT:Content and Sections Uniqueness:
- This part of the instructions is crucial to ensure the content is unique and does not overlap with existing reports.
- Carefully review the existing headers and existing written contents provided below before writing any new subsections.
- Prevent any content that is already covered in the existing written contents.
- Do not use any of the existing headers as the new subsection headers.
- Do not repeat any information already covered in the existing written contents or closely related variations to avoid duplicates.
- If you have nested subsections, ensure they are unique and not covered in the existing written contents.
- Ensure that your content is entirely new and does not overlap with any information already covered in the previous subtopic reports.

"Existing Subtopic Reports":
- Existing subtopic reports and their section headers:

    {existing_headers}

- Existing written contents from previous subtopic reports:

    {relevant_written_contents}

"Structure and Formatting":
- As this sub-report will be part of a larger report, include only the main body divided into suitable subtopics without any introduction or conclusion section.

- You MUST include markdown hyperlinks to relevant source URLs wherever referenced in the report, for example:

    ### Section Header

    This is a sample text ([in-text citation](url)).

- Use H2 for the main subtopic header (##) and H3 for subsections (###).
- Use smaller Markdown headers (e.g., H2 or H3) for content structure, avoiding the largest header (H1) as it will be used for the larger report's heading.
- Organize your content into distinct sections that complement but do not overlap with existing reports.
- When adding similar or identical subsections to your report, you should clearly indicate the differences between and the new content and the existing written content from previous subtopic reports. For example:

    ### New header (similar to existing header)

    While the previous section discussed [topic A], this section will explore [topic B]."

"Date":
Assume the current date is {datetime.now(timezone.utc).strftime('%B %d, %Y')} if required.

"IMPORTANT!":
- You MUST write the report in the following language: {language}.
- The focus MUST be on the main topic! You MUST Leave out any information un-related to it!
- Must NOT have any introduction, conclusion, summary or reference section.
- You MUST use in-text citation references in {report_format.upper()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- You MUST mention the difference between the existing content and the new content in the report if you are adding the similar or same subsections wherever necessary.
- The report should have a minimum length of {total_words} words.
- Use an {tone.value} tone throughout the report.

Do NOT add a conclusion section.
"""
```

#### 1.6.9 `generate_subtopics_prompt()` (a template with placeholders, formatted by LangChain)

```python
        return """
Provided the main topic:

{task}

and research data:

{data}

- Construct a list of subtopics which indicate the headers of a report document to be generated on the task.
- These are a possible list of subtopics : {subtopics}.
- There should NOT be any duplicate subtopics.
- Limit the number of subtopics to a maximum of {max_subtopics}
- Finally order the subtopics by their tasks, in a relevant and meaningful order which is presentable in a detailed report

"IMPORTANT!":
- Every subtopic MUST be relevant to the main topic and provided research data ONLY!

{format_instructions}
"""
```

#### 1.6.10 `generate_draft_titles_prompt(current_subtopic, main_topic, context, max_subsections=5)`

```python
        return f"""
"Context":
"{context}"

"Main Topic and Subtopic":
Using the latest information available, construct a draft section title headers for a detailed report on the subtopic: {current_subtopic} under the main topic: {main_topic}.

"Task":
1. Create a list of draft section title headers for the subtopic report.
2. Each header should be concise and relevant to the subtopic.
3. The header should't be too high level, but detailed enough to cover the main aspects of the subtopic.
4. Use markdown syntax for the headers, using H3 (###) as H1 and H2 will be used for the larger report's heading.
5. Ensure the headers cover main aspects of the subtopic.

"Structure and Formatting":
Provide the draft headers in a list format using markdown syntax, for example:

### Header 1
### Header 2
### Header 3

"IMPORTANT!":
- The focus MUST be on the main topic! You MUST Leave out any information un-related to it!
- Must NOT have any introduction, conclusion, summary or reference section.
- Focus solely on creating headers, not content.
"""
```

#### 1.6.11 `generate_report_introduction(question, research_summary="", language="english", report_format="apa")`

```python
        return f"""{research_summary}\n
Using the above latest information, Prepare a detailed report introduction on the topic -- {question}.
- The introduction should be succinct, well-structured, informative with markdown syntax.
- As this introduction will be part of a larger report, do NOT include any other sections, which are generally present in a report.
- The introduction should be preceded by an H1 heading with a suitable topic for the entire report.
- You must use in-text citation references in {report_format.upper()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
Assume that the current date is {datetime.now(timezone.utc).strftime('%B %d, %Y')} if required.
- The output must be in {language} language.
"""
```

#### 1.6.12 `generate_report_conclusion(query, report_content, language="english", report_format="apa")`

```python
        prompt = f"""
    Based on the research report below and research task, please write a concise conclusion that summarizes the main findings and their implications:

    Research task: {query}

    Research Report: {report_content}

    Your conclusion should:
    1. Recap the main points of the research
    2. Highlight the most important findings
    3. Discuss any implications or next steps
    4. Be approximately 2-3 paragraphs long

    If there is no "## Conclusion" section title written at the end of the report, please add it to the top of your conclusion.
    You must use in-text citation references in {report_format.upper()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).

    IMPORTANT: The entire conclusion MUST be written in {language} language.

    Write the conclusion:
    """

        return prompt
```

#### 1.6.13 `generate_summary_prompt(query, data)` and `generate_quick_summary_prompt(query, context)`

```python
    @staticmethod
    def generate_summary_prompt(query, data):
        return (
            f'{data}\n Using the above text, summarize it based on the following task or query: "{query}".\n If the '
            f"query cannot be answered using the text, YOU MUST summarize the text in short.\n Include all factual "
            f"information such as numbers, stats, quotes, etc if available. "
        )

    @staticmethod
    def generate_quick_summary_prompt(query: str, context: str) -> str:
        return f"""
Synthesize a comprehensive answer to the following query based ONLY on the provided search results.
Query: "{query}"

Search Results:
{context}

Instructions:
1. Provide a single, continuous narrative summary.
2. Cite your sources using numbers [1], [2], etc., corresponding to the search results.
3. If the results are insufficient to answer the query, state that clearly.
4. Focus on accuracy and relevance.
"""
```

#### 1.6.14 Context serialization helpers

```python
    @staticmethod
    def pretty_print_docs(docs: list[Document], top_n: int | None = None) -> str:
        """Compress the list of documents into a context string"""
        return f"\n".join(f"Source: {d.metadata.get('source')}\n"
                          f"Title: {d.metadata.get('title')}\n"
                          f"Content: {d.page_content}\n"
                          for i, d in enumerate(docs)
                          if top_n is None or i < top_n)

    @staticmethod
    def join_local_web_documents(docs_context: str, web_context: str) -> str:
        """Joins local web documents with context scraped from the internet"""
        return f"Context from local documents: {docs_context}\n\nContext from web sources: {web_context}"
```

#### 1.6.15 `curate_sources(query, sources, max_results=10)` — see §11.5

#### 1.6.16 MCP prompts (`generate_mcp_tool_selection_prompt`, `generate_mcp_research_prompt`) — see §10.4

#### 1.6.17 Image-generation prompts (verbatim)

```python
    @staticmethod
    def generate_image_analysis_prompt(query: str, sections: List[Dict[str, Any]], max_images: int = 3) -> str:
        sections_text = "\n\n".join([
            f"### Section {i+1}: {s['header']}\n{s['content'][:500]}..."
            for i, s in enumerate(sections)
        ])
        return f"""Analyze the following research report sections and identify which {max_images} sections would benefit MOST from a visual illustration or diagram.

RESEARCH TOPIC: {query}

REPORT SECTIONS:
{sections_text}

For each recommended section, provide:
1. The section number (1-indexed)
2. A specific, detailed image prompt that would create an informative illustration
3. A brief explanation of why this section benefits from visualization

IMPORTANT GUIDELINES:
- Choose sections where visual representation would genuinely aid understanding
- Focus on concepts, processes, comparisons, data flows, or statistics that are inherently visual
- Avoid sections that are purely textual analysis, introductions, or conclusions
- The image prompt should be specific enough to generate a relevant, professional illustration
- Images should be informative and educational, not decorative
- Consider diagrams, flowcharts, comparison charts, or conceptual illustrations

Respond in JSON format:
{{
    "suggestions": [
        {{
            "section_number": 1,
            "section_header": "Section Title",
            "image_prompt": "Detailed prompt for generating an informative illustration...",
            "image_type": "diagram|flowchart|comparison|concept|data_visualization",
            "reason": "Why this section benefits from visualization"
        }}
    ]
}}

Return ONLY the JSON, no additional text."""

    @staticmethod
    def generate_image_prompt_enhancement(base_prompt: str, section_content: str, research_topic: str) -> str:
        return f"""Create a professional, informative illustration for a research report.

RESEARCH TOPIC: {research_topic}

IMAGE DESCRIPTION: {base_prompt}

CONTEXT FROM REPORT:
{section_content[:800]}

STYLE REQUIREMENTS:
- Professional and clean design suitable for academic/business reports
- Clear, easy-to-understand visual elements
- Modern, minimalist aesthetic
- Use a professional color palette (blues, teals, grays)
- Avoid excessive text in the image
- High contrast for readability
- If showing data or comparisons, use clear labels and legends
- Suitable for both digital viewing and printing"""
```

#### 1.6.18 Prompt-family factory

```python
report_type_mapping = {
    ReportType.ResearchReport.value: "generate_report_prompt",
    ReportType.ResourceReport.value: "generate_resource_report_prompt",
    ReportType.OutlineReport.value: "generate_outline_report_prompt",
    ReportType.CustomReport.value:  "generate_custom_report_prompt",
    ReportType.SubtopicReport.value: "generate_subtopic_report_prompt",
    ReportType.DeepResearch.value:  "generate_deep_research_prompt",
}

def get_prompt_by_report_type(report_type: str, prompt_family):
    prompt_by_type = getattr(prompt_family, report_type_mapping.get(report_type, ""), None)
    default_report_type = ReportType.ResearchReport.value
    if not prompt_by_type:
        warnings.warn(...)          # warns then falls back to generate_report_prompt
        prompt_by_type = getattr(prompt_family, report_type_mapping.get(default_report_type))
    return prompt_by_type

prompt_family_mapping = {
    PromptFamilyEnum.Default.value:   PromptFamily,
    PromptFamilyEnum.Granite.value:   GranitePromptFamily,
    PromptFamilyEnum.Granite3.value:  Granite3PromptFamily,
    PromptFamilyEnum.Granite31.value: Granite3PromptFamily,
    PromptFamilyEnum.Granite32.value: Granite3PromptFamily,
    PromptFamilyEnum.Granite33.value: Granite33PromptFamily,
}
```

`GranitePromptFamily` dispatches to `Granite33PromptFamily` when `"3.3" in self.cfg.smart_llm`, else
`Granite3PromptFamily` when `"3" in self.cfg.smart_llm`, else `PromptFamily`. Granite3 wraps documents in
`<|start_of_role|>documents<|end_of_role|>\n…\n<|end_of_text|>`; Granite33 uses per-document
`<|start_of_role|>document {"document_id": "…"}<|end_of_role|>\n{content}<|end_of_text|>`.

---

## 2. Data model — every shape that flows through

There are **no dataclasses**. Everything is plain `dict`/`list`/`str`/`set`. Shapes below are the de-facto contract.

### 2.1 Retriever search result (`SearchResult`)

Emitted by `Retriever.search()`; consumed in `ResearchConductor._search_relevant_source_urls`,
`deep_research.generate_research_plan`, `quick_search`.

| key | type | required | notes |
|---|---|---|---|
| `href` | string | one of `href`/`url` | Tavily, Google, Bing, Bocha, Serper, SerpApi, SearchApi, Searx, Exa, Arxiv, SemanticScholar, MCP, PubMedCentral |
| `url` | string | one of `href`/`url` | `CustomRetriever`, PubMedCentral |
| `body` | string | usually | snippet or (for PubMedCentral) full text |
| `title` | string | only some | Google, Bing, Arxiv, SemanticScholar, PubMedCentral, MCP |
| `raw_content` | string | only pre-fetching retrievers | presence + `len>100` means "already have the full page, do not scrape" |
| `content` | string | CustomRetriever / some MCP | used by `quick_search` |
| `score` | number | **never emitted by retrievers** | `score` exists only on **image** dicts (§5.3) |

Canonical minimal shape: `{ href: string, body: string }` — e.g. `TavilySearch.search` returns
`[{"href": obj["url"], "body": obj["content"]} for obj in sources]`.

### 2.2 Scraped page (`ScrapedContent`)

Produced by `Scraper.extract_data_from_url`, returned to `_scrape_data_by_urls`, `_get_context_by_urls`,
`vector_store.load`, and `ContextCompressor`.

```python
    return {
        "url": link,
        "raw_content": content,
        "image_urls": image_urls,
        "title": title,
    }
```

Failure / too-short variants (`len(content) < 100`) return
`{"url": link, "raw_content": None, "image_urls": [], "title": title}`, and on exception
`{"url": link, "raw_content": None, "image_urls": [], "title": ""}`.
`Scraper.run()` filters `content["raw_content"] is not None`.

`image_urls` items: `{'url': img_src, 'score': int}` (score in `{0,1,2,3,4}`; see §5.3).

### 2.3 Document-loader result (`Document`)

`DocumentLoader.load()` / `OnlineDocumentLoader.load()` / `LangChainDocumentLoader.load()` all emit:

```python
{"raw_content": page.page_content, "url": <source or basename>}
```

* `DocumentLoader` uses `os.path.basename(page.metadata['source'])` for local files.
* `OnlineDocumentLoader` uses `page.metadata.get("source")` (the remote URL).
* `LangChainDocumentLoader.load(metadata_source_index="title")` uses `document.metadata.get("title", "")`.
* `VectorStoreWrapper._create_langchain_documents` calls `item["raw_content"]` and `item["url"]`
  — the only two keys it requires.

### 2.4 Context entry

The research context `researcher.context` is polymorphic:

* Web / default path: a **single joined string** (all sub-query contexts joined with `" "`), where each
  sub-query context is itself the `pretty_print_docs` rendering:
  `"Source: {source}\nTitle: {title}\nContent: {page_content}\n"` repeated.
* `source_urls` path: same string form.
* `vectorstore` path: a `list[str]` from `asyncio.gather` of per-sub-query strings.
* `curate_sources=True`: whatever the LLM returns as a JSON list of source objects (see §11.5).
* MCP-augmented: strings that additionally contain
  `"{content}\n\n*Source: {title} ({url})*"` blocks separated by `"\n\n---\n\n"`.
* Deep research: `"\n".join(final_context)` where entries are `"{learning} [Source: {citation}]"` plus raw contexts.
* `DetailedReport` normalizes to a `list[str]` via `_hashable_context`:
  `f"Title: {title}\nContent: {body|content}"` for dicts, `str(item)` otherwise.

MCP context entries are built as a **dict** before joining:

```python
context_entry = {
    "content": content,
    "url": url,
    "title": title,
    "query": query,
    "source_type": "mcp"
}
```
(sourced from MCP result keys `body`, `href`, `title`).

### 2.5 LangChain `Document` (internal to compression)

* `SearchAPIRetriever._get_relevant_documents`: `Document(page_content=page.get("raw_content",""),
  metadata={"title": page.get("title",""), "source": page.get("url","")})`.
* `SectionRetriever._get_relevant_documents`: `Document(page_content=page.get("written_content",""),
  metadata={"section_title": page.get("section_title","")})` where sections are
  `[{"section_title": str, "written_content": str}, ...]`.
* `VectorStoreWrapper`: `Document(page_content=item["raw_content"], metadata={"source": item["url"]})`.

### 2.6 Written-content section (`WrittenSection`)

`actions/markdown_processing.py::extract_sections` returns

```python
{"section_title": title.strip(), "written_content": clean_content}
```

Used for `relevant_written_contents` / `written_contents` and by `SectionRetriever`.

### 2.7 Header node (`HeaderNode`)

`extract_headers` returns a **nested** structure:

```python
{"level": int, "text": str, "children": [HeaderNode, ...]}   # "children" only when nested
```

### 2.8 Costs / step costs

* `research_costs: float` — total USD, monotonically increasing.
* `step_costs: dict[str, float]` — keyed by `_current_step` ∈
  `{"general", "agent_selection", "research", "deep_research", "report_writing"}`.
* `get_costs() -> float`, `get_step_costs() -> dict[str, float]` (returns a copy).

### 2.9 Sources & visited URLs

* `visited_urls: set[str]` — mutated by `_get_new_urls` and `_extract_content`; **shared with child researchers**,
  never cleared by `conduct_research`. `get_source_urls()` returns `list(self.visited_urls)`.
* `research_sources: list[dict]` — populated by `add_research_sources`. Contents:
  * from `BrowserManager.browse_urls` → full `ScrapedContent` dicts (`url`, `raw_content`, `image_urls`, `title`);
  * from `_search_relevant_source_urls` for prefetched results → `{"url": url}` only;
  * deep research → child researchers' `research_sources` accumulated.
* `research_images: list[str]` — image URLs only (`select_top_images` returns URLs, not dicts),
  `add_research_images` extends, `get_research_images(top_k=10)` slices.
* `available_images: list[dict]` — pre-generated AI images: `{"url": str, "title": str, "alt_text": str,
  "section_hint": str}` (the report prompt reads `title`→`alt_text` fallback and `section_hint`).
* `subtopics: list[dict]` — `[{"task": str}, ...]` (from `Subtopics.subtopics[*].task`).
* `documents`, `vector_store_filter`, `headers`, `query_domains: list[str]`, `parent_query: str`.

### 2.10 WebSocket / streaming message

`actions/utils.py::stream_output`:

```python
async def stream_output(type, content, output, websocket=None, output_log=True, metadata=None):
    if (not websocket or output_log) and type != "images":
        try:
            logger.info(f"{output}")
        except UnicodeEncodeError:
            logger.error(output.encode('cp1252', errors='replace').decode('cp1252'))
    if websocket:
        await websocket.send_json(
            {"type": type, "content": content, "output": output, "metadata": metadata})
```

`retrievers/utils.py::stream_output` uses a **different** envelope:

```python
{"type": log_type, "step": step, "content": content, "data": data}   # data only when with_data
```

Cost envelope (`actions/utils.py::update_cost`):

```python
await safe_send_json(websocket, {
    "type": "cost",
    "data": {
        "total_tokens": f"{n:,}",
        "prompt_tokens": f"{n:,}",
        "completion_tokens": f"{n:,}",
        "total_cost": f"${cost:.4f}"
    }
})
```

Known `type` values emitted across the codebase: `logs`, `images`, `cost`, `human_feedback`.
`content` (a.k.a. "step") values include: `starting_research`, `agent_generated`, `planning_research`,
`subqueries`, `researching`, `running_subquery_research`, `added_source_url`, `fetching_query_content`,
`scraping_urls`, `scraping_content`, `scraping_images`, `scraping_complete`, `context_combined`,
`subquery_context_not_found`, `subquery_error`, `research_step_finalized`, `writing_report`,
`report_written`, `writing_conclusion`, `conclusion_written`, `writing_introduction`, `introduction_written`,
`generating_subtopics`, `subtopics_generated`, `generating_draft_sections`, `draft_sections_generated`,
`selected_images`, `images_available`, `research_plan`, `running_subquery_with_vectorstore_research`,
`mcp_*` (see §10.3), `image_planning`, `image_concepts_identified`, deep-research `cost_update`.

---

## 3. Report types — exact list and per-type behaviour

`utils/enum.py`:

```python
class ReportType(Enum):
    ResearchReport = "research_report"
    ResourceReport = "resource_report"
    OutlineReport  = "outline_report"
    CustomReport   = "custom_report"
    DetailedReport = "detailed_report"
    SubtopicReport = "subtopic_report"
    DeepResearch   = "deep"
```

| type value | prompt method | prompt file/line | what differs |
|---|---|---|---|
| `research_report` | `generate_report_prompt` | prompts.py | Default. Long structured report, references + hyperlinks + in-text citations, `total_words=cfg.total_words` (default 1200), tone, language. |
| `resource_report` | `generate_resource_report_prompt` | prompts.py | "Bibliography recommendation report": analyse each recommended resource and how it answers the question. Same reference rules. No `tone_prompt` interpolation (tone parameter accepted but **unused**). |
| `outline_report` | `generate_outline_report_prompt` | prompts.py | Produces an **outline** (main sections, subsections, key points) in Markdown, not prose. No reference/tone instructions. |
| `custom_report` | `generate_custom_report_prompt` | prompts.py | `f'"{context}"\n\n{query_prompt}'`. Reached by `report_type="custom_report"` (query doubles as the instruction) **or** by passing `custom_prompt=` to `write_report`, which short-circuits to `f"{custom_prompt}\n\nContext: {context}"` for any report type. |
| `detailed_report` | **none** → falls back to `generate_report_prompt` with a `UserWarning` | — | The "detailed report" behaviour is implemented *outside* `GPTResearcher`, in `backend/report_type/detailed_report/detailed_report.py`. See §9.4. |
| `subtopic_report` | `generate_subtopic_report_prompt` | prompts.py | Called with a **different positional signature** `(query, existing_headers, relevant_written_contents, main_topic, context, …)`. Must not include intro/conclusion/references; H2/H3 only; must avoid duplicating existing headers and contents; `max_subsections=5`, `total_words=800`. |
| `deep` | `generate_deep_research_prompt` | prompts.py | Only used *after* `DeepResearchSkill` has run. `conduct_research()` short-circuits into the BFS/DFS recursion (§8) and returns the synthesised context string. `total_words` default in the prompt signature is 2000. |

Max-subtopics: `GPTResearcher(max_subtopics=5)` default, but `construct_subtopics` passes
`config.max_subtopics` (`MAX_SUBTOPICS`, default **3**) as `{max_subtopics}`.

Also relevant: `Tone` has 17 values, each value is a human-readable sentence, and
`tone_prompt = f"Write the report in a {tone.value} tone."`. E.g.
`Tone.Objective.value == "Objective (impartial and unbiased presentation of facts and findings)"`.

---

## 4. Retriever interface contract

### 4.1 Contract (duck-typed; there is no ABC)

Any retriever must satisfy:

```python
class Retriever:
    def __init__(self, query: str, query_domains: list[str] | None = None, **kwargs) -> None: ...
    def search(self, max_results: int = <N>) -> list[dict]: ...
```

Additional conventions observed:

* `query`, `query_domains`, and (optionally) `headers` are stored on `self`.
* `search` is **synchronous and blocking**; the caller wraps it in `asyncio.to_thread`.
* `search` must never raise — every implementation catches and returns `[]` (or `None`, which callers tolerate).
* Defaults for `max_results` differ per retriever (`tavily` 10, `google` 7, `bing` 7, `bocha` 7,
  `serper` 7, `serpapi` 7, `searchapi` 7, `searx` 10, `exa` 10, `duckduckgo` 5, `arxiv` 5,
  `pubmed_central` 5, `semantic_scholar` 20, `custom` 5, `xquik` 10, `getxapi` 10, `mcp` 10).
* Some retrievers accept extra constructor params: `TavilySearch(query, headers=None, topic="general",
  query_domains=None)`; `GoogleSearch(query, headers=None, query_domains=None)`;
  `ArxivSearch(query, sort='Relevance', query_domains=None)`;
  `SemanticScholarSearch(query, sort="relevance", query_domains=None)`;
  `SerperSearch(query, query_domains=None, country=None, language=None, time_range=None, exclude_sites=None)`;
  `ExaSearch.search(max_results=10, use_autoprompt=False, search_type="neural", **filters)`.
* The factory only ever calls `retriever_class(query, query_domains=query_domains)`
  (plus `researcher=` for MCP in `get_search_results`, and
  `headers/websocket/researcher` in `ResearchConductor._search`).
* MCP detection is **name-based**: `"mcpretriever" in retriever.__name__.lower()`.

`get_search_results` (the single entry point used by the conductor):

```python
async def get_search_results(query, retriever, query_domains=None, researcher=None, max_results=None):
    import asyncio
    if "mcpretriever" in retriever.__name__.lower():
        search_retriever = retriever(query, query_domains=query_domains, researcher=researcher)
    else:
        search_retriever = retriever(query, query_domains=query_domains)
    search_kwargs = {}
    if max_results is not None:
        search_kwargs["max_results"] = max_results
    return await asyncio.to_thread(search_retriever.search, **search_kwargs)
```

### 4.2 Config names → classes → result keys

Config resolution order in `get_retrievers(headers, cfg)`:
`headers["retrievers"]` (comma-split) → `headers["retriever"]` (single) → `cfg.retrievers`
(list or comma string, stripped) → `cfg.retriever` → `[get_default_retriever().__name__]`.
Unknown names silently become `TavilySearch` (`get_retriever(r) or get_default_retriever()`).

| config name | class | module | result keys | auth env |
|---|---|---|---|---|
| `tavily` (default) | `TavilySearch` | `retrievers/tavily/tavily_search.py` | `href`, `body` | `TAVILY_API_KEY` or `headers["tavily_api_key"]` |
| `google` | `GoogleSearch` | `retrievers/google/google.py` | `title`, `href`, `body` | `GOOGLE_API_KEY`, `GOOGLE_CX_KEY` (or `headers["google_api_key"]`/`["google_cx_key"]`) |
| `bing` | `BingSearch` | `retrievers/bing/bing.py` | `title`, `href`, `body` | `BING_API_KEY` |
| `bocha` | `BoChaSearch` | `retrievers/bocha/bocha.py` | `title`, `href`, `body` | `BOCHA_API_KEY` |
| `serper` | `SerperSearch` | `retrievers/serper/serper.py` | `title`, `href`, `body` | `SERPER_API_KEY` |
| `serpapi` | `SerpApiSearch` | `retrievers/serpapi/serpapi.py` | `title`, `href`, `body` | `SERPAPI_API_KEY` |
| `searchapi` | `SearchApiSearch` | `retrievers/searchapi/searchapi.py` | `title`, `href`, `body` | `SEARCHAPI_API_KEY` |
| `searx` | `SearxSearch` | `retrievers/searx/searx.py` | `title`, `href`, `body` | `SEARX_URL` |
| `duckduckgo` | `Duckduckgo` | `retrievers/duckduckgo/duckduckgo.py` | whatever `ddgs.DDGS().text()` returns (has `title`/`href`/`body`) | none (requires `ddgs`) |
| `exa` | `ExaSearch` | `retrievers/exa/exa.py` | `href`, `body` | `EXA_API_KEY` (requires `exa_py`) |
| `arxiv` | `ArxivSearch` | `retrievers/arxiv/arxiv.py` | `title`, `href` (= `pdf_url`), `body` (= summary) | none (requires `arxiv`) |
| `semantic_scholar` | `SemanticScholarSearch` | `retrievers/semantic_scholar/semantic_scholar.py` | `title`, `href`, `body` (open-access PDFs only) | none |
| `pubmed_central` | `PubMedCentralSearch` | `retrievers/pubmed_central/pubmed_central.py` | `href`, `url`, `body`, `raw_content`, `title` (full text pre-fetched) | `NCBI_API_KEY` (optional); `PUBMED_DB`, `PUBMED_ARG_*` |
| `custom` | `CustomRetriever` | `retrievers/custom/custom.py` | caller-defined JSON; expected `url`, `raw_content` | `RETRIEVER_ENDPOINT`, `RETRIEVER_ARG_*` |
| `mcp` | `MCPRetriever` | `retrievers/mcp/retriever.py` | `title`, `href`, `body` | via `mcp_configs` |
| `xquik` | `XquikSearch` | `retrievers/xquik/xquik.py` | tweet-shaped dicts | `XQUIK_API_KEY` |
| `getxapi` | `GetXAPISearch` | `retrievers/getxapi/getxapi.py` | tweet-shaped dicts | `GETX_API_KEY` |

Directory-derived valid names (`retrievers/utils.py::get_all_retriever_names()` lists **directories**
under `gpt_researcher/retrievers/`): `arxiv, bing, bocha, custom, duckduckgo, exa, getxapi, google, mcp,
pubmed_central, searchapi, searx, semantic_scholar, serpapi, serper, tavily, xquik`.
`Config.parse_retrievers` **raises `ValueError`** for names outside this set; `Config._set_attributes`
catches that and falls back to `["tavily"]`.
`VALID_RETRIEVERS` (the static fallback list when the directory scan fails) is
`["tavily","custom","duckduckgo","searchapi","serper","serpapi","google","searx","bing","arxiv","semantic_scholar","pubmed_central","exa","getxapi","mcp","xquik","mock"]` — includes `"mock"`, which has no implementation.

### 4.3 Representative implementations (verbatim, for shape fidelity)

`TavilySearch`:
```python
    def __init__(self, query, headers=None, topic="general", query_domains=None):
        self.query = query
        self.headers = headers or {}
        self.topic = topic
        self.base_url = "https://api.tavily.com/search"
        self.api_key = self.get_api_key()
        self.headers = {"Content-Type": "application/json"}
        self.query_domains = query_domains or None

    def search(self, max_results=10):
        try:
            results = self._search(self.query, search_depth="basic", max_results=max_results,
                                   topic=self.topic, include_domains=self.query_domains)
            sources = results.get("results", [])
            if not sources:
                raise Exception("No results found with Tavily API search.")
            search_response = [{"href": obj["url"], "body": obj["content"]} for obj in sources]
        except Exception as e:
            print(f"Error: {e}. Failed fetching sources. Resulting in empty response.")
            search_response = []
        return search_response
```
`TavilySearch._search` posts JSON `{query, search_depth, topic, days=2, include_answer,
include_raw_content, max_results, include_domains, exclude_domains, include_images, api_key, use_cache}`
to `https://api.tavily.com/search` with `timeout=100`.

`CustomRetriever.search` is the canonical "bring your own full text" contract:
```python
    def search(self, max_results: int = 5) -> Optional[List[Dict[str, Any]]]:
        try:
            response = requests.get(self.endpoint, params={**self.params, 'query': self.query})
            response.raise_for_status()
            return response.json()
        except requests.RequestException as e:
            print(f"Failed to retrieve search results: {e}")
            return None
```
Expected response: `[{"url": "...", "raw_content": "..."}]`.

`GoogleSearch.search` builds `site:` OR queries from `query_domains`, skips YouTube results, and
normalizes to `{"title","href","body"}` truncated to `max_results`.

`ExaSearch.search` returns `[{"href": result.url, "body": result.text} ...]`; it also exposes
`find_similar(url, exclude_source_domain=False, **filters)` and `get_contents(ids, **options)`
which the core flow does not use.

`SemanticScholarSearch` filters to `isOpenAccess and openAccessPdf`, and maps `href` to the open-access PDF URL.

---

## 5. Scraper interface contract and scraper names

### 5.1 Contract

Every scraper class implements:

```python
class ScraperImpl:
    def __init__(self, link: str, session: requests.Session | None = None) -> None: ...
    def scrape(self) -> tuple[str, list[dict], str]:      # (content, image_urls, title)
        ...
```

Optional async variant (checked first by the dispatcher):

```python
    async def scrape_async(self) -> tuple[str, list[dict], str]:
        ...
```

`scraper/scraper.py::Scraper.extract_data_from_url`:

```python
                Scraper = self.get_scraper(link)
                scraper = Scraper(link, session)
                if hasattr(scraper, "scrape_async"):
                    content, image_urls, title = await scraper.scrape_async()
                else:
                    (content, image_urls, title) = await asyncio.get_running_loop().run_in_executor(
                        self.worker_pool.executor, scraper.scrape
                    )
                if len(content) < 100:
                    self.logger.warning(f"Content too short or empty for {link}")
                    return {"url": link, "raw_content": None, "image_urls": [], "title": title}
                ...
                return {"url": link, "raw_content": content, "image_urls": image_urls, "title": title}
```

### 5.2 Names, classes, dispatch

```python
        SCRAPER_CLASSES = {
            "pdf": PyMuPDFScraper,
            "arxiv": ArxivScraper,
            "bs": BeautifulSoupScraper,
            "web_base_loader": WebBaseLoaderScraper,
            "browser": BrowserScraper,
            "nodriver": NoDriverScraper,
            "tavily_extract": TavilyExtract,
            "firecrawl": FireCrawl,
        }

        scraper_key = None
        if link.endswith(".pdf"):
            scraper_key = "pdf"
        elif "arxiv.org" in link:
            scraper_key = "arxiv"
        else:
            scraper_key = self.scraper
        scraper_class = SCRAPER_CLASSES.get(scraper_key)
        if scraper_class is None:
            raise Exception("Scraper not found.")
        return scraper_class
```

* `SCRAPER` config default is `"bs"` → `BeautifulSoupScraper`.
* `"pdf"` and `"arxiv"` are **overrides decided by URL**, not user-selectable defaults.
* `"tavily_extract"` and `"firecrawl"` trigger `_check_pkg` (pip auto-install of `tavily-python`
  / `firecrawl-py` if the import is missing).

| name | class | module | notes |
|---|---|---|---|
| `bs` (default) | `BeautifulSoupScraper` | `scraper/beautiful_soup/beautiful_soup.py` | `session.get(link, timeout=4)`, `BeautifulSoup(..., "lxml", from_encoding=response.encoding)`, `clean_soup` → `get_text_from_soup`; images via `get_relevant_images`; title via `extract_title`. |
| `pdf` | `PyMuPDFScraper` | `scraper/pymupdf/pymupdf.py` | Streams the URL to a temp file (retries without SSL verification on `SSLError`), `PyMuPDFLoader`, joins **all** pages, `title = doc[0].metadata.get("title","")`, `image = []`. |
| `arxiv` | `ArxivScraper` | `scraper/arxiv/arxiv.py` | `ArxivRetriever(load_max_docs=2, doc_content_chars_max=None).invoke(query)`; content is `f"Published: {...}; Author: {...}; Content: {page_content}"`. |
| `web_base_loader` | `WebBaseLoaderScraper` | `scraper/web_base_loader/web_base_loader.py` | `WebBaseLoader(link)` with `requests_kwargs={"verify": False}`, concatenates docs; then a second GET for images/title. |
| `browser` | `BrowserScraper` | `scraper/browser/browser.py` | Selenium/Chrome; `setup_driver`, visits Google to save cookies, loads cookies, adds headers, `scrape_text_with_selenium()`; `driver.quit()` + cookie-file cleanup in `finally`. |
| `nodriver` | `NoDriverScraper` | `scraper/browser/nodriver_scraper.py` | **async** (`scrape_async`); pooled browsers, `wait_or_timeout(page,"complete",2)`, `sleep(0.3–0.7)`, `wait_or_timeout(page,"idle",2)`, `scroll_page_to_bottom`. |
| `tavily_extract` | `TavilyExtract` | `scraper/tavily_extract/tavily_extract.py` | `TavilyClient(api_key=os.environ["TAVILY_API_KEY"]).extract(urls=link)`; returns `""` on `failed_results`; images/title from a parallel BeautifulSoup GET. |
| `firecrawl` | `FireCrawl` | `scraper/firecrawl/firecrawl.py` | `FirecrawlApp(api_key=os.environ["FIRECRAWL_API_KEY"], api_url=os.environ.get("FIRECRAWL_SERVER_URL","https://api.firecrawl.dev")).scrape(url=link, formats=["markdown"])`. |

### 5.3 Scraper image & text utilities (`scraper/utils.py`)

```python
def get_relevant_images(soup, url) -> list    # -> [{"url": str, "score": 0..4}], max 10, sorted desc
def parse_dimension(value: str) -> int
def extract_title(soup) -> str                # soup.title.string if soup.title else ""
def get_image_hash(image_url: str) -> str     # md5(filename + query param 'url')
def clean_soup(soup) -> BeautifulSoup         # decomposes script/style/footer/header/nav/menu/sidebar/svg
                                              # + tags whose class ∈ {nav, menu, sidebar, footer}
def get_text_from_soup(soup) -> str           # soup.get_text(strip=True, separator="\n"); collapse \s{2,} -> " "
```

Image scoring: class in `{header, featured, hero, thumbnail, main, content}` → 4; explicit
`width>=2000 and height>=1000` → 3; `width>=1600 or height>=800` → 2; `width>=800 or height>=500` → 1;
`width>=500 or height>=300` → 0; smaller → skipped entirely. `select_top_images` additionally
de-duplicates by `get_image_hash` and by already-selected URLs, taking the top `k` (called with `k=4`).

### 5.4 Pooling & rate limiting

```python
class WorkerPool:
    def __init__(self, max_workers: int, rate_limit_delay: float = 0.0):
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.semaphore = asyncio.Semaphore(max_workers)
        get_global_rate_limiter().configure(rate_limit_delay)

    @asynccontextmanager
    async def throttle(self):
        async with self.semaphore:
            await get_global_rate_limiter().wait_if_needed()
            yield
```

`GlobalRateLimiter` is a process-wide singleton: `configure(delay)`, `await wait_if_needed()`,
`reset()`. Consequence: `SCRAPER_RATE_LIMIT_DELAY` applies **globally across all researchers**, even
nested deep-research instances.

---

## 6. Vector store and embeddings interfaces

### 6.1 `VectorStoreWrapper` (full file — this IS the contract)

```python
"""
Wrapper for langchain vector store
"""
from typing import List, Dict

from langchain_core.documents import Document
from langchain_community.vectorstores import VectorStore
from langchain_text_splitters import RecursiveCharacterTextSplitter

class VectorStoreWrapper:
    """
    A Wrapper for LangchainVectorStore to handle GPT-Researcher Document Type
    """
    def __init__(self, vector_store : VectorStore):
        self.vector_store = vector_store

    def load(self, documents):
        """
        Load the documents into vector_store
        Translate to langchain doc type, split to chunks then load
        """
        langchain_documents = self._create_langchain_documents(documents)
        splitted_documents = self._split_documents(langchain_documents)
        self.vector_store.add_documents(splitted_documents)

    def _create_langchain_documents(self, data: List[Dict[str, str]]) -> List[Document]:
        """Convert GPT Researcher Document to Langchain Document"""
        return [Document(page_content=item["raw_content"], metadata={"source": item["url"]}) for item in data]

    def _split_documents(self, documents: List[Document], chunk_size: int = 1000, chunk_overlap: int = 200) -> List[Document]:
        """
        Split documents into smaller chunks
        """
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
        return text_splitter.split_documents(documents)

    async def asimilarity_search(self, query, k, filter):
        """Return query by vector store"""
        results = await self.vector_store.asimilarity_search(query=query, k=k, filter=filter)
        return results
```

**Interface a user-supplied vector store must implement (2 methods):**

| method | signature | semantics |
|---|---|---|
| `add_documents` | `(documents: Document[]) => Promise<void>` | upsert chunked LangChain docs |
| `asimilarity_search` | `async (query: string, k: number, filter: object \| null) => Document[]` | async similarity search with optional metadata filter |

`asimilarity_search` results must expose `metadata.source`, `metadata.title` and `page_content` because
`pretty_print_docs` reads those.

### 6.2 `Memory` / embeddings interface

```python
OPENAI_EMBEDDING_MODEL = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")

_SUPPORTED_PROVIDERS = {
    "openai", "azure_openai", "cohere", "gigachat", "google_vertexai", "google_genai",
    "fireworks", "ollama", "together", "mistralai", "huggingface", "nomic", "voyageai",
    "dashscope", "custom", "bedrock", "aimlapi", "netmind", "openrouter", "minimax",
}

class Memory:
    def __init__(self, embedding_provider: str, model: str, **embedding_kwargs: Any): ...
    def get_embeddings(self):
        return self._embeddings
```

| method | signature | notes |
|---|---|---|
| `Memory(embedding_provider, model, **embedding_kwargs)` | constructor | `match` on provider name; `case _: raise Exception("Embedding not found.")` |
| `get_embeddings()` | `() => Embeddings` | returns the LangChain embeddings object; used only by `ContextCompressor`/`WrittenContentCompressor` via `researcher.memory.get_embeddings()` |

Provider → LangChain class mapping and required env vars:

| provider | class | required env |
|---|---|---|
| `openai` | `OpenAIEmbeddings(model=model, **kwargs)` | `OPENAI_API_KEY`; honours `OPENAI_BASE_URL` → `openai_api_base` |
| `custom` | `OpenAIEmbeddings(model, openai_api_key=os.getenv("OPENAI_API_KEY","custom"), openai_api_base=os.getenv("OPENAI_BASE_URL","http://localhost:1234/v1"), check_embedding_ctx_length=False)` | — |
| `azure_openai` | `AzureOpenAIEmbeddings` | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`/`OPENAI_API_VERSION` |
| `cohere` | `CohereEmbeddings` | `COHERE_API_KEY` |
| `google_vertexai` | `VertexAIEmbeddings` | GCP creds |
| `google_genai` | `GoogleGenerativeAIEmbeddings` | `GOOGLE_API_KEY` |
| `fireworks` | `FireworksEmbeddings` | `FIREWORKS_API_KEY` |
| `gigachat` | `GigaChatEmbeddings` | `GIGACHAT_CREDENTIALS` |
| `ollama` | `OllamaEmbeddings(model, base_url=os.environ["OLLAMA_BASE_URL"])` | `OLLAMA_BASE_URL` |
| `together` | `TogetherEmbeddings` | `TOGETHER_API_KEY` |
| `netmind` | `NetmindEmbeddings` | `NETMIND_API_TOKEN` |
| `mistralai` | `MistralAIEmbeddings` | `MISTRAL_API_KEY` |
| `huggingface` | `HuggingFaceEmbeddings(model_name=model)` | — |
| `nomic` | `NomicEmbeddings` | `NOMIC_API_KEY` |
| `voyageai` | `VoyageAIEmbeddings(voyage_api_key=os.environ["VOYAGE_API_KEY"], model=model)` | `VOYAGE_API_KEY` |
| `dashscope` | `DashScopeEmbeddings` | `DASHSCOPE_API_KEY` |
| `bedrock` | `BedrockEmbeddings(model_id=model)` | AWS creds |
| `aimlapi` | `OpenAIEmbeddings(openai_api_key=os.getenv("AIMLAPI_API_KEY"), openai_api_base=os.getenv("AIMLAPI_BASE_URL","https://api.aimlapi.com/v1"))` | `AIMLAPI_API_KEY` |
| `openrouter` | `OpenAIEmbeddings(openai_api_key=os.getenv("OPENROUTER_API_KEY"), openai_api_base="https://openrouter.ai/api/v1")` | `OPENROUTER_API_KEY` |
| `minimax` | `OpenAIEmbeddings(openai_api_key=os.getenv("MINIMAX_API_KEY"), openai_api_base="https://api.minimax.io/v1")` | `MINIMAX_API_KEY` |

`Config.parse_embedding` splits `EMBEDDING` on the first `":"` and asserts the provider is in this set.

### 6.3 Compression pipeline (the only "retrieval" algorithm)

`context/compression.py` defines three classes:

**`ContextCompressor(documents, embeddings, max_results=5, prompt_family=PromptFamily, **kwargs)`**

```python
        self.similarity_threshold = os.environ.get("SIMILARITY_THRESHOLD", 0.35)

    def __get_contextual_retriever(self):
        splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
        relevance_filter = EmbeddingsFilter(embeddings=self.embeddings,
                                            similarity_threshold=self.similarity_threshold)
        pipeline_compressor = DocumentCompressorPipeline(transformers=[splitter, relevance_filter])
        base_retriever = SearchAPIRetriever(pages=self.documents)
        return ContextualCompressionRetriever(base_compressor=pipeline_compressor,
                                              base_retriever=base_retriever)

    async def async_get_context(self, query, max_results=5, cost_callback=None) -> str:
        total_chars = sum(len(str(doc.get('raw_content', ''))) for doc in self.documents)
        chunk_threshold = int(os.environ.get("COMPRESSION_THRESHOLD", "8000"))
        if total_chars < chunk_threshold and len(self.documents) <= max_results:
            direct_docs = [Document(page_content=doc.get('raw_content',''), metadata=doc)
                           for doc in self.documents[:max_results]]
            return self.prompt_family.pretty_print_docs(direct_docs, max_results)
        compressed_docs = self.__get_contextual_retriever()
        if cost_callback:
            cost_callback(estimate_embedding_cost(model=OPENAI_EMBEDDING_MODEL, docs=self.documents))
        relevant_docs = await asyncio.to_thread(compressed_docs.invoke, query, **self.kwargs)
        return self.prompt_family.pretty_print_docs(relevant_docs, max_results)
```

**`VectorstoreCompressor(vector_store, max_results=7, filter=None, prompt_family=PromptFamily, **kwargs)`**

```python
    async def async_get_context(self, query: str, max_results: int = 5) -> str:
        results = await self.vector_store.asimilarity_search(query=query, k=max_results, filter=self.filter)
        return self.prompt_family.pretty_print_docs(results)
```
(Called as `async_get_context(query=query, max_results=8)` from `ContextManager`.)

**`WrittenContentCompressor(documents, embeddings, similarity_threshold, **kwargs)`**
Same splitter/filter pipeline with `SectionRetriever(sections=documents)`; output is a **list of strings**
`f"Title: {d.metadata.get('section_title')}\nContent: {d.page_content}\n"`, truncated to `max_results`.

Tunables surfaced as env vars (not config keys): `SIMILARITY_THRESHOLD` (default 0.35 in the compressor),
`COMPRESSION_THRESHOLD` (default 8000 characters).

### 6.4 ContextManager surface

```python
class ContextManager:
    def __init__(self, researcher): ...
    async def get_similar_content_by_query(self, query: str, pages: list) -> str: ...          # ContextCompressor, max_results=10
    async def get_similar_content_by_query_with_vectorstore(self, query: str, filter: dict | None) -> str: ...  # max_results=8
    async def get_similar_written_contents_by_draft_section_titles(self, current_subtopic, draft_section_titles, written_contents, max_results=10) -> List[str]: ...
    async def __get_similar_written_contents_by_query(self, query, written_contents, similarity_threshold=0.5, max_results=10) -> List[str]: ...
```

---

## 7. Full default config table

`config/variables/default.py` (`DEFAULT_CONFIG: BaseConfig`) — verbatim, in file order:

| key (env var) | default |
|---|---|
| `RETRIEVER` | `"tavily"` |
| `EMBEDDING` | `"openai:text-embedding-3-small"` |
| `SIMILARITY_THRESHOLD` | `0.42` |
| `FAST_LLM` | `"openai:gpt-4o-mini"` |
| `SMART_LLM` | `"openai:gpt-4.1"` |
| `STRATEGIC_LLM` | `"openai:o4-mini"` |
| `FAST_TOKEN_LIMIT` | `3000` |
| `SMART_TOKEN_LIMIT` | `6000` |
| `STRATEGIC_TOKEN_LIMIT` | `4000` |
| `BROWSE_CHUNK_MAX_LENGTH` | `8192` |
| `CURATE_SOURCES` | `False` |
| `SUMMARY_TOKEN_LIMIT` | `700` |
| `TEMPERATURE` | `0.4` |
| `USER_AGENT` | `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0"` |
| `MAX_SEARCH_RESULTS_PER_QUERY` | `5` |
| `MEMORY_BACKEND` | `"local"` |
| `TOTAL_WORDS` | `1200` |
| `REPORT_FORMAT` | `"APA"` |
| `MAX_ITERATIONS` | `3` |
| `AGENT_ROLE` | `None` |
| `SCRAPER` | `"bs"` |
| `MAX_SCRAPER_WORKERS` | `15` |
| `SCRAPER_RATE_LIMIT_DELAY` | `0.0` |
| `MAX_SUBTOPICS` | `3` |
| `LANGUAGE` | `"english"` |
| `REPORT_SOURCE` | `"web"` |
| `DOC_PATH` | `"./my-docs"` |
| `PROMPT_FAMILY` | `"default"` |
| `LLM_KWARGS` | `{}` |
| `EMBEDDING_KWARGS` | `{}` |
| `VERBOSE` | `False` |
| `DEEP_RESEARCH_BREADTH` | `3` |
| `DEEP_RESEARCH_DEPTH` | `2` |
| `DEEP_RESEARCH_CONCURRENCY` | `4` |
| `MCP_SERVERS` | `[]` |
| `MCP_AUTO_TOOL_SELECTION` | `True` |
| `MCP_ALLOWED_ROOT_PATHS` | `[]` |
| `MCP_STRATEGY` | `"fast"` |
| `REASONING_EFFORT` | `"medium"` |
| `IMAGE_GENERATION_MODEL` | `"models/gemini-2.5-flash-image"` |
| `IMAGE_GENERATION_MAX_IMAGES` | `3` |
| `IMAGE_GENERATION_ENABLED` | `False` |
| `IMAGE_GENERATION_STYLE` | `"dark"` |
| `IMAGE_GENERATION_PROVIDER` | `"google"` |

`BaseConfig` (TypedDict) declares these **plus** `MCP_USE_LLM_ARGS: bool`, which has **no default** in
`DEFAULT_CONFIG` — relevant only if you mirror the typed shape.

### 7.1 Config resolution and derived attributes

```python
    CONFIG_DIR = os.path.join(os.path.dirname(__file__), "variables")

    def __init__(self, config_path: str | None = None):
        self.config_path = config_path
        self.llm_kwargs = {}
        self.embedding_kwargs = {}
        config_to_use = self.load_config(config_path)
        self._set_attributes(config_to_use)
        self._set_embedding_attributes()
        self._set_llm_attributes()
        self._handle_deprecated_attributes()
        if config_to_use['REPORT_SOURCE'] != 'web':
            self._set_doc_path(config_to_use)
        self.mcp_servers = []
        self.mcp_allowed_root_paths = []
        if hasattr(self, 'mcp_servers'): self.mcp_servers = self.mcp_servers
        if hasattr(self, 'mcp_allowed_root_paths'): self.mcp_allowed_root_paths = self.mcp_allowed_root_paths
```

Resolution order: `load_config(config_path or os.environ["CONFIG_PATH"])`; if the path is missing the
file, warn and use `DEFAULT_CONFIG`; otherwise `merged = DEFAULT_CONFIG.copy(); merged.update(json.load(file))`.
**Every key is lower-cased into an attribute** (`FAST_LLM` → `cfg.fast_llm`), and each key can be
overridden by the same-named env var, coerced via `convert_env_value` using the `BaseConfig` annotation
(`bool`: `"true"/"1"/"yes"/"on"`; `int`; `float`; `str`; `list`/`dict`: `json.loads`; `Union[..., None]`:
`"none"/"null"/""` → `None`).

Derived attributes:

| attribute | derivation |
|---|---|
| `cfg.retrievers` | `parse_retrievers(os.environ.get("RETRIEVER", config["RETRIEVER"]))` → `list[str]`, validated against retriever directories (raises → warn → `["tavily"]`) |
| `cfg.embedding_provider`, `cfg.embedding_model` | `parse_embedding(cfg.embedding)` → split first `":"` |
| `cfg.fast_llm_provider`, `cfg.fast_llm_model` | `parse_llm(cfg.fast_llm)` |
| `cfg.smart_llm_provider`, `cfg.smart_llm_model` | `parse_llm(cfg.smart_llm)` |
| `cfg.strategic_llm_provider`, `cfg.strategic_llm_model` | `parse_llm(cfg.strategic_llm)` |
| `cfg.reasoning_effort` | `parse_reasoning_effort(os.getenv("REASONING_EFFORT"))` → default `"medium"` |
| `cfg.doc_path` | set/validated only when `REPORT_SOURCE != "web"`; failure → `DEFAULT_CONFIG['DOC_PATH']` |
| `cfg.mcp_servers`, `cfg.mcp_allowed_root_paths` | rebound from the lower-cased attributes if present |

`parse_llm` asserts the provider is one of `_SUPPORTED_PROVIDERS`; `_SUPPORTED_PROVIDERS` (LLM) is:
`openai, anthropic, azure_openai, cohere, google_vertexai, google_genai, fireworks, ollama, together,
mistralai, huggingface, groq, bedrock, dashscope, xai, deepseek, litellm, gigachat, openrouter,
vllm_openai, aimlapi, netmind, forge, avian, minimax`.

Deprecated-but-honoured env vars (each emits `FutureWarning`): `EMBEDDING_PROVIDER` (with a per-provider
model mapping: ollama→`OLLAMA_EMBEDDING_MODEL`, custom→`OPENAI_EMBEDDING_MODEL` or `"custom"`,
openai/azure_openai→`text-embedding-3-large`, huggingface→`sentence-transformers/all-MiniLM-L6-v2`,
gigachat→`Embeddings`, google_genai→`text-embedding-004`), `LLM_PROVIDER`, `FAST_LLM_MODEL`,
`SMART_LLM_MODEL`.

`set_verbose(v)` writes `self.llm_kwargs["verbose"] = v` — **it does not set `self.verbose`**, and the
`GPTResearcher.verbose` flag is a separate attribute.

`get_mcp_server_config(name)` looks up `cfg.mcp_servers` by `server["name"]`, returning `{}` if absent.

Model-classification tables (used by `create_chat_completion`):

```python
NO_SUPPORT_TEMPERATURE_MODELS = [
    "deepseek/deepseek-reasoner",
    "o1-mini", "o1-mini-2024-09-12", "o1", "o1-2024-12-17",
    "o3-mini", "o3-mini-2025-01-31", "o1-preview",
    "o3", "o3-2025-04-16",
    "o4-mini", "o4-mini-2025-04-16",
    "gpt-5", "gpt-5-mini",
    "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6",
    "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7",
    "claude-haiku-4-5", "claude-haiku-4-5-20251001",
]

SUPPORT_REASONING_EFFORT_MODELS = [
    "o3-mini", "o3-mini-2025-01-31", "o3", "o3-2025-04-16", "o4-mini", "o4-mini-2025-04-16",
]

class ReasoningEfforts(Enum):
    High = "high"
    Medium = "medium"
    Low = "low"
```

`create_chat_completion` behaviour (`utils/llm.py`):

* raises `ValueError("Model cannot be None")` if `model is None`;
* raises if `max_tokens > 32001`;
* `provider_kwargs = {"model": model}` + `llm_kwargs`;
* `reasoning_effort` injected only when `model in SUPPORT_REASONING_EFFORT_MODELS`;
* when `model in NO_SUPPORT_TEMPERATURE_MODELS`, both `temperature` and `max_tokens` are forced to `None`;
* for provider `openai`, `OPENAI_BASE_URL` → `openai_api_base`;
* retries: `max_attempts = 1 if (stream and websocket is not None) else 10`, backoff
  `await asyncio.sleep(min(2 ** (attempt - 1), 8))`, retries also on empty response;
* on success, `cost_callback(estimate_llm_cost(str(messages), response))`;
* otherwise raises `RuntimeError(f"Failed to get response from {llm_provider} API")` chained from the last exception.

---

## 8. Deep research algorithm (breadth/depth recursion)

Entry: `report_type == "deep"` → `GPTResearcher.conduct_research` sets `_current_step = "deep_research"`
and calls `_handle_deep_research(on_progress)` → `DeepResearchSkill.run(on_progress)`.

`DeepResearchSkill.__init__`:

```python
        self.researcher = researcher
        self.breadth = getattr(researcher.cfg, 'deep_research_breadth', 4)
        self.depth = getattr(researcher.cfg, 'deep_research_depth', 2)
        self.concurrency_limit = getattr(researcher.cfg, 'deep_research_concurrency', 2)
        self.websocket = researcher.websocket
        self.tone = researcher.tone
        self.config_path = researcher.cfg.config_path if hasattr(researcher.cfg, 'config_path') else None
        self.headers = researcher.headers or {}
        self.visited_urls = researcher.visited_urls
        self.learnings = []
        self.research_sources = []
        self.context = []
```
(Note the `getattr` fallbacks are 4/2/2, while `DEFAULT_CONFIG` supplies 3/2/4 — the config values win.)

Constants: `MAX_CONTEXT_WORDS = 25000`.

### 8.1 Pseudocode

```
RUN(on_progress):
  follow_up_questions = await GENERATE_RESEARCH_PLAN(query, num_questions=3)
  answers             = ["Automatically proceeding with research"] * len(follow_up_questions)
  qa_pairs            = [f"Q: {q}\nA: {a}" for q, a in zip(follow_up_questions, answers)]
  combined_query      = "Initial Query: {query}\nFollow - up Questions and Answers:\n\n" + "\n".join(qa_pairs)
  results = await DEEP_RESEARCH(query=combined_query, breadth=self.breadth, depth=self.depth,
                                on_progress=on_progress)

  context_with_citations = []
  for learning in results.learnings:
      citation = results.citations.get(learning, "")
      context_with_citations.append(f"{learning} [Source: {citation}]" if citation else learning)
  if results.context: context_with_citations.extend(results.context)

  final_context = TRIM_CONTEXT_TO_WORD_LIMIT(context_with_citations)      # max 25_000 words
  researcher.context      = "\n".join(final_context)
  researcher.visited_urls = results.visited_urls
  if results.sources: researcher.research_sources = results.sources
  return researcher.context                      # report writing happens later, in write_report()


GENERATE_RESEARCH_PLAN(query, num_questions=3):
  all_search_results = []
  for retriever in researcher.retrievers:                 # EVERY retriever, sequentially
      all_search_results += await get_search_results(query, retriever, researcher=researcher)  # no max_results
  current_time = now()                                    # "%Y-%m-%d %H:%M:%S"
  response = await create_chat_completion(
      messages=[{system: <"expert researcher ... Return valid JSON only.">},
                {user:   <see prompt below, includes query, current_time, all_search_results>}],
      llm_provider=cfg.strategic_llm_provider, model=cfg.strategic_llm_model,
      reasoning_effort="high", temperature=0.4)
  return PARSE_FOLLOW_UP_QUESTIONS(response, num_questions)


DEEP_RESEARCH(query, breadth, depth, learnings=[], citations={}, visited_urls=set(), on_progress):
  progress = ResearchProgress(total_depth=depth, total_breadth=breadth)
  if on_progress: on_progress(progress)

  serp_queries = await GENERATE_SEARCH_QUERIES(query, num_queries=breadth)
  progress.total_queries = len(serp_queries)

  all_learnings   = copy(learnings)
  all_citations   = copy(citations)
  all_visited_urls= copy(visited_urls)
  all_context     = []
  all_sources     = []
  semaphore       = asyncio.Semaphore(self.concurrency_limit)

  async def PROCESS_QUERY(serp_query):
      async with semaphore:
          progress.current_query = serp_query.query; on_progress?(progress)
          researcher = GPTResearcher(
              query=serp_query.query,
              report_type="research_report",
              report_source="web",
              tone=self.tone, websocket=self.websocket, config_path=self.config_path,
              headers=self.headers, visited_urls=self.visited_urls,       # placeholder; set below
              mcp_configs=self.researcher.mcp_configs, mcp_strategy=self.researcher.mcp_strategy)
          context = await researcher.conduct_research()
          visited = researcher.visited_urls
          sources = researcher.research_sources
          results = await PROCESS_RESEARCH_RESULTS(query=serp_query.query, context=context)   # num_learnings=3
          progress.completed_queries += 1; progress.current_breadth += 1; on_progress?(progress)
          return {learnings: results.learnings, visited_urls: list(visited),
                  followUpQuestions: results.followUpQuestions, researchGoal: serp_query.researchGoal,
                  citations: results.citations,
                  context: "\n".join(context) if isinstance(context, list) else (context or ""),
                  sources: sources or []}
      # on exception: log traceback, return None

  results = [r for r in await asyncio.gather(*[PROCESS_QUERY(q) for q in serp_queries]) if r is not None]
  progress.current_breadth = len(results); on_progress?(progress)

  for result in results:
      all_learnings.extend(result.learnings)
      all_visited_urls.update(result.visited_urls)
      all_citations.update(result.citations)
      if result.context: all_context.append(result.context)
      if result.sources: all_sources.extend(result.sources)

      if depth > 1:
          new_breadth = max(2, breadth // 2)
          new_depth   = depth - 1
          progress.current_depth += 1
          next_query = f"""
                Previous research goal: {result.researchGoal}
                Follow-up questions: {' '.join(result.followUpQuestions)}
                """
          deeper = await DEEP_RESEARCH(query=next_query, breadth=new_breadth, depth=new_depth,
                                      learnings=all_learnings, citations=all_citations,
                                      visited_urls=all_visited_urls, on_progress=on_progress)
          all_learnings    = deeper.learnings
          all_visited_urls.update(deeper.visited_urls)
          all_citations.update(deeper.citations)
          if deeper.context: all_context.extend(deeper.context)
          if deeper.sources: all_sources.extend(deeper.sources)

  self.context.extend(all_context)
  self.research_sources.extend(all_sources)
  trimmed_context = TRIM_CONTEXT_TO_WORD_LIMIT(all_context)      # 25_000-word budget
  return {learnings: list(set(all_learnings)), visited_urls: list(all_visited_urls),
          citations: all_citations, context: trimmed_context, sources: all_sources}


TRIM_CONTEXT_TO_WORD_LIMIT(context_list, max_words=25000):
  total = 0; out = []
  for item in reversed(context_list):                # keep the most recent items
      words = WORD_COUNT(item)
      if total + words <= max_words: out.insert(0, item); total += words
      elif not out: out.insert(0, " ".join(str(item).split()[:max_words])); break
      else: break
  return out
```

### 8.2 Deep-research LLM prompts (verbatim, from `skills/deep_research.py`)

**Search-query generation** — strategic LLM, `temperature=0.4`:

```
system: "You are an expert researcher generating search queries. Return valid JSON only. Do not include markdown, code fences, bullets, numbering, or prose."

user:
Given the following prompt, generate {num_queries} unique search queries to research the topic thoroughly. For each query, provide a research goal.

Return ONLY a JSON array of objects using this exact schema:
[{"query": "<search query>", "researchGoal": "<research goal>"}]

Prompt: {query}
```

**Research-plan (follow-up questions)** — strategic LLM, `reasoning_effort="high"`, `temperature=0.4`:

```
system: "You are an expert researcher. Your task is to analyze the original query and search results, then generate targeted questions that explore different aspects and time periods of the topic. Return valid JSON only."

user:
Original query: {query}

Current time: {current_time}

Search results:
{search_results}

Based on these results, the original query, and the current time, generate {num_questions} unique questions. Each question should explore a different aspect or time period of the topic, considering recent developments up to {current_time}.

Return ONLY a JSON object using this exact schema:
{"questions": ["<question 1>", "<question 2>"]}
```

**Result processing** — strategic LLM, `reasoning_effort="high"`, `temperature=0.4`, `max_tokens=4000`:

```
system: "You are an expert researcher analyzing search results. Return valid JSON only."

user:
Given the following research results for the query '{query}', extract key learnings and suggest follow-up questions. For each learning, include a citation to the source URL if available.

Return ONLY a JSON object using this exact schema:
{"learnings": [{"insight": "<insight>", "sourceUrl": "<url or empty string>"}], "followUpQuestions": ["<question 1>", "<question 2>"]}

Research results:
{context}
```

### 8.3 Deep-research parsing (robust, worth porting)

* `_extract_json_payloads` tries, in order: fenced blocks ```` ```(?:json)?\s*(?P<payload>[\s\S]*?)``` ````,
  then the first `[...]`, then the first `{...}`.
* `_load_repaired_json` tries the raw string plus each candidate through `json_repair`.
* `parse_search_queries_response(response, num_queries)` accepts `list`, or
  `dict["queries"|"searchQueries"|"items"]`; entries need non-empty `query` and `researchGoal`.
  Fallback: line regex `^(?:[-*]|\d+[.)])?\s*Query:\s*(?P<query>.+)$` / `... (?:Goal|Research Goal):\s*(?P<goal>.+)$`.
* `parse_follow_up_questions_response`: accepts `list` or `dict["questions"|"followUpQuestions"|"items"]`;
  fallback regex `^(?:[-*]|\d+[.)])?\s*(?:Question:\s*)?(?P<question>.+)$` for lines ending in `?`.
* `parse_research_results_response`: accepts `dict` with `learnings` (items being
  `{"insight"|"learning","sourceUrl"|"citation"}` or plain strings) and
  `followUpQuestions`/`questions`; fallback line regex
  `^(?:[-*]|\d+[.)])?\s*Learning(?:\s*\[(?P<citation>[^\]]+)\])?:\s*(?P<learning>.+)$`, inline URL
  extraction via `https?://[^\s\]\)>",;]+`. Returns `{learnings, followUpQuestions, citations}`.
* `ResearchProgress` shape: `{current_depth: 1, total_depth, current_breadth: 0, total_breadth,
  current_query: str|None, total_queries: 0, completed_queries: 0}`.

### 8.4 `_handle_deep_research` logging

Streams `deep_research_initialize` (type/breadth/depth/concurrency), `deep_research_start`,
then runs, then `deep_research_complete` (`context_length`, `visited_urls`, `total_costs`),
then `cost_update` (`cost`, `total_cost`, `research_type="deep_research"`).

---

## 9. Multi-agent flow (`multi_agents/`, LangGraph)

### 9.1 Files

```
multi_agents/
├── agent.py                     # module-level compiled graph example
├── main.py                      # run_research_task(query, websocket, stream_output, tone, headers)
├── agents/
│   ├── __init__.py              # exports all agents; imports orchestrator LAST
│   ├── orchestrator.py          # ChiefEditorAgent — graph construction
│   ├── researcher.py            # ResearchAgent — wraps GPTResearcher
│   ├── editor.py                # EditorAgent — planner node + parallel-research node
│   ├── writer.py                # WriterAgent
│   ├── reviewer.py              # ReviewerAgent
│   ├── reviser.py               # ReviserAgent
│   ├── human.py                 # HumanAgent — HITL gate
│   ├── publisher.py             # PublisherAgent
│   └── utils/{file_formats,llms,utils,views}.py
└── memory/{research.py,draft.py}
```

### 9.2 LangGraph construction (verbatim)

```python
    def _create_workflow(self, agents):
        workflow = StateGraph(ResearchState)

        workflow.add_node("browser", agents["research"].run_initial_research)
        workflow.add_node("planner", agents["editor"].plan_research)
        workflow.add_node("researcher", agents["editor"].run_parallel_research)
        workflow.add_node("writer", agents["writer"].run)
        workflow.add_node("publisher", agents["publisher"].run)
        workflow.add_node("human", agents["human"].review_plan)

        self._add_workflow_edges(workflow)
        return workflow

    def _add_workflow_edges(self, workflow):
        workflow.add_edge('browser', 'planner')
        workflow.add_edge('planner', 'human')
        workflow.add_edge('researcher', 'writer')
        workflow.add_edge('writer', 'publisher')
        workflow.set_entry_point("browser")
        workflow.add_edge('publisher', END)

        # Add human in the loop
        workflow.add_conditional_edges(
            'human',
            lambda review: "accept" if review['human_feedback'] is None else "revise",
            {"accept": "researcher", "revise": "planner"}
        )
```

Edges summary: `browser → planner → human → (accept: researcher | revise: planner)`,
`researcher → writer → publisher → END`.

**Nested per-section subgraph** (`EditorAgent._create_workflow`) — one subgraph run per section header,
all sections invoked concurrently via `asyncio.gather`:

```python
        workflow = StateGraph(DraftState)
        workflow.add_node("researcher", agents["research"].run_depth_research)
        workflow.add_node("reviewer", agents["reviewer"].run)
        workflow.add_node("reviser", agents["reviser"].run)
        workflow.set_entry_point("researcher")
        workflow.add_edge("researcher", "reviewer")
        workflow.add_edge("reviser", "reviewer")
        workflow.add_conditional_edges(
            "reviewer",
            lambda draft: "accept" if draft["review"] is None else "revise",
            {"accept": END, "revise": "reviser"},
        )
```

### 9.3 State objects and agent roles

`memory/research.py`:

```python
class ResearchState(TypedDict):
    task: dict
    initial_research: str
    sections: List[str]
    research_data: List[dict]
    human_feedback: str
    # Report layout
    title: str
    headers: dict
    date: str
    table_of_contents: str
    introduction: str
    conclusion: str
    sources: List[str]
    report: str
```

`memory/draft.py`:

```python
class DraftState(TypedDict):
    task: dict
    topic: str
    draft: dict
    review: str
    revision_notes: str
```

Task dict keys read anywhere: `query`, `max_sections`, `follow_guidelines`, `include_human_feedback`,
`model`, `guidelines` (list[str]), `verbose`, `source` (default `"web"`), `publish_formats`
(`{pdf, docx, markdown}`).

| node | class / method | role | reads | writes |
|---|---|---|---|---|
| `browser` | `ResearchAgent.run_initial_research` | Runs a **full single-agent research + report** for the query: `GPTResearcher(query, report_type="research_report", verbose, report_source=source, tone, websocket, headers)` → `conduct_research()` → `write_report()`. | `task.query`, `task.source`, `task.verbose` | `{task, initial_research}` |
| `planner` | `EditorAgent.plan_research` | LLM produces `{title, date, sections[]}` (≤ `max_sections`), explicitly **excluding intro/conclusion/references**; honours human feedback when present. | `initial_research`, `task.max_sections`, `task.include_human_feedback`, `human_feedback` | `{title, date, sections}` |
| `human` | `HumanAgent.review_plan` | HITL gate. If `task.include_human_feedback`: streams `("human_feedback","request", "Any feedback on this plan of topics to research? {layout}? If not, please reply with 'no'.", websocket)` and `await websocket.websocket.receive_text()`, parsing JSON `{"type":"human_feedback","content":...}`; otherwise `input(...)`. `"no"` in the reply → `None`. | `task.include_human_feedback`, `sections` | `{human_feedback}` |
| `researcher` | `EditorAgent.run_parallel_research` | For each section, runs the nested researcher→reviewer→reviser subgraph concurrently; collects `result["draft"]`. | `sections`, `title`, `task` | `{research_data: List[dict]}` |
| `writer` | `WriterAgent.run` (`write_sections` + optional `revise_headers`) | Writes `table_of_contents`, `introduction`, `conclusion`, `sources`. If `task.follow_guidelines`, rewrites header labels to plain strings. | `title`, `research_data`, `task.model`, `task.guidelines`, `task.follow_guidelines` | `{table_of_contents, introduction, conclusion, sources, headers}` |
| `publisher` | `PublisherAgent.run` → `publish_research_report` | Assembles the final markdown layout and writes PDF/DOCX/Markdown. | `research_data`, `sources`, `headers`, `date`, `introduction`, `table_of_contents`, `conclusion`, `task.publish_formats` | `{report}` |
| (nested) `researcher` | `ResearchAgent.run_depth_research` → `run_subtopic_research` | `GPTResearcher(parent_query=..., query=subtopic, report_type="subtopic_report", tone=self.tone)` → `conduct_research()` → `write_report()`. Failures → `{subtopic: None}`. | `task`, `topic` | `{draft}` |
| (nested) `reviewer` | `ReviewerAgent.run` → `review_draft` | Only runs when `task.follow_guidelines`; returns `None` (accept) when the response contains `"None"`. | `task.guidelines`, `draft`, `revision_notes` | `{review}` |
| (nested) `reviser` | `ReviserAgent.run` → `revise_draft` | Revises the draft per reviewer notes; JSON `{draft, revision_notes}`. | `review`, `draft`, `task.model` | `{draft, revision_notes}` |

Runner: `ChiefEditorAgent.run_research_task(task_id=None)` compiles the graph and
`await chain.ainvoke({"task": self.task}, config={"configurable": {"thread_id": task_id, "thread_ts": datetime.datetime.utcnow()}})`;
output dir `./outputs/run_{int(time.time())}_{sanitized query[:40]}`.

`multi_agents/main.py` overrides `task["model"]` from `STRATEGIC_LLM` (taking the part after the first
`":"`), and `backend/server/multi_agent_runner.py` is the FastAPI adapter
(`report_type == "multi_agents"`).

### 9.4 Report sections produced

`PublisherAgent.generate_layout` (verbatim) defines the final document shape:

```python
        layout = f"""# {headers.get('title')}
#### {headers.get("date")}: {research_state.get('date')}

## {headers.get("introduction")}
{research_state.get('introduction')}

## {headers.get("table_of_contents")}
{research_state.get('table_of_contents')}

{sections_text}

## {headers.get("conclusion")}
{research_state.get('conclusion')}

## {headers.get("references")}
{references}
"""
```

Default header labels (`WriterAgent.get_headers`):

```python
        return {
            "title": research_state.get("title"),
            "date": "Date",
            "introduction": "Introduction",
            "table_of_contents": "Table of Contents",
            "conclusion": "Conclusion",
            "references": "References",
        }
```

So the sections are: **Title (H1) → Date (H4) → Introduction → Table of Contents → N research sections
(from `research_data`, each an H2/H3 body produced by the subtopic researcher) → Conclusion → References.**

### 9.5 Multi-agent prompts (verbatim)

`EditorAgent._create_planning_prompt` system message:

```
You are a research editor. Your goal is to oversee the research project from inception to completion. Your main task is to plan the article section layout based on an initial research summary.
```

`EditorAgent._format_planning_instructions`:

```
Today's date is {today}
                   Research summary report: '{initial_research}'
                   {feedback_instruction}
                   
Your task is to generate an outline of sections headers for the research project
                   based on the research summary report above.
                   You must generate a maximum of {max_sections} section headers.
                   You must focus ONLY on related research topics for subheaders and do NOT include introduction, conclusion and references.
                   You must return nothing but a JSON with the fields 'title' (str) and 
                   'sections' (maximum {max_sections} section headers) with the following structure:
                   '{{title: string research title, date: today's date, 
                   sections: ['section header 1', 'section header 2', 'section header 3' ...]}}'.
```
where `feedback_instruction = f"Human feedback: {human_feedback}. You must plan the sections based on the human feedback."`
only when `include_human_feedback and human_feedback and human_feedback != 'no'`.

`WriterAgent.write_sections`:

```python
sample_json = """
{
  "table_of_contents": A table of contents in markdown syntax (using '-') based on the research headers and subheaders,
  "introduction": An indepth introduction to the topic in markdown syntax and hyperlink references to relevant sources,
  "conclusion": A conclusion to the entire research based on all research data in markdown syntax and hyperlink references to relevant sources,
  "sources": A list with strings of all used source links in the entire research data in markdown syntax and apa citation format. For example: ['-  Title, year, Author [source url](source)', ...]
}
"""
```
```
system: "You are a research writer. Your sole purpose is to write a well-written research reports about a topic based on research findings and information.\n "
user:   f"Today's date is {datetime.now().strftime('%d/%m/%Y')}\n."
        f"Query or Topic: {query}\n"
        f"Research data: {str(data)}\n"
        f"Your task is to write an in depth, well written and detailed "
        f"introduction and conclusion to the research report based on the provided research data. "
        f"Do not include headers in the results.\n"
        f"You MUST include any relevant sources to the introduction and conclusion as markdown hyperlinks -"
        f"For example: 'This is a sample text. ([url website](url))'\n\n"
        f"{f'You must follow the guidelines provided: {guidelines}' if follow_guidelines else ''}\n"
        f"You MUST return nothing but a JSON in the following format (without json markdown):\n"
        f"{sample_json}\n\n"
```

`WriterAgent.revise_headers`:

```
system: """You are a research writer. 
Your sole purpose is to revise the headers data based on the given guidelines."""
user:   f"""Your task is to revise the given headers JSON based on the guidelines given.
You are to follow the guidelines but the values should be in simple strings, ignoring all markdown syntax.
You must return nothing but a JSON in the same format as given in headers data.
Guidelines: {task.get("guidelines")}\n
Headers Data: {headers}\n
"""
```

`ReviewerAgent`:

```python
TEMPLATE = """You are an expert research article reviewer. \
Your goal is to review research drafts and provide feedback to the reviser only based on specific guidelines. \
"""
```
```
revise_prompt = f"""The reviser has already revised the draft based on your previous review notes with the following feedback:
{revision_notes}\n
Please provide additional feedback ONLY if critical since the reviser has already made changes based on your previous feedback.
If you think the article is sufficient or that non critical revisions are required, please aim to return None.
"""

review_prompt = f"""You have been tasked with reviewing the draft which was written by a non-expert based on specific guidelines.
Please accept the draft if it is good enough to publish, or send it for revision, along with your notes to guide the revision.
If not all of the guideline criteria are met, you should send appropriate revision notes.
If the draft meets all the guidelines, please return None.
{revise_prompt if revision_notes else ""}

Guidelines: {guidelines}\nDraft: {draft_state.get("draft")}\n
"""
```

`ReviserAgent`:

```python
sample_revision_notes = """
{
  "draft": { 
    draft title: The revised draft that you are submitting for review 
  },
  "revision_notes": Your message to the reviewer about the changes you made to the draft based on their feedback
}
"""
```
```
system: "You are an expert writer. Your goal is to revise drafts based on reviewer notes."
user:   f"""Draft:\n{draft_report}" + "Reviewer's notes:\n{review}\n\n
You have been tasked by your reviewer with revising the following draft, which was written by a non-expert.
If you decide to follow the reviewer's notes, please write a new draft and make sure to address all of the points they raised.
Please keep all other aspects of the draft the same.
You MUST return nothing but a JSON in the following format:
{sample_revision_notes}
"""
```

`utils/llms.py::call_model` — every multi-agent LLM call goes through this thin wrapper:

```python
async def call_model(prompt: list, model: str, response_format: str | None = None):
    cfg = Config()
    lc_messages = convert_openai_messages(prompt)
    try:
        response = await create_chat_completion(
            model=model, messages=lc_messages, temperature=0,
            llm_provider=cfg.smart_llm_provider, llm_kwargs=cfg.llm_kwargs,
        )
        if response_format == "json":
            return parse_json_markdown(response, parser=json_repair.loads)
        return response
    except Exception as e:
        print("⚠️ Error in calling model")
        logger.error(f"Error in calling model: {e}")
```
Note: `temperature=0` and **no cost callback** in the multi-agent flow; `response_format="json"` triggers
`parse_json_markdown` with `json_repair`.

### 9.6 How multi-agent differs from single-agent

| dimension | single-agent | multi-agent (LangGraph) |
|---|---|---|
| orchestration | imperative async calls inside `ResearchConductor`/`ReportGenerator` | LangGraph `StateGraph` + conditional edges + nested subgraphs |
| planning | `generate_search_queries_prompt` → N *search queries* | `EditorAgent` LLM → `{title, date, sections[]}` *report section headers* |
| work unit | sub-query | report section (one subtopic researcher per section) |
| quality loop | one revision-free pass | reviewer↔reviser loop per section, gated on `follow_guidelines` |
| human | none in core `gpt_researcher` (only in the multi-agent graph, and via `backend` websockets) | `HumanAgent` node with `receive_text()` HITL, conditional back-edge to `planner` |
| output | a single markdown string | assembled markdown + PDF/DOCX/MD written to `./outputs/run_*` |
| model | smart/strategic per step, varied temperatures | `task["model"]` at `temperature=0` for all agents |
| report writes | `write_report()` returns text; the caller persists | `PublisherAgent` persists |
| cost tracking | per-step `step_costs` | none (no cost callback) |

Note the entry research step (`browser` node) **does** reuse the single-agent flow:
`ResearchAgent.research()` constructs a `GPTResearcher` and calls `conduct_research()` + `write_report()`.

### 9.7 `multi_agents_ag2/` (brief)

Present: `agents/editor.py`, `agents/orchestrator.py`, `agents/__init__.py`, `main.py`. It replaces the
LangGraph orchestration with AG2 (`autogen`-style) conversational group; the editor/orchestrator roles
mirror §9.3 but there is no `StateGraph`, no `ResearchState`/`DraftState` TypedDict and no
`reviewer`/`reviser`/`human` graph nodes. Its scope is narrower than the LangGraph variant.

---

## 10. MCP server surface

### 10.1 Important status

`mcp-server/` in this checkout contains **only `README.md`**, which states verbatim:

> **Note:** This content has been moved to a dedicated repository: https://github.com/assafelovic/gptr-mcp

The README section headers retained in-repo are:

> ### Resources
> * `research_resource`: Get web resources related to a given task via research.
>
> ### Primary Tools
> * `deep_research`: Performs deep web research on a topic, finding reliable and relevant information
> * `quick_search`: Performs a fast web search optimized for speed over quality
> * `write_report`: Generate a report based on research results
> * `get_research_sources`: Get the sources used in the research
> * `get_research_context`: Get the full context of the research

`docs/docs/gpt-researcher/mcp-server/getting-started.md` adds a prompt:

> ### Prompts
> * `research_query`: Create a research query prompt

**So the canonical MCP *server* implementation (tool decorators, exact JSON parameter schemas,
descriptions, return shapes, host/port defaults, `server.py` entrypoint) is NOT in this repository.**
I could not resolve it from local sources. What *is* in-repo:

* a docs-level parameter sketch (below),
* the **MCP client / consumer** side, which is complete (§10.2–§10.5),
* the backend's MCP plumbing (§10.6).

Parameter and return-shape details for the server therefore need to be taken from
`github.com/assafelovic/gptr-mcp`, or inferred from the client side (`GPTResearcher.quick_search`,
`conduct_research`, `write_report`, `get_research_sources`, `get_research_context`).
`gpt_researcher/mcp/research.py` also produces `href = "mcp://llm_analysis"` for the LLM's own synthesis,
which is the shape the server's `deep_research` is expected to return.

Documented (non-authoritative) parameter sketch from `docs/.../advanced-usage.md`:

```
Use the conduct_research tool with these advanced parameters:
{
  "query": "quantum computing advancements 2024",
  "depth": "deep",
  "focus_areas": ["hardware", "algorithms", "applications"],
  "timeline": "last 1 year"
}

Use the write_report tool with:
{
  "style": "academic",
  "format": "markdown",
  "include_images": true,
  "citation_style": "APA",
  "executive_summary": true
}
```

Server configuration sketch (`config.json`) and env from the same doc:

```json
{ "host": "0.0.0.0", "port": 8000, "debug": false, "timeout": 300, "max_concurrent_requests": 10 }
```
```bash
python server.py   # or: mcp run server.py
# env: OPENAI_API_KEY, TAVILY_API_KEY, STRATEGIC_LLM, MAX_ITERATIONS, SCRAPER
```
Claude client config sketch:
```json
{ "tools": [ { "name": "gptr-researcher", "endpoint": "http://localhost:8000/mcp" } ] }
```

`backend/chat/chat.py` also references `deep_research`, indicating the FastAPI side exposes the same
capability names.

### 10.2 `MCPClientManager` (`gpt_researcher/mcp/client.py`)

```python
class MCPClientManager:
    def __init__(self, mcp_configs: List[Dict[str, Any]]): ...
    def convert_configs_to_langchain_format(self) -> Dict[str, Dict[str, Any]]: ...
    async def get_or_create_client(self) -> Optional[object]: ...
    async def close_client(self): ...
    async def get_all_tools(self) -> List: ...
```

Config → transport conversion (verbatim logic):

* `connection_url` starting `wss://`/`ws://` → `{"transport": "websocket", "url": connection_url}`
* `connection_url` starting `https://`/`http://` → `{"transport": "streamable_http", "url": connection_url}`
* otherwise `transport = config.get("connection_type", "stdio")` (and `url` for websocket/streamable_http/http)
* `connection_headers` → `server_config["headers"]` (note: the guard checks
  `server_config.get("connection_type")`, a key that is never set — the headers branch is effectively dead)
* stdio: `command`, `args` (string split on whitespace), `env`
* `connection_token` → `server_config["token"]`
* server name: `config.get("name", f"mcp_server_{i+1}")`

Client creation uses `MultiServerMCPClient(server_configs)` from `langchain_mcp_adapters.client`
(guarded by `HAS_MCP_ADAPTERS`), guarded by `asyncio.Lock`; `close_client` only drops the reference
(comment: *"MultiServerMCPClient doesn't support context manager or explicit close methods in
langchain-mcp-adapters 0.1.0"*). Requires `pip install langchain-mcp-adapters`.

Documented server-config fields (`gpt_researcher/mcp/README.md`):

| Field | Type | Description | Example |
|---|---|---|---|
| `name` | `str` | Unique name for the server | `"my_server"` |
| `command` | `str` | Command to start stdio server | `"python"` |
| `args` | `list[str]` | Arguments for the command | `["server.py","--port","8080"]` |
| `connection_url` | `str` | URL for websocket/HTTP connection | `"ws://localhost:8080/mcp"` |
| `connection_type` | `str` | Connection type | `"stdio"`, `"websocket"`, `"http"` |
| `connection_token` | `str` | Authentication token | `"your-token"` |
| `tool_name` | `str` | Specific tool to use (optional) | `"search"` |
| `env` | `dict` | Environment variables | `{"API_KEY": "secret"}` |

### 10.3 MCP streaming (`mcp/streaming.py`)

`MCPStreamer(websocket)` methods, all delegating to `actions.utils.stream_output(type="logs",
content="mcp_retriever", output=message, websocket, metadata=data)`:
`stream_log`, `stream_log_sync`, `stream_stage_start`, `stream_stage_complete`, `stream_tool_selection`,
`stream_tool_execution`, `stream_research_results`, `stream_error`, `stream_warning`, `stream_info`
(message prefixes `🔧`/`✅`/`🧠`/`🔍`/`❌`/`⚠️`/`ℹ️`).

Additional MCP step names streamed from `skills/researcher.py`: `mcp_disabled`, `mcp_optimization`,
`mcp_comprehensive`, `mcp_results_cached`, `mcp_cache_error`, `mcp_cache_reuse`,
`mcp_comprehensive_run`, `mcp_fallback`, `mcp_retrieval_stage1`, `mcp_research_complete`,
`mcp_no_results`, `mcp_research_error`, `mcp_retrieval`, `mcp_results`, `mcp_error`, plus backend
`mcp_init`.

### 10.4 MCP research algorithm (two-stage)

`MCPRetriever.search_async(max_results=10)`:

1. Guard: no `mcp_configs` → log error, stream error, return `[]`.
2. **Stage 1** — `_get_all_tools()` (cached in `self._all_tools_cache`) via
   `client_manager.get_all_tools()` → `client.get_tools()`.
3. **Stage 2** — `tool_selector.select_relevant_tools(self.query, all_tools, max_tools=3)`.
4. **Stage 3** — `mcp_researcher.conduct_research_with_tools(query, selected_tools)`.
5. Truncate to `max_results`; log counts and content lengths; `finally: await client_manager.close_client()`.

`MCPRetriever.search(max_results=10)` is the **sync** facade required by the retriever contract: if an
event loop is already running it spins a fresh loop in a `ThreadPoolExecutor` thread (cancelling pending
tasks, `asyncio.wait_for(gather(...), timeout=5.0)`, `gc.collect()`, closing the loop),
`future.result(timeout=300)`; otherwise `asyncio.run(self.search_async(max_results))`. All errors are
swallowed into `[]`.

`MCPRetriever.__init__` signature (verbatim):

```python
    def __init__(
        self,
        query: str,
        headers: Optional[Dict[str, str]] = None,
        query_domains: Optional[List[str]] = None,
        websocket=None,
        researcher=None,
        **kwargs
    ):
```
It requires `researcher.cfg` and raises
`ValueError("MCPRetriever requires a researcher instance with cfg attribute containing LLM configuration")`
otherwise. It reads `researcher.mcp_configs`.

**Tool selection** (`MCPToolSelector.select_relevant_tools`) builds `tools_info =
[{index, name, description}]` and calls the prompt below via `create_chat_completion` with the
**strategic** LLM at `temperature=0.0`; parses `json.loads`, falling back to regex `r"\{.*\}"`,
then to `_fallback_tool_selection` (pattern scoring: `+3` if a keyword is in the tool name, `+1` if in
the description; keywords `search, get, read, fetch, find, list, query, lookup, retrieve, browse, view,
show, describe`; sorted desc, top `max_tools`). Tool objects are selected by `index` into `all_tools`.

**Stage-1 prompt** (`PromptFamily.generate_mcp_tool_selection_prompt(query, tools_info, max_tools=3)`, verbatim):

```python
        return f"""You are a research assistant helping to select the most relevant tools for a research query.

RESEARCH QUERY: "{query}"

AVAILABLE TOOLS:
{json.dumps(tools_info, indent=2)}

TASK: Analyze the tools and select EXACTLY {max_tools} tools that are most relevant for researching the given query.

SELECTION CRITERIA:
- Choose tools that can provide information, data, or insights related to the query
- Prioritize tools that can search, retrieve, or access relevant content
- Consider tools that complement each other (e.g., different data sources)
- Exclude tools that are clearly unrelated to the research topic

Return a JSON object with this exact format:
{{
  "selected_tools": [
    {{
      "index": 0,
      "name": "tool_name",
      "relevance_score": 9,
      "reason": "Detailed explanation of why this tool is relevant"
    }}
  ],
  "selection_reasoning": "Overall explanation of the selection strategy"
}}

Select exactly {max_tools} tools, ranked by relevance to the research query.
"""
```

**Stage-3 prompt** (`generate_mcp_research_prompt(query, selected_tools)`, verbatim):

```python
        return f"""You are a research assistant with access to specialized tools. Your task is to research the following query and provide comprehensive, accurate information.

RESEARCH QUERY: "{query}"

INSTRUCTIONS:
1. Use the available tools to gather relevant information about the query
2. Call multiple tools if needed to get comprehensive coverage
3. If a tool call fails or returns empty results, try alternative approaches
4. Synthesize information from multiple sources when possible
5. Focus on factual, relevant information that directly addresses the query

AVAILABLE TOOLS: {tool_names}

Please conduct thorough research and provide your findings. Use the tools strategically to gather the most relevant and comprehensive information."""
```

Execution: `GenericLLMProvider.from_provider(cfg.strategic_llm_provider, model=cfg.strategic_llm_model,
**cfg.llm_kwargs)`, then `llm_provider.llm.bind_tools(selected_tools)`, `await llm_with_tools.ainvoke(messages)`.
Each `response.tool_calls[i]` → `{name, args}` → find tool by `t.name`, invoke via `ainvoke`/`invoke`/call.
Finally the LLM's own `response.content` is appended as
`{"title": f"LLM Analysis: {query}", "href": "mcp://llm_analysis", "body": response.content}`.

`_process_tool_result(tool_name, result)` normalizes (in priority order): MCP wrapper
`{"structured_content": {"results": [...]}}` → `[{title, href, body}]`; `{"content": [{"type":"text","text":...}]}`
→ joined text; a `list` of dicts (requires `title` and `content`/`body`) ; a plain `dict`; anything else → `str`.
MCP-generated URLs default to `mcp://{tool_name}/{i}`.

**MCP sub-query optimization**: `plan_research_outline` returns `[query]` (skipping sub-query generation
entirely) when MCP is the *only* retriever; otherwise sub-queries are generated for the other retrievers.
Strategy `fast` runs MCP once on the original query and copies the cache for every sub-query; `deep` runs
MCP for every sub-query; `disabled` skips MCP. The cache is populated under an `asyncio.Lock` so hybrid
mode (which calls `_get_context_by_web_search` twice concurrently) does not double-run MCP.

### 10.5 Enabling MCP from the backend

`backend/server/websocket_manager.py::run_agent`:

```python
    if mcp_enabled and mcp_configs:
        current_retriever = os.getenv("RETRIEVER", "tavily")
        if "mcp" not in current_retriever:
            os.environ["RETRIEVER"] = f"{current_retriever},mcp"
        os.environ["MCP_STRATEGY"] = mcp_strategy
        await logs_handler.send_json({
            "type": "logs", "content": "mcp_init",
            "output": f"🔧 MCP enabled with strategy '{mcp_strategy}' and {len(mcp_configs)} server(s)"})
```
(Note: the backend still mutates `os.environ`, unlike `GPTResearcher._process_mcp_configs`.)

---

## 11. Notable behaviours

### 11.1 Cost tracking

* Constants (`utils/costs.py`):
  ```python
  ENCODING_MODEL = "o200k_base"
  INPUT_COST_PER_TOKEN  = 0.000005     # $5 / 1M input tokens
  OUTPUT_COST_PER_TOKEN = 0.000015     # $15 / 1M output tokens
  IMAGE_INFERENCE_COST  = 0.003825
  EMBEDDING_COST        = 0.02 / 1000000   # assumes ada-3-small
  ```
* `estimate_llm_cost(input_content, output_content)` tiktoken-encodes both strings with `o200k_base`
  and returns `len(input)*5e-6 + len(output)*1.5e-5`.
* `estimate_embedding_cost(model, docs)` uses `tiktoken.encoding_for_model(model)` and
  `total_tokens * 2e-8`.
* Costs are attached via the `cost_callback` argument of `create_chat_completion`, which calls
  `cost_callback(estimate_llm_cost(str(messages), response))` **only on success**.
* `GPTResearcher.add_costs` accumulates into `research_costs` and `step_costs[_current_step]`, and (only
  if `log_handler` is set) fires an awaited `_log_event("research", step="cost_update", ...)` — note this
  is not awaited inside `add_costs`, so it is a scheduled coroutine.
* The legacy `actions/utils.py::calculate_cost` table is unrelated and inconsistent:
  `{"gpt-3.5-turbo":0.002, "gpt-4":0.03, "gpt-4-32k":0.06, "gpt-4o":0.00001, "gpt-4o-mini":0.000001,
  "o3-mini":0.0000005}` with unknown models defaulting to `0.0001`.
* Step accounting means a port must know which phase is active when a call returns. Phase labels in
  order: `general` → `agent_selection` → `research` → `report_writing` (+ `deep_research` for deep mode).

### 11.2 `report_source` semantics (`ReportSource` enum)

| value | behaviour |
|---|---|
| `web` (default) | `_get_context_by_web_search(query, [], query_domains)` |
| `local` | `DocumentLoader(cfg.doc_path).load()` → optional vector store load → web-search pipeline with those docs as `scraped_data` |
| `hybrid` | local (from `document_urls` via `OnlineDocumentLoader`, else `cfg.doc_path`) + web, run **concurrently**, joined by `prompt_family.join_local_web_documents` → `"Context from local documents: {docs}\n\nContext from web sources: {web}"` |
| `azure` | `AzureDocumentLoader(container_name=$AZURE_CONTAINER_NAME, connection_string=$AZURE_CONNECTION_STRING).load()` → `DocumentLoader(files).load()` → web pipeline |
| `langchain_documents` | `LangChainDocumentLoader(documents).load()` → optional vector store load → web pipeline |
| `langchain_vectorstore` | `_get_context_by_vectorstore(query, vector_store_filter)` — **skips scraping entirely**; also ran without an initial seed search |
| `static` | Declared in the enum, **not handled** by `ResearchConductor.conduct_research` (falls through with `research_data = []`) |

`source_urls` (a constructor arg, not a `report_source` value) short-circuits to
`_get_context_by_urls(source_urls)`: `_get_new_urls` → `browse_urls` → optional vector store load →
`context_manager.get_similar_content_by_query(query, scraped_content)`.
If `complement_source_urls` is true, web search is appended.

### 11.3 Websocket streaming callbacks

* `actions/utils.py::stream_output(type, content, output, websocket=None, output_log=True, metadata=None)`
  → `await websocket.send_json({"type", "content", "output", "metadata"})`. Logging is skipped only when
  `type == "images"` or `(websocket and not output_log)`.
* `safe_send_json(websocket, data)` swallows send errors and logs hints for `"closed"/"connection` and `"timeout"`.
* `create_cost_callback(websocket)` returns an async `cost_callback(prompt_tokens, completion_tokens, model)`
  that sends the `{"type":"cost","data":{...}}` envelope via `update_cost`.
* The FastAPI `WebSocketManager` uses one `asyncio.Queue` + one sender task per connection, treats the
  literal string `"ping"` as a heartbeat (replies `"pong"`), and uses `None` as a shutdown sentinel.
* `CustomLogsHandler` (backend) wraps the websocket for `log_handler`; `retrievers/utils.py::stream_output`
  emits the alternative `{"type","step","content","data"}` envelope for MCP retriever logging.
* `HumanAgent` reads **inbound** messages with `await self.websocket.websocket.receive_text()`, expecting
  `{"type":"human_feedback","content": ...}`.

### 11.4 Retrieval / context selection

* No MMR anywhere. Selection is `EmbeddingsFilter(similarity_threshold=…)` after
  `RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)`.
* Fast path skips embeddings entirely when total `raw_content` < `COMPRESSION_THRESHOLD` (8000 chars)
  and `len(docs) <= max_results`.
* `get_similar_content_by_query` uses `max_results=10`; the vector-store variant uses `8`;
  `WrittenContentCompressor` uses `similarity_threshold=0.5`.
* `pretty_print_docs` is the serialization boundary: `Source:`, `Title:`, `Content:` per document.
* Seed search uses only `retrievers[0]`; the full retriever list is used only for URL harvesting.

### 11.5 `curate_sources` flow

Triggered in `ResearchConductor.conduct_research` when `cfg.curate_sources` is truthy
(`CURATE_SOURCES`, default `False`), after the source dispatch and before the verbose cost log:

```python
        self.researcher.context = research_data
        if self.researcher.cfg.curate_sources:
            self.logger.info("Curating sources")
            self.researcher.context = await self.researcher.source_curator.curate_sources(research_data)
```

`SourceCurator.curate_sources(source_data, max_results=10)`:

```python
            response = await create_chat_completion(
                model=self.researcher.cfg.smart_llm_model,
                messages=[
                    {"role": "system", "content": f"{self.researcher.role}"},
                    {"role": "user", "content": self.researcher.prompt_family.curate_sources(
                        self.researcher.query, source_data, max_results)},
                ],
                temperature=0.2,
                max_tokens=8000,
                llm_provider=self.researcher.cfg.smart_llm_provider,
                llm_kwargs=self.researcher.cfg.llm_kwargs,
                cost_callback=self.researcher.add_costs,
            )
            curated_sources = json.loads(response)
            ...
            return curated_sources
        except Exception as e:
            print(f"Error in curate_sources from LLM response: {response}")
            ...
            return source_data
```

So: input is the whole research context, output **replaces** `researcher.context` with a parsed JSON
list, and any failure returns the original context unchanged. Note `json.loads` (strict) is used here,
unlike elsewhere where `json_repair` is used.

`curate_sources` prompt (verbatim):

```python
    @staticmethod
    def curate_sources(query, sources, max_results=10):
        return f"""Your goal is to evaluate and curate the provided scraped content for the research task: "{query}"
    while prioritizing the inclusion of relevant and high-quality information, especially sources containing statistics, numbers, or concrete data.

The final curated list will be used as context for creating a research report, so prioritize:
- Retaining as much original information as possible, with extra emphasis on sources featuring quantitative data or unique insights
- Including a wide range of perspectives and insights
- Filtering out only clearly irrelevant or unusable content

EVALUATION GUIDELINES:
1. Assess each source based on:
   - Relevance: Include sources directly or partially connected to the research query. Err on the side of inclusion.
   - Credibility: Favor authoritative sources but retain others unless clearly untrustworthy.
   - Currency: Prefer recent information unless older data is essential or valuable.
   - Objectivity: Retain sources with bias if they provide a unique or complementary perspective.
   - Quantitative Value: Give higher priority to sources with statistics, numbers, or other concrete data.
2. Source Selection:
   - Include as many relevant sources as possible, up to {max_results}, focusing on broad coverage and diversity.
   - Prioritize sources with statistics, numerical data, or verifiable facts.
   - Overlapping content is acceptable if it adds depth, especially when data is involved.
   - Exclude sources only if they are entirely irrelevant, severely outdated, or unusable due to poor content quality.
3. Content Retention:
   - DO NOT rewrite, summarize, or condense any source content.
   - Retain all usable information, cleaning up only clear garbage or formatting issues.
   - Keep marginally relevant or incomplete sources if they contain valuable data or insights.

SOURCES LIST TO EVALUATE:
{sources}

You MUST return your response in the EXACT sources JSON list format as the original sources.
The response MUST not contain any markdown format or additional text (like ```json), just the JSON list!
"""
```

### 11.6 Markdown post-processing

* `extract_headers(markdown_text)` — `markdown.markdown()` then a stack walk over `<h1>…<h6>` lines,
  building the nested `{level, text, children}` tree.
* `extract_sections(markdown_text)` — regex `r'<h\d>(.*?)</h\d>(.*?)(?=<h\d>|$)'` with DOTALL, strips
  inner tags, returns `[{"section_title", "written_content"}]` for non-empty content.
* `table_of_contents(markdown_text)` — prefix `"## Table of Contents\n\n"` + `- {text}` lines with
  4-space indent per nesting level; on exception returns the input unchanged. **Only used by
  `DetailedReport`**, because `generate_report_prompt` explicitly forbids the model from adding a TOC.
* `add_references(report_markdown, visited_urls)` — appends
  `"\n\n\n## References\n\n" + "".join(f"- [{url}]({url})\n" for url in visited_urls)`. This duplicates
  the model's own reference list when the model followed the prompt (as `DetailedReport` demonstrates by
  applying it only to the conclusion).

### 11.7 Inline image generation

* Config-gated: `IMAGE_GENERATION_ENABLED` (default `False`), `IMAGE_GENERATION_PROVIDER`
  (`"google"` | `"modelslab"`), `IMAGE_GENERATION_MODEL` (default `models/gemini-2.5-flash-image`),
  `IMAGE_GENERATION_MAX_IMAGES` (3), `IMAGE_GENERATION_STYLE` (`"dark"`).
* `ImageGenerator.is_enabled()` = `self.image_provider is not None and self.image_provider.is_available()`.
* `plan_and_generate_images(context, query, research_id)` runs **during `conduct_research()`**, i.e.
  before report writing: `_plan_image_concepts(context, query)` (LLM, using
  `generate_image_analysis_prompt`) then generation in parallel (`generate_single_image`).
* `write_report` passes `available_images` into `generate_report`, which appends:
  ```
  AVAILABLE IMAGES:
  You have the following pre-generated images available. Embed them in relevant sections of your report using the exact markdown syntax provided:

  - Image 1: ![{title|alt_text|Illustration}]({url}) - {section_hint|General}
  ...

  Place each image on its own line after the relevant section header or paragraph. Use all available images where they add value to the content.
  ```
* `ImageGenerator` also exposes `analyze_report_for_images`, `generate_images_for_report`,
  `_embed_images_in_report`, `get_generated_images`, `process_image_placeholders`, `_extract_sections`,
  `_build_analysis_prompt`, `_parse_analysis_response` (post-hoc path, used when images are generated
  after the fact).

### 11.8 Miscellaneous gotchas a port must reproduce or deliberately fix

1. `Config.set_verbose` sets `llm_kwargs["verbose"]`, not `cfg.verbose`.
2. `ContextCompressor` ignores its `similarity_threshold` constructor argument; it reads the env var.
3. `ContextCompressor` reads `doc['raw_content']` but `VectorstoreCompressor` works on LangChain docs.
4. `get_search_results` reverse-engineers MCP by class-name substring matching.
5. `Corpus`-level `retrievers[0]`-only seed search and `quick_search`'s mismatch of result keys.
6. `_get_context_by_urls` has a dead branch: `if research_data and len(research_data) == 0`.
7. `web_scraping.process_scraped_data`/`filter_urls`/`extract_main_content` are unused stubs;
   `filter_urls` references `config.excluded_domains`, which **is not in `BaseConfig`/`DEFAULT_CONFIG`**
   and would raise `AttributeError` if called.
8. `MCPClientManager.convert_configs_to_langchain_format` has a dead `connection_headers` branch
   (checks `connection_type` on the output dict).
9. `MCPRetriever` fabricates a fresh event loop in a thread for sync calls — a Python-specific wart;
   in TS this is naturally `async`.
10. `multi_agents` uses one model at `temperature=0` for everything and does not track cost.
11. The `auto_agent_instructions` example JSON contains a malformed key
    (`"agent_role_prompt:` without a closing quote), so the model is instructed by a slightly broken example.
12. `Retriever.search` results are sometimes `None` (e.g. `CustomRetriever`, `PubMedCentralSearch`);
    callers must tolerate falsy returns (`if not search_results: continue`).
13. `de-duplication of scraper URLs` happens twice: `Scraper.__init__` (`dict.fromkeys`) and
    `_get_new_urls` (against `visited_urls`).
14. `random.shuffle(new_search_urls)` makes scraping order non-deterministic.
15. There is no retry/backoff at the retriever or scraper layer; retries exist only in
    `create_chat_completion` (up to 10 attempts, exponential backoff capped at 8s) and in the
    sub-query generator's strategic→smart fallback ladder.

---

## 12. Gaps, discrepancies, and things I could not resolve

1. **MCP *server* source is absent.** `mcp-server/` contains only a README pointing to
   `github.com/assafelovic/gptr-mcp`. Therefore I could **not** provide exact MCP tool decorator
   signatures, JSON parameter schemas (names/types/required/defaults), tool descriptions, return shapes,
   `server.py` entrypoint, or host/port/env defaults. §10.1 lists the tool *names* (`deep_research`,
   `quick_search`, `write_report`, `get_research_sources`, `get_research_context`), the resource
   (`research_resource`) and the prompt (`research_query`) from in-repo docs, plus the docs-level
   parameter sketch. A faithful server port requires fetching the `gptr-mcp` repository.
2. **Files named in the brief that do not exist upstream** (the brief's names look like an older revision):
   * `gpt_researcher/actions/research.py` → does not exist; web search lives in `skills/researcher.py`.
   * `gpt_researcher/actions/retrieval.py` → does not exist; the factory is `actions/retriever.py`.
   * `gpt_researcher/agent.py::get_subtopic_report` → does not exist; the subtopic loop is
     `backend/report_type/detailed_report/detailed_report.py::DetailedReport._get_subtopic_report`.
   * `gpt_researcher/skills/browser.py` exists (it is `BrowserManager`), but there is no
     `gpt_researcher/skills/` "browser" scraper — that is `scraper/browser/`.
3. **Retriever set differs from the zread/master snapshot.** The live GitHub `master` (via zread)
   `actions/retriever.py` also maps `brave`, `bocha`, `groundroute`, `crw`, `openalex`; the **local
   checkout** has `bocha`, `getxapi`, `xquik` but **no** `brave`, `crw`, `groundroute`, `openalex`
   directories or cases. §4.2 documents the local checkout (authoritative for this document).
4. **`deep_agents/` and top-level `skills/` do not exist** in the local checkout (only
   `gpt_researcher/skills/`). The forwarding note mentioned them; they are absent.
5. **Unused/vestigial code** that a port can omit but should not mistake for behaviour:
   `actions/web_scraping.py::filter_urls|extract_main_content|process_scraped_data`;
   `PromptFamily.generate_summary_prompt`; `PromptFamily.generate_deep_research_prompt`'s `tone`
   parameter is applied only via `tone_prompt`; `SemanticScholarSearch`/`ExaSearch` extra methods
   (`find_similar`, `get_contents`).
6. **`REPORT_FORMAT` default is `"APA"`** (config) but the prompt helper defaults are `"apa"`, and
   `generate_report` passes `cfg.report_format` straight through; the subtopic prompt upper-cases it
   (`{report_format.upper()}`) while the main report prompt does not. Reproduce exactly.
7. **`MMR` and Tavily context** as named in the brief do not exist (see §11.4 and the preamble).
   If the port needs MMR, it is a new feature, not a parity item.
8. **`MMR`-adjacent `SIMILARITY_THRESHOLD` is doubly defined**: `DEFAULT_CONFIG["SIMILARITY_THRESHOLD"] = 0.42`
   → `cfg.similarity_threshold`, but `ContextCompressor` overwrites it with
   `os.environ.get("SIMILARITY_THRESHOLD", 0.35)`. The effective default is **0.35**, and
   `WrittenContentCompressor` hardcodes **0.5**. I chose to document both rather than guess intent.
9. **`MultiServerMCPClient` lifecycle** is a known upstream limitation (no `close()`), so local resource
   cleanup semantics for the MCP client are not well-defined; the port should design its own.
10. **Python-only details intentionally listed** for behaviour parity but that have no direct TS analogue:
    `asyncio.to_thread` around blocking retrievers, `ThreadPoolExecutor`, `asyncio.Semaphore` +
    `asyncio.Lock`, and the MCP sync/async bridge. In TS these collapse into ordinary async + a bounded
    concurrency helper.
11. I did **not** enumerate the FastAPI route surface (`backend/server/app.py`) in depth, since the brief
    asked for the MCP surface and the control flow; the websocket manager and the two report runners
    (`BasicReport`, `DetailedReport`, `multi_agent_runner`) are covered because they drive the agent.
12. Line numbers cited in table cells refer to the local checkout at the time of writing; upstream
    `master` moves.
