/**
 * Query processing — the port of
 * `gpt_researcher/actions/query_processing.py` (plus the retriever-side part of
 * `actions/retriever.py`).
 *
 * The flow upstream is: run the raw query through the first retriever, hand the
 * hits to the strategic model, and ask for sub-queries that close the gaps. The
 * port keeps the three-step retry ladder for the strategic call because it is a
 * real, observed failure mode (the strategic model rejecting a
 * `max_tokens: None` request).
 *
 * @module gpt-researcher/actions/query-processing
 */

import type { EngineDeps } from '../deps.ts'
import type { RetrieverContext } from '../retrievers/base.ts'
import type { Retriever, RetrieverDefinition } from '../retrievers/base.ts'
import { callLlm, isAbortError } from '../llm/call.ts'
import { parseStringList } from '../utils/json.ts'
import { sanitizeDomainFilter } from '../utils/url-policy.ts'
import type { SearchResult } from '../types.ts'

/**
 * Run one retriever (upstream `get_search_results`).
 *
 * @param definition - the retriever to run.
 * @param ctx - injected runtime + retriever config.
 * @param query - the search query.
 * @param options - domain filter, result cap, cancellation.
 * @returns raw search results.
 */
export async function getSearchResults(
  definition: RetrieverDefinition,
  ctx: RetrieverContext,
  query: string,
  options: {
    queryDomains?: string[]
    maxResults?: number
    signal?: AbortSignal
  } = {},
): Promise<SearchResult[]> {
  // Domain filters are interpolated into provider query syntax as
  // `site:${domain}` (optionally joined by OR), so anything that is not a plain
  // hostname is dropped here rather than being allowed to rewrite the search.
  const queryDomains = (options.queryDomains ?? [])
    .map((domain) => sanitizeDomainFilter(domain))
    .filter((domain): domain is string => domain !== undefined)
  const dropped = (options.queryDomains ?? []).length - queryDomains.length
  if (dropped > 0) {
    ctx.runtime.log.warn(
      `ignored ${dropped} query_domains entr${dropped === 1 ? 'y' : 'ies'} that ${dropped === 1 ? 'is' : 'are'} not a plain hostname`,
    )
  }
  const retriever: Retriever = definition.create(ctx, {
    query,
    queryDomains,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return retriever.search(options.maxResults ?? ctx.config.maxSearchResultsPerQuery)
}

/**
 * Generate research sub-queries from the initial search context (upstream
 * `generate_sub_queries`), including its strategic→smart fallback ladder.
 *
 * @param deps - engine dependencies.
 * @param params - query, parent query, report type, and the initial context.
 * @returns the sub-queries, or an empty list when the model produced nothing
 *   usable (callers then fall back to the original query alone).
 */
export async function generateSubQueries(
  deps: EngineDeps,
  params: {
    query: string
    parentQuery: string
    reportType: string
    context: readonly SearchResult[]
  },
): Promise<string[]> {
  const prompt = deps.prompts.generate_search_queries_prompt(
    params.query,
    params.parentQuery,
    params.reportType,
    {
      max_iterations: deps.config.maxIterations || 3,
      context: params.context,
    },
  )
  const messages = [{ role: 'user' as const, content: prompt }]

  // Ladder 1: strategic model with no explicit token cap (upstream default).
  try {
    const response = await callLlm(deps, {
      tier: 'strategic',
      messages,
      step: 'query_planning',
      signal: deps.runtime.signal,
    })
    const queries = parseStringList(response.text)
    if (queries.length > 0) return queries
    deps.runtime.log.warn('strategic query planning returned no queries; retrying with a token cap')
  } catch (error) {
    if (isAbortError(error) || deps.runtime.signal?.aborted) throw error
    deps.runtime.log.warn(
      `strategic query planning failed: ${error instanceof Error ? error.message : String(error)}; retrying with a token cap`,
    )
  }

  // Ladder 2: strategic model with the configured strategic token limit.
  try {
    const response = await callLlm(deps, {
      tier: 'strategic',
      messages,
      maxTokens: deps.config.strategicTokenLimit,
      step: 'query_planning',
      signal: deps.runtime.signal,
    })
    const queries = parseStringList(response.text)
    if (queries.length > 0) return queries
  } catch (error) {
    if (isAbortError(error) || deps.runtime.signal?.aborted) throw error
    deps.runtime.log.warn(
      `strategic query planning retry failed: ${error instanceof Error ? error.message : String(error)}; falling back to the smart model`,
    )
  }

  // Ladder 3: smart model at the configured temperature.
  try {
    const response = await callLlm(deps, {
      tier: 'smart',
      messages,
      temperature: deps.config.temperature,
      maxTokens: deps.config.smartTokenLimit,
      step: 'query_planning',
      signal: deps.runtime.signal,
    })
    return parseStringList(response.text)
  } catch (error) {
    if (isAbortError(error) || deps.runtime.signal?.aborted) throw error
    deps.runtime.log.warn(
      `query planning failed entirely: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

/**
 * Plan the research outline (upstream `plan_research_outline`).
 *
 * @param deps - engine dependencies.
 * @param params - query, parent query, report type, initial results, retriever names.
 * @returns the sub-queries to research.
 */
export async function planResearchOutline(
  deps: EngineDeps,
  params: {
    query: string
    parentQuery: string
    reportType: string
    searchResults: readonly SearchResult[]
    retrieverNames: readonly string[]
  },
): Promise<string[]> {
  // Upstream: an MCP-only retriever setup skips sub-query generation entirely.
  const mcpOnly =
    params.retrieverNames.length === 1 &&
    params.retrieverNames.some((name) => name.toLowerCase().includes('mcp'))
  if (mcpOnly) {
    deps.runtime.log.info('MCP-only retrieval: skipping sub-query generation')
    return [params.query]
  }

  return generateSubQueries(deps, {
    query: params.query,
    parentQuery: params.parentQuery,
    reportType: params.reportType,
    context: params.searchResults,
  })
}

/**
 * Build a retriever context from engine deps (upstream constructs retrievers
 * with `cfg` + `headers`; here the config surface is narrowed).
 *
 * @param deps - engine dependencies.
 * @param overrides - per-run overrides (e.g. a shorter timeout in tests).
 * @returns the retriever context.
 */
export function retrieverContext(
  deps: EngineDeps,
  overrides: { timeoutMs?: number } = {},
): RetrieverContext {
  return {
    runtime: deps.runtime,
    config: {
      maxSearchResultsPerQuery: deps.config.maxSearchResultsPerQuery,
      userAgent: deps.config.userAgent,
      timeoutMs: overrides.timeoutMs ?? deps.config.timeoutMs,
      language: deps.config.language,
    },
  }
}
