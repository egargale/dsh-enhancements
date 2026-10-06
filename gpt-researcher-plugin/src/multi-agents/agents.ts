/**
 * The multi-agent team — a port of `multi_agents/agents/*.py`.
 *
 * One class per upstream agent, with upstream's method names and upstream's
 * prompts copied verbatim (including the odd indentation and spacing inside the
 * template literals; `test/unit/multi-agents.test.ts` pins the rendered output
 * against strings produced by running the Python originals).
 *
 * Substitutions made here, all recorded at the point of use:
 *
 * - `langgraph` is gone; the nested subgraph's `researcher → reviewer →
 *   (accept | reviser → reviewer)` cycle is a plain `for` loop in
 *   {@link EditorAgent.runSection} and the outer graph is a sequential driver in
 *   `orchestrator.ts`.
 * - `call_model(prompt, model, response_format=…)` becomes
 *   `callLlm(deps, {tier:'strategic', messages, temperature:0, step:'multi_agents'})`.
 *   Upstream's `model` comes from the task; the port routes by tier instead (the
 *   task's `model` is kept in {@link Task} for fidelity but is not a routing
 *   input).
 * - `print_agent_output` (a coloured `print`) becomes `deps.runtime.log`, and
 *   every `stream_output(...)` becomes a `deps.runtime.progress(...)` event with
 *   the same `step` and message.
 * - `asyncio.gather` over sections becomes a bounded `WorkerPool`, while
 *   preserving gather's fail-the-node semantics.
 *
 * @module gpt-researcher/multi-agents/agents
 */

import { GptResearcher } from '../agent.ts'
import { canonicalToneName } from '../config.ts'
import type { EngineDeps } from '../deps.ts'
import { callLlm } from '../llm/call.ts'
import type { ChatMessage, ReportSource, ReportType, Tone } from '../types.ts'
import { parseJsonLoose } from '../utils/json.ts'
import { WorkerPool } from '../utils/workers.ts'
import {
  DEFAULT_MAX_REVISIONS,
  DEFAULT_MAX_SECTIONS,
  type DraftContent,
  type DraftState,
  type MultiAgentOptions,
  type PublishFormat,
  type PublishFormats,
  type ResearchHeaders,
  type ResearchPlan,
  type ResearchState,
  type SubtopicDraft,
  type Task,
  type WriterState,
} from './state.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Render a value the way Python's `str()` does, for prompt interpolation.
 *
 * Upstream builds almost every prompt with f-strings, and Python renders a list
 * or dict with `repr` semantics (`['a', 'b']`, `{'k': 'v'}`, `True`, `None`).
 * Reproducing that is required for verbatim prompts, so the research data, the
 * guidelines list, the headers dict and the drafts all go through this.
 *
 * @param value - any value interpolated into a prompt.
 * @returns the Python `str()` rendering.
 */
export function pythonStr(value: unknown): string {
  if (typeof value === 'string') return value
  return pythonRepr(value)
}

/**
 * Render a value the way Python's `repr()` does.
 *
 * @param value - any value.
 * @returns the Python `repr()` rendering.
 */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map((item) => pythonRepr(item)).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`,
    )
    return `{${entries.join(', ')}}`
  }
  return String(value)
}

/** `datetime.now().strftime('%d/%m/%Y')` — the local date format upstream uses. */
function formatToday(): string {
  const now = new Date()
  const day = String(now.getDate()).padStart(2, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${now.getFullYear()}`
}

/** Port of `agents/utils/views.py::print_agent_output` (colour dropped). */
function logAgent(deps: EngineDeps, agent: string, output: string): void {
  deps.runtime.log.info(`${agent}: ${output}`)
}

/** Port of an upstream `stream_output("logs", step, message, websocket)` call. */
function emitLogs(deps: EngineDeps, step: string, message: string, data?: unknown): void {
  deps.runtime.progress({
    type: 'logs',
    step,
    message,
    ...(data === undefined ? {} : { data }),
  })
  deps.runtime.log.info(message)
}

/**
 * Port of `agents/utils/llms.py::call_model` with `response_format='json'`.
 *
 * Upstream parses with `parse_json_markdown(..., parser=json_repair.loads)`; a
 * payload that repairs to nothing yields an empty object here, so every
 * `.get(key)` call site observes `undefined` exactly as upstream observes
 * `None` for a missing key.
 *
 * DEVIATION: upstream's `call_model` swallows a failed completion and returns
 * `None`, which makes the caller's next `.get(...)`/`in` raise an unrelated
 * `AttributeError`/`TypeError`. The port lets the completion error surface
 * unchanged instead of masking it.
 *
 * @param deps - engine dependencies.
 * @param messages - the prompt, as an OpenAI-style message list.
 * @returns the parsed JSON object, or `{}` when the model produced none.
 */
async function callModelJson(
  deps: EngineDeps,
  messages: readonly ChatMessage[],
): Promise<Record<string, unknown>> {
  const result = await callLlm(deps, {
    tier: 'strategic',
    messages: [...messages],
    temperature: 0,
    step: 'multi_agents',
  })
  const parsed = parseJsonLoose<unknown>(result.text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

/**
 * Port of `call_model(prompt, model)` — the plain-text form.
 *
 * @param deps - engine dependencies.
 * @param messages - the prompt, as an OpenAI-style message list.
 * @returns the completion text.
 */
async function callModelText(
  deps: EngineDeps,
  messages: readonly ChatMessage[],
): Promise<string> {
  const result = await callLlm(deps, {
    tier: 'strategic',
    messages: [...messages],
    temperature: 0,
    step: 'multi_agents',
  })
  return result.text
}

/**
 * Normalise `task.guidelines` to a list.
 *
 * Upstream's `task.json` supplies `List[str]`; a DSH tool argument supplies one
 * string, which is treated as a single guideline so the reviewer's `"- ".join`
 * sees one element instead of a string's characters.
 *
 * @param guidelines - the task's raw value.
 * @returns the guideline list.
 */
function guidelineList(guidelines: Task['guidelines']): string[] {
  if (guidelines === undefined) return []
  return Array.isArray(guidelines) ? guidelines : [guidelines]
}

/** Narrow a JSON field to a string, as `str(value)` would where upstream needs one. */
function optionalText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : pythonStr(value)
}

// ---------------------------------------------------------------------------
// ResearchAgent (`agents/researcher.py`)
// ---------------------------------------------------------------------------

/**
 * The `browser` node and the nested `researcher` node.
 *
 * Upstream holds a `GPTResearcher` constructed per call; the port constructs the
 * same `GptResearcher` with the injected engine deps. The retriever/embeddings/
 * vector-store seams from {@link MultiAgentOptions} are forwarded only when a
 * caller supplied them, which is how the offline tests run this node.
 */
export class ResearchAgent {
  readonly deps: EngineDeps
  readonly options: MultiAgentOptions

  /**
   * @param deps - engine dependencies threaded into every `GptResearcher`.
   * @param options - multi-agent options (research seams).
   */
  constructor(deps: EngineDeps, options: MultiAgentOptions = {}) {
    this.deps = deps
    this.options = options
  }

  /**
   * Run one full single-agent research pass (upstream `research`).
   *
   * `conduct_research()` + `write_report()` on a `GPTResearcher`, which is
   * exactly what upstream's `browser` node reuses.
   *
   * @param query - the query or subtopic to research.
   * @param researchReport - upstream `research_report` / `subtopic_report`.
   * @param parentQuery - the main query, for a subtopic report.
   * @param verbose - upstream `verbose` flag.
   * @param source - upstream `source` (report source).
   * @param tone - the canonical tone name, when the task carried one.
   * @returns the written report markdown.
   */
  async research(
    query: string,
    researchReport: ReportType = 'research_report',
    parentQuery = '',
    verbose = true,
    source: ReportSource = 'web',
    tone?: Tone,
  ): Promise<string> {
    const researcher = new GptResearcher({
      deps: this.deps,
      query,
      reportType: researchReport,
      reportSource: source,
      parentQuery,
      ...(tone === undefined ? {} : { tone }),
      ...(verbose === this.deps.config.verbose ? {} : { overrides: { VERBOSE: verbose } }),
      ...(this.options.retrieverRegistry === undefined
        ? {}
        : { retrieverRegistry: this.options.retrieverRegistry }),
      ...(this.options.embeddingsRegistry === undefined
        ? {}
        : { embeddingsRegistry: this.options.embeddingsRegistry }),
      ...(this.options.vectorStore === undefined ? {} : { vectorStore: this.options.vectorStore }),
    })
    await researcher.conductResearch()
    return researcher.writeReport()
  }

  /**
   * Research one subtopic (upstream `run_subtopic_research`).
   *
   * Upstream catches every exception and stores `None` for the subtopic; that
   * behaviour is preserved.
   *
   * @param parentQuery - the main query.
   * @param subtopic - the section header to research.
   * @param verbose - upstream `verbose` flag.
   * @param source - upstream `source`.
   * @returns `{subtopic: report}`, or `{subtopic: null}` on failure.
   */
  async runSubtopicResearch(
    parentQuery: string,
    subtopic: string,
    verbose = true,
    source: ReportSource = 'web',
    tone?: Tone,
  ): Promise<SubtopicDraft> {
    try {
      const report = await this.research(
        subtopic,
        'subtopic_report',
        parentQuery,
        verbose,
        source,
        tone,
      )
      return { [subtopic]: report }
    } catch (error) {
      this.deps.runtime.log.error(
        `Error in researching topic ${subtopic}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return { [subtopic]: null }
    }
  }

  /**
   * The `browser` node (upstream `run_initial_research`).
   *
   * @param researchState - the outer state; only `task` is read.
   * @returns `{task, initial_research}`.
   */
  async runInitialResearch(
    researchState: Pick<ResearchState, 'task'>,
  ): Promise<{ task: Task; initial_research: string }> {
    const task = researchState.task
    const query = task.query
    const source = task.source ?? 'web'
    emitLogs(this.deps, 'initial_research', `Running initial research on the following query: ${query}`)
    return {
      task,
      initial_research: await this.research(
        query,
        'research_report',
        '',
        task.verbose ?? this.deps.config.verbose,
        source,
        task.tone === undefined ? undefined : canonicalToneName(task.tone),
      ),
    }
  }

  /**
   * The nested `researcher` node (upstream `run_depth_research`).
   *
   * @param draftState - the section state; `task` and `topic` are read.
   * @returns `{draft}` — the `{subtopic: report}` map.
   */
  async runDepthResearch(draftState: Pick<DraftState, 'task' | 'topic'>): Promise<{
    draft: SubtopicDraft
  }> {
    const task = draftState.task
    const topic = draftState.topic
    const source = task.source ?? 'web'
    emitLogs(
      this.deps,
      'depth_research',
      `Running in depth research on the following report topic: ${topic}`,
    )
    const draft = await this.runSubtopicResearch(
      task.query,
      topic,
      task.verbose ?? this.deps.config.verbose,
      source,
      task.tone === undefined ? undefined : canonicalToneName(task.tone),
    )
    return { draft }
  }
}

// ---------------------------------------------------------------------------
// ReviewerAgent (`agents/reviewer.py`)
// ---------------------------------------------------------------------------

/** Upstream `reviewer.py::TEMPLATE`, verbatim. */
const REVIEWER_TEMPLATE =
  'You are an expert research article reviewer. Your goal is to review research drafts and ' +
  'provide feedback to the reviser only based on specific guidelines. '

/** The `reviewer` node of the nested subgraph. */
export class ReviewerAgent {
  readonly deps: EngineDeps

  /**
   * @param deps - engine dependencies.
   */
  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  /**
   * Build the review prompt (upstream's inline `prompt = [...]`).
   *
   * Exposed so the exact rendered prompt can be asserted without a model call.
   *
   * @param draftState - the current section state.
   * @returns the system+user message list.
   */
  createReviewPrompt(draftState: DraftState): ChatMessage[] {
    const task = draftState.task
    const guidelines = guidelineList(task.guidelines).join('- ')
    const revisionNotes = draftState.revision_notes

    const revisePrompt = `The reviser has already revised the draft based on your previous review notes with the following feedback:
${pythonStr(revisionNotes)}\n
Please provide additional feedback ONLY if critical since the reviser has already made changes based on your previous feedback.
If you think the article is sufficient or that non critical revisions are required, please aim to return None.
`

    const reviewPrompt = `You have been tasked with reviewing the draft which was written by a non-expert based on specific guidelines.
Please accept the draft if it is good enough to publish, or send it for revision, along with your notes to guide the revision.
If not all of the guideline criteria are met, you should send appropriate revision notes.
If the draft meets all the guidelines, please return None.
${revisionNotes ? revisePrompt : ''}

Guidelines: ${guidelines}\nDraft: ${pythonStr(draftState.draft)}\n
`

    return [
      { role: 'system', content: REVIEWER_TEMPLATE },
      { role: 'user', content: reviewPrompt },
    ]
  }

  /**
   * Review one draft (upstream `review_draft`).
   *
   * `"None" in response` is preserved as a substring test, so any reply
   * containing `None` accepts the draft.
   *
   * @param draftState - the current section state.
   * @returns the review text, or `null` for the "accept" edge.
   */
  async reviewDraft(draftState: DraftState): Promise<string | null> {
    const task = draftState.task
    const response = await callModelText(this.deps, this.createReviewPrompt(draftState))

    if (task.verbose) {
      emitLogs(this.deps, 'review_feedback', `Review feedback is: ${response}...`)
    }

    if (response.includes('None')) return null
    return response
  }

  /**
   * The `reviewer` node (upstream `run`).
   *
   * Guidelines are only enforced when `task.follow_guidelines` is set; the node
   * returns `{review: null}` otherwise, which drives the conditional edge to
   * "accept".
   *
   * @param draftState - the current section state.
   * @returns `{review}`.
   */
  async run(draftState: DraftState): Promise<{ review: string | null }> {
    const task = draftState.task
    const guidelines = task.guidelines
    const toFollowGuidelines = task.follow_guidelines
    let review: string | null = null
    if (toFollowGuidelines) {
      logAgent(this.deps, 'REVIEWER', 'Reviewing draft...')
      if (task.verbose) {
        logAgent(this.deps, 'REVIEWER', `Following guidelines ${pythonStr(guidelines)}...`)
      }

      review = await this.reviewDraft(draftState)
    } else {
      logAgent(this.deps, 'REVIEWER', 'Ignoring guidelines...')
    }
    return { review }
  }
}

// ---------------------------------------------------------------------------
// ReviserAgent (`agents/reviser.py`)
// ---------------------------------------------------------------------------

/** Upstream `reviser.py::sample_revision_notes`, verbatim (trailing spaces included). */
const SAMPLE_REVISION_NOTES = `
{
  "draft": { 
    draft title: The revised draft that you are submitting for review 
  },
  "revision_notes": Your message to the reviewer about the changes you made to the draft based on their feedback
}
`

/** The `reviser` node of the nested subgraph. */
export class ReviserAgent {
  readonly deps: EngineDeps

  /**
   * @param deps - engine dependencies.
   */
  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  /**
   * Build the revision prompt (upstream's inline `prompt = [...]`).
   *
   * Upstream's f-string accidentally embeds the literal text `" + "` between the
   * draft and the reviewer's notes; that is preserved.
   *
   * @param draftState - the current section state (`draft` and `review`).
   * @returns the system+user message list.
   */
  createRevisionPrompt(draftState: DraftState): ChatMessage[] {
    return [
      {
        role: 'system',
        content: 'You are an expert writer. Your goal is to revise drafts based on reviewer notes.',
      },
      {
        role: 'user',
        content: `Draft:\n${pythonStr(draftState.draft)}" + "Reviewer's notes:\n${pythonStr(
          draftState.review,
        )}\n\n
You have been tasked by your reviewer with revising the following draft, which was written by a non-expert.
If you decide to follow the reviewer's notes, please write a new draft and make sure to address all of the points they raised.
Please keep all other aspects of the draft the same.
You MUST return nothing but a JSON in the following format:
${SAMPLE_REVISION_NOTES}
`,
      },
    ]
  }

  /**
   * Revise one draft (upstream `revise_draft`).
   *
   * @param draftState - the current section state.
   * @returns the parsed `{draft, revision_notes}` object.
   */
  async reviseDraft(draftState: DraftState): Promise<Record<string, unknown>> {
    return callModelJson(this.deps, this.createRevisionPrompt(draftState))
  }

  /**
   * The `reviser` node (upstream `run`).
   *
   * @param draftState - the current section state.
   * @returns `{draft, revision_notes}` merged back into the draft state.
   */
  async run(draftState: DraftState): Promise<{
    draft: DraftContent
    revision_notes: string | null
  }> {
    logAgent(this.deps, 'REVISOR', 'Rewriting draft based on feedback...')
    const revision = await this.reviseDraft(draftState)

    if (draftState.task.verbose) {
      emitLogs(this.deps, 'revision_notes', `Revision notes: ${pythonStr(revision.revision_notes)}`)
    }

    return {
      draft: toDraftContent(revision.draft),
      revision_notes: optionalText(revision.revision_notes) ?? null,
    }
  }
}

/** Narrow a reviser `draft` field to a {@link DraftContent}. */
function toDraftContent(value: unknown): DraftContent {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object' && !Array.isArray(value)) {
    const map: SubtopicDraft = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      map[key] = item === null || item === undefined ? null : pythonStr(item)
    }
    return map
  }
  return pythonStr(value)
}

// ---------------------------------------------------------------------------
// WriterAgent (`agents/writer.py`)
// ---------------------------------------------------------------------------

/** Upstream `writer.py::sample_json`, verbatim. */
const SAMPLE_JSON = `
{
  "table_of_contents": A table of contents in markdown syntax (using '-') based on the research headers and subheaders,
  "introduction": An indepth introduction to the topic in markdown syntax and hyperlink references to relevant sources,
  "conclusion": A conclusion to the entire research based on all research data in markdown syntax and hyperlink references to relevant sources,
  "sources": A list with strings of all used source links in the entire research data in markdown syntax and apa citation format. For example: ['-  Title, year, Author [source url](source)', ...]
}
`

/** The report-layout label keys, in upstream's `get_headers` order. */
const HEADER_KEYS = [
  'title',
  'date',
  'introduction',
  'table_of_contents',
  'conclusion',
  'references',
] as const

/** The `writer` node. */
export class WriterAgent {
  readonly deps: EngineDeps

  /**
   * @param deps - engine dependencies.
   */
  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  /**
   * The default report headers (upstream `get_headers`).
   *
   * @param researchState - the outer state (`title` is read).
   * @returns the layout labels.
   */
  getHeaders(researchState: ResearchState): ResearchHeaders {
    return {
      title: researchState.title,
      date: 'Date',
      introduction: 'Introduction',
      table_of_contents: 'Table of Contents',
      conclusion: 'Conclusion',
      references: 'References',
    }
  }

  /**
   * Build the introduction/conclusion/sources prompt (upstream's inline prompt).
   *
   * @param researchState - the outer state (`title`, `research_data`, `task`).
   * @returns the system+user message list.
   */
  createSectionsPrompt(researchState: ResearchState): ChatMessage[] {
    const query = researchState.title
    const data = researchState.research_data
    const task = researchState.task
    const followGuidelines = task.follow_guidelines
    const guidelines = task.guidelines

    return [
      {
        role: 'system',
        content:
          'You are a research writer. Your sole purpose is to write a well-written ' +
          'research reports about a ' +
          'topic based on research findings and information.\n ',
      },
      {
        role: 'user',
        content:
          `Today's date is ${formatToday()}\n.` +
          `Query or Topic: ${query}\n` +
          `Research data: ${pythonStr(data)}\n` +
          `Your task is to write an in depth, well written and detailed ` +
          `introduction and conclusion to the research report based on the provided research data. ` +
          `Do not include headers in the results.\n` +
          `You MUST include any relevant sources to the introduction and conclusion as markdown hyperlinks -` +
          `For example: 'This is a sample text. ([url website](url))'\n\n` +
          `${followGuidelines ? `You must follow the guidelines provided: ${pythonStr(guidelines)}` : ''}\n` +
          `You MUST return nothing but a JSON in the following format (without json markdown):\n` +
          `${SAMPLE_JSON}\n\n`,
      },
    ]
  }

  /**
   * Write the report layout (upstream `write_sections`).
   *
   * @param researchState - the outer state.
   * @returns the parsed `{table_of_contents, introduction, conclusion, sources}`.
   */
  async writeSections(researchState: ResearchState): Promise<Record<string, unknown>> {
    return callModelJson(this.deps, this.createSectionsPrompt(researchState))
  }

  /**
   * Build the headers-rewrite prompt (upstream's inline prompt).
   *
   * @param task - the task carrying the guidelines.
   * @param headers - the current header labels.
   * @returns the system+user message list.
   */
  createReviseHeadersPrompt(task: Task, headers: ResearchHeaders): ChatMessage[] {
    return [
      {
        role: 'system',
        content: `You are a research writer. 
Your sole purpose is to revise the headers data based on the given guidelines.`,
      },
      {
        role: 'user',
        content: `Your task is to revise the given headers JSON based on the guidelines given.
You are to follow the guidelines but the values should be in simple strings, ignoring all markdown syntax.
You must return nothing but a JSON in the same format as given in headers data.
Guidelines: ${pythonStr(task.guidelines)}\n
Headers Data: ${pythonStr(headers)}\n
`,
      },
    ]
  }

  /**
   * Rewrite the header labels per the guidelines (upstream `revise_headers`).
   *
   * @param task - the task carrying the guidelines.
   * @param headers - the current header labels.
   * @returns `{headers}` with the model's replacement labels.
   */
  async reviseHeaders(
    task: Task,
    headers: ResearchHeaders,
  ): Promise<{ headers: ResearchHeaders }> {
    const response = await callModelJson(this.deps, this.createReviseHeadersPrompt(task, headers))
    const revised: ResearchHeaders = {}
    for (const key of HEADER_KEYS) {
      const value = response[key]
      if (value !== undefined) revised[key] = pythonStr(value)
    }
    return { headers: revised }
  }

  /**
   * The `writer` node (upstream `run`).
   *
   * @param researchState - the outer state.
   * @returns the layout fields plus the headers, merged into the outer state.
   */
  async run(researchState: ResearchState): Promise<WriterState> {
    emitLogs(
      this.deps,
      'writing_report',
      'Writing final research report based on research data...',
    )

    const researchLayoutContent = await this.writeSections(researchState)

    if (researchState.task.verbose) {
      emitLogs(
        this.deps,
        'research_layout_content',
        JSON.stringify(researchLayoutContent, null, 2),
      )
    }

    let headers = this.getHeaders(researchState)
    if (researchState.task.follow_guidelines) {
      emitLogs(this.deps, 'rewriting_layout', 'Rewriting layout based on guidelines...')
      headers = (await this.reviseHeaders(researchState.task, headers)).headers
    }

    return { ...toWriterContent(researchLayoutContent), headers }
  }
}

/**
 * Normalise the writer model's JSON into the four layout fields.
 *
 * A missing field becomes the string `'None'` because that is what upstream's
 * `research_state.get(...)` renders into the publisher's f-string; a `sources`
 * value that is not a list is dropped (upstream would iterate a string
 * character by character there).
 */
function toWriterContent(parsed: Record<string, unknown>): Omit<WriterState, 'headers'> {
  return {
    table_of_contents: pythonStr(parsed.table_of_contents),
    introduction: pythonStr(parsed.introduction),
    conclusion: pythonStr(parsed.conclusion),
    sources: Array.isArray(parsed.sources) ? parsed.sources.map((source) => pythonStr(source)) : [],
  }
}

// ---------------------------------------------------------------------------
// EditorAgent (`agents/editor.py`)
// ---------------------------------------------------------------------------

/** The nested subgraph's three agents (upstream `_initialize_agents`). */
export interface EditorAgents {
  research: ResearchAgent
  reviewer: ReviewerAgent
  reviser: ReviserAgent
}

/**
 * The `planner` node and the `researcher` node of the outer graph: it plans the
 * section outline, then runs one nested researcher→reviewer→reviser subgraph per
 * section.
 */
export class EditorAgent {
  readonly deps: EngineDeps
  readonly options: MultiAgentOptions

  /**
   * @param deps - engine dependencies.
   * @param options - multi-agent options (concurrency, revision bound).
   */
  constructor(deps: EngineDeps, options: MultiAgentOptions = {}) {
    this.deps = deps
    this.options = options
  }

  /**
   * The nested subgraph's agents (upstream `_initialize_agents`).
   *
   * Public so a caller (or a test) can substitute the section researcher while
   * keeping the real reviewer/reviser.
   *
   * @returns the three agent instances.
   */
  initializeAgents(): EditorAgents {
    return {
      research: new ResearchAgent(this.deps, this.options),
      reviewer: new ReviewerAgent(this.deps),
      reviser: new ReviserAgent(this.deps),
    }
  }

  /**
   * The `planner` node (upstream `plan_research`).
   *
   * @param researchState - the outer state (`initial_research`, `human_feedback`, `task`).
   * @returns `{title, date, sections}`; every field is `undefined` when the model
   *   produced no usable JSON, which is what upstream's `plan.get(...)` yields.
   */
  async planResearch(researchState: ResearchState): Promise<ResearchPlan> {
    const initialResearch = researchState.initial_research
    const task = researchState.task
    const includeHumanFeedback = task.include_human_feedback ?? false
    const humanFeedback = researchState.human_feedback ?? null
    const maxSections = task.max_sections ?? DEFAULT_MAX_SECTIONS

    const prompt = this.createPlanningPrompt(
      pythonStr(initialResearch),
      includeHumanFeedback,
      humanFeedback,
      maxSections,
    )

    logAgent(this.deps, 'EDITOR', 'Planning an outline layout based on initial research...')
    const plan = await callModelJson(this.deps, prompt)

    return {
      title: optionalText(plan.title),
      date: optionalText(plan.date),
      sections: Array.isArray(plan.sections)
        ? plan.sections.map((section) => pythonStr(section))
        : undefined,
    }
  }

  /**
   * Build the planning prompt (upstream `_create_planning_prompt`).
   *
   * @param initialResearch - the `browser` node's report.
   * @param includeHumanFeedback - `task.include_human_feedback`.
   * @param humanFeedback - the `human` node's feedback, when any.
   * @param maxSections - `task.max_sections`.
   * @returns the system+user message list.
   */
  createPlanningPrompt(
    initialResearch: string,
    includeHumanFeedback: boolean,
    humanFeedback: string | null,
    maxSections: number,
  ): ChatMessage[] {
    return [
      {
        role: 'system',
        content:
          'You are a research editor. Your goal is to oversee the research project ' +
          'from inception to completion. Your main task is to plan the article section ' +
          'layout based on an initial research summary.\n ',
      },
      {
        role: 'user',
        content: this.formatPlanningInstructions(
          initialResearch,
          includeHumanFeedback,
          humanFeedback,
          maxSections,
        ),
      },
    ]
  }

  /**
   * Format the planning instructions (upstream `_format_planning_instructions`).
   *
   * @param initialResearch - the `browser` node's report.
   * @param includeHumanFeedback - `task.include_human_feedback`.
   * @param humanFeedback - the `human` node's feedback, when any.
   * @param maxSections - `task.max_sections`.
   * @returns the rendered user prompt (upstream's 19-space continuation indent kept).
   */
  formatPlanningInstructions(
    initialResearch: string,
    includeHumanFeedback: boolean,
    humanFeedback: string | null,
    maxSections: number,
  ): string {
    const today = formatToday()
    const feedbackInstruction =
      includeHumanFeedback && humanFeedback && humanFeedback !== 'no'
        ? `Human feedback: ${humanFeedback}. You must plan the sections based on the human feedback.`
        : ''

    return `Today's date is ${today}
                   Research summary report: '${initialResearch}'
                   ${feedbackInstruction}
                   \nYour task is to generate an outline of sections headers for the research project
                   based on the research summary report above.
                   You must generate a maximum of ${maxSections} section headers.
                   You must focus ONLY on related research topics for subheaders and do NOT include introduction, conclusion and references.
                   You must return nothing but a JSON with the fields 'title' (str) and 
                   'sections' (maximum ${maxSections} section headers) with the following structure:
                   '{title: string research title, date: today's date, 
                   sections: ['section header 1', 'section header 2', 'section header 3' ...]}'.`
  }

  /**
   * The `researcher` node (upstream `run_parallel_research`).
   *
   * DEVIATION: LangGraph replaced by a sequential driver. Upstream compiles the
   * nested subgraph and calls `chain.ainvoke(...)` for every section inside
   * `asyncio.gather`; here `runSection` is the driver for one section and the
   * sections are mapped through a bounded {@link WorkerPool}. Results stay in
   * section order, and a section failure aborts the node exactly as a rejected
   * `gather` does (LangSmith's `tags: ["gpt-researcher"]` has no analogue).
   *
   * @param researchState - the outer state (`sections`, `title`, `task`).
   * @returns `{research_data}` — one draft per section.
   */
  async runParallelResearch(researchState: ResearchState): Promise<{ research_data: DraftContent[] }> {
    // DEVIATION: LangGraph replaced by a sequential driver — the nested subgraph
    // is `runSection`, and `asyncio.gather` is the bounded pool below.
    const queries = researchState.sections ?? []
    const title = researchState.title
    const task = researchState.task

    this.logParallelResearch(queries)

    const pool = new WorkerPool(
      this.options.maxSectionWorkers ?? this.deps.config.deepResearchConcurrency,
    )
    const failures: unknown[] = []
    const results = await pool.map(
      queries,
      async (query) => {
        try {
          return await this.runSection(query, title, task)
        } catch (error) {
          failures.push(error)
          throw error
        }
      },
      {
        fallback: null,
        logger: this.deps.runtime.log,
        ...(this.deps.runtime.signal === undefined ? {} : { signal: this.deps.runtime.signal }),
        now: this.deps.runtime.now,
      },
    )

    // `asyncio.gather` propagates the first section failure; the pool swallows
    // per-item errors, so re-raise it here to keep the node's contract.
    if (failures.length > 0) throw failures[0]

    return { research_data: results }
  }

  /**
   * Drive the nested subgraph for one section (the LangGraph substitution).
   *
   * Node order and the conditional edge are upstream's:
   * `researcher → reviewer → ("accept" if review is None else "reviser") →
   * reviewer → …`. The loop is bounded by `task.max_revisions` (default 3), the
   * sibling AG2 implementation's counter, because the LangGraph variant relies on
   * LangGraph's own recursion limit.
   *
   * @param topic - the section header.
   * @param title - the report title, passed to the researcher like upstream.
   * @param task - the task.
   * @returns the final draft for this section.
   */
  async runSection(topic: string, title: string | undefined, task: Task): Promise<DraftContent> {
    // DEVIATION: LangGraph replaced by a sequential driver — this method drives
    // the `researcher → reviewer → (accept | reviser → reviewer)` cycle.
    const agents = this.initializeAgents()
    // Upstream's `_create_task_input` also passes `title` into the subgraph;
    // no nested node reads it (the researcher takes the parent query from the
    // task), so it is accepted for signature fidelity only.
    const draftState: DraftState = {
      task,
      topic,
      draft: (await agents.research.runDepthResearch({ task, topic })).draft,
      review: null,
      revision_notes: null,
    }

    const maxRevisions = task.max_revisions ?? this.options.maxRevisions ?? DEFAULT_MAX_REVISIONS
    let current = draftState
    for (let attempt = 0; attempt < maxRevisions; attempt += 1) {
      const { review } = await agents.reviewer.run(current)
      if (review === null) break // conditional edge: "accept" → END
      const revision = await agents.reviser.run({ ...current, review })
      current = {
        ...current,
        draft: revision.draft,
        revision_notes: revision.revision_notes,
      }
    }
    return current.draft
  }

  /**
   * Log the parallel-research start (upstream `_log_parallel_research`).
   *
   * @param queries - the section headers about to be researched.
   */
  logParallelResearch(queries: readonly string[]): void {
    emitLogs(
      this.deps,
      'parallel_research',
      `Running parallel research for the following queries: ${pythonStr(queries)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// PublisherAgent (`agents/publisher.py`)
// ---------------------------------------------------------------------------

/** The `publisher` node: assembles the final markdown document. */
export class PublisherAgent {
  readonly deps: EngineDeps
  readonly options: MultiAgentOptions

  /**
   * @param deps - engine dependencies.
   * @param options - multi-agent options (publish sink).
   */
  constructor(deps: EngineDeps, options: MultiAgentOptions = {}) {
    this.deps = deps
    this.options = options
  }

  /**
   * The `\n`-joined reference block (upstream's `references` local).
   *
   * @param researchState - the outer state (`sources` is read).
   * @returns the references text.
   */
  referencesText(researchState: ResearchState): string {
    return (researchState.sources ?? []).map((reference) => pythonStr(reference)).join('\n')
  }

  /**
   * Assemble the document (upstream `generate_layout`).
   *
   * Section bodies come from `research_data`; a `{subtopic: report}` entry
   * contributes its values, anything else is rendered directly.
   *
   * @param researchState - the outer state.
   * @returns the final markdown layout.
   */
  generateLayout(researchState: ResearchState): string {
    const sections: string[] = []
    for (const subheader of researchState.research_data ?? []) {
      if (subheader !== null && typeof subheader === 'object' && !Array.isArray(subheader)) {
        for (const value of Object.values(subheader)) sections.push(pythonStr(value))
      } else {
        sections.push(pythonStr(subheader))
      }
    }

    const sectionsText = sections.join('\n\n')
    const references = this.referencesText(researchState)
    const headers = researchState.headers ?? {}
    return `# ${pythonStr(headers.title)}
#### ${pythonStr(headers.date)}: ${pythonStr(researchState.date)}

## ${pythonStr(headers.introduction)}
${pythonStr(researchState.introduction)}

## ${pythonStr(headers.table_of_contents)}
${pythonStr(researchState.table_of_contents)}

${sectionsText}

## ${pythonStr(headers.conclusion)}
${pythonStr(researchState.conclusion)}

## ${pythonStr(headers.references)}
${references}
`
  }

  /**
   * Publish the report (upstream `publish_research_report`).
   *
   * DEVIATION: upstream writes PDF/DOCX/Markdown files into `./outputs/run_*`
   * (`write_md_to_pdf` / `write_md_to_word` / `write_text_to_md`). This port has
   * no filesystem seam, so the layout is handed to
   * {@link MultiAgentOptions.onPublish} once per requested format and nothing is
   * written when no sink is configured.
   *
   * @param researchState - the outer state.
   * @param publishFormats - the formats to emit (upstream `task["publish_formats"]`).
   * @returns the assembled layout.
   */
  async publishResearchReport(
    researchState: ResearchState,
    publishFormats: PublishFormats,
  ): Promise<string> {
    const layout = this.generateLayout(researchState)
    await this.writeReportByFormats(layout, publishFormats)
    return layout
  }

  /**
   * Emit the layout in each requested format (upstream `write_report_by_formats`).
   *
   * @param layout - the assembled markdown.
   * @param publishFormats - the requested formats.
   */
  async writeReportByFormats(
    layout: string,
    publishFormats: PublishFormats,
  ): Promise<void> {
    const formats: PublishFormat[] = []
    if (publishFormats.pdf) formats.push('pdf')
    if (publishFormats.docx) formats.push('docx')
    if (publishFormats.markdown) formats.push('markdown')

    for (const format of formats) {
      if (this.options.onPublish) {
        await this.options.onPublish(format, layout)
      } else {
        this.deps.runtime.log.debug(
          `publish format '${format}' requested but no onPublish sink is configured; ` +
            'the report stays in memory',
          { format, chars: layout.length },
        )
      }
    }
  }

  /**
   * The `publisher` node (upstream `run`).
   *
   * @param researchState - the outer state.
   * @returns `{report}`.
   */
  async run(researchState: ResearchState): Promise<{ report: string }> {
    const task = researchState.task
    const publishFormats = this.options.publishFormats ?? task.publish_formats ?? {}
    emitLogs(
      this.deps,
      'publishing',
      'Publishing final research report based on retrieved data...',
    )
    const report = await this.publishResearchReport(researchState, publishFormats)
    return { report }
  }
}

// ---------------------------------------------------------------------------
// HumanAgent (`agents/human.py`)
// ---------------------------------------------------------------------------

/** The `human` node: upstream's human-in-the-loop gate, as an injected callback. */
export class HumanAgent {
  readonly deps: EngineDeps
  readonly options: MultiAgentOptions

  /**
   * @param deps - engine dependencies.
   * @param options - multi-agent options (`onHumanFeedback`).
   */
  constructor(deps: EngineDeps, options: MultiAgentOptions = {}) {
    this.deps = deps
    this.options = options
  }

  /**
   * The `human` graph node.
   *
   * Upstream registers `HumanAgent.review_plan` as the node; `run` is the name
   * the graph-facing contract uses (every other node is `run`), so it delegates.
   *
   * @param researchState - the outer state (`task`, `sections`).
   * @returns `{human_feedback}`; `null` means "accept the plan".
   */
  async run(researchState: ResearchState): Promise<{ human_feedback: string | null }> {
    return this.reviewPlan(researchState)
  }

  /**
   * The `human` node (upstream `review_plan`).
   *
   * DEVIATION: upstream reads the reply either from a websocket
   * (`receive_text()` + `json.loads` expecting `{type: "human_feedback",
   * content}`) or from the console (`input(...)`). The port calls
   * {@link MultiAgentOptions.onHumanFeedback} with the streamed question and
   * treats the resolved string as the feedback content. With no callback — like
   * upstream with `include_human_feedback = false` — the node returns
   * `{human_feedback: null}`, which drives the conditional edge to "accept".
   *
   * @param researchState - the outer state (`task`, `sections`).
   * @returns `{human_feedback}`; `null` means "accept the plan".
   */
  async reviewPlan(researchState: ResearchState): Promise<{ human_feedback: string | null }> {
    const task = researchState.task
    const layout = researchState.sections
    let userFeedback: string | null = null

    if (task.include_human_feedback && this.options.onHumanFeedback) {
      const question =
        `Any feedback on this plan of topics to research? ${pythonStr(layout)}? ` +
        `If not, please reply with 'no'.`
      userFeedback = await this.options.onHumanFeedback(question)
    }

    if (userFeedback && userFeedback.trim().toLowerCase().includes('no')) {
      userFeedback = null
    }

    return { human_feedback: userFeedback }
  }
}
