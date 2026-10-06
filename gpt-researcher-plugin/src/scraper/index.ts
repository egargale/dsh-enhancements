/**
 * Scraper implementations and registry factory.
 *
 * Upstream `scraper/scraper.py` runs every URL through one of eight classes,
 * chosen by `SCRAPER=` with two hard-coded overrides: a `.pdf` URL goes to
 * `PyMuPDFScraper` and any `arxiv.org` URL goes to `ArxivScraper`. It throttles
 * through `WorkerPool` (`MAX_SCRAPER_WORKERS` concurrency plus a global
 * `SCRAPER_RATE_LIMIT_DELAY`), drops content shorter than 100 characters, and
 * logs-and-continues on failure. This module keeps all of that contract behind
 * the {@link ScraperDefinition} seam, with every network call routed through
 * `ctx.runtime.http` or `ctx.runtime.web`.
 *
 * @module gpt-researcher/scraper
 */

import { withTimeout, type WebSeam } from '../runtime.ts'
import type { ScrapedContent } from '../types.ts'
import {
  ScraperRegistry,
  type ScraperConfig,
  type ScraperContext,
  type ScraperDefinition,
} from './base.ts'
import { collapseWhitespace, extractHtml } from './html.ts'
import { assertFetchableUrl, fetchWithPolicy } from '../utils/url-policy.ts'

/** Raised when a scraper cannot fetch or extract a URL. */
export class ScraperError extends Error {
  override readonly name = 'ScraperError'

  /**
   * @param message - human-readable reason, naming the URL when known.
   * @param options - standard `Error` options (e.g. `cause`).
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/**
 * Upstream `Scraper.extract_data_from_url` rejects extracted content shorter
 * than 100 characters (the check runs before any `BROWSE_CHUNK_MAX_LENGTH`
 * truncation, exactly as upstream's context manager truncates later).
 */
export const MIN_SCRAPED_CONTENT_LENGTH = 100

/** Upstream `ArxivScraper` queries the public arXiv API. */
const ARXIV_API_URL = 'https://export.arxiv.org/api/query'

/** Default Firecrawl server, mirroring `FireCrawl.get_server_url`. */
const FIRECRAWL_DEFAULT_SERVER_URL = 'https://api.firecrawl.dev'

/** Default Tavily API endpoint (`tavily-python`'s extract endpoint). */
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract'

/** Exa contents endpoint (`/contents` returns clean text for known URLs). */
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents'

/** Accept header a text scraper sends. */
const HTML_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'

/** One fetched page, as `runtime.http` can see it. */
interface FetchedPage {
  url: string
  status: number
  contentType: string
  body: string
}

/** A per-URL scrape implementation, before it is wrapped into a registry entry. */
type UrlScraper = (
  url: string,
  ctx: ScraperContext,
  signal: AbortSignal | undefined,
) => Promise<ScrapedContent>

/** Wait for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Read a message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Narrow an unknown JSON value to a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Narrow an unknown value to a string, or return the fallback. */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** The run signal: the caller's, or the runtime's, whichever exists. */
function runSignal(ctx: ScraperContext, signal: AbortSignal | undefined): AbortSignal | undefined {
  return signal ?? ctx.runtime.signal
}

/** True when a URL points at a PDF (extension in the path, query ignored). */
export function isPdfUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? url
  return /\.pdf$/i.test(path)
}

/** True when a URL belongs to `arxiv.org` (or a subdomain). */
export function isArxivUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'arxiv.org' || host.endsWith('.arxiv.org')
  } catch {
    return /(^|[./])arxiv\.org([/:?#]|$)/i.test(url)
  }
}

/**
 * Mirror upstream `Scraper.get_scraper`: `.pdf` wins over everything,
 * `arxiv.org` next, otherwise the configured scraper name.
 *
 * @param configured - the scraper selected by `SCRAPER=`.
 * @param url - the URL about to be scraped.
 * @returns the registry name that should handle `url`.
 */
export function selectScraperForUrl(configured: string, url: string): string {
  if (isPdfUrl(url)) return 'pdf'
  if (isArxivUrl(url)) return 'arxiv'
  return configured
}

/**
 * Run a bounded number of workers over `items`, preserving input order in the
 * result. This is the port's `asyncio.Semaphore(max_workers)` — the concurrency
 * half of upstream `WorkerPool.throttle()`.
 *
 * @param items - the work items.
 * @param limit - maximum number of concurrent workers (values < 1 are clamped to 1).
 * @param worker - async work for one item.
 * @returns results in the same order as `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let cursor = 0
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Build a global rate limiter enforcing a minimum gap between request starts —
 * the rate-limit half of upstream `WorkerPool.throttle()`, which shares one
 * limiter across all pools.
 *
 * @param delaySeconds - `SCRAPER_RATE_LIMIT_DELAY`; `<= 0` disables throttling.
 * @param now - injectable clock (defaults to `Date.now`).
 * @returns an object whose `next()` resolves when the next request may start.
 */
/**
 * Process-wide limiter cache.
 *
 * The limiter used to be created inside `scrape()`, i.e. per batch. Since the
 * engine calls `scrape([url])` once per URL, every batch was a fresh limiter
 * whose first request never waited, so `SCRAPER_RATE_LIMIT_DELAY` could never
 * insert a gap. Caching by delay makes consecutive batches share one schedule,
 * which is what the docstring always promised.
 */
const sharedLimiters = new Map<number, { next: () => Promise<void> }>()

/**
 * Return the process-wide limiter for a delay (creating it on first use).
 *
 * @param delaySeconds - minimum seconds between request starts.
 * @param now - injectable clock, for deterministic tests.
 * @returns the shared limiter.
 */
export function sharedRateLimiter(
  delaySeconds: number,
  now: () => number = Date.now,
): { next: () => Promise<void> } {
  const gapMs = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : 0
  const existing = sharedLimiters.get(gapMs)
  if (existing) return existing
  const created = createRateLimiter(delaySeconds, now)
  sharedLimiters.set(gapMs, created)
  return created
}

/** Drop the cached limiters (tests that reconfigure the delay between cases). */
export function resetSharedRateLimiters(): void {
  sharedLimiters.clear()
}

export function createRateLimiter(
  delaySeconds: number,
  now: () => number = Date.now,
): { next: () => Promise<void> } {
  const gapMs = Number.isFinite(delaySeconds) ? delaySeconds * 1000 : 0
  let chain: Promise<void> = Promise.resolve()
  let lastStartMs = Number.NEGATIVE_INFINITY

  return {
    next(): Promise<void> {
      const wait = chain.then(async () => {
        if (gapMs > 0 && Number.isFinite(lastStartMs)) {
          const remaining = gapMs - (now() - lastStartMs)
          if (remaining > 0) await sleep(remaining)
        }
        lastStartMs = now()
      })
      chain = wait.catch(() => undefined)
      return wait
    },
  }
}

/**
 * Turn an extracted page into a {@link ScrapedContent}, applying upstream's
 * length rules: content below {@link MIN_SCRAPED_CONTENT_LENGTH} is a failure,
 * and the text is truncated to `BROWSE_CHUNK_MAX_LENGTH`.
 *
 * @param options - the extracted fields plus the owning scraper name.
 * @returns the scraped content.
 * @throws {ScraperError} when the content is too short to be useful.
 */
function buildScraped(options: {
  url: string
  text: string
  title?: string
  imageUrls?: readonly string[]
  sourceType: string
  ctx: ScraperContext
}): ScrapedContent {
  const text = options.text
  const length = text.trim().length
  if (length < MIN_SCRAPED_CONTENT_LENGTH) {
    throw new ScraperError(
      `content too short (${length} characters, minimum ${MIN_SCRAPED_CONTENT_LENGTH}) for ${options.url}`,
    )
  }
  const cap = options.ctx.config.browseChunkMaxLength
  const rawContent = Number.isFinite(cap) && cap > 0 ? text.slice(0, Math.floor(cap)) : text
  return {
    url: options.url,
    raw_content: rawContent,
    title: options.title ?? '',
    image_urls: [...(options.imageUrls ?? [])],
    source_type: options.sourceType,
  }
}

/**
 * Hard ceiling on the bytes handed to the HTML extractor.
 *
 * `BROWSE_CHUNK_MAX_LENGTH` truncates the *result*, long after the parser has
 * walked it, so a hostile or truncated page could still cost quadratic work.
 * 400 000 characters is two orders of magnitude above the default chunk cap and
 * leaves the extractor with bounded input.
 */
export const MAX_PARSE_CHARS = 400_000

/** Fetch one URL through the HTTP seam, honouring the run signal and timeout. */
async function fetchPage(
  url: string,
  ctx: ScraperContext,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string,
): Promise<FetchedPage> {
  const timeout = withTimeout(runSignal(ctx, signal), ctx.config.timeoutMs)
  try {
    // The URL is model-controlled (a tool argument or a harvested link), so it
    // is validated here, and every redirect hop is validated too — otherwise a
    // public URL answering `302 Location: http://169.254.169.254/…` would walk
    // straight past the check.
    const { response } = await fetchWithPolicy(
      ctx.runtime.http,
      url,
      {
        method,
        headers: {
          'User-Agent': ctx.config.userAgent,
          Accept: HTML_ACCEPT,
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        signal: timeout.signal,
      },
      {
        allowPrivateHosts: ctx.runtime.allowPrivateHosts ?? false,
        maxRedirects: 5,
      },
    )
    if (!response.ok) {
      throw new ScraperError(`HTTP ${response.status} for ${url}`)
    }
    const text = await response.text()
    return {
      url,
      status: response.status,
      contentType: response.header('content-type') ?? '',
      body: text.length > MAX_PARSE_CHARS ? text.slice(0, MAX_PARSE_CHARS) : text,
    }
  } finally {
    timeout.dispose()
  }
}

/** The `bs` path: fetch HTML and run it through {@link extractHtml}. */
const scrapeHtml: UrlScraper = async (url, ctx, signal) => {
  const page = await fetchPage(url, ctx, signal)
  if (isPdfContent(page)) return scrapePdfBody(url, page.body, ctx, 'bs')
  const extraction = extractHtml(page.body, { url: page.url })
  return buildScraped({
    url,
    text: extraction.text,
    title: extraction.title,
    imageUrls: extraction.imageUrls,
    sourceType: 'bs',
    ctx,
  })
}

/** True when a fetched page is a PDF, by header or magic bytes. */
function isPdfContent(page: FetchedPage): boolean {
  if (/application\/pdf/i.test(page.contentType)) return true
  return page.body.startsWith('%PDF-')
}

/**
 * Extract text from a PDF payload.
 *
 * // DEVIATION: upstream delegates PDFs to `PyMuPDFScraper`
 * // (`langchain_community` + PyMuPDF). No PDF library is bundled here, and the
 * // `runtime.http` seam exposes decoded text rather than bytes, so this is a
 * // best-effort extractor for uncompressed content streams only. Compressed
 * // (`/FlateDecode`), encrypted, or scanned PDFs fail with a clear
 * // {@link ScraperError} instead of silently producing an empty document.
 *
 * @param pdf - the decoded PDF payload.
 * @returns whatever text the uncompressed content streams contain (may be empty).
 */
function extractPdfText(pdf: string): string {
  if (!pdf.includes('%PDF-')) {
    throw new ScraperError('response is not a PDF (missing %PDF- header)')
  }
  const parts: string[] = []
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let match: RegExpExecArray | null
  while ((match = streamPattern.exec(pdf)) !== null) {
    const window = pdf.slice(Math.max(0, match.index - 800), match.index)
    const dictionary = window.slice(Math.max(0, window.lastIndexOf('<<')))
    if (/FlateDecode|LZWDecode|ASCII85Decode|RunLengthDecode|DCTDecode|JPXDecode/i.test(dictionary)) {
      continue
    }
    parts.push(pdfTextOperators(match[1] ?? ''))
  }
  return collapseWhitespace(parts.join('\n'))
}

/** Decode the text-showing operators of one PDF content stream. */
function pdfTextOperators(stream: string): string {
  const parts: string[] = []
  const tokenPattern =
    /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\b(?:Td|TD|T\*|ET|TJ|Tj|'|")\b/g
  for (const token of stream.match(tokenPattern) ?? []) {
    if (token.startsWith('(')) {
      parts.push(unescapePdfString(token.slice(1, -1)))
    } else if (token.startsWith('<')) {
      parts.push(hexPdfString(token.slice(1, -1)))
    } else if (token === 'Td' || token === 'TD' || token === 'T*' || token === 'ET') {
      parts.push('\n')
    }
  }
  return parts.join('')
}

/** Unescape a literal PDF string (`\n`, `\(`, `\053`, …). */
function unescapePdfString(value: string): string {
  return value.replace(/\\(\d{1,3}|.)/g, (_match, escape: string) => {
    if (/^\d+$/.test(escape)) {
      const code = Number.parseInt(escape, 8)
      return Number.isFinite(code) ? String.fromCharCode(code & 0xff) : ''
    }
    const replacements: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    }
    return replacements[escape] ?? escape
  })
}

/** Decode a hexadecimal PDF string, dropping bytes outside printable ASCII. */
function hexPdfString(value: string): string {
  const hex = value.replace(/\s+/g, '')
  let text = ''
  for (let index = 0; index + 1 < hex.length; index += 2) {
    const code = Number.parseInt(hex.slice(index, index + 2), 16)
    if (Number.isFinite(code) && code >= 0x20 && code <= 0x7e) {
      text += String.fromCharCode(code)
    }
  }
  return text
}

/** Build a {@link ScrapedContent} from a PDF body, or fail with a clear reason. */
function scrapePdfBody(
  url: string,
  body: string,
  ctx: ScraperContext,
  sourceType: string,
): ScrapedContent {
  let text = ''
  try {
    text = extractPdfText(body)
  } catch (error) {
    throw new ScraperError(`cannot read PDF at ${url}: ${errorMessage(error)}`, { cause: error })
  }
  if (text.trim().length < MIN_SCRAPED_CONTENT_LENGTH) {
    throw new ScraperError(
      `no extractable text in PDF at ${url}: compressed, encrypted, or scanned PDFs need a ` +
        `PDF extractor (PyMuPDF upstream), which is not bundled. Convert the PDF to text or use 'bs'/'dsh_web' for HTML.`,
    )
  }
  return buildScraped({ url, text, title: '', imageUrls: [], sourceType, ctx })
}

/** The `pdf` path: fetch and extract a PDF payload. */
const scrapePdf: UrlScraper = async (url, ctx, signal) => {
  const page = await fetchPage(url, ctx, signal)
  return scrapePdfBody(url, page.body, ctx, 'pdf')
}

/** Pull the arXiv identifier out of an `/abs/<id>` or `/pdf/<id>` URL. */
function arxivIdOf(url: string): string | undefined {
  const match = /\/(?:abs|pdf)\/([^/?#]+)/i.exec(url)
  if (!match) return undefined
  const id = (match[1] ?? '').replace(/\.pdf$/i, '')
  return id.length > 0 ? id : undefined
}

/** Text of the first `<name>` element inside the first `<entry>`. */
function firstXmlTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return collapseWhitespace(htmlEntitiesOnly(match?.[1] ?? ''))
}

/** Decode entities for Atom payloads without touching their tags. */
function htmlEntitiesOnly(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity: string) => {
      const named: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      }
      const known = named[entity]
      if (known !== undefined) return known
      const isHex = entity.startsWith('&#x') || entity.startsWith('&#X')
      const code = Number.parseInt(entity.slice(isHex ? 3 : 2, -1), isHex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity
    })
}

/**
 * The `arxiv` path, mirroring upstream `ArxivScraper`: query the arXiv API for
 * the identifier in the link and format the first entry the way upstream does
 * (`Published: …; Author: …; Content: …`).
 */
const scrapeArxiv: UrlScraper = async (url, ctx, signal) => {
  const id = arxivIdOf(url)
  if (id === undefined) {
    // Nothing arXiv-specific to query (e.g. an arxiv.org listing page): fall
    // back to the HTML path rather than failing the URL.
    const page = await fetchPage(url, ctx, signal)
    const extraction = extractHtml(page.body, { url: page.url })
    return buildScraped({
      url,
      text: extraction.text,
      title: extraction.title,
      imageUrls: extraction.imageUrls,
      sourceType: 'arxiv',
      ctx,
    })
  }
  const apiUrl = `${ARXIV_API_URL}?id_list=${encodeURIComponent(id)}`
  const page = await fetchPage(apiUrl, ctx, signal)
  const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(page.body)?.[1]
  if (entry === undefined) {
    throw new ScraperError(`arXiv returned no entry for '${id}' (${url})`)
  }
  const title = firstXmlTag(entry, 'title')
  const summary = firstXmlTag(entry, 'summary')
  const published = firstXmlTag(entry, 'published')
  const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)]
    .map((author) => firstXmlTag(author[1] ?? '', 'name'))
    .filter((name) => name.length > 0)
    .join(', ')
  const text = `Published: ${published}; Author: ${authors}; Content: ${summary}`
  return buildScraped({ url, text, title, imageUrls: [], sourceType: 'arxiv', ctx })
}

/** The `dsh_web` path: reuse the deployment's native web fetch seam. */
const scrapeDshWeb: UrlScraper = async (url, ctx, signal) => {
  // The deployment's fetch provider owns its own redirects, so only the entry
  // URL can be validated here; the policy still refuses private/internal hosts.
  assertFetchableUrl(url, { allowPrivateHosts: ctx.runtime.allowPrivateHosts ?? false })
  const web = ctx.runtime.web
  if (web === undefined) {
    throw new ScraperError(
      "The 'dsh_web' scraper needs the deployment's web seam (runtime.web). " +
        "Use scraper 'bs' instead, or run inside a DSH session that provides web fetch.",
    )
  }
  if (!web.available()) {
    throw new ScraperError(
      "The 'dsh_web' scraper is not available in this deployment (runtime.web.available() is false). " +
        "Use scraper 'bs' instead.",
    )
  }
  const timeout = withTimeout(runSignal(ctx, signal), ctx.config.timeoutMs)
  let response: Awaited<ReturnType<WebSeam['fetch']>>
  try {
    response = await web.fetch(url, timeout.signal)
  } finally {
    timeout.dispose()
  }
  if (response.status >= 400) {
    throw new ScraperError(`HTTP ${response.status} for ${url}`)
  }
  if (response.kind === 'html') {
    const extraction = extractHtml(response.body, { url })
    return buildScraped({
      url,
      text: extraction.text,
      title: extraction.title,
      imageUrls: extraction.imageUrls,
      sourceType: 'dsh_web',
      ctx,
    })
  }
  return buildScraped({
    url,
    text: response.body,
    title: '',
    imageUrls: [],
    sourceType: 'dsh_web',
    ctx,
  })
}

/**
 * Best-effort image collection for providers that return markdown/text only.
 *
 * // DEVIATION: upstream `FireCrawl`/`TavilyExtract` fetch the page a second time
 * // with `requests` and lose the extracted content if that second request fails.
 * // Here the extra fetch is isolated: a failure only costs the images.
 */
async function bestEffortImageUrls(
  url: string,
  ctx: ScraperContext,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  try {
    const page = await fetchPage(url, ctx, signal)
    return extractHtml(page.body, { url }).imageUrls
  } catch {
    return []
  }
}

/** The `firecrawl` path: `POST /v1/scrape` with `formats: ['markdown']`. */
const scrapeFirecrawl: UrlScraper = async (url, ctx, signal) => {
  const apiKey = ctx.runtime.env('FIRECRAWL_API_KEY')
  if (!apiKey) {
    throw new ScraperError('FIRECRAWL_API_KEY is not set; the firecrawl scraper cannot run.')
  }
  const serverUrl = (ctx.runtime.env('FIRECRAWL_SERVER_URL') ?? FIRECRAWL_DEFAULT_SERVER_URL).replace(
    /\/+$/,
    '',
  )
  const timeout = withTimeout(runSignal(ctx, signal), ctx.config.timeoutMs)
  let payload: Record<string, unknown>
  try {
    const response = await ctx.runtime.http(`${serverUrl}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: timeout.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new ScraperError(`HTTP ${response.status} from Firecrawl for ${url}`)
    payload = asRecord(await response.json())
  } finally {
    timeout.dispose()
  }

  if (payload.success === false) {
    throw new ScraperError(`Firecrawl reported a failure for ${url}`)
  }
  const data = asRecord(payload.data)
  const metadata = asRecord(data.metadata)
  const statusCode = metadata.statusCode
  if (typeof statusCode === 'number' && statusCode !== 200) {
    throw new ScraperError(`Firecrawl returned status ${statusCode} for ${url}`)
  }
  if (asString(metadata.error).length > 0) {
    throw new ScraperError(`Firecrawl error for ${url}: ${asString(metadata.error)}`)
  }
  const text = asString(data.markdown)
  return buildScraped({
    url,
    text,
    title: asString(metadata.title),
    imageUrls: await bestEffortImageUrls(url, ctx, signal),
    sourceType: 'firecrawl',
    ctx,
  })
}

/** The `tavily_extract` path: the Tavily extract endpoint for one URL. */
const scrapeTavilyExtract: UrlScraper = async (url, ctx, signal) => {
  const apiKey = ctx.runtime.env('TAVILY_API_KEY')
  if (!apiKey) {
    throw new ScraperError('TAVILY_API_KEY is not set; the tavily_extract scraper cannot run.')
  }
  const timeout = withTimeout(runSignal(ctx, signal), ctx.config.timeoutMs)
  let payload: Record<string, unknown>
  try {
    const response = await ctx.runtime.http(TAVILY_EXTRACT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
      signal: timeout.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new ScraperError(`HTTP ${response.status} from Tavily for ${url}`)
    payload = asRecord(await response.json())
  } finally {
    timeout.dispose()
  }

  const failed = Array.isArray(payload.failed_results) ? payload.failed_results : []
  const results = Array.isArray(payload.results) ? payload.results : []
  const first = asRecord(results[0])
  const text = asString(first.raw_content)
  if (failed.length > 0 || text.length === 0) {
    throw new ScraperError(`Tavily could not extract ${url}`)
  }
  return buildScraped({
    url,
    text,
    title: '',
    imageUrls: await bestEffortImageUrls(url, ctx, signal),
    sourceType: 'tavily_extract',
    ctx,
  })
}

/**
 * The `exa` path: the Exa `/contents` endpoint.
 *
 * // DEVIATION: upstream ships Exa only as a *retriever* (`retrievers/exa`), not
 * // as a scraper class. This entry exposes Exa's content-extraction endpoint as
 * // a scraper so `SCRAPER=exa` is selectable; the request/response handling is
 * // otherwise the same style as the other keyed scrapers.
 */
const scrapeExa: UrlScraper = async (url, ctx, signal) => {
  const apiKey = ctx.runtime.env('EXA_API_KEY')
  if (!apiKey) {
    throw new ScraperError('EXA_API_KEY is not set; the exa scraper cannot run.')
  }
  const timeout = withTimeout(runSignal(ctx, signal), ctx.config.timeoutMs)
  let payload: Record<string, unknown>
  try {
    const response = await ctx.runtime.http(EXA_CONTENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ urls: [url], text: true }),
      signal: timeout.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new ScraperError(`HTTP ${response.status} from Exa for ${url}`)
    payload = asRecord(await response.json())
  } finally {
    timeout.dispose()
  }

  const results = Array.isArray(payload.results) ? payload.results : []
  const first = asRecord(results[0])
  const text = asString(first.text)
  if (text.length === 0) {
    throw new ScraperError(`Exa returned no content for ${url}`)
  }
  return buildScraped({
    url,
    text,
    title: asString(first.title),
    imageUrls: [],
    sourceType: 'exa',
    ctx,
  })
}

/** The per-URL implementation behind each dispatchable name. */
const urlScrapers: Record<string, UrlScraper> = {
  bs: scrapeHtml,
  pdf: scrapePdf,
  arxiv: scrapeArxiv,
}

/**
 * Wrap a URL scraper into a {@link ScraperDefinition}: de-duplicate the URLs,
 * run them with `maxScraperWorkers` concurrency and the configured rate limit,
 * and turn each failure into a warning so one bad URL cannot abort the batch.
 */
function makeScraper(options: {
  name: string
  keys?: readonly string[]
  keyless?: boolean
  description: string
  /** When set, the URL is first routed through {@link selectScraperForUrl}. */
  dispatch?: boolean
  scrapeUrl: UrlScraper
}): ScraperDefinition {
  const keys = [...(options.keys ?? [])]
  return {
    name: options.name,
    keys,
    keyless: options.keyless ?? keys.length === 0,
    description: options.description,
    async scrape(
      urls: readonly string[],
      ctx: ScraperContext,
      signal?: AbortSignal,
    ): Promise<ScrapedContent[]> {
      // Upstream removes duplicate URLs while preserving order.
      const uniqueUrls = [...new Set(urls)]
      const limiter = sharedRateLimiter(ctx.config.scraperRateLimitDelay, ctx.runtime.now)
      const concurrency = ctx.config.maxScraperWorkers
      const results = await mapWithConcurrency(uniqueUrls, concurrency, async (url) => {
        await limiter.next()
        try {
          const selected = options.dispatch
            ? (urlScrapers[selectScraperForUrl(options.name, url)] ?? options.scrapeUrl)
            : options.scrapeUrl
          return await selected(url, ctx, signal)
        } catch (error) {
          ctx.runtime.log.warn(
            `Failed to scrape ${url} with '${options.name}': ${errorMessage(error)}`,
            { url, scraper: options.name, error },
          )
          return undefined
        }
      })
      return results.filter((content): content is ScrapedContent => content !== undefined)
    },
  }
}

/**
 * The headless-browser scraper.
 *
 * // DEVIATION: upstream ships `BrowserScraper` (Selenium) and `NoDriverScraper`
 * // (nodriver/zendriver) with cookie seeding, scrolling, and per-domain
 * // semaphores. Neither driver is bundled in this port, and faking one would
 * // produce pages the engine cannot actually read, so the entry keeps the
 * // upstream interface and fails loudly with a fix.
 */
const browserScraper: ScraperDefinition = {
  name: 'browser',
  keys: [],
  keyless: true,
  description:
    'Headless-browser scraper (upstream Selenium/nodriver). NOT BUNDLED: fails with instructions.',
  async scrape(): Promise<ScrapedContent[]> {
    throw new ScraperError(
      "The 'browser' scraper is not bundled in this port: it needs a headless browser " +
        '(Selenium/nodriver upstream), which is not a dependency here. ' +
        "Use the keyless 'bs' scraper (BeautifulSoup equivalent), or 'dsh_web' when the " +
        'deployment provides a web fetch seam.',
    )
  },
}

/** The upstream-compatible default scrapers, in registry order. */
function defaultScrapers(): ScraperDefinition[] {
  return [
    makeScraper({
      name: 'bs',
      description:
        'Default keyless scraper: fetch with runtime.http and extract with the BeautifulSoup-equivalent HTML extractor.',
      dispatch: true,
      scrapeUrl: scrapeHtml,
    }),
    makeScraper({
      name: 'dsh_web',
      description:
        "Reuse DSH's native web fetch seam (runtime.web) and extract HTML with the local extractor.",
      scrapeUrl: scrapeDshWeb,
    }),
    makeScraper({
      name: 'firecrawl',
      description: 'Firecrawl scrape API (FIRECRAWL_API_KEY, optional FIRECRAWL_SERVER_URL).',
      keys: ['FIRECRAWL_API_KEY'],
      keyless: false,
      scrapeUrl: scrapeFirecrawl,
    }),
    makeScraper({
      name: 'tavily_extract',
      description: 'Tavily extract API (TAVILY_API_KEY).',
      keys: ['TAVILY_API_KEY'],
      keyless: false,
      scrapeUrl: scrapeTavilyExtract,
    }),
    makeScraper({
      name: 'exa',
      description: 'Exa /contents API (EXA_API_KEY).',
      keys: ['EXA_API_KEY'],
      keyless: false,
      scrapeUrl: scrapeExa,
    }),
    makeScraper({
      name: 'pdf',
      description: 'PDF extraction: best-effort text-layer extraction (PyMuPDF upstream is not bundled).',
      scrapeUrl: scrapePdf,
      dispatch: true,
    }),
    makeScraper({
      name: 'arxiv',
      description: 'arXiv API scraper for arxiv.org links, mirroring upstream ArxivScraper.',
      scrapeUrl: scrapeArxiv,
      dispatch: true,
    }),
    browserScraper,
  ]
}

/**
 * Build the scraper registry: the upstream-compatible defaults plus any extra
 * definitions a deployment (or a test) wants to add or override.
 *
 * @param extra - additional definitions; a name collision replaces the default.
 * @returns a registry holding every definition.
 */
export function createScraperRegistry(
  extra: readonly ScraperDefinition[] = [],
): ScraperRegistry {
  return new ScraperRegistry([...defaultScrapers(), ...extra])
}

/**
 * Re-exported so consumers (the agent composition root, tests) can name the
 * scraper contract without importing `scraper/base.ts` directly.
 */
export type { ScraperConfig, ScraperContext, ScraperDefinition } from './base.ts'
