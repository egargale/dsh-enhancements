/**
 * Offline unit tests for the retriever module tree.
 *
 * No network access: every retriever is driven through a fake `Runtime` whose
 * `http` records `{url, init}` and replays canned responses, and whose `env`
 * serves a fixed credential map. Request-shape and response-parse assertions
 * therefore run against the exported `build*Request` / `parse*Response` helpers
 * and against each definition's `search()`.
 *
 * @module gpt-researcher/test/retrievers
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RetrieverError,
  buildArxivRequest,
  buildBingRequest,
  buildBochaRequest,
  buildBraveRequest,
  buildCustomRequest,
  buildDuckduckgoRequest,
  buildExaRequest,
  buildGetXapiRequest,
  buildGoogleApiRequest,
  buildPubMedSearchRequest,
  buildSearchApiRequest,
  buildSemanticScholarRequest,
  buildSerpApiRequest,
  buildSearxRequest,
  buildSerperRequest,
  buildTavilyRequest,
  buildXquikRequest,
  createRetrieverRegistry,
  parseArxivFeed,
  parseBingResponse,
  parseBochaResponse,
  parseBraveResponse,
  parseCustomResponse,
  parseDuckduckgoHtml,
  parseExaResponse,
  parseGetXapiResponse,
  parseGoogleHtml,
  parseGoogleResponse,
  parsePubMedSearchResponse,
  parseSearchApiResponse,
  parseSemanticScholarResponse,
  parseSerpApiResponse,
  parseSearxResponse,
  parseSerperResponse,
  parseTavilyResponse,
  parseXquikResponse,
} from '../../src/retrievers/index.ts'
import type { RetrieverContext, RetrieverDefinition } from '../../src/retrievers/index.ts'
import type {
  HttpFetch,
  HttpRequestInit,
  Runtime,
  WebSeam,
} from '../../src/runtime.ts'
import type { SearchResult } from '../../src/types.ts'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One canned HTTP response. */
interface CannedResponse {
  status?: number
  json?: unknown
  text?: string
}

/** One recorded HTTP call. */
interface RecordedCall {
  url: string
  init: HttpRequestInit | undefined
}

/** A fixed credential map; every keyed retriever finds its key here. */
const ENV: Record<string, string> = {
  TAVILY_API_KEY: 'tavily-key',
  EXA_API_KEY: 'exa-key',
  BRAVE_API_KEY: 'brave-key',
  SERPER_API_KEY: 'serper-key',
  SEARCHAPI_API_KEY: 'searchapi-key',
  SERPAPI_API_KEY: 'serpapi-key',
  BING_API_KEY: 'bing-key',
  BOCHA_API_KEY: 'bocha-key',
  XQUIK_API_KEY: 'xquik-key',
  GETXAPI_API_KEY: 'getxapi-key',
  GOOGLE_API_KEY: 'google-key',
  GOOGLE_CX_KEY: 'google-cx',
  RETRIEVER_ENDPOINT: 'https://custom.example/search',
  SEARX_URL: 'https://searx.example/',
}

/** Build a recording `HttpFetch` that replays `queue` in order. */
function recordingHttp(queue: CannedResponse[]): { calls: RecordedCall[]; http: HttpFetch } {
  const calls: RecordedCall[] = []
  const pending = [...queue]
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, init })
    const canned = pending.shift() ?? { status: 200, json: {} }
    const status = canned.status ?? 200
    const text =
      canned.text ?? (canned.json === undefined ? '' : JSON.stringify(canned.json))
    return {
      ok: status >= 200 && status < 300,
      status,
      header: () => null,
      text: async () => text,
      json: async () => {
        if (canned.json !== undefined) return canned.json
        return JSON.parse(text) as unknown
      },
    }
  }
  return { calls, http }
}

/** Build a `RetrieverContext` around the given HTTP seam and credential map. */
function context(
  http: HttpFetch,
  web?: WebSeam,
  env: Record<string, string | undefined> = ENV,
): RetrieverContext {
  const runtime: Runtime = {
    llm: { complete: async () => ({ text: '' }) },
    http,
    env: (name) => env[name],
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    progress: () => {},
    ...(web ? { web } : {}),
  }
  return {
    runtime,
    config: {
      maxSearchResultsPerQuery: 5,
      userAgent: 'dsh-test-agent',
      timeoutMs: 1_000,
      language: 'english',
    },
  }
}

/** Options accepted by {@link runRetriever}. */
interface RunOptions {
  query?: string
  queryDomains?: string[]
  maxResults?: number
  signal?: AbortSignal
}

/** Resolve, create, and run one registered retriever. */
async function runRetriever(
  name: string,
  ctx: RetrieverContext,
  options: RunOptions = {},
): Promise<SearchResult[]> {
  const definition = createRetrieverRegistry().get(name)
  assert.ok(definition, `retriever '${name}' must be registered`)
  const instance = definition.create(ctx, {
    query: options.query ?? 'test query',
    ...(options.queryDomains ? { queryDomains: options.queryDomains } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return instance.search(options.maxResults)
}

/** Parse a JSON request body recorded by the fake seam. */
function jsonBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.init?.body ?? '{}') as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry lists every upstream retriever name plus dsh_web', () => {
  const names = createRetrieverRegistry().names()
  for (const name of [
    'tavily',
    'duckduckgo',
    'exa',
    'brave',
    'serper',
    'searchapi',
    'searx',
    'google',
    'bing',
    'arxiv',
    'semantic_scholar',
    'pubmed_central',
    'serpapi',
    'bocha',
    'xquik',
    'getxapi',
    'custom',
    'dsh_web',
  ]) {
    assert.ok(names.includes(name), `registry is missing '${name}'`)
  }
  assert.equal(names.length, 18)
  // DEVIATION: mcp is intentionally not ported (DSH already has MCP tools).
  assert.equal(names.includes('mcp'), false)
})

test('keyless flags and key lists match the documented contract', () => {
  const registry = createRetrieverRegistry()
  const keyless = registry
    .all()
    .filter((definition) => definition.keyless)
    .map((definition) => definition.name)
    .sort()
  assert.deepEqual(keyless, [
    'arxiv',
    'dsh_web',
    'duckduckgo',
    'google',
    'pubmed_central',
    'searx',
    'semantic_scholar',
  ])
  for (const definition of registry.all()) {
    if (!definition.keyless) {
      assert.ok(definition.keys.length > 0, `${definition.name} must list its env vars`)
    }
  }
  assert.deepEqual(registry.get('tavily')?.keys, ['TAVILY_API_KEY'])
  assert.deepEqual(registry.get('exa')?.keys, ['EXA_API_KEY'])
  assert.deepEqual(registry.get('brave')?.keys, ['BRAVE_API_KEY'])
  assert.deepEqual(registry.get('serper')?.keys, ['SERPER_API_KEY'])
  assert.deepEqual(registry.get('searchapi')?.keys, ['SEARCHAPI_API_KEY'])
  assert.deepEqual(registry.get('serpapi')?.keys, ['SERPAPI_API_KEY'])
  assert.deepEqual(registry.get('bing')?.keys, ['BING_API_KEY'])
  assert.deepEqual(registry.get('bocha')?.keys, ['BOCHA_API_KEY'])
  assert.deepEqual(registry.get('xquik')?.keys, ['XQUIK_API_KEY'])
  assert.deepEqual(registry.get('getxapi')?.keys, ['GETXAPI_API_KEY'])
  assert.deepEqual(registry.get('custom')?.keys, ['RETRIEVER_ENDPOINT'])
  assert.deepEqual(registry.get('google')?.keys, ['GOOGLE_API_KEY', 'GOOGLE_CX_KEY'])
})

test('resolve rejects unknown names and lists the valid ones', () => {
  const registry = createRetrieverRegistry()
  const { runtime } = context(recordingHttp([]).http)
  assert.throws(
    () => registry.resolve(['nope'], runtime),
    (error: unknown) => {
      assert.ok(error instanceof RetrieverError)
      assert.match(error.message, /'nope'/)
      assert.match(error.message, /tavily/)
      assert.match(error.message, /dsh_web/)
      return true
    },
  )
})

test('resolve names the missing credential and suggests keyless retrievers', () => {
  const registry = createRetrieverRegistry()
  const { runtime } = context(recordingHttp([]).http, undefined, {})
  assert.throws(
    () => registry.resolve(['exa'], runtime),
    (error: unknown) => {
      assert.ok(error instanceof RetrieverError)
      assert.match(error.message, /exa/)
      assert.match(error.message, /EXA_API_KEY/)
      assert.match(error.message, /duckduckgo/)
      assert.match(error.message, /dsh_web/)
      return true
    },
  )
  // A keyed retriever resolves cleanly once its variable is present.
  assert.equal(registry.resolve(['exa'], context(recordingHttp([]).http).runtime).length, 1)
})

test('createRetrieverRegistry registers extras last so they override built-ins', () => {
  const override: RetrieverDefinition = {
    name: 'tavily',
    keys: [],
    keyless: true,
    description: 'test override',
    create: () => ({ search: async () => [] }),
  }
  const registry = createRetrieverRegistry([override])
  assert.equal(registry.get('tavily'), override)
  assert.equal(registry.names().filter((name) => name === 'tavily').length, 1)
})

test('retrievers compose the run signal with the request timeout', async () => {
  const { calls, http } = recordingHttp([{ json: { results: [] } }])
  const controller = new AbortController()
  controller.abort()
  await runRetriever('tavily', context(http), { signal: controller.signal })
  assert.equal(calls[0]?.init?.signal?.aborted, true)
})

// ---------------------------------------------------------------------------
// tavily
// ---------------------------------------------------------------------------

test('tavily: request shape and response parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        query: 'deep learning',
        results: [
          {
            title: 'Deep Learning 101',
            url: 'https://example.com/dl',
            content: 'A primer on deep learning.',
            score: 0.97,
            raw_content: 'Full page text.',
          },
          { title: 'Neural nets', url: 'https://example.com/nn', content: 'Networks.' },
        ],
      },
    },
  ])
  const results = await runRetriever('tavily', context(http), {
    query: 'deep learning',
    queryDomains: ['example.com'],
    maxResults: 2,
  })

  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.url, 'https://api.tavily.com/search')
  assert.equal(call.init?.method, 'POST')
  assert.equal(call.init?.headers?.['Content-Type'], 'application/json')
  const body = jsonBody(call)
  assert.equal(body.query, 'deep learning')
  assert.equal(body.max_results, 2)
  assert.deepEqual(body.include_domains, ['example.com'])
  assert.equal(body.api_key, 'tavily-key')
  assert.equal(body.search_depth, 'basic')

  assert.deepEqual(results, [
    {
      url: 'https://example.com/dl',
      title: 'Deep Learning 101',
      content: 'A primer on deep learning.',
      score: 0.97,
      raw_content: 'Full page text.',
    },
    {
      url: 'https://example.com/nn',
      title: 'Neural nets',
      content: 'Networks.',
    },
  ])
})

test('tavily: the config cap is the fallback when no maxResults is given', async () => {
  const { calls, http } = recordingHttp([{ json: { results: [] } }])
  await runRetriever('tavily', context(http))
  assert.equal(jsonBody(calls[0]!).max_results, 5)
})

test('tavily: helper builds an unrestricted body without domains', () => {
  const request = buildTavilyRequest({ query: 'q', maxResults: 3, apiKey: 'k' })
  assert.deepEqual((JSON.parse(request.init.body ?? '{}') as { include_domains: unknown }).include_domains, null)
})

// ---------------------------------------------------------------------------
// exa
// ---------------------------------------------------------------------------

test('exa: request shape and response parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        results: [
          {
            title: 'Exa hit',
            url: 'https://exa.example/a',
            text: 'Exa body text',
            score: 0.42,
            publishedDate: '2024-01-02',
            author: 'A. Author',
          },
        ],
      },
    },
  ])
  const results = await runRetriever('exa', context(http), {
    query: 'transformers',
    queryDomains: ['exa.example'],
    maxResults: 3,
  })

  const call = calls[0]!
  assert.equal(call.url, 'https://api.exa.ai/search')
  assert.equal(call.init?.method, 'POST')
  assert.equal(call.init?.headers?.['x-api-key'], 'exa-key')
  const body = jsonBody(call)
  assert.equal(body.query, 'transformers')
  assert.equal(body.numResults, 3)
  assert.equal(body.type, 'neural')
  assert.equal(body.useAutoprompt, false)
  assert.deepEqual(body.includeDomains, ['exa.example'])

  assert.deepEqual(results, [
    {
      url: 'https://exa.example/a',
      title: 'Exa hit',
      content: 'Exa body text',
      score: 0.42,
      published_date: '2024-01-02',
      author: 'A. Author',
    },
  ])
})

// ---------------------------------------------------------------------------
// brave
// ---------------------------------------------------------------------------

test('brave: request shape and response parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        web: {
          results: [
            {
              title: 'Brave hit',
              url: 'https://brave.example/a',
              description: 'Brave snippet',
              page_age: '2024-03-01',
            },
          ],
        },
      },
    },
  ])
  const results = await runRetriever('brave', context(http), {
    query: 'brave search',
    queryDomains: ['brave.example'],
    maxResults: 2,
  })

  const call = calls[0]!
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search')
  assert.equal(url.searchParams.get('q'), '(site:brave.example) brave search')
  assert.equal(url.searchParams.get('count'), '2')
  assert.equal(call.init?.headers?.['X-Subscription-Token'], 'brave-key')
  assert.equal(call.init?.headers?.['Accept'], 'application/json')

  assert.deepEqual(results, [
    {
      url: 'https://brave.example/a',
      title: 'Brave hit',
      content: 'Brave snippet',
      published_date: '2024-03-01',
    },
  ])
})

// ---------------------------------------------------------------------------
// serper
// ---------------------------------------------------------------------------

test('serper: request shape and response parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        organic: [
          {
            title: 'Serper hit',
            link: 'https://serper.example/a',
            snippet: 'Serper snippet',
            position: 1,
          },
        ],
      },
    },
  ])
  const results = await runRetriever('serper', context(http), {
    query: 'serper query',
    queryDomains: ['serper.example'],
    maxResults: 2,
  })

  const call = calls[0]!
  assert.equal(call.url, 'https://google.serper.dev/search')
  assert.equal(call.init?.method, 'POST')
  assert.equal(call.init?.headers?.['X-API-KEY'], 'serper-key')
  const body = jsonBody(call)
  assert.equal(body.q, 'serper query site:serper.example')
  assert.equal(body.num, 2)

  assert.deepEqual(results, [
    {
      url: 'https://serper.example/a',
      title: 'Serper hit',
      content: 'Serper snippet',
      position: 1,
    },
  ])
})

test('serper: helper appends excluded sites before the domain filter', () => {
  const request = buildSerperRequest({
    query: 'q',
    maxResults: 1,
    queryDomains: ['a.example', 'b.example'],
    excludeSites: ['spam.example'],
    apiKey: 'k',
    country: 'us',
    language: 'en',
    timeRange: 'qdr:w',
  })
  const body = JSON.parse(request.init.body ?? '{}') as Record<string, unknown>
  assert.equal(body.q, 'q -site:spam.example site:a.example OR site:b.example')
  assert.equal(body.gl, 'us')
  assert.equal(body.hl, 'en')
  assert.equal(body.tbs, 'qdr:w')
})

// ---------------------------------------------------------------------------
// searchapi
// ---------------------------------------------------------------------------

test('searchapi: request shape, YouTube skip, and response parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        organic_results: [
          {
            title: 'SearchApi hit',
            link: 'https://searchapi.example/a',
            snippet: 'SearchApi snippet',
          },
          {
            title: 'Video',
            link: 'https://www.youtube.com/watch?v=1',
            snippet: 'skip me',
          },
        ],
      },
    },
  ])
  const results = await runRetriever('searchapi', context(http), {
    query: 'searchapi query',
    queryDomains: ['searchapi.example'],
    maxResults: 3,
  })

  const call = calls[0]!
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://www.searchapi.io/api/v1/search')
  assert.equal(url.searchParams.get('q'), '(site:searchapi.example) searchapi query')
  assert.equal(url.searchParams.get('engine'), 'google')
  assert.equal(call.init?.headers?.Authorization, 'Bearer searchapi-key')
  assert.equal(call.init?.headers?.['X-SearchApi-Source'], 'gpt-researcher')

  assert.deepEqual(results, [
    {
      url: 'https://searchapi.example/a',
      title: 'SearchApi hit',
      content: 'SearchApi snippet',
    },
  ])
})

test('searchapi: helper omits the domain group when no domains are given', () => {
  const request = buildSearchApiRequest({ query: 'plain', apiKey: 'k' })
  assert.equal(new URL(request.url).searchParams.get('q'), 'plain')
})

// ---------------------------------------------------------------------------
// searx
// ---------------------------------------------------------------------------

test('searx: request shape, cap, and response parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        results: [
          { url: 'https://searx.example/a', title: 'Searx hit', content: 'Searx content' },
          { url: 'https://searx.example/b', title: 'Second hit', content: 'Second content' },
        ],
      },
    },
  ])
  const results = await runRetriever('searx', context(http), {
    query: 'searx query',
    queryDomains: ['searx.example'],
    maxResults: 1,
  })

  const call = calls[0]!
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://searx.example/search')
  assert.equal(url.searchParams.get('q'), '(site:searx.example) searx query')
  assert.equal(url.searchParams.get('format'), 'json')
  assert.equal(call.init?.headers?.Accept, 'application/json')

  assert.deepEqual(results, [
    { url: 'https://searx.example/a', title: 'Searx hit', content: 'Searx content' },
  ])
})

test('searx: falls back to the default public instance when SEARX_URL is unset', () => {
  const request = buildSearxRequest({ query: 'q' })
  assert.equal(new URL(request.url).origin, 'https://searx.be')
})

// ---------------------------------------------------------------------------
// duckduckgo
// ---------------------------------------------------------------------------

/** A realistic slice of DuckDuckGo's HTML results page. */
const DUCKDUCKGO_HTML = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-a&amp;rut=abc">DDG Result A</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-a">Snippet A text</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-b">Result B</a>
    </h2>
    <a class="result__snippet">Snippet B text</a>
  </div>
</div>
`

test('duckduckgo: request shape, HTML parse, and cap', async () => {
  const { calls, http } = recordingHttp([{ text: DUCKDUCKGO_HTML }])
  const results = await runRetriever('duckduckgo', context(http), {
    query: 'duckduckgo query',
    queryDomains: ['example.com'],
    maxResults: 1,
  })

  const call = calls[0]!
  assert.equal(call.url, 'https://html.duckduckgo.com/html/')
  assert.equal(call.init?.method, 'POST')
  assert.equal(call.init?.headers?.['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(call.init?.headers?.['User-Agent'], 'dsh-test-agent')
  const body = new URLSearchParams(call.init?.body ?? '')
  assert.equal(body.get('q'), '(site:example.com) duckduckgo query')
  assert.equal(body.get('kl'), 'wt-wt')

  assert.deepEqual(results, [
    { url: 'https://example.com/ddg-a', title: 'DDG Result A', content: 'Snippet A text' },
  ])
})

test('duckduckgo: the parser returns every result without a cap', () => {
  const parsed = parseDuckduckgoHtml(DUCKDUCKGO_HTML)
  assert.deepEqual(parsed, [
    { url: 'https://example.com/ddg-a', title: 'DDG Result A', content: 'Snippet A text' },
    { url: 'https://example.com/ddg-b', title: 'Result B', content: 'Snippet B text' },
  ])
})

// ---------------------------------------------------------------------------
// arxiv
// ---------------------------------------------------------------------------

/** A realistic slice of an arXiv Atom feed. */
const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query: search_query=all:graph neural networks</title>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>A Study of Graph Neural Networks</title>
    <summary>We study graph neural networks in depth.</summary>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v1"/>
  </entry>
</feed>
`

test('arxiv: request shape and Atom parse', async () => {
  const { calls, http } = recordingHttp([{ text: ARXIV_FEED }])
  const results = await runRetriever('arxiv', context(http), {
    query: 'graph neural networks',
    maxResults: 2,
  })

  const call = calls[0]!
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://export.arxiv.org/api/query')
  assert.equal(url.searchParams.get('search_query'), 'all:graph neural networks')
  assert.equal(url.searchParams.get('max_results'), '2')
  assert.equal(url.searchParams.get('start'), '0')
  assert.equal(url.searchParams.get('sortBy'), 'relevance')

  assert.deepEqual(results, [
    {
      url: 'http://arxiv.org/pdf/2401.12345v1',
      title: 'A Study of Graph Neural Networks',
      content: 'We study graph neural networks in depth.',
    },
  ])
})

test('arxiv: a field-qualified query is passed through unchanged', () => {
  const request = buildArxivRequest({ query: 'ti:transformer', maxResults: 1 })
  assert.equal(new URL(request.url).searchParams.get('search_query'), 'ti:transformer')
})

// ---------------------------------------------------------------------------
// semantic_scholar
// ---------------------------------------------------------------------------

test('semantic_scholar: request shape, open-access filter, and parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        total: 2,
        data: [
          {
            title: 'Paper One',
            abstract: 'Abstract one.',
            url: 'https://s2.example/1',
            venue: 'NeurIPS',
            year: 2023,
            isOpenAccess: true,
            openAccessPdf: { url: 'https://pdf.example/1.pdf' },
          },
          { title: 'Closed Paper', abstract: 'Nope', isOpenAccess: false },
        ],
      },
    },
  ])
  const results = await runRetriever('semantic_scholar', context(http), {
    query: 'open access papers',
    maxResults: 2,
  })

  const call = calls[0]!
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://api.semanticscholar.org/graph/v1/paper/search')
  assert.equal(url.searchParams.get('query'), 'open access papers')
  assert.equal(url.searchParams.get('limit'), '2')
  assert.equal(url.searchParams.get('sort'), 'relevance')
  assert.match(url.searchParams.get('fields') ?? '', /openAccessPdf/)

  assert.deepEqual(results, [
    {
      url: 'https://pdf.example/1.pdf',
      title: 'Paper One',
      content: 'Abstract one.',
      venue: 'NeurIPS',
      year: 2023,
      landing_page_url: 'https://s2.example/1',
    },
  ])
})

test('semantic_scholar: helper requests the documented field list', () => {
  const request = buildSemanticScholarRequest({ query: 'q', maxResults: 4 })
  assert.equal(
    new URL(request.url).searchParams.get('fields'),
    'title,abstract,url,venue,year,authors,isOpenAccess,openAccessPdf',
  )
})

// ---------------------------------------------------------------------------
// pubmed_central
// ---------------------------------------------------------------------------

/** A realistic slice of a PubMed Central full-text article. */
const PUBMED_XML = `<pmc-articleset><article>
  <front><article-meta>
    <title-group><article-title>Vitamin D and Immunity</article-title></title-group>
    <abstract><p>We review vitamin D and immune function.</p></abstract>
  </article-meta></front>
  <body><p>Body text here.</p></body>
</article></pmc-articleset>`

test('pubmed_central: two-stage request shape and full-text parse', async () => {
  const { calls, http } = recordingHttp([
    { json: { esearchresult: { idlist: ['PMC1234567'] } } },
    { text: PUBMED_XML },
  ])
  const results = await runRetriever('pubmed_central', context(http), {
    query: 'vitamin d',
    maxResults: 3,
  })

  assert.equal(calls.length, 2)
  const search = new URL(calls[0]!.url)
  assert.equal(
    search.origin + search.pathname,
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
  )
  assert.equal(search.searchParams.get('db'), 'pmc')
  assert.equal(search.searchParams.get('term'), 'vitamin d')
  assert.equal(search.searchParams.get('retmax'), '3')
  assert.equal(search.searchParams.get('retmode'), 'json')
  assert.equal(search.searchParams.get('sort'), 'relevance')
  assert.equal(search.searchParams.has('api_key'), false)

  const fetch = new URL(calls[1]!.url)
  assert.equal(
    fetch.origin + fetch.pathname,
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
  )
  assert.equal(fetch.searchParams.get('db'), 'pmc')
  assert.equal(fetch.searchParams.get('id'), 'PMC1234567')
  assert.equal(fetch.searchParams.get('rettype'), 'full')
  assert.equal(fetch.searchParams.get('retmode'), 'xml')

  const fullText =
    'Title: Vitamin D and Immunity\n\n' +
    'Abstract: We review vitamin D and immune function.\n\n' +
    'Body: Body text here.'
  assert.deepEqual(results, [
    {
      url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/',
      title: 'Vitamin D and Immunity',
      body: fullText,
      raw_content: fullText,
    },
  ])
})

test('pubmed_central: the pubmed database adds the full-text filter', () => {
  const request = buildPubMedSearchRequest({
    query: 'cancer',
    maxResults: 2,
    dbType: 'pubmed',
    apiKey: 'ncbi-key',
  })
  const params = new URL(request.url).searchParams
  assert.equal(params.get('db'), 'pubmed')
  assert.equal(params.get('term'), 'cancer AND (ffrft[filter] OR pmc[filter])')
  assert.equal(params.get('api_key'), 'ncbi-key')
})

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

test('a non-2xx response throws a RetrieverError naming the retriever and status', async () => {
  const cases: Array<[string, number]> = [
    ['tavily', 401],
    ['exa', 500],
    ['brave', 403],
    ['serper', 401],
    ['searchapi', 500],
    ['searx', 503],
    ['duckduckgo', 500],
    ['arxiv', 500],
    ['semantic_scholar', 429],
    ['pubmed_central', 401],
  ]
  for (const [name, status] of cases) {
    const { http } = recordingHttp([{ status, json: { error: 'nope' } }])
    await assert.rejects(
      runRetriever(name, context(http)),
      (error: unknown) => {
        assert.ok(error instanceof RetrieverError, `${name} must throw RetrieverError`)
        assert.match(error.message, new RegExp(name))
        assert.match(error.message, new RegExp(String(status)))
        return true
      },
      `${name} must reject on ${status}`,
    )
  }
})

// ---------------------------------------------------------------------------
// dsh_web
// ---------------------------------------------------------------------------

/** A seam that records the calls made to it. */
function fakeWebSeam(available = true): { seam: WebSeam; calls: Array<{ query: string; max?: number }> } {
  const calls: Array<{ query: string; max?: number }> = []
  const seam: WebSeam = {
    available: () => available,
    search: async (query, maxResults) => {
      calls.push({ query, ...(maxResults === undefined ? {} : { max: maxResults }) })
      return [{ url: 'https://seam.example/a', title: 'Seam hit', snippet: 'Seam snippet' }]
    },
    fetch: async (url) => ({ url, status: 200, body: '', kind: 'text' }),
  }
  return { seam, calls }
}

test('dsh_web: forwards the query to the seam and maps snippet to content', async () => {
  const { seam, calls } = fakeWebSeam()
  const results = await runRetriever('dsh_web', context(recordingHttp([]).http, seam), {
    query: 'seam query',
    queryDomains: ['seam.example'],
    maxResults: 2,
  })
  assert.deepEqual(calls, [{ query: '(site:seam.example) seam query', max: 2 }])
  assert.deepEqual(results, [
    { url: 'https://seam.example/a', title: 'Seam hit', content: 'Seam snippet' },
  ])
})

test('dsh_web: throws a RetrieverError when the seam is absent', async () => {
  await assert.rejects(
    runRetriever('dsh_web', context(recordingHttp([]).http)),
    (error: unknown) => {
      assert.ok(error instanceof RetrieverError)
      assert.match(error.message, /dsh_web/)
      assert.match(error.message, /Runtime\.web/)
      return true
    },
  )
})

test('dsh_web: throws a RetrieverError when the seam is unavailable', async () => {
  const { seam } = fakeWebSeam(false)
  await assert.rejects(
    runRetriever('dsh_web', context(recordingHttp([]).http, seam)),
    RetrieverError,
  )
})

// ---------------------------------------------------------------------------
// Remaining providers: request shape + parse
// ---------------------------------------------------------------------------

test('serpapi: request shape and parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        organic_results: [
          { title: 'SerpApi hit', link: 'https://serpapi.example/a', snippet: 'Snippet' },
          { title: 'Video', link: 'https://www.youtube.com/watch?v=1', snippet: 'skip' },
        ],
      },
    },
  ])
  const results = await runRetriever('serpapi', context(http), {
    query: 'serpapi query',
    queryDomains: ['serpapi.example'],
    maxResults: 3,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin + url.pathname, 'https://serpapi.com/search.json')
  assert.equal(url.searchParams.get('q'), 'serpapi query site:serpapi.example')
  assert.equal(url.searchParams.get('api_key'), 'serpapi-key')
  assert.deepEqual(results, [
    { url: 'https://serpapi.example/a', title: 'SerpApi hit', content: 'Snippet' },
  ])
  assert.equal(parseSerpApiResponse({}).length, 0)
})

test('bing: request shape and parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        webPages: {
          value: [{ name: 'Bing hit', url: 'https://bing.example/a', snippet: 'Bing snippet' }],
        },
      },
    },
  ])
  const results = await runRetriever('bing', context(http), {
    query: 'bing query',
    queryDomains: ['bing.example'],
    maxResults: 4,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin + url.pathname, 'https://api.bing.microsoft.com/v7.0/search')
  assert.equal(url.searchParams.get('q'), '(site:bing.example) bing query')
  assert.equal(url.searchParams.get('count'), '4')
  assert.equal(url.searchParams.get('responseFilter'), 'Webpages')
  assert.equal(calls[0]!.init?.headers?.['Ocp-Apim-Subscription-Key'], 'bing-key')
  assert.deepEqual(results, [
    { url: 'https://bing.example/a', title: 'Bing hit', content: 'Bing snippet' },
  ])
})

test('bocha: request shape and parse', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        data: {
          webPages: {
            value: [{ name: 'BoCha hit', url: 'https://bocha.example/a', snippet: 'BoCha text' }],
          },
        },
      },
    },
  ])
  const results = await runRetriever('bocha', context(http), {
    query: 'bocha query',
    queryDomains: ['bocha.example'],
    maxResults: 6,
  })
  const call = calls[0]!
  assert.equal(call.url, 'https://api.bochaai.com/v1/web-search')
  assert.equal(call.init?.headers?.Authorization, 'Bearer bocha-key')
  const body = jsonBody(call)
  assert.equal(body.query, '(site:bocha.example) bocha query')
  assert.equal(body.count, 6)
  assert.equal(body.freshness, 'noLimit')
  assert.deepEqual(results, [
    { url: 'https://bocha.example/a', title: 'BoCha hit', content: 'BoCha text' },
  ])
})

test('google: the Custom Search path is used when both keys are configured', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        items: [
          { title: 'Google hit', link: 'https://google.example/a', snippet: 'Google snippet' },
          { title: 'Video', link: 'https://www.youtube.com/watch?v=1', snippet: 'skip' },
        ],
      },
    },
  ])
  const results = await runRetriever('google', context(http), {
    query: 'google query',
    queryDomains: ['google.example'],
    maxResults: 3,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/customsearch/v1')
  assert.equal(url.searchParams.get('q'), '(site:google.example) google query')
  assert.equal(url.searchParams.get('key'), 'google-key')
  assert.equal(url.searchParams.get('cx'), 'google-cx')
  assert.equal(url.searchParams.get('num'), '3')
  assert.deepEqual(results, [
    { url: 'https://google.example/a', title: 'Google hit', content: 'Google snippet' },
  ])
  assert.equal(parseGoogleResponse({}).length, 0)
})

test('google: the keyless path scrapes the public HTML endpoint', async () => {
  const { calls, http } = recordingHttp([{ text: '<html><body>no results</body></html>' }])
  const env: Record<string, string | undefined> = {
    ...ENV,
    GOOGLE_API_KEY: undefined,
    GOOGLE_CX_KEY: undefined,
  }
  const results = await runRetriever('google', context(http, undefined, env), {
    query: 'google query',
    maxResults: 2,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin + url.pathname, 'https://www.google.com/search')
  assert.equal(url.searchParams.get('q'), 'google query')
  assert.equal(url.searchParams.get('num'), '2')
  assert.equal(calls[0]!.init?.headers?.['User-Agent'], 'dsh-test-agent')
  assert.equal(results.length, 0)
})

test('xquik: request shape and tweet rendering', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        tweets: [
          {
            author: { username: 'researcher' },
            text: 'A short tweet about retrieval.',
            id: '12345',
            likeCount: 7,
            retweetCount: 2,
            viewCount: 100,
          },
        ],
      },
    },
  ])
  const results = await runRetriever('xquik', context(http), {
    query: 'retrieval',
    maxResults: 400,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin + url.pathname, 'https://xquik.com/api/v1/x/tweets/search')
  assert.equal(url.searchParams.get('q'), 'retrieval')
  assert.equal(url.searchParams.get('limit'), '200')
  assert.equal(url.searchParams.get('queryType'), 'Top')
  assert.equal(calls[0]!.init?.headers?.['X-API-Key'], 'xquik-key')
  assert.deepEqual(results, [
    {
      url: 'https://x.com/researcher/status/12345',
      title: '@researcher: A short tweet about retrieval.',
      content: 'A short tweet about retrieval.\n\n[7 likes, 2 RTs, 100 views]',
    },
  ])
})

test('getxapi: request shape and tolerant tweet rendering', async () => {
  const { calls, http } = recordingHttp([
    {
      json: {
        data: [
          {
            author: { userName: 'analyst' },
            full_text: 'A tweet using the snake_case fallbacks.',
            id_str: '999',
            favorite_count: 3,
            retweet_count: 1,
            reply_count: 0,
            view_count: 42,
          },
        ],
      },
    },
  ])
  const results = await runRetriever('getxapi', context(http), {
    query: 'fallbacks',
    maxResults: 5,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(
    url.origin + url.pathname,
    'https://api.getxapi.com/twitter/tweet/advanced_search',
  )
  assert.equal(url.searchParams.get('q'), 'fallbacks')
  assert.equal(calls[0]!.init?.headers?.Authorization, 'Bearer getxapi-key')
  assert.deepEqual(results, [
    {
      url: 'https://x.com/analyst/status/999',
      title: '@analyst: A tweet using the snake_case fallbacks.',
      content:
        'A tweet using the snake_case fallbacks.\n\n[likes:3 retweets:1 replies:0 views:42]',
    },
  ])
  assert.equal(parseGetXapiResponse({}).length, 0)
})

test('custom: request shape, extra params, and verbatim result preservation', async () => {
  const { calls, http } = recordingHttp([
    {
      json: [
        { url: 'https://custom.example/a', raw_content: 'Custom content', score: 9 },
      ],
    },
  ])
  const env = { ...ENV, RETRIEVER_ARG_JSON: '{"engine":"google"}' }
  const results = await runRetriever('custom', context(http, undefined, env), {
    query: 'custom query',
    maxResults: 5,
  })
  const url = new URL(calls[0]!.url)
  assert.equal(url.origin + url.pathname, 'https://custom.example/search')
  assert.equal(url.searchParams.get('query'), 'custom query')
  assert.equal(url.searchParams.get('engine'), 'google')
  assert.deepEqual(results, [
    { url: 'https://custom.example/a', raw_content: 'Custom content', score: 9, title: undefined, content: 'Custom content' },
  ])
  assert.equal(parseCustomResponse({ results: [] }).length, 0)
})

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

test('build*Request helpers construct provider URLs without network access', () => {
  const exa = buildExaRequest({
    query: 'q',
    maxResults: 2,
    apiKey: 'k',
    queryDomains: ['a.example'],
  })
  assert.equal(exa.url, 'https://api.exa.ai/search')
  assert.equal(exa.init.headers?.['x-api-key'], 'k')
  assert.deepEqual((JSON.parse(exa.init.body ?? '{}') as Record<string, unknown>).includeDomains, [
    'a.example',
  ])

  const brave = buildBraveRequest({ query: 'q', maxResults: 2, apiKey: 'k' })
  assert.equal(new URL(brave.url).searchParams.get('count'), '2')
  assert.equal(brave.init.headers?.['X-Subscription-Token'], 'k')

  const duckduckgo = buildDuckduckgoRequest({
    query: 'q',
    queryDomains: ['a.example'],
    userAgent: 'ua',
  })
  assert.equal(new URLSearchParams(duckduckgo.init.body ?? '').get('q'), '(site:a.example) q')
  assert.equal(duckduckgo.init.headers?.['User-Agent'], 'ua')

  const bing = buildBingRequest({ query: 'q', maxResults: 2, apiKey: 'k' })
  assert.equal(new URL(bing.url).searchParams.get('safeSearch'), 'Strict')
  assert.equal(bing.init.headers?.['Ocp-Apim-Subscription-Key'], 'k')

  const bocha = buildBochaRequest({ query: 'q', maxResults: 2, apiKey: 'k' })
  assert.equal((JSON.parse(bocha.init.body ?? '{}') as { count: number }).count, 2)

  const serpapi = buildSerpApiRequest({ query: 'q', apiKey: 'k', queryDomains: ['a.example'] })
  assert.equal(new URL(serpapi.url).searchParams.get('q'), 'q site:a.example')

  const xquik = buildXquikRequest({ query: 'q', maxResults: 10, apiKey: 'k' })
  assert.equal(new URL(xquik.url).searchParams.get('limit'), '10')

  const getxapi = buildGetXapiRequest({ query: 'q', apiKey: 'k' })
  assert.equal(new URL(getxapi.url).searchParams.get('q'), 'q')

  const custom = buildCustomRequest({
    endpoint: 'https://custom.example/search',
    query: 'q',
    params: { engine: 'google' },
  })
  assert.equal(new URL(custom.url).searchParams.get('engine'), 'google')

  const google = buildGoogleApiRequest({
    query: 'q',
    maxResults: 1,
    apiKey: 'k',
    cxKey: 'cx',
    queryDomains: ['a.example'],
  })
  assert.equal(new URL(google.url).searchParams.get('q'), '(site:a.example) q')
})

test('parsers tolerate sparse payloads without throwing', () => {
  assert.equal(parseTavilyResponse(null).length, 0)
  assert.equal(parseExaResponse({}).length, 0)
  assert.equal(parseBraveResponse({ web: {} }).length, 0)
  assert.equal(parseSerperResponse({ organic: [] }).length, 0)
  assert.equal(parseSearchApiResponse({}).length, 0)
  assert.equal(parseSearxResponse({}).length, 0)
  assert.equal(parseDuckduckgoHtml('not html at all').length, 0)
  assert.equal(parseArxivFeed('<feed></feed>').length, 0)
  assert.equal(parseSemanticScholarResponse({ data: [{ isOpenAccess: true }] }).length, 0)
  assert.equal(parsePubMedSearchResponse({}).length, 0)
  assert.equal(parseBingResponse({}).length, 0)
  assert.equal(parseBochaResponse({}).length, 0)
  assert.equal(parseSerpApiResponse({}).length, 0)
  assert.equal(parseXquikResponse({}).length, 0)
  assert.equal(parseCustomResponse({}).length, 0)

  const [sparse] = parseSerperResponse({ organic: [{}] })
  assert.ok(sparse)
  assert.equal(sparse.url, undefined)
  assert.equal(sparse.title, undefined)
  assert.equal(sparse.content, undefined)
})

// ---------------------------------------------------------------------------
// Regression: a malformed percent escape must not abort the parser
// ---------------------------------------------------------------------------

test('google skips an anchor with a malformed percent escape instead of throwing', () => {
  // `?discount=50%` is a real-world URL shape; decodeURIComponent throws on it.
  const html =
    '<a href="/url?q=https://shop.test/item?discount=50%&sa=U">Shop</a>' +
    '<a href="/url?q=https%3A%2F%2Fok.test%2Fpage&sa=U">Good</a>'
  const results = parseGoogleHtml(html)
  assert.ok(Array.isArray(results))
  assert.ok(
    results.some((result) => String(result.url ?? result.href ?? '').includes('ok.test')),
    'the well-formed anchor must still be parsed',
  )
})

test('duckduckgo skips a malformed uddg redirect instead of throwing', () => {
  const html =
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbad.test%2F%&rut=x">Bad</a>' +
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fok.test%2Fpage">Good</a>'
  const results = parseDuckduckgoHtml(html)
  assert.ok(Array.isArray(results))
  assert.ok(results.some((result) => String(result.url ?? result.href ?? '').includes('ok.test')))
})
