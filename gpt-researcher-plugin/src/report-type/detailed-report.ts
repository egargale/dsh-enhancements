/**
 * Detailed report — the port of
 * `backend/report_type/detailed_report/detailed_report.py`.
 *
 * A detailed report is a small orchestration on top of ordinary research:
 *
 * 1. `_initial_research` — run the main research and capture its context and
 *    visited URLs as the *global* context/URL set;
 * 2. `_get_all_subtopics` — ask the smart model for the report's subtopics;
 * 3. `write_introduction` — the report's H1 + introduction;
 * 4. `_generate_subtopic_reports` — one child researcher per subtopic, each
 *    seeded with the global context and told which headers/sections were already
 *    written so the sections do not repeat each other;
 * 5. `_construct_detailed_report` — table of contents, conclusion, references,
 *    and the final `introduction \n\n toc \n\n body \n\n conclusion` assembly.
 *
 * ## Deviations from upstream
 *
 * 1. **Visited URLs.** Upstream passes `visited_urls=self.global_urls` into each
 *    child and shares the *same* `set` object, but a child's
 *    `conduct_research()` calls `visited_urls.clear()` first, so the parent's
 *    URLs are destroyed and `self.global_urls.update(subtopic_assistant
 *    .visited_urls)` cannot restore them (it is the same object). This port
 *    gives each child its own copy and merges it back afterwards, which is the
 *    union upstream's code intends. See {@link DetailedReport.getSubtopicReport}.
 * 2. **`_hashable_context` input.** Upstream calls it on
 *    `gpt_researcher.context`, which for the web path is a single *string*, so
 *    Python iterates it character by character and the child's seeded context
 *    becomes a list of unique characters. That is plainly unintended; this port
 *    keeps the context as a one-element list of the full string, which is the
 *    shape `_hashable_context` is written for. The dedupe (`list(set(...))`
 *    upstream) is insertion-ordered here so a run is reproducible.
 * 3. **Main researcher.** Upstream builds a fresh `GPTResearcher` with
 *    `report_type="research_report"`. This port does the same through an
 *    injectable factory ({@link DetailedReportOptions.createResearcher}) but
 *    additionally copies the finished state back onto the agent it was handed,
 *    because `GptResearcher.run()` builds its `ResearchOutcome` from that agent.
 * 4. **Deep owners.** `GptResearcher.run()` routes both `detailed_report` and
 *    `deep` here. Upstream's deep flow is a separate wrapper
 *    (`backend/report_type/deep_research/main.py`: `conduct_research` →
 *    `write_report`), reproduced for a `deep` owner instead of the subtopic
 *    assembly.
 *
 * @module gpt-researcher/report-type/detailed-report
 */

import { createHash } from 'node:crypto'

import { GptResearcher, type GptResearcherOptions } from '../agent.ts'
import type { ReportType, ScrapedContent } from '../types.ts'
import { asContextText } from '../utils/text.ts'
import { isAbortError } from '../llm/call.ts'

/** One subtopic, as the report planner hands it on. */
export interface DetailedReportSubtopic {
  /** The subtopic's task/title. */
  task: string
}

/** One child researcher's report (upstream's `{"topic", "report"}` dict). */
export interface DetailedSubtopicReport {
  /** The subtopic this report covers. */
  topic: DetailedReportSubtopic
  /** The report markdown. */
  report: string
}

/** What {@link DetailedReport.run} returns. */
export interface DetailedReportResult {
  /** The fully assembled report. */
  report: string
  /** Subtopic task names, in report order. */
  subtopics: string[]
  /** One entry per non-empty subtopic report. */
  subtopicReports: Array<{ subtopic: string; report: string }>
}

/** Construction options for {@link DetailedReport}. */
export interface DetailedReportOptions {
  /**
   * Candidate subtopics passed on to the children (upstream's `subtopics`
   * argument); defaults to the owner agent's subtopics.
   */
  subtopics?: string[]
  /**
   * Upstream's `max_search_results` override: applied to the main researcher and
   * every child as `MAX_SEARCH_RESULTS_PER_QUERY`.
   */
  maxSearchResults?: number
  /**
   * Factory for the child researchers. Defaults to
   * `(options) => new GptResearcher(options)`.
   *
   * // PORT SEAM: `GptResearcher` resolves its retriever/embedding registries
   * // internally and exposes no injection point for a scraper registry, so a
   * // test that needs offline children must supply this factory and forward its
   * // own registries. Upstream's `DetailedReport` hard-codes `GPTResearcher`.
   */
  createResearcher?: (options: GptResearcherOptions) => GptResearcher
}

/** Upstream `_generate_research_id`: `detailed_<epoch-seconds>_<md5[0:8]>`. */
function generateResearchId(query: string, nowMs: number): string {
  const timestamp = String(Math.floor(nowMs / 1000))
  const queryHash = createHash('md5').update(query, 'utf8').digest('hex').slice(0, 8)
  return `detailed_${timestamp}_${queryHash}`
}

/**
 * De-duplicate strings, keeping first-seen order.
 *
 * // DEVIATION: upstream's `list(set(items))` has arbitrary (hash) order; this
 * // port keeps insertion order so a run is reproducible.
 *
 * @param items - candidate strings.
 * @returns the unique strings, in first-seen order.
 */
function dedupeOrdered(items: readonly string[]): string[] {
  return [...new Set(items)]
}

/**
 * The detailed-report orchestration.
 *
 * Upstream calls the main researcher `gpt_researcher`; that name is kept
 * ({@link gptResearcher}) so the two can be read side by side.
 */
export class DetailedReport {
  readonly #owner: GptResearcher
  readonly #createResearcher: (options: GptResearcherOptions) => GptResearcher
  readonly #maxSearchResults: number | undefined
  readonly #childSources: ScrapedContent[] = []

  /** Upstream `research_id`, used for logging and artifact naming. */
  readonly researchId: string
  /** Candidate subtopics handed to the children (upstream `self.subtopics`). */
  readonly subtopics: string[]
  /** The main researcher (upstream `self.gpt_researcher`). */
  readonly gptResearcher: GptResearcher

  /** Upstream `self.existing_headers`: `{subtopic task, headers}` per report. */
  existingHeaders: Array<Record<string, unknown>> = []
  /** Upstream `self.global_context`: every context gathered so far. */
  globalContext: string[] = []
  /** Upstream `self.global_written_sections`: sections already written. */
  globalWrittenSections: Array<Record<string, unknown>> = []
  /** Upstream `self.global_urls`: every URL visited by the report. */
  globalUrls: Set<string>

  /**
   * @param agent - the agent the detailed report runs for (the DSH run object).
   * @param options - subtopics, `max_search_results`, and the child factory.
   */
  constructor(agent: GptResearcher, options: DetailedReportOptions = {}) {
    this.#owner = agent
    this.subtopics = options.subtopics ?? agent.subtopics
    this.#maxSearchResults = options.maxSearchResults
    this.#createResearcher =
      options.createResearcher ?? ((childOptions) => new GptResearcher(childOptions))
    this.researchId = generateResearchId(agent.query, agent.deps.runtime.now?.() ?? Date.now())

    // PORT NOTE: upstream creates the main researcher with
    // `report_type="research_report"` and — unlike its children — without an
    // explicit agent/role. The port forwards an explicitly chosen agent/role
    // when the caller supplied one, so a tool-level choice is not thrown away.
    const reportType: ReportType = agent.reportType === 'deep' ? 'deep' : 'research_report'
    this.gptResearcher = this.#createResearcher({
      deps: agent.deps,
      query: agent.query,
      reportType,
      reportSource: agent.reportSource,
      tone: agent.tone,
      ...agent.seams,
      sourceUrls: [...agent.sourceUrls],
      documentUrls: [...agent.documentUrls],
      complementSourceUrls: agent.complementSourceUrls,
      queryDomains: [...agent.queryDomains],
      maxSubtopics: agent.maxSubtopics,
      ...(agent.agentName.length > 0 ? { agent: agent.agentName } : {}),
      ...(agent.role.length > 0 ? { role: agent.role } : {}),
      ...(this.#maxSearchResults === undefined
        ? {}
        : { overrides: { MAX_SEARCH_RESULTS_PER_QUERY: this.#maxSearchResults } }),
    })

    // Upstream `self.global_urls = set(self.source_urls) if self.source_urls
    // else set()`; `_initialResearch` replaces it with the main researcher's set.
    this.globalUrls = new Set<string>(agent.sourceUrls)
  }

  // ---------------------------------------------------------------------------
  // Flow
  // ---------------------------------------------------------------------------

  /**
   * Run the whole detailed-report flow.
   *
   * @returns the assembled report, its subtopic names, and the per-subtopic reports.
   */
  async run(): Promise<DetailedReportResult> {
    // PORT NOTE: upstream's deep wrapper is
    // `backend/report_type/deep_research/main.py` (`conduct_research` then
    // `write_report`, which selects `generate_deep_research_prompt`).
    // `GptResearcher.run()` routes `deep` here, so reproduce that wrapper rather
    // than the subtopic assembly.
    if (this.#owner.reportType === 'deep') {
      await this.#initialResearch()
      const report = await this.gptResearcher.writeReport()
      this.propagateToOwner()
      return { report, subtopics: [], subtopicReports: [] }
    }

    await this.#initialResearch()
    const subtopics = await this.#getAllSubtopics()
    const introduction = await this.gptResearcher.writeIntroduction()
    const { subtopicReports, reportBody } = await this.#generateSubtopicReports(subtopics)
    // Upstream: `self.gpt_researcher.visited_urls.update(self.global_urls)`.
    for (const url of this.globalUrls) this.gptResearcher.visitedUrls.add(url)
    const report = await this.#constructDetailedReport(introduction, reportBody)
    this.propagateToOwner()

    return {
      report,
      subtopics: subtopics.map((subtopic) => subtopic.task),
      subtopicReports: subtopicReports.map((entry) => ({
        subtopic: entry.topic.task,
        report: entry.report,
      })),
    }
  }

  /**
   * Run the main research and seed the global context/URL state (upstream
   * `_initial_research`).
   *
   * Upstream assigns the raw context (a string on the web path) to
   * `self.global_context`; this port stores it as a one-element list so
   * {@link hashableContext} receives the collection it is written for — see the
   * module-level deviation note.
   *
   * @returns nothing; the global state is updated.
   */
  async #initialResearch(): Promise<void> {
    await this.gptResearcher.conductResearch()
    this.globalContext = [this.gptResearcher.context]
    this.globalUrls = this.gptResearcher.visitedUrls
  }

  /**
   * Collect the subtopics (upstream `_get_all_subtopics`).
   *
   * @returns the subtopic tasks; an empty list when the model produced nothing.
   */
  async #getAllSubtopics(): Promise<DetailedReportSubtopic[]> {
    const subtopics = await this.gptResearcher.getSubtopics()
    if (subtopics.length === 0) {
      this.#owner.deps.runtime.log.warn(
        `Unexpected subtopics data format: ${asContextText(subtopics)}`,
      )
      return []
    }
    return subtopics.map((task) => ({ task }))
  }

  /**
   * Write every subtopic report (upstream `_generate_subtopic_reports`).
   *
   * @param subtopics - the subtopics to write.
   * @returns the per-subtopic reports and the concatenated report body.
   */
  async #generateSubtopicReports(subtopics: readonly DetailedReportSubtopic[]): Promise<{
    subtopicReports: DetailedSubtopicReport[]
    reportBody: string
  }> {
    const subtopicReports: DetailedSubtopicReport[] = []
    let reportBody = ''

    for (const subtopic of subtopics) {
      try {
        const result = await this.getSubtopicReport(subtopic)
        if (result.report.length > 0) {
          subtopicReports.push(result)
          reportBody += `\n\n\n${result.report}`
        }
      } catch (error) {
        // One flaky child (a retriever failure, a transport error, an embedding
        // failure) used to reject out of `run()` and discard the main research,
        // the introduction and every section already written. Contain it: report
        // the failure and keep the sections that succeeded. Cancellation still
        // propagates.
        if (isAbortError(error) || this.#owner.deps.runtime.signal?.aborted) throw error
        this.#owner.deps.runtime.log.warn(
          `subtopic '${subtopic.task}' failed and was skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        this.#owner.deps.runtime.progress({
          type: 'logs',
          step: 'subtopic_error',
          message: `❌ Subtopic failed and was skipped: ${subtopic.task}`,
        })
      }
    }

    return { subtopicReports, reportBody }
  }

  /**
   * Write one subtopic's report (upstream `_get_subtopic_report`).
   *
   * @param subtopic - the subtopic to write.
   * @returns the subtopic and its report.
   */
  async getSubtopicReport(subtopic: DetailedReportSubtopic): Promise<DetailedSubtopicReport> {
    const main = this.gptResearcher
    const task = subtopic.task
    const seededContext = dedupeOrdered(this.hashableContext(this.globalContext))

    // DEVIATION (visited URLs): upstream hands the child the parent's shared
    // set, but the child's `conduct_research()` clears it, so the parent's URLs
    // are lost and `self.global_urls.update(subtopic_assistant.visited_urls)`
    // (a no-op on the same object) cannot bring them back. Handing each child a
    // copy and merging it back afterwards yields the intended union; the child
    // still starts from an empty set, exactly as upstream's `clear()` leaves it.
    const childUrls = new Set(this.globalUrls)

    const child = this.#createResearcher({
      deps: main.deps,
      query: task,
      reportType: 'subtopic_report',
      reportSource: this.#owner.reportSource,
      // Child researchers must inherit the host's injected registries and the
      // owner's document URLs; without them a hybrid/detailed run reads a
      // different corpus than the main research (and fakes are bypassed).
      ...this.#owner.seams,
      documentUrls: [...this.#owner.documentUrls],
      sourceUrls: [...this.#owner.sourceUrls],
      queryDomains: [...this.#owner.queryDomains],
      parentQuery: this.#owner.query,
      subtopics: [...this.subtopics],
      visitedUrls: childUrls,
      tone: this.#owner.tone,
      complementSourceUrls: this.#owner.complementSourceUrls,
      // Upstream assigns the list after construction; `GptResearcher.context` is
      // a string in this port, so the items are joined with the same newline the
      // engine uses elsewhere (module deviation 2).
      context: seededContext.join('\n'),
      ...(main.agentName.length > 0 ? { agent: main.agentName } : {}),
      ...(main.role.length > 0 ? { role: main.role } : {}),
      ...(this.#maxSearchResults === undefined
        ? {}
        : { overrides: { MAX_SEARCH_RESULTS_PER_QUERY: this.#maxSearchResults } }),
    })

    await child.conductResearch()

    const draftSectionTitles = await child.getDraftSectionTitles(task)
    const draftSectionTitlesText = draftSectionTitles.join('\n')
    const parsedDraftSectionTitles = main
      .extractHeaders(draftSectionTitlesText)
      .map((header) => String(header.text ?? ''))

    const relevantContents = await child.getSimilarWrittenContentsByDraftSectionTitles(
      task,
      parsedDraftSectionTitles,
      this.globalWrittenSections,
    )

    const report = await child.writeReport({
      existingHeaders: this.existingHeaders,
      relevantWrittenContents: relevantContents,
    })

    this.globalWrittenSections.push(...main.extractSections(report))
    this.globalContext = dedupeOrdered(this.hashableContext([child.context]))
    for (const url of childUrls) this.globalUrls.add(url)
    this.#childSources.push(...child.researchSources)
    this.existingHeaders.push({
      'subtopic task': task,
      headers: main.extractHeaders(report),
    })

    return { topic: subtopic, report }
  }

  /**
   * Assemble the final report (upstream `_construct_detailed_report`).
   *
   * @param introduction - the introduction markdown.
   * @param reportBody - the concatenated subtopic reports.
   * @returns the assembled report.
   */
  async #constructDetailedReport(introduction: string, reportBody: string): Promise<string> {
    const toc = this.gptResearcher.tableOfContents(reportBody)
    const conclusion = await this.gptResearcher.writeReportConclusion(reportBody)
    const conclusionWithReferences = this.gptResearcher.addReferences(
      conclusion,
      this.gptResearcher.visitedUrls,
    )
    return `${introduction}\n\n${toc}\n\n${reportBody}\n\n${conclusionWithReferences}`
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert context items to strings (upstream `_hashable_context`).
   *
   * A dict contributes `Title: <title>\nContent: <body|content>`; anything else
   * is stringified (a string passes through unchanged).
   *
   * @param inputContext - the context items.
   * @returns the string forms, in input order (not de-duplicated; upstream
   *   wraps the call in `list(set(...))`, which callers apply via
   *   {@link dedupeOrdered}).
   */
  hashableContext(inputContext: readonly unknown[]): string[] {
    const contextItems: string[] = []
    for (const item of inputContext) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const record = item as Record<string, unknown>
        const title = record.title ?? 'No title'
        const content = record.body ?? record.content ?? ''
        contextItems.push(`Title: ${String(title)}\nContent: ${String(content)}`)
      } else {
        contextItems.push(asContextText(item))
      }
    }
    return contextItems
  }

  /**
   * Copy the finished main-researcher state onto the owning agent.
   *
   * // PORT NOTE: upstream's backend reads `DetailedReport.gpt_researcher`; the
   * // DSH `GptResearcher.run()` instead builds its outcome from the agent it was
   * // called on, so the observable state (context, visited URLs, sources,
   * // deep-research trace) is mirrored there. The sources are the union of the
   * // main run and every subtopic run, matching `ResearchOutcome.sources`
   * // ("All scraped sources").
   *
   * @returns nothing; the owner is updated in place.
   */
  propagateToOwner(): void {
    const owner = this.#owner
    if (owner === this.gptResearcher) return
    owner.context = this.gptResearcher.context

    const sources: ScrapedContent[] = [...this.gptResearcher.researchSources, ...this.#childSources]
    owner.researchSources.splice(0, owner.researchSources.length, ...sources)

    owner.visitedUrls.clear()
    for (const url of this.globalUrls) owner.visitedUrls.add(url)

    if (this.gptResearcher.deepResearchTrace !== undefined) {
      owner.deepResearchTrace = this.gptResearcher.deepResearchTrace
    }
  }
}
