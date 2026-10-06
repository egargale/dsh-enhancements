/**
 * The researcher agent — a port of `gpt_researcher/agent.py`.
 *
 * `GPTResearcher` is the composition root upstream: it owns configuration, the
 * retriever list, memory, the accumulated context, the visited-URL set, and the
 * cost counters, and it instantiates one object per skill. This port keeps that
 * shape (`conductResearch`, `writeReport`, `quickSearch`, `getSubtopics`, …) so
 * the upstream flow is readable side by side, while the I/O seams (LLM, HTTP,
 * web, filesystem) are injected through {@link EngineDeps}.
 *
 * @module gpt-researcher/agent
 */

import { chooseAgent } from './actions/agent-creator.ts'
import { getSearchResults } from './actions/query-processing.ts'
import { getRetrievers, type ResolvedRetrievers } from './actions/retrieval.ts'
import { Config } from './config.ts'
import type { EngineDeps } from './deps.ts'
import { createDocumentLoaderRegistry, type DocumentLoaderDefinition, type DocumentLoadRequest } from './document/index.ts'
import { createEmbeddingsRegistry, type Embeddings, type EmbeddingsRegistry } from './embeddings/index.ts'
import { Memory } from './memory/index.ts'
import { createRetrieverRegistry, type RetrieverRegistry } from './retrievers/index.ts'
import { type ScraperRegistry } from './scraper/base.ts'
import type { DeepResearchProgress } from './skills/deep-research.ts'
import { createScraperRegistry, type ScraperDefinition } from './scraper/index.ts'
import type { PromptFamily } from './prompts.ts'
import { BrowserManager } from './skills/browser.ts'
import { ContextManager } from './skills/context-manager.ts'
import { SourceCurator } from './skills/curator.ts'
import { ResearchConductor } from './skills/researcher.ts'
import { ReportGenerator } from './skills/writer.ts'
import { callLlmText, throwIfAborted } from './llm/call.ts'
import { CostTracker } from './utils/costs.ts'
import { addReferences, extractHeaders, extractSections, tableOfContents } from './utils/markdown.ts'
import { asContextText, collapseWhitespace, countWords } from './utils/text.ts'
import {
  TONES,
  type ContextEntry,
  type ReportSource,
  type ReportType,
  type ResearchOutcome,
  type ScrapedContent,
  type SearchResult,
  type Tone,
} from './types.ts'
import { InMemoryVectorStore, createVectorStoreRegistry, type VectorStore } from './vector_store/index.ts'

/** The deep-research skill's callable surface, kept structural to avoid a cycle. */
export interface DeepResearchRunner {
  run(options?: {
    /** Upstream's progress callback: it receives the live progress object. */
    onProgress?: (progress: DeepResearchProgress) => void
    breadth?: number
    depth?: number
    concurrency?: number
  }): Promise<{ context: string; trace: unknown[]; learnings: string[] }>
}

/** Construction options for {@link GptResearcher}. */
export interface GptResearcherOptions {
  /** Engine seams: LLM client, HTTP, logger, progress. */
  deps: EngineDeps
  /** The research question. */
  query: string
  /** Upstream `report_type`; defaults to `research_report`. */
  reportType?: ReportType
  /** Upstream `report_source`; defaults to the config's value. */
  reportSource?: ReportSource
  /** Tone *name* (`Objective`, `Analytical`, …). */
  tone?: Tone
  /** Explicit agent name; with `role`, skips agent selection. */
  agent?: string
  /** Explicit role prompt; with `agent`, skips agent selection. */
  role?: string
  /** Pre-supplied source URLs to research instead of searching. */
  sourceUrls?: string[]
  /** Document URLs for the hybrid/online loaders. */
  documentUrls?: string[]
  /** Also search the web when `sourceUrls` are supplied. */
  complementSourceUrls?: boolean
  /** Domains the search is restricted to. */
  queryDomains?: string[]
  /** Parent query, when this run is a subtopic report. */
  parentQuery?: string
  /** Candidate subtopics (used by the subtopics prompt). */
  subtopics?: string[]
  /** Shared visited-URL set; passed to child researchers by the detailed report. */
  visitedUrls?: Set<string>
  /** Pre-loaded context (upstream `context`). */
  context?: unknown
  /** In-memory documents for `langchain_documents`. */
  documents?: ScrapedContent[]
  /** Maximum subtopics to generate. */
  maxSubtopics?: number
  /** Injectable registries/stores (used by tests to avoid real providers). */
  retrieverRegistry?: RetrieverRegistry
  scraperRegistry?: ScraperRegistry
  embeddingsRegistry?: EmbeddingsRegistry
  vectorStore?: VectorStore
  vectorStoreFilter?: Record<string, unknown>
  /** Per-run config overrides (a tool argument), applied over the plugin config. */
  overrides?: Record<string, unknown>
}

/**
 * One research run.
 *
 * Lifecycle mirrors upstream exactly: construct, `conductResearch()`, then
 * `writeReport()`. The convenience {@link GptResearcher.run} performs the
 * report-type-specific whole flow and returns a structured
 * {@link ResearchOutcome} for the DSH tool to present.
 */
export class GptResearcher {
  readonly deps: EngineDeps
  readonly query: string
  readonly reportType: ReportType
  readonly reportSource: ReportSource
  readonly tone: Tone
  readonly parentQuery: string
  readonly sourceUrls: string[]
  readonly documentUrls: string[]
  readonly complementSourceUrls: boolean
  readonly queryDomains: string[]
  readonly subtopics: string[]
  readonly visitedUrls: Set<string>
  readonly vectorStoreFilter?: Record<string, unknown>
  readonly documents: ScrapedContent[]
  readonly maxSubtopics: number

  /**
   * Injection seams to forward to child researchers.
   *
   * The detailed/deep flows construct child `GptResearcher`s. Without these the
   * children silently fell back to the default registries, which bypassed a
   * host's injected retriever/scraper/embedding registry (and made the deep path
   * impossible to test with fakes).
   */
  readonly seams: Pick<
    GptResearcherOptions,
    'retrieverRegistry' | 'scraperRegistry' | 'embeddingsRegistry' | 'vectorStore'
  >

  /** The chosen agent name, once selection has run. */
  agentName: string
  /** The chosen role prompt, once selection has run. */
  role: string

  /** Accumulated context: a string after research, as upstream ends up with. */
  context = ''
  /** Structured view of the context, kept in step with {@link context}. */
  contextSources: ContextEntry[] = []
  /** Everything scraped during this run. */
  researchSources: ScrapedContent[] = []
  /** Selected image URLs. */
  researchImages: string[] = []
  /** The last deep-research trace, when the run was a deep-research run. */
  deepResearchTrace?: unknown[]

  readonly embeddings: Embeddings
  readonly memory: Memory
  readonly vectorStore?: VectorStore
  readonly retrievers: ResolvedRetrievers
  readonly scraper: ScraperDefinition
  readonly scraperTimeoutMs: number
  readonly similarityThreshold: number
  readonly compressionThreshold: number

  readonly researchConductor: ResearchConductor
  readonly reportGenerator: ReportGenerator
  readonly contextManager: ContextManager
  readonly scraperManager: BrowserManager
  readonly sourceCurator: SourceCurator

  /** The prompt family in use (also reachable as `deps.prompts`). */
  readonly promptFamily: PromptFamily

  readonly #documentLoaders: ReturnType<typeof createDocumentLoaderRegistry>
  readonly #startedAt: number
  #deepResearchSkill?: DeepResearchRunner

  constructor(options: GptResearcherOptions) {
    // Per-run overrides are folded into the config first, so every reader
    // (retrievers, scrapers, thresholds) sees one consistent config.
    this.deps =
      options.overrides && Object.keys(options.overrides).length > 0
        ? {
            ...options.deps,
            config: new Config({
              ...(options.deps.config.configPath === undefined
                ? {}
                : { configPath: options.deps.config.configPath }),
              overrides: { ...options.deps.config.raw, ...options.overrides },
            }),
          }
        : options.deps

    this.query = options.query
    this.reportType = options.reportType ?? 'research_report'
    this.reportSource = options.reportSource ?? this.deps.config.reportSource
    this.tone = options.tone ?? 'Objective'
    this.parentQuery = options.parentQuery ?? ''
    this.agentName = options.agent ?? ''
    this.role = options.role ?? ''
    this.sourceUrls = options.sourceUrls ?? []
    this.documentUrls = options.documentUrls ?? []
    this.complementSourceUrls = options.complementSourceUrls ?? false
    this.queryDomains = options.queryDomains ?? []
    this.subtopics = options.subtopics ?? []
    this.visitedUrls = options.visitedUrls ?? new Set<string>()
    this.vectorStoreFilter = options.vectorStoreFilter
    this.documents = options.documents ?? []
    this.maxSubtopics = options.maxSubtopics ?? this.deps.config.maxSubtopics
    this.promptFamily = this.deps.prompts
    this.context = asContextText(options.context)
    this.seams = {
      ...(options.retrieverRegistry === undefined
        ? {}
        : { retrieverRegistry: options.retrieverRegistry }),
      ...(options.scraperRegistry === undefined ? {} : { scraperRegistry: options.scraperRegistry }),
      ...(options.embeddingsRegistry === undefined
        ? {}
        : { embeddingsRegistry: options.embeddingsRegistry }),
      ...(options.vectorStore === undefined ? {} : { vectorStore: options.vectorStore }),
    }

    // Retrieval setup. Resolving here means a missing credential fails before
    // any network work starts, with the exact variable named.
    this.retrievers = getRetrievers(
      this.deps,
      options.retrieverRegistry ?? createRetrieverRegistry(),
    )

    // Scraper.
    this.scraper = (options.scraperRegistry ?? createScraperRegistry()).resolve(
      this.deps.config.scraper,
      this.deps.runtime,
    )
    // A NaN/0 here made `withTimeout(signal, 0)` abort every fetch on the next
    // macrotask, which surfaced as an empty context and an unsourced report
    // rather than as a configuration error.
    const scraperTimeout = Number(this.deps.runtime.env('SCRAPER_TIMEOUT_MS') ?? '')
    this.scraperTimeoutMs = Number.isFinite(scraperTimeout) && scraperTimeout > 0
      ? scraperTimeout
      : this.deps.config.timeoutMs

    // Embeddings → memory → optional persistent store.
    const embeddings = (options.embeddingsRegistry ?? createEmbeddingsRegistry()).create(
      this.deps.config.embeddingProvider,
      this.deps.config.embeddingModel,
      { runtime: this.deps.runtime },
      this.deps.config.embeddingKwargs,
    )
    this.embeddings = embeddings
    if (options.vectorStore) {
      this.vectorStore = options.vectorStore
    } else if (this.deps.config.memoryBackend !== 'none') {
      const definition = createVectorStoreRegistry().get(this.deps.config.memoryBackend)
      if (definition) {
        this.vectorStore = definition.create({ runtime: this.deps.runtime }, { embeddings })
      }
    }
    this.memory = new Memory(
      embeddings,
      this.vectorStore ?? new InMemoryVectorStore({ embeddings }),
      this.deps.runtime,
    )

    // Upstream's ContextCompressor reads SIMILARITY_THRESHOLD from the
    // environment with a 0.35 default, shadowing Config.similarity_threshold
    // (0.42). This port follows the *effective* upstream behaviour.
    const envThreshold = Number(this.deps.runtime.env('SIMILARITY_THRESHOLD') ?? '')
    this.similarityThreshold = Number.isFinite(envThreshold) && envThreshold > 0 ? envThreshold : 0.35
    const envCompression = Number(this.deps.runtime.env('COMPRESSION_THRESHOLD') ?? '')
    this.compressionThreshold = Number.isFinite(envCompression) && envCompression > 0 ? envCompression : 8000

    this.#documentLoaders = createDocumentLoaderRegistry()

    this.researchConductor = new ResearchConductor(this)
    this.reportGenerator = new ReportGenerator(this)
    this.contextManager = new ContextManager(this)
    this.scraperManager = new BrowserManager(this)
    this.sourceCurator = new SourceCurator(this)

    this.#startedAt = this.deps.runtime.now?.() ?? Date.now()
  }

  /** Milliseconds since construction, for the outcome summary. */
  get elapsedMs(): number {
    return (this.deps.runtime.now?.() ?? Date.now()) - this.#startedAt
  }

  /** The single cost tracker for the run (shared with {@link EngineDeps}). */
  get costs(): CostTracker {
    return this.deps.costs
  }

  /** The tone's descriptive value, as prompts interpolate it. */
  get toneValue(): string {
    return TONES[this.tone]
  }

  // ---------------------------------------------------------------------------
  // Research
  // ---------------------------------------------------------------------------

  /**
   * Conduct research (upstream `conduct_research`).
   *
   * @returns the accumulated context.
   */
  async conductResearch(): Promise<string> {
    throwIfAborted(this.deps.runtime.signal)
    this.deps.runtime.progress({
      type: 'logs',
      step: 'start',
      message: `Research start: ${this.query}`,
      data: { query: this.query, report_type: this.reportType },
    })

    if (this.reportType === 'deep') {
      return this.#handleDeepResearch()
    }

    if (!this.agentName || !this.role) {
      this.deps.costs.setStep('agent_selection')
      const choice = await chooseAgent(this.deps, {
        query: this.query,
        ...(this.parentQuery ? { parentQuery: this.parentQuery } : {}),
      })
      this.agentName = choice.server
      this.role = choice.agentRolePrompt
    }

    this.deps.costs.setStep('research')
    this.context = await this.researchConductor.conductResearch()
    return this.context
  }

  async #handleDeepResearch(): Promise<string> {
    this.deps.costs.setStep('deep_research')
    const skill = await this.deepResearchSkill()
    const result = await skill.run({
      breadth: this.deps.config.deepResearchBreadth,
      depth: this.deps.config.deepResearchDepth,
      concurrency: this.deps.config.deepResearchConcurrency,
    })
    this.context = result.context
    this.deepResearchTrace = result.trace
    this.deps.runtime.progress({
      type: 'logs',
      step: 'deep_research_complete',
      message: `Deep research complete: ${countWords(result.context)} words, ${this.visitedUrls.size} visited URLs`,
      data: { total_costs: this.getCosts() },
    })
    return this.context
  }

  /** Lazily construct the deep-research skill (the import is circular otherwise). */
  async deepResearchSkill(): Promise<DeepResearchRunner> {
    if (!this.#deepResearchSkill) {
      const { DeepResearchSkill } = await import('./skills/deep-research.ts')
      this.#deepResearchSkill = new DeepResearchSkill(this) as DeepResearchRunner
    }
    return this.#deepResearchSkill
  }

  /**
   * Write the report (upstream `write_report`).
   *
   * @param options - headers/contents from earlier subtopics, context override.
   * @returns the report markdown.
   */
  async writeReport(
    options: {
      existingHeaders?: Array<Record<string, unknown>>
      relevantWrittenContents?: string[]
      extContext?: unknown
      customPrompt?: string
    } = {},
  ): Promise<string> {
    return this.reportGenerator.writeReport(options)
  }

  /** Write the conclusion (upstream `write_report_conclusion`). */
  async writeReportConclusion(reportBody: string): Promise<string> {
    return this.reportGenerator.writeReportConclusion(reportBody)
  }

  /** Write the introduction (upstream `write_introduction`). */
  async writeIntroduction(): Promise<string> {
    return this.reportGenerator.writeIntroduction()
  }

  /**
   * Generate subtopics (upstream `get_subtopics`).
   *
   * @returns the subtopic task names.
   */
  async getSubtopics(): Promise<string[]> {
    return this.reportGenerator.getSubtopics()
  }

  /**
   * Draft section titles for a subtopic (upstream `get_draft_section_titles`).
   *
   * @param currentSubtopic - the subtopic being written.
   * @returns the titles.
   */
  async getDraftSectionTitles(currentSubtopic: string): Promise<string[]> {
    return this.reportGenerator.getDraftSectionTitles(currentSubtopic)
  }

  /**
   * Written contents similar to a subtopic's draft titles (upstream
   * `get_similar_written_contents_by_draft_section_titles`).
   *
   * @param currentSubtopic - the subtopic.
   * @param draftSectionTitles - candidate titles.
   * @param writtenContents - sections written so far.
   * @param maxResults - cap on returned sections.
   * @returns the relevant sections.
   */
  async getSimilarWrittenContentsByDraftSectionTitles(
    currentSubtopic: string,
    draftSectionTitles: readonly string[],
    writtenContents: readonly Record<string, unknown>[],
    maxResults = 10,
  ): Promise<string[]> {
    return this.contextManager.getSimilarWrittenContentsByDraftSectionTitles(
      currentSubtopic,
      draftSectionTitles,
      writtenContents,
      maxResults,
    )
  }

  /**
   * Quick search without the full pipeline (upstream `quick_search`).
   *
   * @param query - the query to search for.
   * @param options - domain filter and whether to synthesise a summary.
   * @returns raw results, or the summary string when `aggregatedSummary` is set.
   */
  async quickSearch(
    query: string,
    options: {
      queryDomains?: string[]
      aggregatedSummary?: boolean
      /** Return both the raw results and the summary, from a single search. */
      withResults?: boolean
    } = {},
  ): Promise<SearchResult[] | string | { results: SearchResult[]; summary: string }> {
    const definition = this.retrievers.definitions[0]
    if (!definition) throw new Error('No retriever is configured for quick_search')
    const searchResults = await getSearchResults(definition, this.retrievers.context, query, {
      queryDomains: options.queryDomains ?? [],
    })
    if (!options.aggregatedSummary) return searchResults

    let context = ''
    searchResults.forEach((result, index) => {
      const body = result.content ?? result.body ?? ''
      context += `[${index + 1}] ${result.title ?? ''}: ${body} (${result.url ?? result.href ?? ''})\n\n`
    })
    const prompt = this.deps.prompts.generate_quick_summary_prompt(query, context)
    // Through `callLlm`, so the completion is charged to the run's cost report
    // and observes cancellation (both were skipped when calling the client
    // directly).
    const summary = await callLlmText(this.deps, {
      tier: 'smart',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: this.deps.config.smartTokenLimit,
      step: 'general',
    })
    return options.withResults ? { results: searchResults, summary } : summary
  }

  // ---------------------------------------------------------------------------
  // Whole-run convenience
  // ---------------------------------------------------------------------------

  /**
   * Run research + report for one report type and return a structured outcome.
   *
   * This mirrors the backend's `report_type/` wrappers:
   * `basic_report.BasicReport.run` for the simple types and
   * `detailed_report.DetailedReport.run` for `detailed_report`.
   *
   * @param options.customPrompt - replaces the report prompt (upstream
   *   `generate_report(custom_prompt=…)`).
   * @returns the research outcome.
   */
  async run(options: { customPrompt?: string } = {}): Promise<ResearchOutcome> {
    throwIfAborted(this.deps.runtime.signal)
    if (this.reportType === 'detailed_report' || this.reportType === 'deep') {
      return this.#runDetailed()
    }
    await this.conductResearch()
    const report = await this.writeReport(
      options.customPrompt === undefined ? {} : { customPrompt: options.customPrompt },
    )
    return this.#outcome(report)
  }

  /** Upstream `backend/report_type/detailed_report/detailed_report.py`. */
  async #runDetailed(): Promise<ResearchOutcome> {
    const { DetailedReport } = await import('./report-type/detailed-report.ts')
    const result = await new DetailedReport(this).run()
    return this.#outcome(result.report, {
      subtopics: result.subtopics,
      subtopicReports: result.subtopicReports,
      ...(this.deepResearchTrace === undefined
        ? {}
        : { researchTrace: this.deepResearchTrace as ResearchOutcome['researchTrace'] }),
    })
  }

  #outcome(report: string, extra: Partial<ResearchOutcome> = {}): ResearchOutcome {
    return {
      query: this.query,
      reportType: this.reportType,
      report,
      sources: this.researchSources,
      visitedUrls: [...this.visitedUrls],
      context: this.context,
      costs: this.costs.report(),
      ...extra,
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities (upstream's public utility methods)
  // ---------------------------------------------------------------------------

  /** Top research images (upstream `get_research_images`). */
  getResearchImages(topK = 10): string[] {
    return this.researchImages.slice(0, topK)
  }

  /** Add research images (upstream `add_research_images`). */
  addResearchImages(images: readonly string[]): void {
    this.researchImages.push(...images)
  }

  /** All scraped sources (upstream `get_research_sources`). */
  getResearchSources(): ScrapedContent[] {
    return this.researchSources
  }

  /** Add scraped sources (upstream `add_research_sources`). */
  addResearchSources(sources: readonly ScrapedContent[]): void {
    this.researchSources.push(...sources)
  }

  /** Append references (upstream `add_references`). */
  addReferences(reportMarkdown: string, visitedUrls: Iterable<string>): string {
    return addReferences(reportMarkdown, visitedUrls)
  }

  /** Extract headers (upstream `extract_headers`). */
  extractHeaders(markdownText: string): Array<Record<string, unknown>> {
    return extractHeaders(markdownText) as unknown as Array<Record<string, unknown>>
  }

  /** Extract sections (upstream `extract_sections`). */
  extractSections(markdownText: string): Array<Record<string, unknown>> {
    return extractSections(markdownText) as unknown as Array<Record<string, unknown>>
  }

  /** Table of contents (upstream `table_of_contents`). */
  tableOfContents(markdownText: string): string {
    return tableOfContents(markdownText)
  }

  /** Visited URLs (upstream `get_source_urls`). */
  getSourceUrls(): string[] {
    return [...this.visitedUrls]
  }

  /** Accumulated context (upstream `get_research_context`). */
  getResearchContext(): string {
    return this.context
  }

  /** Total cost (upstream `get_costs`). */
  getCosts(): number {
    return this.costs.getCosts()
  }

  /** Per-step costs (upstream `get_step_costs`). */
  getStepCosts(): Record<string, number> {
    return this.costs.getStepCosts()
  }

  /** Add a cost, attached to the current step (upstream `add_costs`). */
  addCosts(cost: number): void {
    this.costs.add(cost)
  }

  /**
   * Replace the context with curated entries, keeping the structured view in
   * step with the flat string (upstream overwrites `researcher.context`).
   *
   * @param curated - the curated sources (or the original data on failure).
   */
  applyCuratedSources(curated: unknown): void {
    this.contextSources = this.contextManager.normaliseContext(curated)
  }

  /**
   * Load documents through a registered loader.
   *
   * @param loaderName - registry name.
   * @param request - loader inputs.
   * @returns the loaded documents.
   */
  async loadDocuments(
    loaderName: string,
    request: DocumentLoadRequest,
  ): Promise<ScrapedContent[]> {
    const definition: DocumentLoaderDefinition | undefined = this.#documentLoaders.get(loaderName)
    if (!definition) {
      throw new Error(
        `Unknown document loader '${loaderName}'. Valid options are: ${this.#documentLoaders
          .names()
          .join(', ')}.`,
      )
    }
    return definition.load({ runtime: this.deps.runtime }, request)
  }

  /** Recompute the flat context string from structured entries. */
  contextFromEntries(): string {
    return this.contextSources.map((entry) => entry.Content).join(' ')
  }

  /**
   * Merge structured context entries, skipping duplicates.
   *
   * @param entries - entries to add.
   */
  mergeContextEntries(entries: readonly ContextEntry[]): void {
    const seen = new Set(
      this.contextSources.map((entry) => `${entry.Source}\u0000${entry.Content}`),
    )
    for (const entry of entries) {
      const key = `${entry.Source}\u0000${entry.Content}`
      if (seen.has(key)) continue
      seen.add(key)
      this.contextSources.push(entry)
    }
  }

  /** Normalise extracted text the way scrapers do. */
  static normalise(text: string): string {
    return collapseWhitespace(text)
  }
}
