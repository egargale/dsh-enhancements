/**
 * PubMed Central retriever — port of
 * `gpt_researcher/retrievers/pubmed_central/pubmed_central.py`.
 *
 * Two-stage upstream flow, reproduced exactly:
 * 1. `esearch.fcgi` with `{db, term, retmax, api_key, sort, retmode:'json'}`;
 *    when `PUBMED_DB=pubmed` the term gains
 *    `AND (ffrft[filter] OR pmc[filter])`, otherwise PMC is searched directly.
 * 2. one `efetch.fcgi` per id with `{db:'pmc', id, rettype:'full', retmode:'xml'}`,
 *    whose XML is flattened to `Title: …\n\nAbstract: …\n\nBody: …`.
 *
 * `NCBI_API_KEY` is optional (requests are merely rate-limited without it), so
 * the retriever is keyless.
 *
 * DEVIATION: upstream enumerates every `PUBMED_ARG_*` environment variable.
 * The injected `env(name)` seam can only look up known names, so extra
 * parameters come from a single JSON object in `PUBMED_ARG_JSON` instead.
 *
 * @module gpt-researcher/retrievers/pubmed_central
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream `base_search_url`. */
export const PUBMED_SEARCH_ENDPOINT =
  'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'

/** Upstream `base_fetch_url`. */
export const PUBMED_FETCH_ENDPOINT =
  'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'

/** Optional NCBI API key environment variable. */
export const NCBI_API_KEY_ENV = 'NCBI_API_KEY'

/** Database selector; `pmc` (full text) is upstream's default. */
export const PUBMED_DB_ENV = 'PUBMED_DB'

/** JSON object of extra esearch parameters (upstream `PUBMED_ARG_*`). */
export const PUBMED_ARG_JSON_ENV = 'PUBMED_ARG_JSON'

/** Inputs of {@link buildPubMedSearchRequest}. */
export interface PubMedSearchRequestOptions {
  query: string
  maxResults: number
  /** `pmc` (default) or `pubmed`. */
  dbType?: string
  apiKey?: string
  /** Extra esearch parameters, applied over the upstream defaults. */
  extraParams?: Readonly<Record<string, string>>
}

/** Inputs of {@link buildPubMedFetchRequest}. */
export interface PubMedFetchRequestOptions {
  /** One id from the esearch `idlist`. */
  articleId: string
  apiKey?: string
}

/**
 * Build the `esearch.fcgi` GET request.
 *
 * @param options - query, cap, database, optional key, extra parameters.
 * @returns the absolute URL and request init.
 */
export function buildPubMedSearchRequest(options: PubMedSearchRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const db = options.dbType ?? 'pmc'
  const params: Record<string, string> = {
    sort: 'relevance',
    retmode: 'json',
    ...(options.extraParams ?? {}),
  }
  params.db = db
  params.term = db === 'pubmed' ? `${options.query} AND (ffrft[filter] OR pmc[filter])` : options.query
  params.retmax = String(options.maxResults)
  if (options.apiKey) params.api_key = options.apiKey

  const url = new URL(PUBMED_SEARCH_ENDPOINT)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Build one `efetch.fcgi` GET request (always against `pmc`, as upstream does).
 *
 * @param options - article id and optional key.
 * @returns the absolute URL and request init.
 */
export function buildPubMedFetchRequest(options: PubMedFetchRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(PUBMED_FETCH_ENDPOINT)
  url.searchParams.set('db', 'pmc')
  url.searchParams.set('id', options.articleId)
  url.searchParams.set('rettype', 'full')
  url.searchParams.set('retmode', 'xml')
  if (options.apiKey) url.searchParams.set('api_key', options.apiKey)
  return { url: url.toString(), init: { method: 'GET' } }
}

/**
 * Read the `esearchresult.idlist` from an esearch response.
 *
 * @param payload - the decoded JSON body.
 * @returns the article ids, or `[]` when the payload is sparse.
 */
export function parsePubMedSearchResponse(payload: unknown): string[] {
  const root = asRecord(payload)
  const searchResult = asRecord(root?.esearchresult)
  const idList = searchResult?.idlist
  if (!Array.isArray(idList)) return []
  return idList.filter((id): id is string => typeof id === 'string')
}

/**
 * Flatten one `efetch` article XML document.
 *
 * @param xml - the XML body.
 * @returns `{title, rawContent}` or `undefined` when no section was extractable
 *   (upstream's `ET.ParseError` path).
 */
export function parsePubMedArticleXml(
  xml: string,
): { title: string | undefined; rawContent: string } | undefined {
  const title = firstTagText(xml, 'article-title')
  const abstract = firstTagText(xml, 'abstract')
  const body = firstTagText(xml, 'body')
  if (!title && !abstract && !body) return undefined
  const fullContent = `Title: ${title ?? ''}\n\nAbstract: ${abstract ?? ''}\n\nBody: ${body ?? ''}`
  return { title, rawContent: fullContent }
}

/**
 * Build the canonical result for one fetched article.
 *
 * @param articleId - the PMC id (or bare PubMed id).
 * @param dbType - the configured `PUBMED_DB`.
 * @param xml - the fetched XML.
 * @returns the search result, or `undefined` when nothing was extractable.
 */
export function pubmedResult(
  articleId: string,
  dbType: string,
  xml: string,
): SearchResult | undefined {
  const parsed = parsePubMedArticleXml(xml)
  if (!parsed) return undefined
  const url =
    dbType === 'pmc' || articleId.startsWith('PMC')
      ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${articleId}/`
      : `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${articleId}/`
  return {
    url,
    title: parsed.title,
    body: parsed.rawContent,
    raw_content: parsed.rawContent,
  }
}

/** The PubMed Central retriever definition. */
export const pubmedCentralRetriever: RetrieverDefinition = {
  name: 'pubmed_central',
  keys: [],
  keyless: true,
  description:
    'PubMed Central full-text search via NCBI E-utilities (no key required; NCBI_API_KEY ' +
    'raises the rate limit). Optional PUBMED_DB and PUBMED_ARG_JSON.',
  create(ctx, options) {
    const apiKey = ctx.runtime.env(NCBI_API_KEY_ENV)
    const dbType = ctx.runtime.env(PUBMED_DB_ENV) ?? 'pmc'
    const extraParams = readArgJson(ctx)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const searchRequest = buildPubMedSearchRequest({
            query: options.query,
            maxResults: limit,
            dbType,
            apiKey,
            extraParams,
          })
          const searchResponse = await ctx.runtime.http(searchRequest.url, {
            ...searchRequest.init,
            signal,
          })
          ensureOk('pubmed_central', searchResponse)
          const ids = parsePubMedSearchResponse(await searchResponse.json())

          const results: SearchResult[] = []
          for (const articleId of ids) {
            const fetchRequest = buildPubMedFetchRequest({ articleId, apiKey })
            const fetchResponse = await ctx.runtime.http(fetchRequest.url, {
              ...fetchRequest.init,
              signal,
            })
            ensureOk('pubmed_central', fetchResponse)
            const result = pubmedResult(articleId, dbType, await fetchResponse.text())
            if (result) results.push(result)
          }
          return results
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Read and validate the optional `PUBMED_ARG_JSON` parameter object. */
function readArgJson(ctx: RetrieverContext): Record<string, string> {
  const raw = ctx.runtime.env(PUBMED_ARG_JSON_ENV)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RetrieverError(
      `pubmed_central: ${PUBMED_ARG_JSON_ENV} must be a JSON object of query parameters.`,
    )
  }
  const record = asRecord(parsed)
  if (!record) {
    throw new RetrieverError(
      `pubmed_central: ${PUBMED_ARG_JSON_ENV} must be a JSON object of query parameters.`,
    )
  }
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') params[key.toLowerCase()] = value
  }
  return params
}

/** Read and whitespace-collapse the first matching tag's text. */
function firstTagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  if (!match) return undefined
  const text = decodeXmlEntities((match[1] ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 0 ? text : undefined
}

/** Decode the XML entities NCBI emits. */
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

/** Apply the configured result cap (`retmax` upstream). */
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
