/**
 * GetXAPI X/Twitter retriever — port of
 * `gpt_researcher/retrievers/getxapi/getxapi.py`.
 *
 * Upstream GETs `https://api.getxapi.com/twitter/tweet/advanced_search?q=…`
 * with a Bearer token, reads `tweets` (or `data`), and renders each tweet as
 * `@user: <text[:80]>` plus a
 * `[likes:N retweets:N replies:N views:N]` footer. Every field is read with the
 * tolerant fallbacks upstream uses (`userName`/`username`/`screen_name`, …).
 *
 * @module gpt-researcher/retrievers/getxapi
 */

import { RetrieverError, type RetrieverDefinition } from './base.ts'
import { withTimeout } from '../runtime.ts'
import type { HttpRequestInit, HttpResponse } from '../runtime.ts'
import type { RetrieverContext } from './base.ts'
import type { SearchResult } from '../types.ts'

/** Upstream GetXAPI endpoint. */
export const GETXAPI_ENDPOINT = 'https://api.getxapi.com/twitter/tweet/advanced_search'

/** Environment variable holding the GetXAPI key. */
export const GETXAPI_API_KEY_ENV = 'GETXAPI_API_KEY'

/** Inputs of {@link buildGetXapiRequest}. */
export interface GetXapiRequestOptions {
  query: string
  apiKey: string
}

/**
 * Build the GetXAPI GET request.
 *
 * @param options - query and credential.
 * @returns the absolute URL and request init.
 */
export function buildGetXapiRequest(options: GetXapiRequestOptions): {
  url: string
  init: HttpRequestInit
} {
  const url = new URL(GETXAPI_ENDPOINT)
  url.searchParams.set('q', options.query)
  return {
    url: url.toString(),
    init: {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'gpt-researcher/1.0',
      },
    },
  }
}

/**
 * Parse a GetXAPI response into canonical search results.
 *
 * @param payload - the decoded JSON body (`{tweets: [...]}` or `{data: [...]}`).
 * @param maxResults - client-side cap (upstream slices the tweet list).
 * @returns one result per tweet.
 */
export function parseGetXapiResponse(payload: unknown, maxResults = 10): SearchResult[] {
  const root = asRecord(payload)
  const raw = Array.isArray(root?.tweets)
    ? root.tweets
    : Array.isArray(root?.data)
      ? root.data
      : []
  return raw.slice(0, maxResults).map((entry) => {
    const record = asRecord(entry) ?? {}
    const author = asRecord(record.author) ?? {}
    const username =
      asString(author.userName) ??
      asString(author.username) ??
      asString(author.screen_name) ??
      asString(record.username) ??
      'unknown'
    const text = asString(record.text) ?? asString(record.full_text) ?? ''
    const tweetId = asString(record.id) ?? asString(record.id_str) ?? ''
    const likes = firstNumber(record, ['likeCount', 'favorite_count'])
    const retweets = firstNumber(record, ['retweetCount', 'retweet_count'])
    const replies = firstNumber(record, ['replyCount', 'reply_count'])
    const views = firstNumber(record, ['viewCount', 'view_count'])
    const truncated = text.length > 80 ? `${text.slice(0, 80)}...` : text
    return {
      url: `https://x.com/${username}/status/${tweetId}`,
      title: `@${username}: ${truncated}`,
      content: `${text}\n\n[likes:${likes} retweets:${retweets} replies:${replies} views:${views}]`,
    }
  })
}

/** The GetXAPI retriever definition. */
export const getXapiRetriever: RetrieverDefinition = {
  name: 'getxapi',
  keys: [GETXAPI_API_KEY_ENV],
  keyless: false,
  description:
    'GetXAPI X/Twitter advanced search (GET https://api.getxapi.com/twitter/tweet/advanced_search).',
  create(ctx, options) {
    const apiKey = requiredEnv(ctx, GETXAPI_API_KEY_ENV)
    return {
      async search(maxResults) {
        const limit = resolveLimit(maxResults, ctx.config.maxSearchResultsPerQuery)
        const request = buildGetXapiRequest({ query: options.query, apiKey })
        const { signal, dispose } = withTimeout(
          ctx.runtime.signal ?? options.signal,
          ctx.config.timeoutMs,
        )
        try {
          const response = await ctx.runtime.http(request.url, { ...request.init, signal })
          ensureOk('getxapi', response)
          return parseGetXapiResponse(await response.json(), limit)
        } finally {
          dispose()
        }
      },
    }
  },
}

/** Read the first numeric field present, defaulting to `0` (as upstream does). */
function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = asNumber(record[key])
    if (value !== undefined) return value
  }
  return 0
}

/** Read a required credential, naming the retriever and the variable. */
function requiredEnv(ctx: RetrieverContext, envVar: string): string {
  const value = ctx.runtime.env(envVar)
  if (!value) {
    throw new RetrieverError(`getxapi: missing ${envVar}. Set the environment variable.`)
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
