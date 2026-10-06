/**
 * The multi-agent orchestrator — a port of
 * `multi_agents/agents/orchestrator.py` (`ChiefEditorAgent`).
 *
 * Upstream compiles a LangGraph `StateGraph(ResearchState)` whose nodes are
 *
 * ```
 * browser → planner → human → (accept: researcher | revise: planner)
 * researcher → writer → publisher → END
 * ```
 *
 * DEVIATION: LangGraph replaced by a sequential driver. The graph is a chain
 * with one conditional back-edge, so `runResearchTask` reproduces it with plain
 * `await`s, preserving node order, the outputs each node contributes to the
 * state, and the conditional edge's meaning (`human_feedback === null` accepts
 * the plan). The back-edge is bounded by
 * {@link MultiAgentOptions.maxPlanRevisions} because upstream left that loop to
 * LangGraph's recursion limit; the sibling `multi_agents_ag2` variant re-plans
 * exactly once.
 *
 * The other port-level substitutions are upstream's own seams: the
 * `websocket`/`stream_output` pair becomes `runtime.progress`, `print` becomes
 * `runtime.log`, and the `./outputs/run_*` directory is computed but never
 * created (this port has no filesystem seam; see `PublisherAgent`).
 *
 * @module gpt-researcher/multi-agents/orchestrator
 */

import type { EngineDeps } from '../deps.ts'
import {
  EditorAgent,
  HumanAgent,
  PublisherAgent,
  ResearchAgent,
  WriterAgent,
} from './agents.ts'
import {
  DEFAULT_MAX_PLAN_REVISIONS,
  type MultiAgentOptions,
  type MultiAgentResult,
  type ResearchState,
  type Task,
} from './state.ts'

/** The instantiated agents, upstream's `agents` dict. */
export interface ResearchTeam {
  research: ResearchAgent
  editor: EditorAgent
  writer: WriterAgent
  publisher: PublisherAgent
  human: HumanAgent
}

/**
 * Sanitize a filename the way `agents/utils/utils.py::sanitize_filename` does.
 *
 * @param filename - the raw name (the query prefix, upstream).
 * @returns the name with `< > : " / \ | ? *` replaced by `_`.
 */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*]/g, '_')
}

/**
 * Manages and coordinates the research team: the `browser → planner → human →
 * researcher → writer → publisher` run.
 */
export class ChiefEditorAgent {
  readonly deps: EngineDeps
  readonly task: Task
  readonly options: MultiAgentOptions
  /** Upstream `_generate_task_id`: `int(time.time())`. */
  readonly taskId: number
  /**
   * Upstream `_create_output_directory`:
   * `./outputs/run_{task_id}_{sanitized query[:40]}`. Computed for fidelity;
   * nothing is written there in this port.
   */
  readonly outputDir: string

  /**
   * @param deps - engine dependencies.
   * @param task - the task dict (upstream `task.json` plus the query).
   * @param options - multi-agent options (feedback callback, publish sink, caps).
   */
  constructor(deps: EngineDeps, task: Task, options: MultiAgentOptions = {}) {
    this.deps = deps
    this.task = task
    this.options = options
    this.taskId = Math.floor((deps.runtime.now?.() ?? Date.now()) / 1000)
    this.outputDir = `./outputs/run_${this.taskId}_${sanitizeFilename(task.query.slice(0, 40))}`
  }

  /**
   * Build the team (upstream `_initialize_agents`).
   *
   * @returns the five agents.
   */
  initializeAgents(): ResearchTeam {
    return {
      writer: new WriterAgent(this.deps),
      editor: new EditorAgent(this.deps, this.options),
      research: new ResearchAgent(this.deps, this.options),
      publisher: new PublisherAgent(this.deps, this.options),
      human: new HumanAgent(this.deps, this.options),
    }
  }

  /**
   * Initialize the research team (upstream `init_research_team`).
   *
   * DEVIATION: upstream returns a compiled `StateGraph`; with LangGraph gone the
   * driver is {@link runResearchTask}, so this returns the agents it will use.
   *
   * @returns the team.
   */
  initResearchTeam(): ResearchTeam {
    return this.initializeAgents()
  }

  /**
   * Log the run start (upstream `_log_research_start`).
   */
  private async logResearchStart(): Promise<void> {
    const message = `Starting the research process for query '${this.task.query}'...`
    this.deps.runtime.progress({ type: 'logs', step: 'starting_research', message })
    this.deps.runtime.log.info(message)
  }

  /**
   * Run the whole flow (upstream `run_research_task`).
   *
   * Upstream compiles the graph and calls
   * `chain.ainvoke({"task": self.task}, config=config)`, where `config` only
   * carries LangGraph's `thread_id`/`thread_ts`; the port has no checkpointer, so
   * those are dropped.
   *
   * @returns the merged outer state, as {@link MultiAgentResult}.
   */
  async runResearchTask(): Promise<MultiAgentResult> {
    // DEVIATION: LangGraph replaced by a sequential driver — the graph's node
    // order and its one conditional edge are the `await`s and the loop below.
    const agents = this.initResearchTeam()

    await this.logResearchStart()

    // node "browser": initial research → {task, initial_research}
    const browser = await agents.research.runInitialResearch({ task: this.task })
    let state: ResearchState = {
      task: this.task,
      initial_research: browser.initial_research,
    }

    // node "planner": initial research → {title, date, sections}
    let plan = await agents.editor.planResearch(state)
    state = { ...state, ...plan }

    // node "human" plus its conditional edges:
    //   "accept" (human_feedback is None) → researcher
    //   "revise" (any feedback)           → planner → human → …
    const maxPlanRevisions = this.options.maxPlanRevisions ?? DEFAULT_MAX_PLAN_REVISIONS
    for (let attempt = 0; attempt < maxPlanRevisions; attempt += 1) {
      const { human_feedback } = await agents.human.run(state)
      state = { ...state, human_feedback }
      if (human_feedback === null) break
      plan = await agents.editor.planResearch(state)
      state = { ...state, ...plan }
    }

    // node "researcher": one nested subgraph per section → {research_data}
    state = { ...state, ...(await agents.editor.runParallelResearch(state)) }

    // node "writer": → {table_of_contents, introduction, conclusion, sources, headers}
    state = { ...state, ...(await agents.writer.run(state)) }

    // node "publisher": → {report}
    state = { ...state, ...(await agents.publisher.run(state)) }

    return buildResult(state, this.task, agents.publisher)
  }
}

/**
 * Narrow the accumulated graph state into the public result.
 *
 * `drafts` mirrors `research_data`: upstream's `DraftState.draft` values are
 * exactly what `EditorAgent.run_parallel_research` collects into
 * `research_data`. `draft` is the assembled document (what upstream's
 * `publisher.run` returns and then persists, i.e. the same string as `report`).
 * `references` is the publisher's rendered reference block.
 *
 * @param state - the merged outer state.
 * @param task - the task, echoed back like upstream's final state.
 * @param publisher - the publisher, for the reference rendering.
 * @returns the result.
 */
function buildResult(
  state: ResearchState,
  task: Task,
  publisher: PublisherAgent,
): MultiAgentResult {
  const researchData = state.research_data ?? []
  return {
    task,
    initial_research: state.initial_research ?? '',
    sections: state.sections ?? [],
    research_data: researchData,
    human_feedback: state.human_feedback ?? null,
    title: state.title ?? '',
    date: state.date ?? '',
    headers: state.headers ?? {},
    table_of_contents: state.table_of_contents ?? '',
    introduction: state.introduction ?? '',
    conclusion: state.conclusion ?? '',
    sources: state.sources ?? [],
    references: publisher.referencesText(state),
    draft: state.report ?? '',
    drafts: researchData,
    report: state.report ?? '',
  }
}
