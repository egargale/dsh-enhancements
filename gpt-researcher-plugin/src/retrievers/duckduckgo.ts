/**
 * DuckDuckGo retriever — port of
 * `gpt_researcher/retrievers/duckduckgo/duckduckgo.py`.
 *
 * Upstream calls `ddgs.DDGS().text(query, region='wt-wt', max_results=n)`, which
 * scrapes DuckDuckGo's HTML endpoint (no API key). This port talks to the same
 * endpoint ({@link DUCKDUCKGO_ENDPOINT}) through the HTTP seam and parses the
 * result anchors itself, so `ddgs` is not a dependency and the parse is
 * unit-testable.
 *
 * DEVIATIONS:
 * - `queryDomains` is applied as a `site:` operator group; upstream carries the
 *   argument with a `TODO`.
 * - The HTML endpoint has no result-count parameter, so `maxResults` is applied
 *   after parsing. The request therefore carries the query and filters but not
 *   the cap.
 *
 * @module gpt-researcher/retrievers/duckduckgo
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { SearchResult } from '../types.ts'
import { safeDecodeUriComponent } from '../utils/text.ts'

/** The DuckDuckGo HTML endpoint the `ddgs` package scrapes. */
export const DUCKDUCKGO_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** Inputs of {@link buildDuckduckgoRequest}. */
export interface DuckduckgoRequestOptions {
  query: string
  queryDomains?: readonly string[]
  /** `USER_AGENT` header; the endpoint rejects requests without a browser UA. */
  userAgent?: string
}

/**
 * Build the DuckDuckGo form POST request (`q`, `kl=wt-wt`).
 *
 * @param options - query, domain filter, and user agent.
 * @returns the absolute URL and request init (form-encoded body).
 */
export function buildDuckduckgoRequest(options: DuckduckgoRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const body = new URLSearchParams()
  body.set('q', withSiteFilters(options.query, options.queryDomains))
  body.set('kl', 'wt-wt')
  body.set('b', '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'text/html',
  }
  if (options.userAgent) headers['User-Agent'] = options.userAgent
  return {
    url: DUCKDUCKGO_ENDPOINT,
    init: { method: 'POST', headers, body: body.toString() },
  }
}

/**
 * Parse DuckDuckGo's HTML results page.
 *
 * Anchors with `class="result__a"` carry the redirect URL and the title;
 * `result__snippet` elements carry the body. The `uddg` redirect parameter is
 * unwrapped, HTML entities are decoded, and each snippet is attached to the
 * nearest preceding anchor so a missing snippet does not shift results.
 *
 * @param html - the response body.
 * @returns one result per parsed anchor.
 */
export function parseDuckduckgoHtml(html: string): SearchResult[] {
  const anchors: Array<{ index: number; url: string; title: string | undefined }> = []
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1] ?? ''
    if (!/class\s*=\s*["'][^"']*result__a\b/i.test(attrs)) continue
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs) ?? /href\s*=\s*'([^']*)'/i.exec(attrs)
    anchors.push({
      index: match.index,
      url: normaliseDuckduckgoUrl(href?.[1] ?? ''),
      title: cleanText(match[2] ?? '') || undefined,
    })
  }

  const snippets: Array<{ index: number; text: string }> = []
  const snippetPattern =
    /<[a-z]+[^>]*class\s*=\s*"[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/gi
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push({ index: match.index, text: cleanText(match[1] ?? '') })
  }

  return anchors.map((anchor, position) => {
    const nextIndex = anchors[position + 1]?.index ?? html.length
    const snippet = snippets.find(
      (candidate) => candidate.index > anchor.index && candidate.index < nextIndex,
    )
    return {
      url: anchor.url,
      title: anchor.title,
      content: snippet?.text || undefined,
    }
  })
}

/** The DuckDuckGo retriever definition. */
export const duckduckgoRetriever: RetrieverDefinition = {
  name: 'duckduckgo',
  keys: [],
  keyless: true,
  description: 'DuckDuckGo HTML search (no API key; POST https://html.duckduckgo.com/html/).',
  create(ctx, options) {
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildDuckduckgoRequest({
          query: options.query,
          queryDomains: options.queryDomains,
          userAgent: ctx.config.userAgent,
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('duckduckgo', response)
          return parseDuckduckgoHtml(await response.text()).slice(0, limit)
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

/**
 * Unwrap DuckDuckGo's `/l/?uddg=…` redirect and make the URL absolute.
 *
 * @param href - the raw `href` attribute.
 * @returns the decoded target URL.
 */
function normaliseDuckduckgoUrl(href: string): string {
  let url = decodeHtmlEntities(href)
  const redirect = /[?&]uddg=([^&]+)/.exec(url)
  if (redirect?.[1]) url = safeDecodeUriComponent(redirect[1])
  if (url.startsWith('//')) url = `https:${url}`
  return url
}

/** Decode the small HTML entity set DuckDuckGo emits. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Strip tags, decode entities, and collapse whitespace. */
function cleanText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
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
