/**
 * Text helpers shared by the engine.
 *
 * @module gpt-researcher/utils/text
 */

import type { ScrapedContent, SearchResult } from '../types.ts'
import { resultBody, resultUrl } from '../types.ts'

/**
 * Render any context value as text, mirroring how upstream's f-strings render
 * it. Upstream's context is sometimes a list and sometimes a string; Python
 * renders a list as `['a', 'b']` and that is what reaches the prompt there, so a
 * faithful port must render lists the same way rather than joining them.
 *
 * @param value - the context value.
 * @returns the text form.
 */
export function asContextText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return `[${value.map((item) => `'${asContextText(item).replace(/'/g, "\\'")}'`).join(', ')}]`
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Join context items into one string, the way upstream's web-search branch does
 * (`" ".join(context)`).
 *
 * @param items - context strings.
 * @returns the joined context.
 */
export function joinContext(items: readonly string[]): string {
  return items.filter((item) => item.length > 0).join(' ')
}

/** Truncate text to a character budget, appending an ellipsis marker. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

/** A filesystem-safe slug for a research artifact name. */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'research'
}

/** Collapse runs of whitespace and blank lines in extracted page text. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Convert a search result into a scraped document when it already carries text. */
export function searchResultToScraped(result: SearchResult): ScrapedContent | undefined {
  const url = resultUrl(result)
  const body = resultBody(result)
  if (!url || !body) return undefined
  return {
    url,
    raw_content: body,
    ...(result.title === undefined ? {} : { title: result.title }),
  }
}

/**
 * `decodeURIComponent` that never throws.
 *
 * Scraped search-result URLs routinely contain a bare `%` (for example
 * `?discount=50%`), which makes `decodeURIComponent` throw `URIError: URI
 * malformed`. In a parser loop that aborted the whole retriever — and, on the
 * seed search, the whole research run — because one anchor was malformed.
 *
 * @param value - the percent-encoded candidate.
 * @returns the decoded value, or the input unchanged when it is malformed.
 */
export function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Best-effort host extraction, for diagnostics and provider hints. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Word count with upstream's whitespace-splitting semantics. */
export function countWords(text: unknown): number {
  if (Array.isArray(text)) return text.reduce<number>((sum, item) => sum + countWords(item), 0)
  return String(text ?? '')
    .split(/\s+/)
    .filter((word) => word.length > 0).length
}

/**
 * Upstream `trim_context_to_word_limit`: keep the most recent items that fit
 * inside a word budget (deep research calls this with 25 000 words).
 *
 * @param contextList - context items, oldest first.
 * @param maxWords - the budget.
 * @returns the trimmed list, original order preserved.
 */
export function trimContextToWordLimit(
  contextList: readonly string[],
  maxWords = 25_000,
): string[] {
  let total = 0
  const kept: string[] = []
  for (const item of [...contextList].reverse()) {
    const words = countWords(item)
    if (total + words > maxWords) {
      // Upstream keeps a truncated first item rather than discarding
      // everything: `elif not out: out.insert(0, " ".join(item.split()[:max]))`.
      // Without this a single page larger than the budget produced an empty
      // context (and therefore an unsourced report).
      if (kept.length === 0) {
        kept.unshift(item.split(/\s+/).slice(0, Math.max(0, maxWords)).join(' '))
      }
      break
    }
    kept.unshift(item)
    total += words
  }
  return kept
}
