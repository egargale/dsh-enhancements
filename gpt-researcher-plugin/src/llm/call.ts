/**
 * One-shot LLM call helper: the port of `gpt_researcher/utils/llm.py`'s
 * `create_chat_completion`, reduced to what the engine actually uses.
 *
 * Every call site in upstream passes a model + provider from the config and a
 * `cost_callback`. Here the tier is passed instead, the client resolves the
 * route, and the cost is charged to the tracker with the configured step
 * attribution. Upstream's retry-with-smaller-budget dance for the strategic LLM
 * is preserved as an explicit fallback chain in `generateSubQueries`.
 *
 * @module gpt-researcher/llm/call
 */

import { messagesToText } from './chat.ts'
import type { EngineDeps } from '../deps.ts'
import type { ChatMessage, ChatResult, LlmTier } from '../types.ts'
import { chargeCompletion } from '../utils/costs.ts'

/** True for an abort, however the abort surfaced (AbortError, DOMException, reason). */
export function isAbortError(error: unknown): boolean {
  if (error == null) return false
  const candidate = error as { name?: string; code?: string; message?: string }
  if (candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR') return true
  if (candidate.code === 'ABORTED') return true
  return typeof candidate.message === 'string' && /\babort(ed)?\b/i.test(candidate.message)
}

/**
 * Throw the caller's cancellation reason when the run has been aborted.
 *
 * Cancellation must never be swallowed into a fallback path: a cancelled run
 * that keeps issuing model calls (and then reports an empty success) is worse
 * than one that stops. Every ladder in this codebase checks this first.
 *
 * @param signal - the signal to inspect.
 * @throws when the signal is aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'the run was aborted',
  )
  error.name = 'AbortError'
  throw error
}

/** One completion request in engine terms. */
export interface LlmCall {
  tier: LlmTier
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  /** Cost-attribution step, mirroring upstream `_current_step`. */
  step?: string
  signal?: AbortSignal
}

/**
 * Run one completion and charge its cost.
 *
 * @param deps - engine dependencies (llm client, cost tracker, runtime).
 * @param call - the request.
 * @returns the completion, with text and reported usage.
 */
export async function callLlm(deps: EngineDeps, call: LlmCall): Promise<ChatResult> {
  const signal = call.signal ?? deps.runtime.signal
  throwIfAborted(signal)
  if (call.step) deps.costs.setStep(call.step)
  const result = await deps.runtime.llm.complete({
    tier: call.tier,
    messages: call.messages,
    ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
    ...(call.maxTokens === undefined ? {} : { maxTokens: call.maxTokens }),
    ...(call.stop === undefined ? {} : { stop: call.stop }),
    ...(call.signal === undefined && deps.runtime.signal === undefined
      ? {}
      : { signal: call.signal ?? deps.runtime.signal }),
  })
  chargeCompletion(
    deps.costs,
    result.usage,
    messagesToText(call.messages),
    result.text,
  )
  deps.runtime.log.debug('llm completion', {
    tier: call.tier,
    model: result.model,
    chars: result.text.length,
  })
  return result
}

/**
 * Run one completion and return only its text — the common case.
 *
 * @param deps - engine dependencies.
 * @param call - the request.
 * @returns the completion text.
 */
export async function callLlmText(deps: EngineDeps, call: LlmCall): Promise<string> {
  return (await callLlm(deps, call)).text
}

/**
 * Build the two-message shape upstream uses almost everywhere: a role/system
 * prompt plus one user prompt.
 *
 * @param systemPrompt - the agent role prompt.
 * @param userPrompt - the task prompt.
 * @returns the message list.
 */
export function roleMessages(systemPrompt: string, userPrompt: string): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}
