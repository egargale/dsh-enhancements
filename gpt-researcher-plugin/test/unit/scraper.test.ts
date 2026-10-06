/**
 * Offline unit tests for the scraper module tree (`src/scraper`).
 *
 * Every test runs against fakes of the `Runtime` seams: no network, no
 * filesystem, no real clock beyond the rate limiter's short waits.
 *
 * @module gpt-researcher/test/unit/scraper
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { HttpFetch, HttpResponse, Runtime, WebSeam } from '../../src/runtime.ts'
import type { ScrapedContent } from '../../src/types.ts'
import type { ScraperConfig, ScraperContext, ScraperDefinition } from '../../src/scraper/base.ts'
import {
  SITE_TEXT_HANDLERS,
  collapseWhitespace,
  decodeHtmlEntities,
  extractHtml,
  handlerForHost,
} from '../../src/scraper/html.ts'
import {
  MIN_SCRAPED_CONTENT_LENGTH,
  ScraperError,
  createRateLimiter,
  createScraperRegistry,
  mapWithConcurrency,
  selectScraperForUrl,
} from '../../src/scraper/index.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A paragraph comfortably above the 100-character minimum. */
const LONG_PARAGRAPH =
  'Research agents plan, retrieve, and synthesise evidence from many sources before they write a cited report.'

/** A realistic page: head metadata, chrome, a `<main>` body, and two images. */
const FIXTURE = `<!doctype html>
<html lang="en">
<head>
  <title>Research notes &mdash; ensemble</title>
  <meta name="description" content="How agents gather &amp; cite sources.">
  <style>body { color: red; }</style>
  <script>window.secret = 'SHOULD_NOT_APPEAR';</script>
</head>
<body>
  <div class="cookie-banner" hidden>We use cookies.</div>
  <nav><a href="/x">Navigation link</a></nav>
  <header>Site header chrome</header>
  <div><p>Distractor outside main: sponsor message.</p></div>
  <main>
    <article>
      <h1>Ensemble notes</h1>
      <p>A &amp; B &quot;quoted&quot; &#8212; done.</p>
      <p>${LONG_PARAGRAPH} ${LONG_PARAGRAPH}</p>
      <img src="/img/hero.png" class="featured" width="1200" height="600">
      <img src="https://cdn.example.com/logo.png" width="50" height="50">
    </article>
  </main>
  <footer>Footer chrome &copy; 2024</footer>
</body>
</html>`

/** HTML with no `<main>`/`<article>`, so the whole body is extracted. */
const FLAT_FIXTURE = `<html><head><title>Flat page</title></head><body>
  <div><p>Distractor outside main: sponsor message.</p></div>
  <div><p>${LONG_PARAGRAPH}</p></div>
</body></html>`

/** An arXiv abstract page with a distractor that the site handler must drop. */
const ARXIV_FIXTURE = `<html><head><title>arXiv:2401.00001</title></head><body>
  <div class="extra-services">Distractor taxonomy listing that must not appear.</div>
  <blockquote class="abstract mathjax">
    We prove that retrieval augmented generation improves citation accuracy in long-form reports.
  </blockquote>
</body></html>`

/** A minimal arXiv Atom response for one identifier. */
const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query</title>
  <entry>
    <title>Attention Is All You Need</title>
    <summary>${LONG_PARAGRAPH}</summary>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>Vaswani</name></author>
    <author><name>Shazeer</name></author>
  </entry>
</feed>`

/** A small page whose text is below the 100-character minimum. */
const SHORT_FIXTURE = '<html><head><title>Short</title></head><body><p>Too small.</p></body></html>'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the first item, failing the test when the list is empty. */
function first<T>(items: readonly T[]): T {
  assert.ok(items.length > 0, 'expected at least one item')
  return items[0] as T
}

/** Build a fake `HttpResponse`. */
function fakeResponse(
  body: string,
  options: { status?: number; contentType?: string } = {},
): HttpResponse {
  const status = options.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    header: (name: string) =>
      name.toLowerCase() === 'content-type'
        ? (options.contentType ?? 'text/html; charset=utf-8')
        : null,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  }
}

/** A recorded request against the fake HTTP seam. */
interface RecordedRequest {
  url: string
  signal?: AbortSignal | undefined
}

/** The fakes and recorders one test needs. */
interface Harness {
  ctx: ScraperContext
  runtime: Runtime
  warnings: string[]
  requests: RecordedRequest[]
}

/** Build a `ScraperContext` around fake seams. */
function makeHarness(options: {
  http?: HttpFetch
  web?: WebSeam
  env?: Record<string, string>
  config?: Partial<ScraperConfig>
  signal?: AbortSignal
} = {}): Harness {
  const warnings: string[] = []
  const requests: RecordedRequest[] = []
  const inner: HttpFetch =
    options.http ??
    (async (url) => {
      throw new Error(`unexpected HTTP request to ${url}`)
    })
  const config: ScraperConfig = {
    browseChunkMaxLength: 8192,
    userAgent: 'gpt-researcher-test',
    timeoutMs: 5_000,
    maxScraperWorkers: 4,
    scraperRateLimitDelay: 0,
    ...options.config,
  }
  const runtime: Runtime = {
    llm: { complete: async () => ({ text: '' }) },
    http: async (url, init) => {
      requests.push({ url, ...(init?.signal === undefined ? {} : { signal: init.signal }) })
      return inner(url, init)
    },
    env: (name: string) => options.env?.[name],
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message)
      },
      error: () => {},
    },
    progress: () => {},
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  return { ctx: { runtime, config }, runtime, warnings, requests }
}

/** A web seam that returns one canned response. */
function fakeWeb(
  response: { body: string; kind: 'html' | 'text'; status?: number },
  available = true,
): WebSeam {
  return {
    available: () => available,
    search: async () => [],
    fetch: async (url: string) => ({
      url,
      status: response.status ?? 200,
      body: response.body,
      kind: response.kind,
    }),
  }
}

/** Scrape with a named default scraper. */
async function scrapeWith(
  name: string,
  urls: readonly string[],
  ctx: ScraperContext,
  signal?: AbortSignal,
): Promise<ScrapedContent[]> {
  const definition = createScraperRegistry().get(name)
  assert.ok(definition, `scraper '${name}' should exist`)
  return definition.scrape(urls, ctx, signal)
}

/** Wait for a short while. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// html.ts — entities and whitespace
// ---------------------------------------------------------------------------

test('decodeHtmlEntities decodes numeric, hex, named, and legacy references', () => {
  assert.equal(decodeHtmlEntities('&amp;&lt;&gt;&quot;&#39;'), '&<>"\'')
  assert.equal(decodeHtmlEntities('&#65;&#x42;'), 'AB')
  assert.equal(decodeHtmlEntities('a&nbsp;b&mdash;c&hellip;'), 'a\u00a0b\u2014c\u2026')
  assert.equal(decodeHtmlEntities('legacy &amp and &nbsp here'), 'legacy & and \u00a0 here')
  assert.equal(decodeHtmlEntities('&bogus; &unknown;'), '&bogus; &unknown;')
  assert.equal(decodeHtmlEntities('no entities here'), 'no entities here')
})

test('collapseWhitespace trims lines and drops blank lines', () => {
  assert.equal(collapseWhitespace('  a   b \n\n\n  c\t\t d  \n'), 'a b\nc d')
  assert.equal(collapseWhitespace('\u00a0 \n \u00a0'), '')
})

// ---------------------------------------------------------------------------
// html.ts — extraction
// ---------------------------------------------------------------------------

test('extractHtml strips chrome, decodes entities, keeps main content and images', () => {
  const extraction = extractHtml(FIXTURE, { url: 'https://example.com/a' })

  assert.equal(extraction.title, 'Research notes — ensemble')
  assert.equal(extraction.description, 'How agents gather & cite sources.')

  assert.ok(extraction.text.includes('Ensemble notes'))
  assert.ok(extraction.text.includes('A & B "quoted" — done.'))
  assert.ok(extraction.text.includes(LONG_PARAGRAPH))

  // No script/style/chrome text, and no markup left behind.
  assert.ok(!extraction.text.includes('SHOULD_NOT_APPEAR'))
  assert.ok(!extraction.text.includes('color: red'))
  assert.ok(!extraction.text.includes('Navigation link'))
  assert.ok(!extraction.text.includes('Site header chrome'))
  assert.ok(!extraction.text.includes('Footer chrome'))
  assert.ok(!extraction.text.includes('We use cookies'))
  assert.ok(!extraction.text.includes('©'))
  assert.ok(!/<[a-z/][^>]*>/i.test(extraction.text))

  // <main> preference: the distractor outside <main> is excluded.
  assert.ok(!extraction.text.includes('Distractor outside main'))

  // Collapsed blank lines, no leading/trailing whitespace.
  assert.ok(!/\n\s*\n/.test(extraction.text))
  assert.equal(extraction.text, extraction.text.trim())

  // Only the class-scored hero image survives (the 50x50 logo is dropped).
  assert.deepEqual(extraction.imageUrls, ['https://example.com/img/hero.png'])
})

test('extractHtml falls back to the whole body when there is no main/article', () => {
  const extraction = extractHtml(FLAT_FIXTURE, { url: 'https://example.com/flat' })
  assert.equal(extraction.title, 'Flat page')
  assert.ok(extraction.text.includes('Distractor outside main'))
  assert.ok(extraction.text.includes(LONG_PARAGRAPH))
})

test('extractHtml resolves relative images against <base href>', () => {
  const extraction = extractHtml(
    `<html><head><base href="https://cdn.example.com/assets/"></head>
     <body><p>Body text.</p><img src="pic.png" width="800" height="600"></body></html>`,
    { url: 'https://example.com/page' },
  )
  assert.deepEqual(extraction.imageUrls, ['https://cdn.example.com/assets/pic.png'])
})

test('extractHtml falls back to og:title and then <h1>', () => {
  const og = extractHtml(
    '<html><head><meta property="og:title" content="OG &amp; title"></head><body><p>x</p></body></html>',
  )
  assert.equal(og.title, 'OG & title')
  const h1 = extractHtml('<html><body><h1>Heading fallback</h1><p>x</p></body></html>')
  assert.equal(h1.title, 'Heading fallback')
})

test('handlerForHost selects a per-site handler, including subdomains', () => {
  assert.equal(handlerForHost('https://arxiv.org/abs/2401.00001'), SITE_TEXT_HANDLERS['arxiv.org'])
  assert.equal(handlerForHost('arxiv.org'), SITE_TEXT_HANDLERS['arxiv.org'])
  assert.equal(handlerForHost('https://blog.medium.com/post-1'), SITE_TEXT_HANDLERS['medium.com'])
  assert.equal(handlerForHost('news.ycombinator.com'), undefined)
  assert.equal(handlerForHost(''), undefined)
})

test('the arxiv handler narrows extraction to the abstract block', () => {
  const scoped = extractHtml(ARXIV_FIXTURE, { url: 'https://arxiv.org/abs/2401.00001' })
  assert.equal(scoped.title, 'arXiv:2401.00001')
  assert.ok(scoped.text.includes('retrieval augmented generation'))
  assert.ok(!scoped.text.includes('Distractor taxonomy'))

  const unscoped = extractHtml(ARXIV_FIXTURE)
  assert.ok(unscoped.text.includes('Distractor taxonomy'))
})

test('empty and garbage input yields empty fields without throwing', () => {
  const garbage = [
    '',
    '   \n\t ',
    '<html><head><title></title></head><body></body></html>',
    '<div><span></span></div>',
    '%%%@@@',
    '\u0000\u0001',
    '<script>onlyScriptText()</script>',
  ]
  for (const input of garbage) {
    const extraction = extractHtml(input)
    assert.equal(extraction.text, '', `expected empty text for ${JSON.stringify(input)}`)
    assert.equal(extraction.title, '')
    assert.deepEqual(extraction.imageUrls, [])
  }
  assert.doesNotThrow(() => extractHtml(undefined as unknown as string))
  assert.doesNotThrow(() => extractHtml(null as unknown as string))
  assert.equal(extractHtml('').text, '')
})

// ---------------------------------------------------------------------------
// html.ts — malformed markup and performance
// ---------------------------------------------------------------------------

test('extractHtml tokenizes a malformed 100 KB page in linear time', () => {
  const html = '<a'.repeat(50_000)
  const started = Date.now()
  const extraction = extractHtml(html)
  const elapsed = Date.now() - started

  assert.equal(typeof extraction.text, 'string')
  // ~50 ms when linear; the quadratic tokenizer this guards took ~140 s.
  assert.ok(elapsed < 2_000, `tokenizing ${html.length} bytes took ${elapsed} ms`)
})

test('extractHtml sizes unterminated elements in linear time', () => {
  // `<title>` opens an element that never closes, so element matching and tag
  // stripping both see 40 KB of unterminated `<a` markup.
  const html = `<title>${'<a'.repeat(20_000)}<b`
  const started = Date.now()
  const extraction = extractHtml(html)
  const elapsed = Date.now() - started

  assert.equal(typeof extraction.title, 'string')
  assert.ok(elapsed < 2_000, `extracting ${html.length} bytes took ${elapsed} ms`)
})

test('extractHtml falls through an image-only <main> to the body content', () => {
  const extraction = extractHtml(
    '<html><body><main id="app"><img src="/hero.png"></main>' +
      `<div><p>${LONG_PARAGRAPH}</p></div></body></html>`,
  )
  assert.equal(extraction.text, LONG_PARAGRAPH)
})

test('extractHtml keeps the body after an unclosed chrome element', () => {
  const pages: Array<[string, string]> = [
    ['nav', `<html><body><nav><a href="/">Home</a><p>${LONG_PARAGRAPH}</p></body></html>`],
    ['form', `<html><body><form><input name="q"><p>${LONG_PARAGRAPH}</p></body></html>`],
    [
      'div class="menu"',
      `<html><body><div class="menu"><a href="/">Home</a><p>${LONG_PARAGRAPH}</p></body></html>`,
    ],
  ]
  for (const [label, page] of pages) {
    const extraction = extractHtml(page)
    assert.ok(extraction.text.includes(LONG_PARAGRAPH), `unclosed <${label}> dropped the body`)
  }
})

test('extractHtml tokenizes a quoted > as part of its tag', () => {
  const extraction = extractHtml(
    '<html><body><p>Before</p><a title="a > b" href="/x">After</a></body></html>',
  )
  // A split at the quoted `>` would leak `b" href="/x"` into the text.
  assert.equal(extraction.text, 'Before\nAfter')
})

test('extractHtml tolerates an unterminated trailing tag', () => {
  const html = `<html><body><p>${LONG_PARAGRAPH}</p><div class="x`
  assert.doesNotThrow(() => extractHtml(html))
  assert.ok(extractHtml(html).text.includes(LONG_PARAGRAPH))
})

// ---------------------------------------------------------------------------
// registry and dispatcher
// ---------------------------------------------------------------------------

test('the default registry exposes the upstream scraper names', () => {
  const registry = createScraperRegistry()
  assert.deepEqual(registry.names().sort(), [
    'arxiv',
    'browser',
    'bs',
    'dsh_web',
    'exa',
    'firecrawl',
    'pdf',
    'tavily_extract',
  ])
})

test('an unknown scraper name lists the valid options', () => {
  const registry = createScraperRegistry()
  const { runtime } = makeHarness()
  assert.throws(
    () => registry.resolve('nope', runtime),
    /Invalid scraper 'nope'\. Valid options are: .*bs/,
  )
})

test('keyed scrapers are rejected until their environment variable is set', () => {
  const registry = createScraperRegistry()
  const bare = makeHarness()
  assert.throws(() => registry.resolve('firecrawl', bare.runtime), /FIRECRAWL_API_KEY/)
  assert.throws(() => registry.resolve('exa', bare.runtime), /EXA_API_KEY/)

  const configured = makeHarness({ env: { EXA_API_KEY: 'exa-test' } })
  assert.equal(registry.resolve('exa', configured.runtime).name, 'exa')
  assert.equal(registry.resolve('bs', configured.runtime).name, 'bs')
})

test('extra definitions are registered and can replace a default', () => {
  const custom: ScraperDefinition = {
    name: 'custom',
    keys: [],
    keyless: true,
    description: 'test scraper',
    async scrape() {
      return []
    },
  }
  const registry = createScraperRegistry([custom])
  assert.equal(registry.get('custom'), custom)
  assert.ok(registry.names().includes('custom'))
})

test('selectScraperForUrl mirrors upstream get_scraper', () => {
  assert.equal(selectScraperForUrl('bs', 'https://example.com/report.pdf'), 'pdf')
  assert.equal(selectScraperForUrl('bs', 'https://example.com/report.PDF?x=1'), 'pdf')
  assert.equal(selectScraperForUrl('bs', 'https://arxiv.org/abs/2401.00001'), 'arxiv')
  assert.equal(selectScraperForUrl('bs', 'https://example.com/article'), 'bs')
  assert.equal(selectScraperForUrl('firecrawl', 'https://example.com/article'), 'firecrawl')
})

test('ScraperError is a named Error', () => {
  const error = new ScraperError('boom')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'ScraperError')
  assert.equal(error.message, 'boom')
})

// ---------------------------------------------------------------------------
// concurrency and rate limiting
// ---------------------------------------------------------------------------

test('mapWithConcurrency preserves order and bounds concurrency', async () => {
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await sleep(3)
    active -= 1
    return value * 2
  })
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  assert.ok(peak <= 3, `peak concurrency was ${peak}`)
})

test('createRateLimiter spaces consecutive requests deterministically', async () => {
  // Driven by an injected clock and a stubbed timer: asserting elapsed wall time
  // made this test fail on a loaded machine whenever scheduling delayed two
  // resolved awaits by more than the bound.
  const realSetTimeout = globalThis.setTimeout
  const waits: number[] = []
  let now = 0
  ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0)
    now += ms ?? 0
    fn()
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout
  try {
    const limiter = createRateLimiter(0.02, () => now)
    await limiter.next()
    await limiter.next()
    await limiter.next()
    assert.deepEqual(waits, [20, 20], 'each follow-up request waits the configured gap')

    const disabled = createRateLimiter(0, () => now)
    await disabled.next()
    await disabled.next()
    assert.equal(waits.length, 2, 'a zero delay never waits')
  } finally {
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout
  }
})

// ---------------------------------------------------------------------------
// bs scraper
// ---------------------------------------------------------------------------

test('bs maps an HTML response to ScrapedContent', async () => {
  const harness = makeHarness({ http: async () => fakeResponse(FIXTURE) })
  const results = await scrapeWith('bs', ['https://example.com/a'], harness.ctx)

  assert.equal(results.length, 1)
  const document = first(results)
  assert.equal(document.url, 'https://example.com/a')
  assert.equal(document.title, 'Research notes — ensemble')
  assert.ok(document.raw_content.includes(LONG_PARAGRAPH))
  assert.equal(document.source_type, 'bs')
  assert.deepEqual(document.image_urls, ['https://example.com/img/hero.png'])
  assert.ok(!document.raw_content.includes('SHOULD_NOT_APPEAR'))
  assert.equal(document.raw_content.length, extractHtml(FIXTURE, { url: 'https://example.com/a' }).text.length)
})

test('bs truncates extracted text at BROWSE_CHUNK_MAX_LENGTH', async () => {
  const cap = 150
  const harness = makeHarness({
    http: async () => fakeResponse(FIXTURE),
    config: { browseChunkMaxLength: cap },
  })
  const results = await scrapeWith('bs', ['https://example.com/a'], harness.ctx)
  const document = first(results)
  const reference = extractHtml(FIXTURE, { url: 'https://example.com/a' }).text

  assert.ok(reference.length > cap, 'fixture must be longer than the cap for this test')
  assert.equal(document.raw_content.length, cap)
  assert.equal(document.raw_content, reference.slice(0, cap))
})

test('bs reports content below the minimum length and returns no document', async () => {
  const harness = makeHarness({ http: async () => fakeResponse(SHORT_FIXTURE) })
  const results = await scrapeWith('bs', ['https://example.com/short'], harness.ctx)
  assert.deepEqual(results, [])
  assert.ok(harness.warnings.some((warning) => warning.includes('too short')))
  assert.ok(MIN_SCRAPED_CONTENT_LENGTH > 0)
})

test('bs logs and continues when one URL in a batch fails', async () => {
  const harness = makeHarness({
    http: async (url) => {
      if (url.endsWith('/boom')) throw new Error('network down')
      return fakeResponse(FIXTURE)
    },
  })
  const urls = ['https://example.com/ok-1', 'https://example.com/boom', 'https://example.com/ok-2']
  const results = await scrapeWith('bs', urls, harness.ctx)

  assert.deepEqual(
    results.map((document) => document.url),
    ['https://example.com/ok-1', 'https://example.com/ok-2'],
  )
  assert.ok(harness.warnings.some((warning) => warning.includes('https://example.com/boom')))
  assert.ok(harness.warnings.some((warning) => warning.includes('network down')))
})

test('bs treats a non-2xx response as a per-URL failure', async () => {
  const harness = makeHarness({ http: async () => fakeResponse('gone', { status: 410 }) })
  const results = await scrapeWith('bs', ['https://example.com/gone'], harness.ctx)
  assert.deepEqual(results, [])
  assert.ok(harness.warnings.some((warning) => warning.includes('410')))
})

test('bs honours an aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  const harness = makeHarness({
    http: async (_url, init) => {
      assert.equal(init?.signal?.aborted, true)
      if (init?.signal?.aborted) throw new Error('request aborted')
      return fakeResponse(FIXTURE)
    },
  })
  const results = await scrapeWith(
    'bs',
    ['https://example.com/a', 'https://example.com/b'],
    harness.ctx,
    controller.signal,
  )
  assert.deepEqual(results, [])
  assert.equal(harness.warnings.length, 2)
  assert.ok(harness.warnings.every((warning) => warning.includes('aborted')))
})

test('bs scrapes duplicate URLs once', async () => {
  let calls = 0
  const harness = makeHarness({
    http: async () => {
      calls += 1
      return fakeResponse(FIXTURE)
    },
  })
  const results = await scrapeWith(
    'bs',
    ['https://example.com/a', 'https://example.com/a', 'https://example.com/a'],
    harness.ctx,
  )
  assert.equal(results.length, 1)
  assert.equal(calls, 1)
})

test('bs routes .pdf URLs to the PDF path and fails with a clear reason', async () => {
  const harness = makeHarness({
    http: async () => fakeResponse('this is not really a pdf', { contentType: 'application/pdf' }),
  })
  const results = await scrapeWith('bs', ['https://example.com/paper.pdf'], harness.ctx)
  assert.deepEqual(results, [])
  assert.ok(harness.warnings.some((warning) => warning.includes('not a PDF')))
  assert.deepEqual(harness.requests.map((request) => request.url), [
    'https://example.com/paper.pdf',
  ])
})

test('bs routes arxiv.org URLs to the arXiv API scraper', async () => {
  const harness = makeHarness({ http: async () => fakeResponse(ARXIV_ATOM, { contentType: 'application/atom+xml' }) })
  const results = await scrapeWith('bs', ['https://arxiv.org/abs/1706.03762'], harness.ctx)

  const document = first(results)
  assert.equal(document.url, 'https://arxiv.org/abs/1706.03762')
  assert.equal(document.title, 'Attention Is All You Need')
  assert.ok(
    document.raw_content.startsWith(
      'Published: 2017-06-12T00:00:00Z; Author: Vaswani, Shazeer; Content: ',
    ),
  )
  assert.equal(harness.requests[0]?.url, 'https://export.arxiv.org/api/query?id_list=1706.03762')
})

test('the pdf scraper fails loudly instead of faking an empty document', async () => {
  const harness = makeHarness({
    http: async () => fakeResponse('%PDF-1.4\nstream\n(x) Tj\nendstream'),
  })
  const results = await scrapeWith('pdf', ['https://example.com/paper.pdf'], harness.ctx)
  assert.deepEqual(results, [])
  assert.ok(
    harness.warnings.some(
      (warning) => warning.includes('no extractable text') && warning.includes('not bundled'),
    ),
  )
})

// ---------------------------------------------------------------------------
// dsh_web scraper
// ---------------------------------------------------------------------------

test('dsh_web maps an html seam response through the HTML extractor', async () => {
  const harness = makeHarness({ web: fakeWeb({ body: FIXTURE, kind: 'html' }) })
  const results = await scrapeWith('dsh_web', ['https://example.com/a'], harness.ctx)

  const document = first(results)
  assert.equal(document.url, 'https://example.com/a')
  assert.equal(document.title, 'Research notes — ensemble')
  assert.ok(document.raw_content.includes(LONG_PARAGRAPH))
  assert.deepEqual(document.image_urls, ['https://example.com/img/hero.png'])
  assert.equal(document.source_type, 'dsh_web')
})

test('dsh_web passes a text seam response through unchanged', async () => {
  const text = 'Plain text document body. '.repeat(6)
  assert.ok(text.length >= MIN_SCRAPED_CONTENT_LENGTH)
  const harness = makeHarness({ web: fakeWeb({ body: text, kind: 'text' }) })
  const results = await scrapeWith('dsh_web', ['https://example.com/notes.txt'], harness.ctx)

  const document = first(results)
  assert.equal(document.raw_content, text)
  assert.equal(document.title, '')
  assert.deepEqual(document.image_urls, [])
})

test('dsh_web fails per URL when the deployment has no web seam', async () => {
  const harness = makeHarness()
  const results = await scrapeWith('dsh_web', ['https://example.com/a'], harness.ctx)
  assert.deepEqual(results, [])
  assert.ok(harness.warnings.some((warning) => warning.includes('web seam')))
})

test('dsh_web reports an unavailable seam and non-2xx responses', async () => {
  const unavailable = makeHarness({ web: fakeWeb({ body: FIXTURE, kind: 'html' }, false) })
  assert.deepEqual(
    await scrapeWith('dsh_web', ['https://example.com/a'], unavailable.ctx),
    [],
  )
  assert.ok(unavailable.warnings.some((warning) => warning.includes('not available')))

  const failing = makeHarness({ web: fakeWeb({ body: 'nope', kind: 'html', status: 503 }) })
  assert.deepEqual(await scrapeWith('dsh_web', ['https://example.com/a'], failing.ctx), [])
  assert.ok(failing.warnings.some((warning) => warning.includes('503')))
})

// ---------------------------------------------------------------------------
// browser scraper
// ---------------------------------------------------------------------------

test('the browser scraper is documented as not bundled and throws', async () => {
  const registry = createScraperRegistry()
  const definition = registry.get('browser')
  assert.ok(definition)
  const harness = makeHarness()
  await assert.rejects(
    definition.scrape(['https://example.com/a'], harness.ctx),
    (error: unknown) => {
      assert.ok(error instanceof ScraperError)
      assert.match((error as Error).message, /not bundled/)
      assert.match((error as Error).message, /'bs'/)
      assert.match((error as Error).message, /'dsh_web'/)
      return true
    },
  )
})
