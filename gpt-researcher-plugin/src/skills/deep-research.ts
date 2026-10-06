/**
 * Deep research skill — the port of `gpt_researcher/skills/deep_research.py`.
 *
 * Upstream's `report_type="deep"` replaces the single research pass with a
 * breadth/depth recursion: at each level the strategic model is asked for
 * `breadth` search queries (each with a research goal), every query is
 * researched on the shared retriever/scraper stack, the model extracts the
 * learnings and follow-up questions of each query's context, and the recursion
 * descends into the follow-up questions while `depth > 1`, halving `breadth`
 * (floor division, minimum 2) per level. The accumulated learnings-with-
 * citations plus the accumulated context are trimmed to {@link MAX_CONTEXT_WORDS}
 * and become the researcher's context; the later `writeReport()` call then uses
 * `generate_deep_research_prompt`.
 *
 * ## Deviations from upstream
 *
 * 1. Upstream constructs a *nested* `GPTResearcher` per SERP query (which
 *    re-plans sub-queries with the strategic model and re-runs agent selection)
 *    and then reads that child's `context`, `visited_urls` and
 *    `research_sources`. This port keeps one agent and runs the child's
 *    per-sub-query stage for each SERP query — `_scrape_data_by_urls` plus the
 *    compression half of `_process_sub_query`, see
 *    {@link DeepResearchSkill.deepResearch} and its `#researchQuery` helper — so
 *    the shared runtime, cost tracker and visited-URL set stay in one place and
 *    no extra agent-selection call is paid per query. Each query's URLs and
 *    sources are captured locally, which is the isolation upstream gets from
 *    the child researcher.
 * 2. `reasoning_effort` is not part of a completion request in this port (the
 *    tier's route decides), so upstream's `ReasoningEfforts.High` on the
 *    research-plan and result-processing calls is not reproduced per call.
 * 3. Learning de-duplication is insertion-ordered; upstream's `list(set(...))`
 *    has arbitrary order. `GptResearcher.context`/`visitedUrls`/`researchSources`
 *    are mutated in place because the port exposes them as `readonly` fields.
 * 4. `process_research_results` reproduces upstream's first-colon split for a
 *    `Learning [url]: text` line *verbatim*, including the URL's own `:` — see
 *    {@link DeepResearchSkill.processResearchResults}. That looks like an
 *    upstream bug (the extracted learning keeps the URL's tail) but it is the
 *    observable behaviour of the source this port tracks.
 *
 * @module gpt-researcher/skills/deep-research
 */

import type { GptResearcher } from '../agent.ts'
import { getSearchResults } from '../actions/query-processing.ts'
import { callLlmText, isAbortError } from '../llm/call.ts'
import type {
  ChatMessage,
  DeepResearchNode,
  ScrapedContent,
  SearchResult,
} from '../types.ts'
import { asContextText, trimContextToWordLimit } from '../utils/text.ts'
import { WorkerPool } from '../utils/workers.ts'

/** Maximum words allowed in context (upstream's `MAX_CONTEXT_WORDS`). */
export const MAX_CONTEXT_WORDS = 25_000

/**
 * Hard bounds on the research fan-out.
 *
 * `breadth`/`depth`/`concurrency` come from model-visible tool arguments. The
 * per-level breadth floor is 2, so the query count is roughly
 * `breadth × 2^(depth-1)`: breadth 10 / depth 5 is ~760 queries — each with a
 * search, up to `max_search_results` scrapes and two completions — inside one
 * tool call. These bounds keep a single call inside a sane cost and latency
 * envelope; upstream has no bounds at all.
 */
export const DEEP_RESEARCH_LIMITS = {
  breadth: { min: 1, max: 10 },
  depth: { min: 0, max: 4 },
  concurrency: { min: 1, max: 16 },
} as const

/**
 * Clamp one research bound, reporting what was applied.
 *
 * @param value - the requested value (possibly undefined or non-finite).
 * @param bounds - the allowed range.
 * @param fallback - value used when the request is absent or unusable.
 * @returns the effective value.
 */
export function clampBound(
  value: number | undefined,
  bounds: { min: number; max: number },
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)))
}

/** Upstream `ResearchProgress`: the snapshot handed to an `onProgress` callback. */
export interface DeepResearchProgress {
  /** Starts at 1 and increments per recursion level. */
  currentDepth: number
  totalDepth: number
  /** Completed queries at the current level. */
  currentBreadth: number
  totalBreadth: number
  /** The query being processed, when one is in flight. */
  currentQuery?: string
  totalQueries: number
  completedQueries: number
}

/** One generated SERP query with its research goal (upstream's `{'query','researchGoal'}`). */
export interface DeepResearchQuery {
  query: string
  /**
   * The model's research goal. Upstream stores this key only when a `Goal:`
   * line followed the `Query:` line; a query without one raises `KeyError`
   * inside the per-query `try`, so the query is dropped. Ported unchanged.
   */
  researchGoal?: string
}

/** The learnings/follow-up questions and citations of one context. */
export interface DeepResearchAnalysis {
  learnings: string[]
  followUpQuestions: string[]
  /** learning text → cited source URL. */
  citations: Record<string, string>
}

/** The accumulated result of one `deepResearch` call (upstream's dict). */
export interface DeepResearchOutcome {
  /** Insertion-ordered de-duplicated learnings. */
  learnings: string[]
  visitedUrls: string[]
  citations: Record<string, string>
  /** Context items, trimmed to {@link MAX_CONTEXT_WORDS}. */
  context: string[]
  sources: ScrapedContent[]
}

/** Options for {@link DeepResearchSkill.run}. */
export interface DeepResearchRunOptions {
  /**
   * Progress callback. Upstream hands the mutable `ResearchProgress` object to
   * the callback on every state change; the same object is reused here.
   */
  onProgress?: (progress: DeepResearchProgress) => void
  /** Overrides the configured breadth. */
  breadth?: number
  /** Overrides the configured depth. */
  depth?: number
  /** Overrides the configured concurrency bound. */
  concurrency?: number
}

/** What {@link DeepResearchSkill.run} returns to the agent. */
export interface DeepResearchResult {
  /** The context string left on the researcher. */
  context: string
  /** One node per processed SERP query, breadth-first. */
  trace: DeepResearchNode[]
  learnings: string[]
}

/** One SERP query's intermediate result inside `deepResearch`. */
interface QueryResult {
  query: string
  researchGoal: string
  learnings: string[]
  followUpQuestions: string[]
  citations: Record<string, string>
  visitedUrls: string[]
  context: string
  sources: ScrapedContent[]
}

/** The result of researching one SERP query on the shared agent. */
interface QueryResearch {
  context: string
  visitedUrls: string[]
  sources: ScrapedContent[]
}

/**
 * Upstream's `getattr(cfg, name, fallback)`: the fallback applies only when the
 * attribute is absent (or not a finite number), never when it is `0`.
 *
 * @param value - the configured value, when present.
 * @param fallback - upstream's `getattr` default.
 * @returns the effective value.
 */
function configNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Render a thrown value's message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Format a timestamp the way Python's `datetime.now().strftime('%Y-%m-%d %H:%M:%S')`
 * does (local time, zero padded).
 *
 * @param milliseconds - epoch milliseconds.
 * @returns the formatted local timestamp.
 */
export function formatLocalTimestamp(milliseconds: number): string {
  const date = new Date(milliseconds)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Format elapsed milliseconds the way Python renders a `timedelta`
 * (`H:MM:SS.ffffff`), which is what upstream logs.
 *
 * @param milliseconds - elapsed milliseconds.
 * @returns the `timedelta`-style string.
 */
export function formatTimedelta(milliseconds: number): string {
  const totalMs = Math.max(0, Math.round(milliseconds))
  const hours = Math.floor(totalMs / 3_600_000)
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const micros = (totalMs % 1000) * 1000
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(micros, 6)}`
}

/**
 * Render one accumulated context item the way upstream's `run()` does:
 * strings pass through, dicts contribute their `Content`, everything else is
 * stringified.
 *
 * // DEVIATION: upstream's `"\n".join(...)` raises `TypeError` for a non-string
 * // `Content`; this port stringifies it instead of failing the whole run.
 *
 * @param item - one context item.
 * @returns the text form.
 */
function renderContextItem(item: unknown): string {
  if (typeof item === 'string') return item
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const content = (item as Record<string, unknown>).Content
    return content === undefined ? asContextText(item) : String(content)
  }
  return String(item)
}

/**
 * The deep research skill: one instance per researcher.
 *
 * The instance is stateful exactly like upstream's: {@link context} accumulates
 * every level's context items, and {@link researchSources} accumulates every
 * level's scraped sources.
 */
export class DeepResearchSkill {
  readonly #agent: GptResearcher

  /** `DEEP_RESEARCH_BREADTH` (upstream `getattr(..., 4)`; the config ships 3). */
  readonly breadth: number
  /** `DEEP_RESEARCH_DEPTH` (upstream `getattr(..., 2)`; the config ships 2). */
  readonly depth: number
  /** `DEEP_RESEARCH_CONCURRENCY` (upstream `getattr(..., 2)`; the config ships 4). */
  readonly concurrencyLimit: number
  /**
   * Upstream `self.visited_urls = researcher.visited_urls`: the *same* set the
   * agent owns, kept here for parity. The per-query work goes through the agent,
   * so this is the set that records what was visited.
   */
  readonly visitedUrls: Set<string>
  /**
   * Upstream `self.learnings`, which upstream declares and never writes to.
   * Kept for parity; the learnings are returned from {@link run} instead.
   */
  readonly learnings: string[] = []
  /** Every level's scraped sources (upstream `self.research_sources`). */
  readonly researchSources: ScrapedContent[] = []
  /** Every level's context items (upstream `self.context`). */
  readonly context: string[] = []

  /**
   * @param agent - the researcher this skill researches for.
   */
  constructor(agent: GptResearcher) {
    this.#agent = agent
    const cfg = agent.deps.config
    this.breadth = configNumber(cfg.deepResearchBreadth, 4)
    this.depth = configNumber(cfg.deepResearchDepth, 2)
    this.concurrencyLimit = configNumber(cfg.deepResearchConcurrency, 2)
    this.visitedUrls = agent.visitedUrls
  }

  // ---------------------------------------------------------------------------
  // Prompts
  // ---------------------------------------------------------------------------

  /**
   * Generate SERP queries for research (upstream `generate_search_queries`).
   *
   * The model answers with `Query:`/`Goal:` line pairs, which are parsed
   * tolerantly: any line before the first `Query:` is ignored, and a trailing
   * `Query:` without a `Goal:` yields an entry without a research goal (which
   * downstream drops, exactly as upstream's `KeyError` does).
   *
   * @param query - the query (or combined deep-research query) to search for.
   * @param numQueries - how many queries to ask for and to return.
   * @returns the generated queries with their goals.
   */
  async generateSearchQueries(query: string, numQueries = 3): Promise<DeepResearchQuery[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an expert researcher generating search queries.' },
      {
        role: 'user',
        content:
          `Given the following prompt, generate ${numQueries} unique search queries to research the topic thoroughly. ` +
          `For each query, provide a research goal. Format as 'Query: <query>' followed by 'Goal: <goal>' for each pair: ${query}`,
      },
    ]

    const response = await callLlmText(this.#agent.deps, {
      tier: 'strategic',
      messages,
      temperature: 0.4,
      step: 'deep_research',
    })

    const queries: DeepResearchQuery[] = []
    let current: DeepResearchQuery | undefined
    for (const rawLine of response.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('Query:')) {
        if (current !== undefined) queries.push(current)
        current = { query: line.replaceAll('Query:', '').trim() }
      } else if (line.startsWith('Goal:') && current !== undefined) {
        current.researchGoal = line.replaceAll('Goal:', '').trim()
      }
    }
    if (current !== undefined) queries.push(current)

    return queries.slice(0, numQueries)
  }

  /**
   * Generate follow-up questions that clarify the research direction (upstream
   * `generate_research_plan`).
   *
   * Upstream seeds the prompt with the results of *every* configured retriever,
   * gathering them sequentially and logging — not failing — when one errors.
   *
   * @param query - the researcher's query.
   * @param numQuestions - how many questions to ask for and to return.
   * @returns the follow-up questions.
   */
  async generateResearchPlan(query: string, numQuestions = 3): Promise<string[]> {
    const agent = this.#agent
    const allSearchResults: SearchResult[] = []

    for (const definition of agent.retrievers.definitions) {
      try {
        const results = await getSearchResults(definition, agent.retrievers.context, query)
        allSearchResults.push(...results)
      } catch (error) {
        if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
        agent.deps.runtime.log.warn(`Error with retriever ${definition.name}: ${errorMessage(error)}`)
      }
    }
    agent.deps.runtime.log.info(`Initial web knowledge obtained: ${allSearchResults.length} results`)

    const currentTime = formatLocalTimestamp(agent.deps.runtime.now?.() ?? Date.now())
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are an expert researcher. Your task is to analyze the original query and search results, ' +
          'then generate targeted questions that explore different aspects and time periods of the topic.',
      },
      {
        role: 'user',
        content: `Original query: ${query}

Current time: ${currentTime}

Search results:
${asContextText(allSearchResults)}

Based on these results, the original query, and the current time, generate ${numQuestions} unique questions. Each question should explore a different aspect or time period of the topic, considering recent developments up to ${currentTime}.

Format each question on a new line starting with 'Question: '`,
      },
    ]

    const response = await callLlmText(agent.deps, {
      tier: 'strategic',
      messages,
      temperature: 0.4,
      step: 'deep_research',
    })

    return response
      .split('\n')
      .filter((line) => line.trim().startsWith('Question:'))
      .map((line) => line.replaceAll('Question:', '').trim())
      .slice(0, numQuestions)
  }

  /**
   * Extract learnings and follow-up questions from one query's context
   * (upstream `process_research_results`).
   *
   * Three shapes are accepted per `Learning…` line, in upstream's order:
   *
   * 1. `Learning [url]: insight` — the URL comes from the bracketed group;
   * 2. otherwise, a bare `http(s)://…` URL anywhere in the line;
   * 3. otherwise, the whole line with `Learning:` stripped.
   *
   * // DEVIATION (upstream bug fixed): upstream branch 1 does
   * // `line.split(':', 1)[1]`, i.e. everything after the *first* colon — which
   * // for the format its own prompt requests (`Learning [https://x]: insight`)
   * // is the colon inside `https:`. Every learning therefore came back as
   * // `//x]: insight`, and that mangled string is what the deep-research
   * // context and the report carry. This port takes the text after the
   * // `[citation]` group instead, which is what the prompt asks for and what
   * // the surrounding code clearly intends; the raw format is still fully
   * // supported through the other two branches below. Reverting to upstream's
   * // exact behaviour is a one-line change here if strict bug-compatibility is
   * // ever required.
   *
   * @param query - the query the context belongs to.
   * @param context - the researched context.
   * @param numLearnings - maximum learnings and follow-up questions to return.
   * @returns the learnings, follow-up questions, and learning → URL citations.
   */
  async processResearchResults(
    query: string,
    context: string,
    numLearnings = 3,
  ): Promise<DeepResearchAnalysis> {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an expert researcher analyzing search results.' },
      {
        role: 'user',
        content:
          `Given the following research results for the query '${query}', extract key learnings and suggest follow-up questions. ` +
          `For each learning, include a citation to the source URL if available. ` +
          `Format each learning as 'Learning [source_url]: <insight>' and each question as 'Question: <question>':\n\n${context}`,
      },
    ]

    const response = await callLlmText(this.#agent.deps, {
      tier: 'strategic',
      messages,
      temperature: 0.4,
      maxTokens: 1000,
      step: 'deep_research',
    })

    const learnings: string[] = []
    const questions: string[] = []
    const citations: Record<string, string> = {}

    for (const rawLine of response.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('Learning')) {
        const urlMatch = /\[(.*?)\]\s*:(.*)$/.exec(line)
        if (urlMatch && urlMatch[1] !== undefined) {
          const url = urlMatch[1]
          // Everything after the `[citation]:` group — see the DEVIATION note
          // above for why this is not upstream's first-colon split.
          const learning = (urlMatch[2] ?? '').trim()
          learnings.push(learning)
          citations[learning] = url
        } else {
          const inlineUrl = /https?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*(),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/.exec(
            line,
          )
          if (inlineUrl !== null) {
            const url = inlineUrl[0]
            const learning = line.replaceAll(url, '').replaceAll('Learning:', '').trim()
            learnings.push(learning)
            citations[learning] = url
          } else {
            learnings.push(line.replaceAll('Learning:', '').trim())
          }
        }
      } else if (line.startsWith('Question:')) {
        questions.push(line.replaceAll('Question:', '').trim())
      }
    }

    return {
      learnings: learnings.slice(0, numLearnings),
      followUpQuestions: questions.slice(0, numLearnings),
      citations,
    }
  }

  // ---------------------------------------------------------------------------
  // Recursion
  // ---------------------------------------------------------------------------

  /**
   * Conduct deep iterative research (upstream `deep_research`).
   *
   * Concurrency is bounded per level by `concurrency` (upstream's per-skill
   * `asyncio.Semaphore`), and each level recurses sequentially into its results
   * while `depth > 1`.
   *
   * @param params - the query, breadth/depth, the inherited learnings/citations/
   *   visited URLs, the progress callback and the trace accumulator.
   * @returns the accumulated outcome for this level and everything below it.
   */
  async deepResearch(params: {
    query: string
    breadth: number
    depth: number
    learnings?: readonly string[]
    citations?: Record<string, string>
    visitedUrls?: Iterable<string>
    concurrency?: number
    onProgress?: (progress: DeepResearchProgress) => void
    /** Port addition: the trace accumulator, appended breadth-first. */
    trace?: DeepResearchNode[]
  }): Promise<DeepResearchOutcome> {
    const agent = this.#agent
    const { query, breadth, depth } = params
    const onProgress = params.onProgress
    const trace = params.trace ?? []

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'deep_research',
      message: `\n📊 DEEP RESEARCH: depth=${depth}, breadth=${breadth}, query=${query.slice(0, 100)}...`,
    })

    const progress: DeepResearchProgress = {
      currentDepth: 1,
      totalDepth: depth,
      currentBreadth: 0,
      totalBreadth: breadth,
      totalQueries: 0,
      completedQueries: 0,
    }
    onProgress?.(progress)

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'deep_research_queries',
      message: `🔎 Generating ${breadth} search queries...`,
    })
    const serpQueries = await this.generateSearchQueries(query, breadth)
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'deep_research_queries',
      message: `✅ Generated ${serpQueries.length} queries: ${asContextText(
        serpQueries.map((entry) => entry.query),
      )}`,
    })
    progress.totalQueries = serpQueries.length

    let allLearnings = [...(params.learnings ?? [])]
    const allCitations: Record<string, string> = { ...(params.citations ?? {}) }
    const allVisitedUrls = new Set<string>(params.visitedUrls ?? [])
    const allContext: string[] = []
    const allSources: ScrapedContent[] = []

    const processQuery = async (serpQuery: DeepResearchQuery): Promise<QueryResult | undefined> => {
      const researchGoal = serpQuery.researchGoal
      try {
        // Upstream reads `serp_query['researchGoal']` inside the `try`; a query
        // the model emitted without a goal line raises there and is dropped.
        if (researchGoal === undefined) {
          throw new Error(`the generated query '${serpQuery.query}' has no research goal`)
        }
        progress.currentQuery = serpQuery.query
        onProgress?.(progress)

        const research = await this.#researchQuery(serpQuery.query)

        const results = await this.processResearchResults(serpQuery.query, research.context)

        progress.completedQueries += 1
        progress.currentBreadth += 1
        onProgress?.(progress)

        return {
          query: serpQuery.query,
          researchGoal,
          learnings: results.learnings,
          followUpQuestions: results.followUpQuestions,
          citations: results.citations,
          visitedUrls: research.visitedUrls,
          context: research.context,
          sources: research.sources,
        }
      } catch (error) {
        if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
        agent.deps.runtime.log.error(`Error processing query '${serpQuery.query}': ${errorMessage(error)}`, {
          error,
        })
        agent.deps.runtime.progress({
          type: 'logs',
          step: 'deep_research_error',
          message: `\n❌ DEEP RESEARCH ERROR: ${errorMessage(error)}`,
        })
        return undefined
      }
    }

    const pool = new WorkerPool(params.concurrency ?? this.concurrencyLimit)
    const settled = await pool.map(serpQueries, processQuery, {
      fallback: undefined as QueryResult | undefined,
      logger: agent.deps.runtime.log,
      ...(agent.deps.runtime.signal === undefined ? {} : { signal: agent.deps.runtime.signal }),
      now: agent.deps.runtime.now,
    })
    const results = settled.filter((entry): entry is QueryResult => entry !== undefined)

    progress.currentBreadth = results.length
    onProgress?.(progress)

    // Port addition: one trace node per processed query at this level, in query
    // order. Deeper levels append afterwards, so the trace is breadth-first.
    for (const result of results) {
      trace.push({
        query: result.query,
        depth,
        learnings: [...result.learnings],
        followedUpQuestions: [...result.followUpQuestions],
        sources: [...new Set(result.sources.map((source) => source.url))],
      })
    }

    for (const result of results) {
      allLearnings.push(...result.learnings)
      for (const url of result.visitedUrls) allVisitedUrls.add(url)
      Object.assign(allCitations, result.citations)
      if (result.context.length > 0) allContext.push(result.context)
      if (result.sources.length > 0) allSources.push(...result.sources)

      if (depth > 1) {
        const newBreadth = Math.max(2, Math.floor(breadth / 2))
        const newDepth = depth - 1
        progress.currentDepth += 1
        progress.currentQuery = undefined

        const nextQuery = `
                Previous research goal: ${result.researchGoal}
                Follow-up questions: ${result.followUpQuestions.join(' ')}
                `

        const deeper = await this.deepResearch({
          query: nextQuery,
          breadth: newBreadth,
          depth: newDepth,
          learnings: allLearnings,
          citations: allCitations,
          visitedUrls: allVisitedUrls,
          ...(params.concurrency === undefined ? {} : { concurrency: params.concurrency }),
          ...(onProgress === undefined ? {} : { onProgress }),
          trace,
        })

        allLearnings = [...deeper.learnings]
        for (const url of deeper.visitedUrls) allVisitedUrls.add(url)
        Object.assign(allCitations, deeper.citations)
        if (deeper.context.length > 0) allContext.push(...deeper.context)
        if (deeper.sources.length > 0) allSources.push(...deeper.sources)
      }
    }

    this.context.push(...allContext)
    this.researchSources.push(...allSources)

    const trimmedContext = trimContextToWordLimit(allContext, MAX_CONTEXT_WORDS)
    agent.deps.runtime.log.info(
      `Trimmed context from ${allContext.length} items to ${trimmedContext.length} items to stay within word limit`,
    )

    return {
      // Upstream returns `list(set(all_learnings))`: same values, arbitrary
      // order. This port keeps first-seen order, which is deterministic.
      learnings: [...new Set(allLearnings)],
      visitedUrls: [...allVisitedUrls],
      citations: allCitations,
      context: trimmedContext,
      sources: allSources,
    }
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  /**
   * Run the deep research process, leaving the enhanced context on the
   * researcher (upstream `run` — the report itself is written later by
   * `writeReport()`).
   *
   * @param options - progress callback and breadth/depth/concurrency overrides.
   * @returns the context string, the recursion trace, and the learnings.
   */
  async run(options: DeepResearchRunOptions = {}): Promise<DeepResearchResult> {
    const agent = this.#agent
    // Clamp every model-supplied bound before it drives the recursion.
    const breadth = clampBound(options.breadth, DEEP_RESEARCH_LIMITS.breadth, this.breadth)
    const depth = clampBound(options.depth, DEEP_RESEARCH_LIMITS.depth, this.depth)
    const concurrency = clampBound(
      options.concurrency,
      DEEP_RESEARCH_LIMITS.concurrency,
      this.concurrencyLimit,
    )
    const clamped =
      (options.breadth !== undefined && options.breadth !== breadth) ||
      (options.depth !== undefined && options.depth !== depth) ||
      (options.concurrency !== undefined && options.concurrency !== concurrency)
    if (clamped) {
      agent.deps.runtime.log.warn(
        `deep-research bounds applied: breadth=${breadth} (max ${DEEP_RESEARCH_LIMITS.breadth.max}), ` +
          `depth=${depth} (max ${DEEP_RESEARCH_LIMITS.depth.max}), ` +
          `concurrency=${concurrency} (max ${DEEP_RESEARCH_LIMITS.concurrency.max})`,
      )
    }

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'deep_research',
      message: `\n🔍 DEEP RESEARCH: Starting with breadth=${breadth}, depth=${depth}, concurrency=${concurrency}`,
    })
    const startedAt = agent.deps.runtime.now?.() ?? Date.now()
    const initialCosts = agent.getCosts()

    const followUpQuestions = await this.generateResearchPlan(agent.query)
    const answers = followUpQuestions.map(() => 'Automatically proceeding with research')
    const qaPairs = followUpQuestions.map(
      (question, index) => `Q: ${question}\nA: ${answers[index] ?? 'Automatically proceeding with research'}`,
    )
    const combinedQuery =
      `\n        Initial Query: ${agent.query}\nFollow - up Questions and Answers:\n\n        ` +
      qaPairs.join('\n')

    const trace: DeepResearchNode[] = []
    const results = await this.deepResearch({
      query: combinedQuery,
      breadth,
      depth,
      concurrency,
      trace,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    })

    const researchCosts = agent.getCosts() - initialCosts
    agent.deps.runtime.log.info(
      `deep research costs: $${researchCosts.toFixed(2)} (total $${agent.getCosts().toFixed(2)})`,
    )

    const contextWithCitations: string[] = []
    for (const learning of results.learnings) {
      const citation = results.citations[learning] ?? ''
      contextWithCitations.push(citation.length > 0 ? `${learning} [Source: ${citation}]` : learning)
    }
    if (results.context.length > 0) contextWithCitations.push(...results.context)

    const finalContext = trimContextToWordLimit(contextWithCitations, MAX_CONTEXT_WORDS)

    agent.context = finalContext.map(renderContextItem).join('\n')
    // DEVIATION: upstream assigns a new list to `researcher.visited_urls`; the
    // port exposes the set as `readonly`, so the same contents are swapped in
    // place (which keeps every holder of the reference in step).
    agent.visitedUrls.clear()
    for (const url of results.visitedUrls) agent.visitedUrls.add(url)
    if (results.sources.length > 0) {
      // Upstream: `researcher.research_sources = results['sources']`.
      agent.researchSources.splice(0, agent.researchSources.length, ...results.sources)
    }

    const elapsedMs = (agent.deps.runtime.now?.() ?? Date.now()) - startedAt
    agent.deps.runtime.log.info(`Total research execution time: ${formatTimedelta(elapsedMs)}`)
    agent.deps.runtime.log.info(`Total research costs: $${researchCosts.toFixed(2)}`)

    return { context: agent.context, trace, learnings: results.learnings }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Research one SERP query on the shared agent and return its compressed
   * context, the URLs it newly visited, and the sources it produced.
   *
   * This is upstream's per-sub-query stage — `_scrape_data_by_urls` + the
   * compression half of `_process_sub_query` — written out explicitly so that
   * each query's URLs and sources stay local to it. Upstream gets that
   * isolation from constructing one child researcher per query; a delta over
   * the shared agent state would mix concurrent queries together.
   *
   * @param query - the SERP query.
   * @returns the compressed context plus this query's URLs and sources.
   */
  async #researchQuery(query: string): Promise<QueryResearch> {
    const agent = this.#agent

    const { urls, prefetched } = await agent.researchConductor.searchRelevantSourceUrls(
      query,
      agent.queryDomains,
    )

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'researching',
      message: '🤔 Researching for relevant information across multiple sources...\n',
    })
    const scraped = await agent.scraperManager.browseUrls(urls)
    scraped.push(...prefetched)
    if (agent.vectorStore) await agent.vectorStore.load(scraped)

    if (scraped.length === 0) {
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'subquery_context_not_found',
        message: `🤷 No content found for '${query}'...`,
      })
      return { context: '', visitedUrls: urls, sources: [] }
    }

    // `scraped` is non-empty, so `processSubQuery` only compresses it: upstream's
    // `_process_sub_query` with `scraped_data` already gathered.
    const context = await agent.researchConductor.processSubQuery(query, scraped, agent.queryDomains)
    return { context, visitedUrls: urls, sources: scraped }
  }
}
