/**
 * Bing Web Search retriever — port of `gpt_researcher/retrievers/bing/bing.py`.
 *
 * Upstream GETs {@link BING_ENDPOINT} with the `Ocp-Apim-Subscription-Key`
 * header and the exact parameter set
 * `{responseFilter:'Webpages', q, count, setLang:'en-GB', textDecorations:false,
 * textFormat:'HTML', safeSearch:'Strict'}`, then reads
 * `webPages.value[*].{name,url,snippet}`, skipping YouTube hits.
 *
 * DEVIATION: upstream carries `query_domains` with a `TODO`; this port appends a
 * `site:` operator group to `q` so the filter is applied.
 *
 * @module gpt-researcher/retrievers/bing
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream Bing endpoint. */
export const BING_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search'

/** Environment variable holding the Bing subscription key. */
export const BING_API_KEY_ENV = 'BING_API_KEY'

/** Inputs of {@link buildBingRequest}. */
export interface BingRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
  /** Upstream hard-codes `en-GB`. */
  setLang?: string
}

/**
 * Build the Bing GET request.
 *
 * @param options - query, cap, domain filter, credential, language.
 * @returns the absolute URL (with upstream's parameter set) and request init.
 */
export function buildBingRequest(options: BingRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(BING_ENDPOINT)
  url.searchParams.set('responseFilter', 'Webpages')
  url.searchParams.set('q', withSiteFilters(options.query, options.queryDomains))
  url.searchParams.set('count', String(options.maxResults))
  url.searchParams.set('setLang', options.setLang ?? 'en-GB')
  url.searchParams.set('textDecorations', 'false')
  url.searchParams.set('textFormat', 'HTML')
  url.searchParams.set('safeSearch', 'Strict')
  return {
    url: url.toString(),
    init: {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': options.apiKey,
        'Content-Type': 'application/json',
      },
    },
  }
}

/**
 * Parse a Bing response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{webPages:{value:[...]}}`).
 * @returns the non-YouTube results in provider order.
 */
export function parseBingResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const webPages = asRecord(root?.webPages)
  const entries = Array.isArray(webPages?.value) ? webPages.value : []
  const results: SearchResult[] = []
  for (const entry of entries) {
    const record = asRecord(entry) ?? {}
    const link = asString(record.url)
    if (link !== undefined && link.includes('youtube.com')) continue
    results.push({
      url: link,
      title: asString(record.name),
      content: asString(record.snippet),
    })
  }
  return results
}

/** The Bing retriever definition. */
export const bingRetriever: RetrieverDefinition = {
  name: 'bing',
  keys: [BING_API_KEY_ENV],
  keyless: false,
  description:
    'Bing Web Search v7 (GET https://api.bing.microsoft.com/v7.0/search, ' +
    '`Ocp-Apim-Subscription-Key`).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, BING_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildBingRequest({
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
          ensureOk('bing', response)
          return parseBingResponse(await response.json())
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
    throw new RetrieverError(`bing: missing ${envVar}. Set the environment variable.`)
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
