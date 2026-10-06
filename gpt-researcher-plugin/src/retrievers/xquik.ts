/**
 * Xquik X/Twitter retriever — port of
 * `gpt_researcher/retrievers/xquik/xquik.py`.
 *
 * Upstream GETs `https://xquik.com/api/v1/x/tweets/search` with
 * `{q, limit: min(max_results, 200), queryType: 'Top'}` and an `X-API-Key`
 * header, then renders each tweet as
 * `@user: <text[:120]>` with an engagement footer.
 *
 * @module gpt-researcher/retrievers/xquik
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream Xquik search endpoint. */
export const XQUIK_ENDPOINT = 'https://xquik.com/api/v1/x/tweets/search'

/** Environment variable holding the Xquik API key. */
export const XQUIK_API_KEY_ENV = 'XQUIK_API_KEY'

/** Upstream caps `limit` at 200. */
export const XQUIK_MAX_LIMIT = 200

/** Inputs of {@link buildXquikRequest}. */
export interface XquikRequestOptions {
  query: string
  maxResults: number
  apiKey: string
}

/**
 * Build the Xquik GET request.
 *
 * @param options - query, cap (clamped to {@link XQUIK_MAX_LIMIT}), credential.
 * @returns the absolute URL and request init.
 */
export function buildXquikRequest(options: XquikRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(XQUIK_ENDPOINT)
  url.searchParams.set('q', options.query)
  url.searchParams.set('limit', String(Math.min(options.maxResults, XQUIK_MAX_LIMIT)))
  url.searchParams.set('queryType', 'Top')
  return {
    url: url.toString(),
    init: {
      method: 'GET',
      headers: {
        'X-API-Key': options.apiKey,
        Accept: 'application/json',
        'User-Agent': 'gpt-researcher/1.0',
      },
    },
  }
}

/**
 * Parse an Xquik response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{tweets: [...]}`).
 * @returns one result per tweet, oldest field spellings first.
 */
export function parseXquikResponse(payload: unknown): SearchResult[] {
  const root = asRecord(payload)
  const tweets = Array.isArray(root?.tweets) ? root.tweets : []
  return tweets.map((entry) => {
    const record = asRecord(entry) ?? {}
    const author = asRecord(record.author) ?? {}
    const username = asString(author.username) ?? 'unknown'
    const text = asString(record.text) ?? ''
    const tweetId = asString(record.id) ?? ''
    const likes = asNumber(record.likeCount) ?? 0
    const retweets = asNumber(record.retweetCount) ?? 0
    const views = asNumber(record.viewCount) ?? 0
    let engagement = `${likes} likes, ${retweets} RTs`
    if (views) engagement += `, ${views} views`
    const truncated = text.length > 120 ? `${text.slice(0, 120)}...` : text
    return {
      url: `https://x.com/${username}/status/${tweetId}`,
      title: `@${username}: ${truncated}`,
      content: `${text}\n\n[${engagement}]`,
    }
  })
}

/** The Xquik retriever definition. */
export const xquikRetriever: RetrieverDefinition = {
  name: 'xquik',
  keys: [XQUIK_API_KEY_ENV],
  keyless: false,
  description: 'Xquik X/Twitter search API (GET https://xquik.com/api/v1/x/tweets/search).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, XQUIK_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildXquikRequest({
          query: options.query,
          maxResults: limit,
          apiKey,
        })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('xquik', response)
          return parseXquikResponse(await response.json())
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Read a required credential, naming the retriever and the variable. */
function requiredEnv(ctx: RetrieverContext, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`xquik: missing ${envVar}. Set the environment variable.`)
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
