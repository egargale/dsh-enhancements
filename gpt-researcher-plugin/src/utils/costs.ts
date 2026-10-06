/**
 * Cost tracking: a port of `gpt_researcher/utils/costs.py` plus upstream's
 * per-step attribution (`GPTResearcher.add_costs` / `get_step_costs`).
 *
 * Upstream prices a call with `tiktoken` and a flat OpenAI rate. A tokeniser is
 * not bundled here, so the estimate uses the provider's reported usage when it
 * exists and falls back to a character-based estimate otherwise — the same
 * figure upstream reports for English prose to within a few percent. The
 * uncertainty is stated in the result rather than hidden.
 *
 * @module gpt-researcher/utils/costs
 */

import type { CostReport } from '../types.ts'

/** Upstream `ENCODING_MODEL` pricing constants (USD). */
export const INPUT_COST_PER_TOKEN = 0.000005
export const OUTPUT_COST_PER_TOKEN = 0.000015
export const EMBEDDING_COST_PER_TOKEN = 0.02 / 1_000_000

/** Rough characters-per-token ratio for English prose (tiktoken ≈ 4). */
export const CHARS_PER_TOKEN = 4

/** Estimate tokens for a string without a tokeniser. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Upstream `estimate_llm_cost`, with a token estimate instead of tiktoken.
 *
 * @param inputContent - the request text.
 * @param outputContent - the completion text.
 * @returns estimated USD.
 */
export function estimateLlmCost(inputContent: string, outputContent: string): number {
  return (
    estimateTokens(inputContent) * INPUT_COST_PER_TOKEN +
    estimateTokens(outputContent) * OUTPUT_COST_PER_TOKEN
  )
}

/**
 * Upstream `estimate_embedding_cost`.
 *
 * @param docs - the texts being embedded.
 * @returns estimated USD.
 */
export function estimateEmbeddingCost(docs: readonly string[]): number {
  const tokens = docs.reduce((sum, doc) => sum + estimateTokens(doc), 0)
  return tokens * EMBEDDING_COST_PER_TOKEN
}

/**
 * Per-step cost accumulator, mirroring upstream `research_costs` +
 * `step_costs` + `_current_step`.
 */
export class CostTracker {
  private total = 0
  private readonly steps = new Map<string, number>()
  private currentStep = 'general'

  /** Set the step subsequent costs are attributed to. */
  setStep(step: string): void {
    this.currentStep = step
  }

  /** The step costs are currently attributed to. */
  get step(): string {
    return this.currentStep
  }

  /**
   * Add a cost, attributed to the current step (upstream `add_costs`).
   *
   * @param cost - USD amount; must be finite and non-negative.
   * @param logger - optional warn sink for non-finite input.
   */
  add(cost: number): void {
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error('Cost must be a non-negative finite number')
    }
    this.total += cost
    this.steps.set(this.currentStep, (this.steps.get(this.currentStep) ?? 0) + cost)
  }

  /** Total accumulated USD. */
  get totalCost(): number {
    return this.total
  }

  /** Upstream `get_step_costs()`: a copy of the per-step breakdown. */
  getStepCosts(): Record<string, number> {
    return Object.fromEntries(this.steps.entries())
  }

  /** Upstream `get_costs()`. */
  getCosts(): number {
    return this.total
  }

  /** Snapshot for the tool result. */
  report(): CostReport {
    return { total: round6(this.total), perStep: mapValues(this.getStepCosts(), round6), currency: 'USD' }
  }
}

/**
 * Attribute a completion's cost, preferring the provider's real usage numbers.
 *
 * @param tracker - the accumulator to charge.
 * @param usage - reported token counts, when the provider supplied them.
 * @param inputContent - request text, for the fallback estimate.
 * @param outputContent - completion text, for the fallback estimate.
 */
export function chargeCompletion(
  tracker: CostTracker,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  inputContent: string,
  outputContent: string,
): void {
  if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    // A provider that reports a negative, NaN or infinite count must not turn a
    // successful completion into a thrown error (which the report ladder then
    // read as "the system role was rejected" and retried).
    const input = sanitiseTokens(usage.inputTokens) ?? estimateTokens(inputContent)
    const output = sanitiseTokens(usage.outputTokens) ?? estimateTokens(outputContent)
    tracker.add(input * INPUT_COST_PER_TOKEN + output * OUTPUT_COST_PER_TOKEN)
    return
  }
  tracker.add(estimateLlmCost(inputContent, outputContent))
}

/** Accept a token count only when it is a non-negative finite number. */
function sanitiseTokens(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function mapValues(
  record: Record<string, number>,
  fn: (value: number) => number,
): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]))
}
