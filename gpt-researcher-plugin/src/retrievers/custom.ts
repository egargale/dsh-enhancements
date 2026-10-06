/**
 * Custom retriever — port of `gpt_researcher/retrievers/custom/custom.py`.
 *
 * Upstream reads `RETRIEVER_ENDPOINT`, collects every `RETRIEVER_ARG_*`
 * environment variable into query parameters, GETs the endpoint with
 * `{...params, query}`, and returns the JSON body verbatim (documented as a list
 * of `{url, raw_content}` objects).
 *
 * DEVIATIONS:
 * - Upstream enumerates `RETRIEVER_ARG_*` from the process environment. The
 *   injected `env(name)` seam can only look up known names, so extra parameters
 *   come from one JSON object in `RETRIEVER_ARG_JSON` (`{"engine":"google"}`).
 * - `max_results` is documented upstream as unused; this port honours the
 *   project's result-cap rule by slicing the response.
 * - A non-2xx response throws instead of returning `None`, per the project's
 *   error contract.
 *
 * @module gpt-researcher/retrievers/custom
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Environment variable holding the custom endpoint URL. */
export const RETRIEVER_ENDPOINT_ENV = 'RETRIEVER_ENDPOINT'

/** JSON object of extra query parameters (upstream `RETRIEVER_ARG_*`). */
export const RETRIEVER_ARG_JSON_ENV = 'RETRIEVER_ARG_JSON'

/** Inputs of {@link buildCustomRequest}. */
export interface CustomRequestOptions {
  endpoint: string
  query: string
  /** Extra query parameters, merged before `query` (upstream ordering). */
  params?: Readonly<Record<string, string>>
}

/**
 * Build the custom GET request.
 *
 * @param options - endpoint URL, query, and extra parameters.
 * @returns the absolute URL and request init.
 */
export function buildCustomRequest(options: CustomRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(options.endpoint)
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('query', options.query)
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Normalise the custom endpoint's JSON body.
 *
 * Accepts a bare array, `{results: [...]}`, or `{data: [...]}`. Each entry is
 * copied verbatim (unknown provider keys are preserved) and then given the
 * canonical `url`/`title`/`content` keys where it has a recognised spelling.
 *
 * @param payload - the decoded JSON body.
 * @param maxResults - result cap.
 * @returns the normalised results.
 */
export function parseCustomResponse(payload: unknown, maxResults = 5): SearchResult[] {
  const entries = Array.isArray(payload)
    ? payload
    : (() => {
        const root = asRecord(payload)
        if (Array.isArray(root?.results)) return root.results
        if (Array.isArray(root?.data)) return root.data
        return []
      })()

  return entries.slice(0, maxResults).map((entry) => {
    const record = asRecord(entry) ?? {}
    const result: SearchResult = {}
    for (const [key, value] of Object.entries(record)) result[key] = value
    result.url = asString(record.url) ?? asString(record.href)
    result.title = asString(record.title)
    result.content =
      asString(record.content) ?? asString(record.body) ?? asString(record.raw_content)
    const raw = asString(record.raw_content)
    if (raw !== undefined) result.raw_content = raw
    return result
  })
}

/** The custom retriever definition. */
export const customRetriever: RetrieverDefinition = {
  name: 'custom',
  keys: [RETRIEVER_ENDPOINT_ENV],
  keyless: false,
  description:
    `Custom JSON search endpoint from ${RETRIEVER_ENDPOINT_ENV} ` +
    `(optional extra params in ${RETRIEVER_ARG_JSON_ENV}).`,
  create(ctx, options) {
    const endpoint = requiredEnv(ctx, RETRIEVER_ENDPOINT_ENV)
    const params = readArgJson(ctx)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildCustomRequest({ endpoint, query: options.query, params })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('custom', response)
          return parseCustomResponse(await response.json(), limit)
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Read and validate the optional `RETRIEVER_ARG_JSON` parameter object. */
function readArgJson(ctx: RetrieverContext): Record<string, string> {
  const raw = ctx.runtime.env(RETRIEVER_ARG_JSON_ENV)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RetrieverError(
      `custom: ${RETRIEVER_ARG_JSON_ENV} must be a JSON object of query parameters.`,
    )
  }
  const record = asRecord(parsed)
  if (!record) {
    throw new RetrieverError(
      `custom: ${RETRIEVER_ARG_JSON_ENV} must be a JSON object of query parameters.`,
    )
  }
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') params[key.toLowerCase()] = value
  }
  return params
}

/** Read a required credential, naming the retriever and the variable. */
function requiredEnv(ctx: RetrieverContext, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`custom: missing ${envVar}. Set the environment variable.`)
  }
  return value
}

/** Apply the configured result cap (upstream ignores `max_results`). */
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
