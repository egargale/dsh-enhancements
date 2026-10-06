/**
 * Brave Search retriever.
 *
 * DEVIATION: the pinned upstream checkout has **no** `brave/` retriever (the
 * `get_retriever` switch in `actions/retriever.py` has no `brave` case, and
 * `retrievers/__init__.py` exports no Brave class). This module therefore
 * implements Brave's documented Web Search API while following every
 * convention the upstream retrievers use: `BRAVE_API_KEY`, GET with query
 * parameters, `X-Subscription-Token` auth, and `site:` operators for
 * `queryDomains`.
 *
 * @module gpt-researcher/retrievers/brave
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Brave Web Search endpoint (`/res/v1/web/search`). */
export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** Environment variable holding the Brave subscription token. */
export const BRAVE_API_KEY_ENV = 'BRAVE_API_KEY'

/** Inputs of {@link buildBraveRequest}. */
export interface BraveRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
  /** Optional Brave `country` hint (e.g. `US`). */
  country?: string
  /** Optional Brave `search_lang` hint (e.g. `en`). */
  searchLang?: string
}

/**
 * Build the Brave GET request.
 *
 * Domain restrictions are expressed with the same
 * `site:a OR site:b` operator grouping the upstream Google-shaped retrievers
 * use, because Brave's Web Search API has no structured domain filter.
 *
 * @param options - query, result cap, domain filter, credential, locale hints.
 * @returns the absolute URL and request init (auth + accept headers).
 */
export function buildBraveRequest(options: BraveRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(BRAVE_ENDPOINT)
  url.searchParams.set('q', withSiteFilters(options.query, options.queryDomains))
  url.searchParams.set('count', String(options.maxResults))
  if (options.country) url.searchParams.set('country', options.country)
  if (options.searchLang) url.searchParams.set('search_lang', options.searchLang)
  return {
    url: url.toString(),
    init: {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': options.apiKey,
      },
    },
  }
}

/**
 * Parse a Brave response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{web: {results: [...]}}`).
 * @returns one result per entry, with `description` mapped to `content`.
 */
export function parseBraveResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const web = asRecord(root?.web)
  const entries = Array.isArray(web?.results) ? web.results : []
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {}
    const result: SearchResult = {
      url: asString(record.url),
      title: asString(record.title),
      content: asString(record.description),
    }
    const age = asString(record.page_age) ?? asString(record.age)
    if (age !== undefined) result.published_date = age
    return result
  })
}

/** The Brave retriever definition. */
export const braveRetriever: RetrieverDefinition = {
  name: 'brave',
  keys: [BRAVE_API_KEY_ENV],
  keyless: false,
  description: 'Brave Web Search API (GET https://api.search.brave.com/res/v1/web/search).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, 'brave', BRAVE_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildBraveRequest({
          query: options.query,
          maxResults: limit,
          queryDomains: options.queryDomains,
          apiKey,
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('brave', response)
          return parseBraveResponse(await response.json())
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

/** Apply the configured result cap (`count` upstream). */
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
