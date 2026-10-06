/**
 * SearchApi.io retriever — port of
 * `gpt_researcher/retrievers/searchapi/searchapi.py`.
 *
 * Upstream GETs `https://www.searchapi.io/api/v1/search` with `?q=…&engine=google`,
 * a Bearer token, and the `X-SearchApi-Source: gpt-researcher` attribution
 * header, then reads `organic_results[*].{title,link,snippet}`, skipping
 * YouTube hits and stopping at `max_results`.
 *
 * DEVIATION: upstream accepts `query_domains` but never applies it. This port
 * appends the same ` site:a OR site:b` operator grouping the other
 * Google-shaped retrievers use, so the domain filter is not silently dropped.
 *
 * @module gpt-researcher/retrievers/searchapi
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream SearchApi endpoint. */
export const SEARCHAPI_ENDPOINT = 'https://www.searchapi.io/api/v1/search'

/** Environment variable holding the SearchApi key. */
export const SEARCHAPI_API_KEY_ENV = 'SEARCHAPI_API_KEY'

/** Inputs of {@link buildSearchApiRequest}. */
export interface SearchApiRequestOptions {
  query: string
  queryDomains?: readonly string[]
  apiKey: string
  /** Upstream always sends `engine=google`. */
  engine?: string
}

/**
 * Build the SearchApi GET request.
 *
 * @param options - query, domain filter, credential, engine.
 * @returns the absolute URL (query in the query string) and request init.
 */
export function buildSearchApiRequest(options: SearchApiRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(SEARCHAPI_ENDPOINT)
  url.searchParams.set('q', withSiteFilters(options.query, options.queryDomains))
  url.searchParams.set('engine', options.engine ?? 'google')
  return {
    url: url.toString(),
    init: {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
        'X-SearchApi-Source': 'gpt-researcher',
      },
    },
  }
}

/**
 * Parse a SearchApi response into canonical search results.
 *
 * Mirrors upstream's YouTube skip; the caller applies the result cap.
 *
 * @param payload - the decoded JSON body (`{organic_results: [...]}`).
 * @returns the non-YouTube results in provider order.
 */
export function parseSearchApiResponse(payload: unknown): SearchResult[] {
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

/** The SearchApi retriever definition. */
export const searchApiRetriever: RetrieverDefinition = {
  name: 'searchapi',
  keys: [SEARCHAPI_API_KEY_ENV],
  keyless: false,
  description: 'SearchApi.io Google engine (GET https://www.searchapi.io/api/v1/search).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, 'searchapi', SEARCHAPI_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildSearchApiRequest({
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
          ensureOk('searchapi', response)
          return parseSearchApiResponse(await response.json()).slice(0, limit)
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Join a query with upstream-style `site:` domain operators. */
function withSiteFilters(query: string, domains: readonly string[] | undefined): string {
  if (!domains || domains.length === 0) return query
  return `(${domains.map((domain) => `site:${domain}`).join(' OR ')}) ${query}`
}

/** Read a required credential, naming the retriever and the variable. */
function requiredEnv(ctx: RetrieverContext, name: string, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`${name}: missing ${envVar}. Set the environment variable.`)
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
