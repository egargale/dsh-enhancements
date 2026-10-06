/**
 * Agent selection — the port of `gpt_researcher/actions/agent_creator.py`.
 *
 * Upstream asks the smart model to pick a domain expert (e.g. "Finance Agent")
 * and returns its role prompt; on any failure it falls back to a default
 * critical-thinker role. Both behaviours are preserved, including the
 * prose-wrapped-JSON recovery.
 *
 * @module gpt-researcher/actions/agent-creator
 */

import type { EngineDeps } from '../deps.ts'
import { callLlm, isAbortError } from '../llm/call.ts'
import { parseAgentChoice } from '../utils/json.ts'

/** The resolved agent, mirroring upstream's `(agent, role)` tuple. */
export interface AgentChoice {
  /** Agent name, e.g. `Default Agent`. */
  server: string
  /** The role prompt used as the system message for later calls. */
  agentRolePrompt: string
  /** True when the model output could not be used and the default was applied. */
  fallback: boolean
}

/**
 * Choose the research agent for a query (upstream `choose_agent`).
 *
 * @param deps - engine dependencies.
 * @param params.query - the (sub-)query to characterise.
 * @param params.parentQuery - parent query, when researching a subtopic.
 * @returns the chosen agent and role prompt.
 */
export async function chooseAgent(
  deps: EngineDeps,
  params: { query: string; parentQuery?: string },
): Promise<AgentChoice> {
  if (deps.config.agentRole) {
    return { server: 'Custom Agent', agentRolePrompt: deps.config.agentRole, fallback: false }
  }

  const query = params.parentQuery
    ? `${params.parentQuery} - ${params.query}`
    : params.query

  try {
    const response = await callLlm(deps, {
      tier: 'smart',
      messages: [
        { role: 'system', content: deps.prompts.auto_agent_instructions() },
        { role: 'user', content: `task: ${query}` },
      ],
      temperature: 0.15,
      step: 'agent_selection',
    })
    const choice = parseAgentChoice(response.text)
    deps.runtime.log.debug('agent selected', { server: choice.server, fallback: choice.fallback })
    return choice
  } catch (error) {
    if (isAbortError(error) || deps.runtime.signal?.aborted) throw error
    deps.runtime.log.warn(
      `agent selection failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return parseAgentChoice(undefined)
  }
}
