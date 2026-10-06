/**
 * Retriever resolution — the port of
 * `gpt_researcher/actions/retriever.py`.
 *
 * Upstream turns the configured retriever names into classes, and every search
 * site walks that list in order. This port resolves names to registry
 * definitions up front (so a missing credential fails before any search runs)
 * and exposes the ordered list plus the per-run context.
 *
 * @module gpt-researcher/actions/retrieval
 */

import type { EngineDeps } from '../deps.ts'
import {
  RetrieverRegistry,
  type RetrieverContext,
  type RetrieverDefinition,
} from '../retrievers/base.ts'
import { retrieverContext } from './query-processing.ts'

/** The resolved retrieval setup for one research run. */
export interface ResolvedRetrievers {
  /** Definitions in configured order. */
  definitions: RetrieverDefinition[]
  /** Context every retriever is created with. */
  context: RetrieverContext
}

/**
 * Resolve the configured retrievers (upstream `get_retrievers`).
 *
 * @param deps - engine dependencies, including the run's config.
 * @param registry - the retriever registry to resolve against.
 * @param overrides - optional per-run retriever names (a tool argument).
 * @returns the ordered definitions and their shared context.
 */
export function getRetrievers(
  deps: EngineDeps,
  registry: RetrieverRegistry,
  overrides: { retrieverNames?: readonly string[]; timeoutMs?: number } = {},
): ResolvedRetrievers {
  const names = overrides.retrieverNames ?? deps.config.retrievers
  const definitions = registry.resolve(names, deps.runtime)
  return {
    definitions,
    context: retrieverContext(
      deps,
      overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs },
    ),
  }
}
