/**
 * Google retriever — port of `gpt_researcher/retrievers/google/google.py`.
 *
 * Upstream uses the Custom Search JSON API: a GET to
 * {@link GOOGLE_CSE_ENDPOINT} with `key`, `cx`, `q`, and `start=1`, where `q`
 * carries an upstream-built `(site:a OR site:b) <query>` prefix when
 * `queryDomains` is set. It reads `items[*].{title,link,snippet}` and skips
 * YouTube hits.
 *
 * DEVIATION (deliberate, required by the project's keyless list): upstream
 * *requires* `GOOGLE_API_KEY` + `GOOGLE_CX_KEY` and raises without them. This
 * port keeps the CSE path as the preferred path when both are configured, but
 * falls back to scraping the public `https://www.google.com/search` HTML page
 * when they are not, which is why the registry marks it `keyless: true`. Both
 * paths are exposed as separate, individually testable helpers.
 *
 * @module gpt-researcher/retrievers/google
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { SearchResult } from '../types.ts'
import { safeDecodeUriComponent } from '../utils/text.ts'

/** Upstream Custom Search JSON API endpoint. */
export const GOOGLE_CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1'

/** The public HTML endpoint used by the keyless fallback. */
export const GOOGLE_SCRAPE_ENDPOINT = 'https://www.google.com/search'

/** Environment variable holding the Custom Search API key. */
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY'

/** Environment variable holding the Programmable Search Engine id. */
export const GOOGLE_CX_KEY_ENV = 'GOOGLE_CX_KEY'

/** Inputs of {@link buildGoogleApiRequest}. */
export interface GoogleApiRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  apiKey: string
  cxKey: string
}

/** Inputs of {@link buildGoogleScrapeRequest}. */
export interface GoogleScrapeRequestOptions {
  query: string
  maxResults: number
  queryDomains?: readonly string[]
  userAgent?: string
  /** `LANGUAGE` config value, mapped to `hl`. */
  language?: string
}

/**
 * Build the Custom Search JSON API GET request.
 *
 * @param options - query, cap, domain filter, and both credentials.
 * @returns the absolute URL and request init (`num` carries the cap).
 */
export function buildGoogleApiRequest(options: GoogleApiRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(GOOGLE_CSE_ENDPOINT)
  url.searchParams.set('key', options.apiKey)
  url.searchParams.set('cx', options.cxKey)
  url.searchParams.set('q', googleCseQuery(options.query, options.queryDomains))
  url.searchParams.set('start', '1')
  // The Custom Search JSON API rejects `num` outside 1-10 with HTTP 400, so an
  // unclamped caller limit made the retriever fail instead of returning 10.
  url.searchParams.set('num', String(Math.min(10, Math.max(1, Math.trunc(options.maxResults)))))
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Parse a Custom Search JSON response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{items: [...]}`).
 * @returns the non-YouTube results in provider order.
 */
export function parseGoogleResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const entries = Array.isArray(root?.items) ? root.items : []
  const results: SearchResult[] = []
  for (const entry of entries) {
    const record = asRecord(entry) ?? {}
    const link = asString(record.link)
    if (link !== undefined && link.includes('youtube.com')) continue
    results.push({
      url: link,
      title: asString(record.title),
      content: asString(record.snippet),
    })
  }
  return results
}

/**
 * Build the keyless HTML-scrape GET request.
 *
 * @param options - query, cap, domain filter, user agent, language.
 * @returns the absolute URL and request init.
 */
export function buildGoogleScrapeRequest(options: GoogleScrapeRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(GOOGLE_SCRAPE_ENDPOINT)
  url.searchParams.set('q', withSiteFilters(options.query, options.queryDomains))
  // The Custom Search JSON API rejects `num` outside 1-10 with HTTP 400, so an
  // unclamped caller limit made the retriever fail instead of returning 10.
  url.searchParams.set('num', String(Math.min(10, Math.max(1, Math.trunc(options.maxResults)))))
  if (options.language) url.searchParams.set('hl', options.language)
  const headers: Record<string, string> = { Accept: 'text/html' }
  if (options.userAgent) headers['User-Agent'] = options.userAgent
  return { url: url.toString(), init: { method: 'GET', headers } }
}

/**
 * Best-effort parse of Google's HTML results page.
 *
 * Google's markup is obfuscated and changes often; this parser matches the
 * long-standing `/url?q=…` redirect anchors and pairs the `VwiC3b`/`aCOpRe`
 * snippet containers with them **in document order**, so a missing snippet
 * simply yields `undefined` content rather than shifting results.
 *
 * @param html - the response body.
 * @returns one result per parsed redirect anchor.
 */
export function parseGoogleHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const anchorPattern =
    /<a\b[^>]*href="\/url\?q=([^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const target = safeDecodeUriComponent(decodeHtmlEntities(match[1] ?? ''))
    if (!target.startsWith('http')) continue
    results.push({
      url: target,
      title: cleanText(match[2] ?? '') || undefined,
      content: undefined,
    })
  }

  const snippets: string[] = []
  const snippetPattern =
    /<div\b[^>]*class="[^"]*(?:VwiC3b|aCOpRe)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(cleanText(match[1] ?? ''))
  }
  for (const [index, result] of results.entries()) {
    const snippet = snippets[index]
    if (snippet) result.content = snippet
  }
  return results
}

/** The Google retriever definition. */
export const googleRetriever: RetrieverDefinition = {
  name: 'google',
  keys: [GOOGLE_API_KEY_ENV, GOOGLE_CX_KEY_ENV],
  keyless: true,
  description:
    'Google search: Custom Search JSON API when GOOGLE_API_KEY + GOOGLE_CX_KEY are set, ' +
    'otherwise a keyless scrape of https://www.google.com/search.',
  create(ctx, options) {
    const apiKey = ctx.runtime.env(GOOGLE_API_KEY_ENV)
    const cxKey = ctx.runtime.env(GOOGLE_CX_KEY_ENV)
    const useCse = Boolean(apiKey && cxKey)

    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          if (useCse && apiKey && cxKey) {
            const request = buildGoogleApiRequest({
              query: options.query,
              maxResults: limit,
              queryDomains: options.queryDomains,
              apiKey,
              cxKey,
            })
            const response = await ctx.runtime.http(request.url, {
              ...request.init,
              signal,
            })
            ensureOk('google', response)
            return parseGoogleResponse(await response.json()).slice(0, limit)
          }
          const request = buildGoogleScrapeRequest({
            query: options.query,
            maxResults: limit,
            queryDomains: options.queryDomains,
            userAgent: ctx.config.userAgent,
            language: ctx.config.language,
          })
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('google', response)
          return parseGoogleHtml(await response.text()).slice(0, limit)
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Reproduce upstream's `(site:a OR site:b) <query>` CSE prefix. */
function googleCseQuery(query: string, domains: readonly string[] | undefined): string {
  if (!domains || domains.length === 0) return query
  return `(${domains.map((domain) => `site:${domain}`).join(' OR ')}) ${query}`
}

/** Join a query with upstream-style `site:` domain operators. */
function withSiteFilters(query: string, domains: readonly string[] | undefined): string {
  if (!domains || domains.length === 0) return query
  return `(${domains.map((domain) => `site:${domain}`).join(' OR ')}) ${query}`
}

/** Strip tags, decode entities, and collapse whitespace. */
function cleanText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Decode the small HTML entity set Google emits. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
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
