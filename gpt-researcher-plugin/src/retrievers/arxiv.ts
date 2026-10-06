/**
 * arXiv retriever — port of `gpt_researcher/retrievers/arxiv/arxiv.py`.
 *
 * Upstream uses the `arxiv` client, which issues a GET against
 * {@link ARXIV_ENDPOINT} with `search_query`, `start`, `max_results`, and
 * `sortBy`, then maps each Atom entry to
 * `{title, href: result.pdf_url, body: result.summary}`. This port performs the
 * same request through the HTTP seam and parses the Atom feed itself, so the
 * `arxiv` package is not a dependency.
 *
 * Notes: the `arxiv` client prefixes a bare query with `all:` and leaves any
 * query that already contains `:` untouched; that rule is reproduced here.
 * arXiv has no domain filter, so `queryDomains` is ignored (as upstream does).
 *
 * @module gpt-researcher/retrievers/arxiv
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { SearchResult } from '../types.ts'

/** The arXiv Atom API endpoint used by `arxiv.Client`. */
export const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query'

/** The two upstream sort criteria (`arxiv.SortCriterion`). */
export const ARXIV_SORT_CRITERIA = ['Relevance', 'SubmittedDate'] as const
/** An upstream arXiv sort criterion. */
export type ArxivSortCriterion = (typeof ARXIV_SORT_CRITERIA)[number]

/** Inputs of {@link buildArxivRequest}. */
export interface ArxivRequestOptions {
  query: string
  maxResults: number
  /** Upstream `sort`, defaulting to `Relevance`. */
  sort?: ArxivSortCriterion
}

/**
 * Build the arXiv GET request.
 *
 * @param options - query, result cap, and sort criterion.
 * @returns the absolute URL and request init.
 */
export function buildArxivRequest(options: ArxivRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(ARXIV_ENDPOINT)
  url.searchParams.set('search_query', arxivQuery(options.query))
  url.searchParams.set('start', '0')
  url.searchParams.set('max_results', String(options.maxResults))
  url.searchParams.set(
    'sortBy',
    options.sort === 'SubmittedDate' ? 'submittedDate' : 'relevance',
  )
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Parse an arXiv Atom feed into canonical search results.
 *
 * @param xml - the Atom response body.
 * @returns one result per `<entry>`, `href` set to the PDF URL and `content` to
 *   the abstract.
 */
export function parseArxivFeed(xml: string): SearchResult[] {
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? []
  return entries.map((entry) => {
    const id = firstTagText(entry, 'id')
    const pdfLink = pdfLinkFromEntry(entry)
    return {
      url: pdfLink ?? derivePdfUrl(id),
      title: firstTagText(entry, 'title'),
      content: firstTagText(entry, 'summary'),
    }
  })
}

/** The arXiv retriever definition. */
export const arxivRetriever: RetrieverDefinition = {
  name: 'arxiv',
  keys: [],
  keyless: true,
  description: 'arXiv Atom API (no API key; GET https://export.arxiv.org/api/query).',
  create(ctx, options) {
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildArxivRequest({ query: options.query, maxResults: limit })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('arxiv', response)
          return parseArxivFeed(await response.text())
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Reproduce `arxiv.Search.query`: prefix a bare query with `all:`. */
function arxivQuery(query: string): string {
  return query.includes(':') ? query : `all:${query}`
}

/** Read the text of the first matching tag, whitespace-collapsed. */
function firstTagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  if (!match) return undefined
  return decodeXmlEntities(stripTags(match[1] ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Read the `<link title="pdf">` target when the feed provides one. */
function pdfLinkFromEntry(entry: string): string | undefined {
  const links = entry.match(/<link\b[^>]*\/?>/gi) ?? []
  for (const link of links) {
    if (!/title\s*=\s*"pdf"/i.test(link)) continue
    const href = /href\s*=\s*"([^"]*)"/i.exec(link)
    if (href?.[1]) return href[1]
  }
  return undefined
}

/** Derive the PDF URL from an `<id>` such as `http://arxiv.org/abs/2401.12345v1`. */
function derivePdfUrl(id: string | undefined): string | undefined {
  if (!id) return undefined
  return id.includes('/abs/') ? id.replace('/abs/', '/pdf/') : id
}

/** Strip XML tags. */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ')
}

/** Decode the XML entities arXiv emits. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
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
