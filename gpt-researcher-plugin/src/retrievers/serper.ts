/**
 * Serper (Google) search retriever — port of
 * `gpt_researcher/retrievers/serper/serper.py`.
 *
 * Upstream builds the query string by appending ` -site:<host>` for every
 * excluded site and ` site:a OR site:b` for every allowed domain, then POSTs
 * `{q, num, gl?, hl?, tbs?}` to Google's Serper endpoint with an `X-API-KEY`
 * header. Optional locale/time filters come from `SERPER_REGION`,
 * `SERPER_LANGUAGE`, `SERPER_TIME_RANGE`, and `SERPER_EXCLUDE_SITES`.
 *
 * @module gpt-researcher/retrievers/serper
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream Serper endpoint. */
export const SERPER_ENDPOINT = 'https://google.serper.dev/search'

/** Environment variable holding the Serper API key. */
export const SERPER_API_KEY_ENV = 'SERPER_API_KEY'

/** The JSON body upstream sends to {@link SERPER_ENDPOINT}. */
export interface SerperRequestBody {
  q: string
  num: number
  /** `SERPER_REGION` → `gl`. */
  gl?: string
  /** `SERPER_LANGUAGE` → `hl`. */
  hl?: string
  /** `SERPER_TIME_RANGE` → `tbs`. */
  tbs?: string
}

/** Inputs of {@link buildSerperRequest}. */
export interface SerperRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
  excludeSites?: readonly string[]
  country?: string
  language?: string
  timeRange?: string
}

/**
 * Build the Serper POST request.
 *
 * @param options - query, cap, domain/exclusion filters, credential, locale.
 * @returns the absolute URL and request init (JSON body + `X-API-KEY`).
 */
export function buildSerperRequest(options: SerperRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  let query = options.query
  for (const site of options.excludeSites ?? []) query += ` -site:${site}`
  const domains = options.queryDomains ?? []
  if (domains.length > 0) query += ` site:${domains.join(' OR site:')}`

  const body: SerperRequestBody = { q: query, num: options.maxResults }
  if (options.country) body.gl = options.country
  if (options.language) body.hl = options.language
  if (options.timeRange) body.tbs = options.timeRange

  return {
    url: SERPER_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': options.apiKey },
      body: JSON.stringify(body),
    },
  }
}

/**
 * Parse a Serper response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{organic: [...]}`).
 * @returns one result per `organic` entry, `link`/`snippet` normalised.
 */
export function parseSerperResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.organic) ? root.organic : []
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {}
    const result: SearchResult = {
      url: asString(record.link),
      title: asString(record.title),
      content: asString(record.snippet),
    }
    const position = asNumber(record.position)
    if (position !== undefined) result.position = position
    const date = asString(record.date)
    if (date !== undefined) result.published_date = date
    return result
  })
}

/** The Serper retriever definition. */
export const serperRetriever: RetrieverDefinition = {
  name: 'serper',
  keys: [SERPER_API_KEY_ENV],
  keyless: false,
  description:
    'Serper Google Search API (POST https://google.serper.dev/search, `X-API-KEY`). ' +
    'Optional SERPER_REGION, SERPER_LANGUAGE, SERPER_TIME_RANGE, SERPER_EXCLUDE_SITES.',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, 'serper', SERPER_API_KEY_ENV)
    const excludeSites = splitList(ctx.runtime.env('SERPER_EXCLUDE_SITES'))
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildSerperRequest({
          query: options.query,
          maxResults: limit,
          queryDomains: options.queryDomains,
          apiKey,
          excludeSites,
          country: ctx.runtime.env('SERPER_REGION'),
          language: ctx.runtime.env('SERPER_LANGUAGE'),
          timeRange: ctx.runtime.env('SERPER_TIME_RANGE'),
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('serper', response)
          return parseSerperResponse(await response.json())
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Split a comma-separated environment list, trimming and dropping blanks. */
function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** Read a required credential, naming the retriever and the variable. */
function requiredEnv(ctx: RetrieverContext, name: string, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`${name}: missing ${envVar}. Set the environment variable.`)
  }
  return value
}

/** Apply the configured result cap (`num` upstream). */
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
