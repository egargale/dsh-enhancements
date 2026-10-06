/**
 * Multi-agent state model — the port of `multi_agents/memory/{research,draft}.py`
 * plus the `task` dict that both graphs thread through every node.
 *
 * Upstream keeps two `TypedDict`s: `ResearchState` for the outer graph
 * (`browser → planner → human → researcher → writer → publisher`) and
 * `DraftState` for the per-section subgraph
 * (`researcher → reviewer → (accept | reviser → reviewer)`). Both are reproduced
 * here as interfaces, together with the `Task` shape and the options/result
 * types of the driver.
 *
 * The two TypedDicts are *not* fully faithful to upstream's typing on purpose:
 * upstream's `DraftState.draft` starts as a `{subtopic: report}` mapping and is
 * replaced by the reviser's plain rewritten text, and `ResearchState.sources`
 * arrives from the LLM as whatever the writer model returned. Python's
 * untyped dicts tolerate that; TypeScript needs a union, which is what
 * {@link DraftContent} is.
 *
 * @module gpt-researcher/multi-agents/state
 */

import type { EmbeddingsRegistry } from '../embeddings/index.ts'
import type { RetrieverRegistry } from '../retrievers/index.ts'
import type { VectorStore } from '../vector_store/index.ts'
import type { ReportSource } from '../types.ts'

/**
 * The `publish_formats` task key (`{'pdf': bool, 'docx': bool, 'markdown': bool}`).
 *
 * Upstream's publisher persists the assembled report to disk in each requested
 * format; this port has no filesystem seam, so the flag list survives (and is
 * reported through {@link MultiAgentOptions.onPublish}) but nothing is written.
 */
export interface PublishFormats {
  pdf?: boolean
  docx?: boolean
  markdown?: boolean
}

/**
 * The upstream `task` dict.
 *
 * Required keys are the ones upstream's `task.json` always ships; the optional
 * ones are read with `.get(...)` defaults in the agent files (`source`,
 * `publish_formats`) or by the AG2 sibling (`max_revisions`).
 */
export interface Task {
  /** The research question. */
  query: string
  /**
   * Upstream `task["model"]`. The port routes by tier (`callLlm`), so this is
   * kept for fidelity and diagnostics rather than as a routing input.
   */
  model?: string
  /** Upper bound on the planned section headers; defaults to {@link DEFAULT_MAX_SECTIONS}. */
  max_sections?: number
  /** Whether `HumanAgent` asks for plan feedback (upstream `.get` → falsy). */
  include_human_feedback?: boolean
  /** Whether the reviewer/reviser loop runs at all (`ReviewerAgent.run`). */
  follow_guidelines?: boolean
  /**
   * Guideline strings the reviewer must enforce. Upstream's `task.json` always
   * supplies a list; a DSH tool argument can supply one string, which is treated
   * as a single guideline (`guidelineList` in `agents.ts`).
   */
  guidelines?: string | string[]
  /** Verbose logging switch (`task.get("verbose")`). */
  verbose?: boolean
  /**
   * Upstream `main.py` passes a `Tone` member through to `GPTResearcher`; the
   * DSH tool passes the member *name*, which is canonicalised before use.
   */
  tone?: string
  /** `task.get("source", "web")` — the report source for both research nodes. */
  source?: ReportSource
  /** `task.get("publish_formats")`. */
  publish_formats?: PublishFormats
  /**
   * Revision-loop bound. The LangGraph variant has no explicit cap (LangGraph's
   * recursion limit is the only one); the sibling `multi_agents_ag2` reads
   * `task.get("max_revisions", 3)` and this port follows that spelling.
   */
  max_revisions?: number
}

/**
 * One section draft as `ResearchAgent.runDepthResearch` produces it: the
 * subtopic map `{subtopic: report}`, or `{subtopic: null}` when that research
 * failed (upstream catches the exception and stores `None`).
 */
export type SubtopicDraft = Record<string, string | null>

/**
 * `DraftState.draft`: the subtopic map from the researcher, replaced by the
 * reviser's rewritten `draft` string after a revision. `null` mirrors a failed
 * researcher or a reviser that returned no draft.
 */
export type DraftContent = SubtopicDraft | string | null

/** The per-section subgraph state (`memory/draft.py`). */
export interface DraftState {
  task: Task
  /** The section header being researched. */
  topic: string
  /** The current draft: subtopic map, revised string, or `null`. */
  draft: DraftContent
  /** Reviewer feedback, or `null` for the "accept" edge. */
  review: string | null
  /** The reviser's note to the reviewer, fed into the next review prompt. */
  revision_notes: string | null
}

/**
 * The report layout labels (`WriterAgent.get_headers` defaults, optionally
 * rewritten by the guidelines pass). Upstream reads them with `headers.get(...)`
 * so a missing key is falsy.
 */
export interface ResearchHeaders {
  title?: string
  date?: string
  introduction?: string
  table_of_contents?: string
  conclusion?: string
  references?: string
}

/** The outer graph state (`memory/research.py`), every node merged into it. */
export interface ResearchState {
  task: Task
  /** Output of the `browser` node. */
  initial_research?: string
  /** Output of the `planner` node (also re-written by the `human` revise edge). */
  sections?: string[]
  /** Output of the `researcher` node: one entry per section, in section order. */
  research_data?: DraftContent[]
  /** Output of the `human` node; `null` means "accept the plan". */
  human_feedback?: string | null
  /** Output of the `planner` node. */
  title?: string
  /** Output of the `planner` node (`date`), rendered on the title page. */
  date?: string
  /** Output of the `writer` node. */
  headers?: ResearchHeaders
  /** Output of the `writer` node. */
  table_of_contents?: string
  /** Output of the `writer` node. */
  introduction?: string
  /** Output of the `writer` node. */
  conclusion?: string
  /** Output of the `writer` node. */
  sources?: string[]
  /** Output of the `publisher` node: the assembled markdown document. */
  report?: string
}

/** The plan `EditorAgent.planResearch` returns. */
export interface ResearchPlan {
  /** `plan.get("title")` — undefined when the model omitted it. */
  title?: string
  /** `plan.get("date")`. */
  date?: string
  /** `plan.get("sections")`. */
  sections?: string[]
}

/** The `writer` node's output, merged into {@link ResearchState}. */
export interface WriterState {
  table_of_contents: string
  introduction: string
  conclusion: string
  sources: string[]
  headers: ResearchHeaders
}

/** One emit format the publisher was asked for. */
export type PublishFormat = 'pdf' | 'docx' | 'markdown'

/**
 * Options for the multi-agent driver and its agents.
 *
 * Everything here is either a host seam (human feedback, publish sink), a
 * bounded-concurrency knob for the substitution of `asyncio.gather`, or an
 * injection point that lets a test run `GptResearcher` without providers
 * (`retrieverRegistry` / `embeddingsRegistry` / `vectorStore` are forwarded to
 * `GptResearcherOptions`; they exist because upstream's `ResearchAgent` reaches
 * for a real `GPTResearcher`, which is otherwise impossible to run offline).
 */
export interface MultiAgentOptions {
  /** Fallback when `task.publish_formats` is absent. */
  publishFormats?: PublishFormats
  /**
   * Human-in-the-loop callback. Upstream's `HumanAgent` either awaits a
   * websocket message or calls `input(...)`; the port injects the question and
   * receives the reply. When absent, `HumanAgent` behaves exactly like
   * upstream with `include_human_feedback = false`.
   */
  onHumanFeedback?: (question: string) => Promise<string>
  /**
   * Report sink replacing upstream's PDF/DOCX/Markdown writers. Called once per
   * requested format; with no sink configured the runs stay in memory.
   */
  onPublish?: (format: PublishFormat, layout: string) => Promise<void> | void
  /** Revision-loop bound; falls back to `task.max_revisions`, then 3. */
  maxRevisions?: number
  /**
   * Bound on the parallel section research. Upstream uses `asyncio.gather`
   * (unbounded); this port keeps results in section order but caps in-flight
   * sections. Defaults to `DEEP_RESEARCH_CONCURRENCY`.
   */
  maxSectionWorkers?: number
  /**
   * Bound on the `human → (revise) → planner` back-edge, which the LangGraph
   * variant leaves to its recursion limit. Upstream AG2 re-plans once.
   */
  maxPlanRevisions?: number
  /** Forwarded to `GptResearcher` (test seam / custom retriever set). */
  retrieverRegistry?: RetrieverRegistry
  /** Forwarded to `GptResearcher` (test seam / custom embedding provider). */
  embeddingsRegistry?: EmbeddingsRegistry
  /** Forwarded to `GptResearcher` (test seam / pre-built store). */
  vectorStore?: VectorStore
}

/**
 * The final value of `runResearchTask`, i.e. the merged outer graph state.
 *
 * `draft` and `references` are not literal `ResearchState` keys upstream: they
 * are the `DraftState.draft` values collected per section (the same list as
 * `research_data`) and the `\n`-joined reference block the publisher renders.
 * Both are exposed so the whole flow is observable from one object.
 */
export interface MultiAgentResult {
  task: Task
  initial_research: string
  sections: string[]
  research_data: DraftContent[]
  human_feedback: string | null
  title: string
  date: string
  headers: ResearchHeaders
  table_of_contents: string
  introduction: string
  conclusion: string
  sources: string[]
  /** The rendered `## References` body (`'\n'.join(sources)` upstream). */
  references: string
  /**
   * The assembled document. Upstream's `publisher.run` returns the layout it then
   * persists, so this is identical to {@link MultiAgentResult.report}; it is
   * exposed separately because callers (the DSH tool) read the document as the
   * run's "draft".
   */
  draft: string
  /** Per-section `DraftState.draft` values, in section order (`research_data`). */
  drafts: DraftContent[]
  /** The assembled markdown document (`publisher.run`). */
  report: string
}

/**
 * Default for a task without `max_sections`.
 *
 * Upstream's `task.json` always carries the key; this default exists for callers
 * that build a `Task` from tool arguments (the DSH tool documents "default 5").
 */
export const DEFAULT_MAX_SECTIONS = 5

/** Upstream AG2's default for `task.get("max_revisions", 3)`. */
export const DEFAULT_MAX_REVISIONS = 3

/** Default bound on the `human → planner` back-edge. */
export const DEFAULT_MAX_PLAN_REVISIONS = 3
