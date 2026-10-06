/**
 * The multi-agent research flow as one module tree.
 *
 * Ports `multi_agents/` (`ChiefEditorAgent` + the seven agents of the LangGraph
 * graph) into a plain async pipeline. See `orchestrator.ts` for the graph
 * substitution and `agents.ts` for the per-node ports and verbatim prompts.
 *
 * @module gpt-researcher/multi-agents
 */

export {
  EditorAgent,
  HumanAgent,
  PublisherAgent,
  ResearchAgent,
  ReviewerAgent,
  ReviserAgent,
  WriterAgent,
  pythonRepr,
  pythonStr,
  type EditorAgents,
} from './agents.ts'

export {
  ChiefEditorAgent,
  sanitizeFilename,
  type ResearchTeam,
} from './orchestrator.ts'

export {
  DEFAULT_MAX_PLAN_REVISIONS,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_MAX_SECTIONS,
  type DraftContent,
  type DraftState,
  type MultiAgentOptions,
  type MultiAgentResult,
  type PublishFormat,
  type PublishFormats,
  type ResearchHeaders,
  type ResearchPlan,
  type ResearchState,
  type SubtopicDraft,
  type Task,
  type WriterState,
} from './state.ts'
