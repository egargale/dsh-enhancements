/**
 * BoCha search retriever — port of `gpt_researcher/retrievers/bocha/bocha.py`.
 *
 * Upstream POSTs `{query, freshness:'noLimit', summary:true, count}` to
 * {@link BOCHA_ENDPOINT} with a Bearer token and reads
 * `data.webPages.value[*].{name,url,snippet}`.
 *
 * DEVIATION: upstream accepts `query_domains` but never applies it; this port
 * appends a `site:` operator group to the query so the filter is not dropped.
 *
 * @module gpt-researcher/retrievers/bocha
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream BoCha endpoint. */
export const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

/** Environment variable holding the BoCha API key. */
export const BOCHA_API_KEY_ENV = 'BOCHA_API_KEY'

/** The exact body upstream sends to {@link BOCHA_ENDPOINT}. */
export interface BochaRequestBody {
  query: string
  freshness: string
  summary: boolean
  count: number
}

/** Inputs of {@link buildBochaRequest}. */
export interface BochaRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
}

/**
 * Build the BoCha POST request.
 *
 * @param options - query, result cap, domain filter, and credential.
 * @returns the absolute URL and request init (JSON body + Bearer token).
 */
export function buildBochaRequest(options: BochaRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const body: BochaRequestBody = {
    query: withSiteFilters(options.query, options.queryDomains),
    freshness: 'noLimit',
    summary: true,
    count: options.maxResults,
  }
  return {
    url: BOCHA_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  }
}

/**
 * Parse a BoCha response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{data:{webPages:{value:[...]}}}`).
 * @returns one result per `value` entry.
 */
export function parseBochaResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const data = asRecord(root?.data)
  const webPages = asRecord(data?.webPages)
  const entries = Array.isArray(webPages?.value) ? webPages.value : []
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {}
    return {
      url: asString(record.url),
      title: asString(record.name),
      content: asString(record.snippet),
    }
  })
}

/** The BoCha retriever definition. */
export const bochaRetriever: RetrieverDefinition = {
  name: 'bocha',
  keys: [BOCHA_API_KEY_ENV],
  keyless: false,
  description: 'BoCha web search API (POST https://api.bochaai.com/v1/web-search).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, BOCHA_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildBochaRequest({
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
          ensureOk('bocha', response)
          return parseBochaResponse(await response.json())
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
function requiredEnv(ctx: RetrieverContext, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`bocha: missing ${envVar}. Set the environment variable.`)
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
