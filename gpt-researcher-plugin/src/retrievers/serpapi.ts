/**
 * SerpApi retriever — port of `gpt_researcher/retrievers/serpapi/serpapi.py`.
 *
 * Upstream GETs `https://serpapi.com/search.json` with `{q, api_key}`, appending
 * ` site:a OR site:b` for every allowed domain, then reads
 * `organic_results[*].{title,link,snippet}`, skipping YouTube hits and stopping
 * at `max_results`. As upstream does, the result cap is applied client-side
 * (no `num` parameter is sent).
 *
 * @module gpt-researcher/retrievers/serpapi
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream SerpApi endpoint. */
export const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json'

/** Environment variable holding the SerpApi key. */
export const SERPAPI_API_KEY_ENV = 'SERPAPI_API_KEY'

/** Inputs of {@link buildSerpApiRequest}. */
export interface SerpApiRequestOptions {
  query: string
  queryDomains?: readonly string[]
  apiKey: string
}

/**
 * Build the SerpApi GET request.
 *
 * @param options - query, domain filter, and credential.
 * @returns the absolute URL and request init.
 */
export function buildSerpApiRequest(options: SerpApiRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(SERPAPI_ENDPOINT)
  let query = options.query
  const domains = options.queryDomains ?? []
  if (domains.length > 0) query += ` site:${domains.join(' OR site:')}`
  url.searchParams.set('q', query)
  url.searchParams.set('api_key', options.apiKey)
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Parse a SerpApi response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{organic_results: [...]}`).
 * @returns the non-YouTube results in provider order.
 */
export function parseSerpApiResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.organic_results) ? root.organic_results : []
  const results: SearchResult[] = []
  for (const entry of entries) {
    const record = asRecord(entry) ?? {}
    const link = asString(record.link)
    if (link !== undefined && link.includes('youtube.com')) continue
    results.push({
      url: link,
      title: asString(record.title),
      content: asString(record.snippet),
    })
  }
  return results
}

/** The SerpApi retriever definition. */
export const serpApiRetriever: RetrieverDefinition = {
  name: 'serpapi',
  keys: [SERPAPI_API_KEY_ENV],
  keyless: false,
  description: 'SerpApi Google search (GET https://serpapi.com/search.json, `api_key`).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, SERPAPI_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildSerpApiRequest({
          query: options.query,
          queryDomains: options.queryDomains,
          apiKey,
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('serpapi', response)
          return parseSerpApiResponse(await response.json()).slice(0, limit)
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Read a required credential, naming the retriever and the variable. */
function requiredEnv(ctx: RetrieverContext, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`serpapi: missing ${envVar}. Set the environment variable.`)
  }
  return value
}

/** Apply the configured result cap (`max_results` upstream). */
function resolveLimit(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback
  return Math.max(0, Math.floor(requested))
}

/** Throw a {@link RetrieverError} for a non-2xx response. */
function ensureOk(name: string, response: HttpResponse): void {
  if (!response.ok) {
    throw new RetrieverError(`${name}: search request failed with status ${response.status}`)
  }
}

/** Narrow an unknown value to a non-array record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Narrow an unknown value to a string. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
