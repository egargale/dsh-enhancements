/**
 * Core data model for the gpt-researcher DSH plugin.
 *
 * Every shape here mirrors a shape that flows through the upstream Python
 * project (`gpt_researcher`), so the port stays recognisable: search results
 * use the `{url|href, title, body|raw_content, score}` union that upstream
 * retrievers actually return, context entries use the
 * `{url, title, content}` triple produced by scrapers, and `ReportType`,
 * `Tone`, and `ReportSource` are the exact upstream enum values.
 *
 * @module gpt-researcher/types
 */

/**
 * Upstream `ReportType` (`gpt_researcher/utils/enum.py`).
 *
 * - `research_report`  — short research report on a topic
 * - `resource_report`  — bullet list of the most relevant resources
 * - `outline_report`   — outline (bullet points) of the research
 * - `detailed_report`  — long report driven by subtopic sub-research
 * - `subtopic_report`  — one section of a detailed report
 * - `deep_research`    — recursive breadth/depth research
 */
export const REPORT_TYPES = [
  'research_report',
  'resource_report',
  'outline_report',
  'custom_report',
  'detailed_report',
  'subtopic_report',
  'deep',
] as const
export type ReportType = (typeof REPORT_TYPES)[number]

/**
 * Report types this plugin can emit, including the multi-agent document, which
 * upstream writes outside the single-agent `ReportType` enum.
 */
export type ResearchReportType = ReportType | 'multi_agent_report'

/** Upstream `ReportSource` (`gpt_researcher/utils/enum.py`). */
export const REPORT_SOURCES = [
  'web',
  'local',
  'hybrid',
  'azure',
  'langchain_documents',
  'langchain_vectorstore',
  'static',
] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

/**
 * Upstream `Tone` (`gpt_researcher/utils/enum.py`).
 *
 * Upstream stores the enum member and interpolates its *value* into the report
 * prompt; the backend receives the member *name* (`Tone[name]`). Both are kept:
 * {@link TONES} maps the name to the exact descriptive value used in prompts.
 */
export const TONES = {
  Objective: 'Objective (impartial and unbiased presentation of facts and findings)',
  Formal: 'Formal (adheres to academic standards with sophisticated language and structure)',
  Analytical: 'Analytical (critical evaluation and detailed examination of data and theories)',
  Persuasive: 'Persuasive (convincing the audience of a particular viewpoint or argument)',
  Informative: 'Informative (providing clear and comprehensive information on a topic)',
  Explanatory: 'Explanatory (clarifying complex concepts and processes)',
  Descriptive: 'Descriptive (detailed depiction of phenomena, experiments, or case studies)',
  Critical:
    'Critical (judging the validity and relevance of the research and its conclusions)',
  Comparative:
    'Comparative (juxtaposing different theories, data, or methods to highlight differences and similarities)',
  Speculative:
    'Speculative (exploring hypotheses and potential implications or future research directions)',
  Reflective:
    'Reflective (considering the research process and personal insights or experiences)',
  Narrative: 'Narrative (telling a story to illustrate research findings or methodologies)',
  Humorous:
    'Humorous (light-hearted and engaging, usually to make the content more relatable)',
  Optimistic: 'Optimistic (highlighting positive findings and potential benefits)',
  Pessimistic: 'Pessimistic (focusing on limitations, challenges, or negative outcomes)',
  Simple: 'Simple (written for young readers, using basic vocabulary and clear explanations)',
  Casual: 'Casual (conversational and relaxed style for easy, everyday reading)',
} as const
/** Tone member name, as the backend passes it (`Tone[tone]`). */
export type Tone = keyof typeof TONES
/** The descriptive tone string interpolated into report prompts. */
export type ToneValue = (typeof TONES)[Tone]

/** All tone names, in upstream declaration order. */
export const TONE_NAMES = Object.keys(TONES) as Tone[]

/** Output format of a report (`REPORT_FORMAT` config; upstream defaults to `APA`). */
export const REPORT_FORMATS = ['APA', 'MLA', 'Chicago', 'Harvard', 'IEEE', 'markdown'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

/**
 * One raw search result, preserving the union of keys upstream retrievers
 * return. Downstream code must read through {@link SearchResultHelpers} rather
 * than assuming one spelling.
 */
export interface SearchResult {
  /** Canonical URL (`url` in most retrievers, `href` in serper/google-style ones). */
  url?: string
  /** Alias of {@link SearchResult.url} used by serper/bing/google-shape results. */
  href?: string
  title?: string
  /** Snippet or full body, depending on the retriever. */
  body?: string
  content?: string
  /** Full page text already fetched by the retriever (e.g. PubMed Central). */
  raw_content?: string
  score?: number
  /** Publication date when the provider reports one. */
  published_date?: string
  /** The (sub-)query that produced this result. */
  query?: string
  /** Set when the result came from a non-web retriever (`mcp`, `local`, …). */
  source_type?: string
  /** Image URLs discovered in the result, when the retriever reports any. */
  image_urls?: string[]
  /** Anything else a provider returned; kept verbatim for fidelity. */
  [key: string]: unknown
}

/** Read a search result's URL regardless of which spelling the retriever used. */
export function resultUrl(result: SearchResult): string {
  const raw = result.url ?? result.href ?? ''
  return typeof raw === 'string' ? raw : String(raw)
}

/** Read a search result's body text regardless of which spelling the retriever used. */
export function resultBody(result: SearchResult): string {
  const raw = result.raw_content ?? result.body ?? result.content ?? ''
  return typeof raw === 'string' ? raw : ''
}

/** One scraped document: the unit of context upstream calls a "source". */
export interface ScrapedContent {
  url: string
  /** Full extracted page text. */
  raw_content: string
  title?: string
  image_urls?: string[]
  /** Provider/implementation that produced this content. */
  source_type?: string
}

/**
 * One compressed context entry as produced by the context manager when a
 * structured context is wanted (`{Title, Content, Source}` in upstream
 * `SourceCurator`).
 */
export interface ContextEntry {
  Title: string
  Content: string
  Source: string
}

/** One document chunk fed to the embedding compressor. */
export interface DocumentChunk {
  page_content: string
  metadata: Record<string, unknown>
}

/** Which LLM tier a call belongs to (upstream FAST/SMART/STRATEGIC_LLM). */
export type LlmTier = 'fast' | 'smart' | 'strategic'

/** One chat message, in the provider-neutral shape the client accepts. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** One completion request against a model tier. */
export interface ChatRequest {
  tier: LlmTier
  messages: ChatMessage[]
  /** Request temperature; upstream uses 0.25 / 0.35 / cfg.temperature per call site. */
  temperature?: number
  maxTokens?: number
  /** Stops generation; adapters map to the provider stop field. */
  stop?: string[]
  signal?: AbortSignal
}

/** Token accounting for one completion, when the provider reports it. */
export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
}

/** One completion result. */
export interface ChatResult {
  text: string
  usage?: ChatUsage
  /** Model and provider actually used, for cost attribution. */
  model?: string
  provider?: string
}

/**
 * The only LLM surface the engine uses. The DSH deployment implements it on
 * top of `ctx.llm.stream()`; tests implement it with scripted responses.
 */
export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResult>
}

/** Structured progress event, mirroring upstream `stream_output(...)` types. */
export interface ProgressEvent {
  /** Upstream log "type" (`logs`, `images`, `report`, …). */
  type: 'logs' | 'report' | 'images' | 'costs'
  /** Upstream log "step" key (e.g. `planning_research`, `subqueries`). */
  step: string
  message: string
  /** Optional structured payload (sub-query list, cost breakdown, …). */
  data?: unknown
}

/** Sink for {@link ProgressEvent}s; the DSH tool maps these to session context. */
export type ProgressSink = (event: ProgressEvent) => void

/** Accumulated per-step and total cost, mirroring `research_costs`/`step_costs`. */
export interface CostReport {
  total: number
  perStep: Record<string, number>
  currency: 'USD'
}

/** Final result of one research run. */
export interface ResearchOutcome {
  query: string
  reportType: ResearchReportType
  report: string
  /** All scraped sources, in first-seen order. */
  sources: ScrapedContent[]
  /** Every URL the run visited. */
  visitedUrls: string[]
  /** The final context string handed to the writer. */
  context: string
  costs: CostReport
  /** Subtopics, for detailed/deep research. */
  subtopics?: string[]
  /** Per-subtopic reports, for detailed research. */
  subtopicReports?: Array<{ subtopic: string; report: string }>
  /** Deep-research trace, when applicable. */
  researchTrace?: DeepResearchNode[]
}

/** One node of the deep-research recursion tree. */
export interface DeepResearchNode {
  query: string
  depth: number
  learnings: string[]
  followedUpQuestions: string[]
  sources: string[]
}

/**
 * Logger seam. The plugin never writes to stdout directly: DSH owns the
 * session log, so diagnostics travel through this interface.
 */
export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

/** A resolved embedding vector. */
export type Embedding = number[]
