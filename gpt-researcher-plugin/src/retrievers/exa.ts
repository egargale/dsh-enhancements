/**
 * Exa search retriever — port of `gpt_researcher/retrievers/exa/exa.py`.
 *
 * Upstream drives the `exa_py` SDK; the SDK's `search(...)` is a POST to
 * {@link EXA_ENDPOINT} authenticated with the `x-api-key` header and a JSON
 * body of `{query, type, useAutoprompt, numResults, includeDomains}`. This port
 * performs that request directly through the HTTP seam, so the SDK is not a
 * dependency.
 *
 * Upstream also exposes `find_similar` and `get_contents`; only `search` is
 * part of the {@link Retriever} contract, so those two are not ported.
 *
 * @module gpt-researcher/retrievers/exa
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** The Exa search endpoint used by `exa_py.Exa.search`. */
export const EXA_ENDPOINT = 'https://api.exa.ai/search'

/** Environment variable holding the Exa API key. */
export const EXA_API_KEY_ENV = 'EXA_API_KEY'

/** The JSON body upstream's SDK sends. */
export interface ExaRequestBody {
  query: string
  type: string
  useAutoprompt: boolean
  numResults: number
  /** Omitted entirely when no domain restriction was requested. */
  includeDomains?: string[]
}

/** Inputs of {@link buildExaRequest}. */
export interface ExaRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
  /** Upstream `search_type`, defaulting to `neural`. */
  searchType?: string
  /** Upstream `use_autoprompt`, defaulting to `false`. */
  useAutoprompt?: boolean
}

/**
 * Build the Exa POST request.
 *
 * @param options - query, result cap, domain filter, credential, and the two
 *   upstream search knobs.
 * @returns the absolute URL and request init (JSON body + `x-api-key`).
 */
export function buildExaRequest(options: ExaRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const domains = options.queryDomains ?? []
  const body: ExaRequestBody = {
    query: options.query,
    type: options.searchType ?? 'neural',
    useAutoprompt: options.useAutoprompt ?? false,
    numResults: options.maxResults,
  }
  if (domains.length > 0) body.includeDomains = [...domains]
  return {
    url: EXA_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': options.apiKey,
      },
      body: JSON.stringify(body),
    },
  }
}

/**
 * Parse an Exa response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{results: [...]}`).
 * @returns one result per entry, with `text` mapped to `content`.
 */
export function parseExaResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.results) ? root.results : []
  return entries.map((entry) => {
    const record = asRecord(entry) ?? {}
    const result: SearchResult = {
      url: asString(record.url),
      title: asString(record.title),
      content: asString(record.text),
    }
    const score = asNumber(record.score)
    if (score !== undefined) result.score = score
    const published = asString(record.publishedDate)
    if (published !== undefined) result.published_date = published
    const author = asString(record.author)
    if (author !== undefined) result.author = author
    return result
  })
}

/** The Exa retriever definition. */
export const exaRetriever: RetrieverDefinition = {
  name: 'exa',
  keys: [EXA_API_KEY_ENV],
  keyless: false,
  description: 'Exa neural search API (POST https://api.exa.ai/search, `x-api-key`).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, 'exa', EXA_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildExaRequest({
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
          ensureOk('exa', response)
          return parseExaResponse(await response.json())
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

/** Apply the configured result cap (`num_results` upstream). */
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
