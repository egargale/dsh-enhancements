/**
 * Semantic Scholar retriever — port of
 * `gpt_researcher/retrievers/semantic_scholar/semantic_scholar.py`.
 *
 * Upstream GETs {@link SEMANTIC_SCHOLAR_ENDPOINT} with
 * `{query, limit, fields, sort}` and keeps only the papers that are open access
 * **and** expose an `openAccessPdf.url`, mapping them to
 * `{title, href: openAccessPdf.url, body: abstract}`. The API needs no key for
 * this endpoint, so the retriever is keyless.
 *
 * @module gpt-researcher/retrievers/semantic_scholar
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { SearchResult } from '../types.ts'

/** Upstream `SemanticScholarSearch.BASE_URL`. */
export const SEMANTIC_SCHOLAR_ENDPOINT =
  'https://api.semanticscholar.org/graph/v1/paper/search'

/** Upstream `VALID_SORT_CRITERIA`. */
export const SEMANTIC_SCHOLAR_SORT_CRITERIA = [
  'relevance',
  'citationCount',
  'publicationDate',
] as const

/** An upstream Semantic Scholar sort criterion. */
export type SemanticScholarSort = (typeof SEMANTIC_SCHOLAR_SORT_CRITERIA)[number]

/** The `fields` list upstream requests, verbatim. */
export const SEMANTIC_SCHOLAR_FIELDS =
  'title,abstract,url,venue,year,authors,isOpenAccess,openAccessPdf'

/** Inputs of {@link buildSemanticScholarRequest}. */
export interface SemanticScholarRequestOptions {
  query: string
  maxResults: number
  /** Upstream `sort`, defaulting to `relevance`. */
  sort?: SemanticScholarSort
}

/**
 * Build the Semantic Scholar GET request.
 *
 * @param options - query, result cap, and sort criterion.
 * @returns the absolute URL and request init.
 */
export function buildSemanticScholarRequest(options: SemanticScholarRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(SEMANTIC_SCHOLAR_ENDPOINT)
  url.searchParams.set('query', options.query)
  url.searchParams.set('limit', String(options.maxResults))
  url.searchParams.set('fields', SEMANTIC_SCHOLAR_FIELDS)
  url.searchParams.set('sort', options.sort ?? 'relevance')
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Parse a Semantic Scholar response into canonical search results.
 *
 * Mirrors upstream's open-access filter: a paper without both
 * `isOpenAccess: true` and an `openAccessPdf.url` is dropped.
 *
 * @param payload - the decoded JSON body (`{data: [...]}`).
 * @returns the open-access papers, with the PDF URL as `url`.
 */
export function parseSemanticScholarResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.data) ? root.data : []
  const results: SearchResult[] = []
  for (const entry of entries) {
    const record = asRecord(entry) ?? {}
    if (record.isOpenAccess !== true) continue
    const pdf = asRecord(record.openAccessPdf)
    const pdfUrl = asString(pdf?.url)
    if (!pdfUrl) continue
    const result: SearchResult = {
      url: pdfUrl,
      title: asString(record.title),
      content: asString(record.abstract),
    }
    const venue = asString(record.venue)
    if (venue !== undefined) result.venue = venue
    const year = asNumber(record.year)
    if (year !== undefined) result.year = year
    const landingPage = asString(record.url)
    if (landingPage !== undefined) result.landing_page_url = landingPage
    results.push(result)
  }
  return results
}

/** The Semantic Scholar retriever definition. */
export const semanticScholarRetriever: RetrieverDefinition = {
  name: 'semantic_scholar',
  keys: [],
  keyless: true,
  description:
    'Semantic Scholar Graph API paper search (no key; open-access papers only).',
  create(ctx, options) {
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildSemanticScholarRequest({
          query: options.query,
          maxResults: limit,
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('semantic_scholar', response)
          return parseSemanticScholarResponse(await response.json())
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Apply the configured result cap (`limit` upstream). */
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
