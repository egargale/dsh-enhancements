/**
 * SearxNG retriever — port of `gpt_researcher/retrievers/searx/searx.py`.
 *
 * Upstream reads `SEARX_URL`, joins `search` onto it, sends
 * `?q=…&format=json` with `Accept: application/json`, requires the instance's
 * JSON output format to be enabled, and slices `results` to `max_results`.
 *
 * DEVIATIONS (both required by this project's contract):
 * - `SEARX_URL` is optional: the retriever is registered as keyless and falls
 *   back to {@link DEFAULT_SEARX_URL}, because public instances need no key.
 *   Set `SEARX_URL` for a reliable deployment (many instances disable
 *   `format=json` by default).
 * - `queryDomains` is applied as a `site:` operator group; upstream carries the
 *   argument but has a `TODO` for it.
 *
 * @module gpt-researcher/retrievers/searx
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { SearchResult } from '../types.ts'

/** Environment variable holding the SearxNG instance base URL. */
export const SEARX_URL_ENV = 'SEARX_URL'

/** Fallback instance used when `SEARX_URL` is not configured. */
export const DEFAULT_SEARX_URL = 'https://searx.be/'

/** Inputs of {@link buildSearxRequest}. */
export interface SearxRequestOptions {
  query: string
  queryDomains?: readonly string[]
  /** Instance base URL; a trailing slash is added when missing. */
  baseUrl?: string
}

/**
 * Build the SearxNG GET request.
 *
 * @param options - query, domain filter, and instance base URL.
 * @returns the absolute URL and request init.
 */
export function buildSearxRequest(options: SearxRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const base = options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : DEFAULT_SEARX_URL
  const url = new URL('search', base.endsWith('/') ? base : `${base}/`)
  url.searchParams.set('q', withSiteFilters(options.query, options.queryDomains))
  url.searchParams.set('format', 'json')
  return {
    url: url.toString(),
    init: { method: 'GET', headers: { Accept: 'application/json' } },
  }
}

/**
 * Parse a SearxNG response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{results: [...]}`).
 * @returns one result per entry, `content` mapped to `content`.
 */
export function parseSearxResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.results) ? root.results : []
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {}
    return {
      url: asString(record.url),
      title: asString(record.title),
      content: asString(record.content),
    }
  })
}

/** The SearxNG retriever definition. */
export const searxRetriever: RetrieverDefinition = {
  name: 'searx',
  keys: [],
  keyless: true,
  description:
    'SearxNG instance search using the JSON output format; set SEARX_URL (default ' +
    `${DEFAULT_SEARX_URL}), which must have \`format: json\` enabled.`,
  create(ctx, options) {
    const baseUrl = ctx.runtime.env(SEARX_URL_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildSearxRequest({
          query: options.query,
          queryDomains: options.queryDomains,
          baseUrl,
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('searx', response)
          return parseSearxResponse(await response.json()).slice(0, limit)
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
