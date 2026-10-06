/**
 * DSH-native web search retriever — the one addition beyond the upstream set.
 *
 * The deployment already has a configured search provider (DSH's native web
 * seam, exposed as `Runtime.web`). This retriever forwards the query to it, so
 * a DSH session needs no external API key to run research. It is the retriever
 * a deployment should prefer when no provider credential is present.
 *
 * The seam is called as `web.search(query, maxResults, signal)` and returns
 * `{url, title, snippet}` records, which are normalised to the canonical
 * `{url, title, content}` shape.
 *
 * @module gpt-researcher/retrievers/dsh_web
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { SearchResult } from '../types.ts'

/**
 * Normalise the seam's `{url,title,snippet}` records.
 *
 * @param results - the records returned by `Runtime.web.search`.
 * @returns canonical search results; unknown/absent fields stay `undefined`.
 */
export function normalizeDshWebResults(results: readonly SearchResult[]): SearchResult[] {
  return results.map((entry) => {
    const record = entry as Record<string, unknown>
    const result: SearchResult = {
      url: asString(record.url) ?? asString(record.href),
      title: asString(record.title),
      content:
        asString(record.snippet) ?? asString(record.content) ?? asString(record.body),
    }
    const raw = asString(record.raw_content)
    if (raw !== undefined) result.raw_content = raw
    return result
  })
}

/** The DSH web retriever definition. */
export const dshWebRetriever: RetrieverDefinition = {
  name: 'dsh_web',
  keys: [],
  keyless: true,
  description:
    "The DSH deployment's own configured search provider (Runtime.web seam); no API key.",
  create(ctx, options) {
    return {
      async search(maxResults) {
        const web = ctx.runtime.web
        if (!web || !web.available()) {
          throw new RetrieverError(
            'dsh_web: the DSH native web seam (Runtime.web) is not available in this ' +
              'deployment. Configure a search provider, or use a keyless retriever ' +
              '(duckduckgo, searx, arxiv, pubmed_central, semantic_scholar, google).',
          )
        }
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const results = await web.search(
            withSiteFilters(options.query, options.queryDomains),
            limit,
            signal,
          )
          return normalizeDshWebResults(results).slice(0, limit)
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

/** Apply the configured result cap. */
function resolveLimit(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback
  return Math.max(0, Math.floor(requested))
}

/** Narrow an unknown value to a string. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
