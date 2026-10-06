/**
 * Shared engine dependencies.
 *
 * Upstream threads a `GPTResearcher` instance through every skill and action
 * (`self.researcher.cfg`, `self.researcher.prompt_family`,
 * `self.researcher.add_costs`, …). The port threads this smaller bundle
 * instead, which keeps the skills testable without constructing a whole agent.
 *
 * @module gpt-researcher/deps
 */

import type { Config } from './config.ts'
import type { PromptFamily } from './prompts.ts'
import type { Runtime } from './runtime.ts'
import type { CostTracker } from './utils/costs.ts'

/** Everything a skill or action may need. */
export interface EngineDeps {
  runtime: Runtime
  config: Config
  prompts: PromptFamily
  costs: CostTracker
}

/** A subset for helpers that only need routing and progress. */
export type ProgressDeps = Pick<EngineDeps, 'runtime'>
