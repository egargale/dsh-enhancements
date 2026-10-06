/**
 * Tavily search retriever — port of
 * `gpt_researcher/retrievers/tavily/tavily_search.py`.
 *
 * Upstream posts a JSON body (the API key travels **in the body**, not in a
 * header) and reads `results[*].{url,content,score}`. The port keeps the exact
 * endpoint, method, and payload keys; the only normalisation is that results
 * are emitted in this project's canonical `{url, title, content}` shape instead
 * of upstream's `{href, body}` spelling (both are readable through
 * `resultUrl`/`resultBody`).
 *
 * @module gpt-researcher/retrievers/tavily
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream `TavilySearch.base_url`. */
export const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

/** Environment variable holding the Tavily API key. */
export const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY'

/** The exact body upstream sends to {@link TAVILY_ENDPOINT}. */
export interface TavilyRequestBody {
  query: string
  search_depth: 'basic' | 'advanced'
  topic: string
  days: number
  include_answer: boolean
  include_raw_content: boolean
  max_results: number
  /** `include_domains`; `null` when no domain restriction was requested. */
  include_domains: string[] | null
  exclude_domains: string[] | null
  include_images: boolean
  api_key: string
  use_cache: boolean
}

/** Inputs of {@link buildTavilyRequest}. */
export interface TavilyRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
}

/**
 * Build the Tavily POST request.
 *
 * @param options - query, result cap, domain filter, and credential.
 * @returns the absolute URL and request init (JSON body).
 */
export function buildTavilyRequest(options: TavilyRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const domains = options.queryDomains ?? []
  const body: TavilyRequestBody = {
    query: options.query,
    search_depth: 'basic',
    topic: 'general',
    days: 2,
    include_answer: false,
    include_raw_content: false,
    max_results: options.maxResults,
    include_domains: domains.length > 0 ? [...domains] : null,
    exclude_domains: null,
    include_images: false,
    api_key: options.apiKey,
    use_cache: true,
  }
  return {
    url: TAVILY_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  }
}

/**
 * Parse a Tavily response into canonical search results.
 *
 * Tolerant by contract: unknown/absent fields become `undefined`, a missing
 * `results` array yields `[]`, and no valid-but-sparse payload throws.
 *
 * @param payload - the decoded JSON body.
 * @returns one result per entry of `results`.
 */
export function parseTavilyResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.results) ? root.results : []
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {}
    const result: SearchResult = {
      url: asString(record.url),
      title: asString(record.title),
      content: asString(record.content),
    }
    const score = asNumber(record.score)
    if (score !== undefined) result.score = score
    const raw = asString(record.raw_content)
    if (raw !== undefined) result.raw_content = raw
    const published = asString(record.published_date)
    if (published !== undefined) result.published_date = published
    return result
  })
}

/** The Tavily retriever definition. */
export const tavilyRetriever: RetrieverDefinition = {
  name: 'tavily',
  keys: [TAVILY_API_KEY_ENV],
  keyless: false,
  description:
    'Tavily search API (POST https://api.tavily.com/search, key in the JSON body).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, 'tavily', TAVILY_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildTavilyRequest({
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
          ensureOk('tavily', response)
          return parseTavilyResponse(await response.json())
        } finally {
          dispose()
        }
      },
    }
  },
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

/** Narrow an unknown value to a finite number. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
