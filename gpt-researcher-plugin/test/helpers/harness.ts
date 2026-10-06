/**
 * Offline test harness for the gpt-researcher engine.
 *
 * Every seam the engine uses is faked here, so the full pipeline — planning,
 * retrieval, scraping, compression, report writing — runs deterministically
 * with no network and no model. That is what makes the integration tests in
 * `test/integration/` meaningful: they exercise the real engine code, not a
 * mock of it.
 *
 * The fakes mirror the real contracts deliberately, because a fake that is
 * "easier" than reality hides defects: `fakeHttp` accepts a `signal` (and
 * `delayMs` to lose a timeout race), `fakeWebSeam` rejects when the composed
 * signal aborts, and header lookup is case-insensitive on both sides.
 *
 * @module test/helpers/harness
 */

import { Config } from '../../src/config.ts'
import type { EngineDeps } from '../../src/deps.ts'
import { PromptFamily } from '../../src/prompts.ts'
import type { Runtime, WebSeam } from '../../src/runtime.ts'
import { RetrieverRegistry, type RetrieverDefinition } from '../../src/retrievers/base.ts'
import { ScraperRegistry, type ScraperDefinition } from '../../src/scraper/base.ts'
import type {
  ChatClient,
  ChatRequest,
  ChatResult,
  Logger,
  ProgressEvent,
  ScrapedContent,
  SearchResult,
} from '../../src/types.ts'
import { CostTracker } from '../../src/utils/costs.ts'

/** One scripted reply, matched against the flattened request text. */
export interface ScriptedReply {
  /** Matched against the concatenated message contents (and stop words). */
  match: RegExp | string
  reply: string
  /** Optional token usage to report for this reply. */
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** A {@link ChatClient} that answers from a script and records every request. */
export interface ScriptedChatClient extends ChatClient {
  readonly calls: ChatRequest[]
  /** Prompts seen so far, flattened, for assertions. */
  promptsSeen(): string[]
}

/**
 * Build a scripted chat client.
 *
 * @param replies - ordered rules; the first whose `match` hits the request wins.
 * @param fallback - reply for an unmatched request.
 * @returns the client plus its recorded calls.
 */
export function scriptedChatClient(
  replies: readonly ScriptedReply[],
  fallback = '{}',
): ScriptedChatClient {
  const calls: ChatRequest[] = []
  const client: ScriptedChatClient = {
    calls,
    promptsSeen: () => calls.map((call) => call.messages.map((m) => m.content).join('\n')),
    async complete(request: ChatRequest): Promise<ChatResult> {
      calls.push(request)
      const text = request.messages.map((message) => message.content).join('\n')
      for (const rule of replies) {
        const hit =
          typeof rule.match === 'string' ? text.includes(rule.match) : rule.match.test(text)
        if (hit) {
          return {
            text: rule.reply,
            ...(rule.usage === undefined ? {} : { usage: rule.usage }),
            provider: 'test',
            model: `test-${request.tier}`,
          }
        }
      }
      return { text: fallback, provider: 'test', model: `test-${request.tier}` }
    },
  }
  return client
}

/** A fake HTTP response. */
export interface FakeRoute {
  status?: number
  body: string
  headers?: Record<string, string>
}

/** The fake HTTP seam plus its request log. */
export interface FakeHttp {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean
    status: number
    header(name: string): string | null
    text(): Promise<string>
    json(): Promise<unknown>
  }>
  readonly requests: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }>
}

/**
 * Build a fake HTTP seam.
 *
 * @param routes - ordered `[matcher, response]` pairs; the first URL match wins.
 * @param fallback - response for an unmatched URL.
 * @returns the seam plus its request log.
 */
export function fakeHttp(
  routes: ReadonlyArray<[RegExp | string, FakeRoute]>,
  fallback: FakeRoute = { status: 404, body: '' },
): FakeHttp {
  const requests: FakeHttp['requests'] = []
  const seam = (async (
    url: string,
    init?: {
      method?: string
      headers?: Record<string, string>
      body?: string
      signal?: AbortSignal
      /** Simulate latency so a timeout/abort can win the race, as real I/O does. */
      delayMs?: number
    },
  ) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      ...(init?.body === undefined ? {} : { body: init.body }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
    })
    if (init?.signal?.aborted) {
      const reason = init.signal.reason
      throw reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError')
    }
    if (init?.delayMs !== undefined && init.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, init.delayMs as number)
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            const reason = init?.signal?.reason
            reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
      })
    }
    let route = fallback
    for (const [matcher, candidate] of routes) {
      const hit = typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url)
      if (hit) {
        route = candidate
        break
      }
    }
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      // Header lookup is case-insensitive on BOTH sides, like `Headers.get`.
      header: (name: string) => {
        const wanted = name.toLowerCase()
        for (const [key, value] of Object.entries(route.headers ?? {})) {
          if (key.toLowerCase() === wanted) return value
        }
        return null
      },
      text: async () => route.body,
      json: async () => JSON.parse(route.body) as unknown,
    }
  }) as FakeHttp
  Object.defineProperty(seam, 'requests', { value: requests })
  return seam
}

/**
 * Build a retriever definition returning canned results.
 *
 * @param name - registry name.
 * @param results - results to return (a function receives the query).
 * @returns the definition.
 */
export function fakeRetriever(
  name: string,
  results: readonly SearchResult[] | ((query: string) => readonly SearchResult[]),
): RetrieverDefinition {
  return {
    name,
    keys: [],
    keyless: true,
    description: `fake retriever ${name}`,
    create: (_ctx, options) => ({
      async search(maxResults?: number) {
        const all = typeof results === 'function' ? results(options.query) : results
        return maxResults === undefined ? [...all] : all.slice(0, maxResults)
      },
    }),
  }
}

/**
 * Build a retriever registry containing only fakes.
 *
 * @param definitions - the fakes to register.
 * @returns the registry.
 */
export function fakeRetrieverRegistry(
  definitions: readonly RetrieverDefinition[],
): RetrieverRegistry {
  return new RetrieverRegistry(definitions)
}

/**
 * Build a scraper definition returning canned content per URL.
 *
 * @param contentByUrl - map from URL to extracted text; a missing URL yields
 *   `<title> of <url>` with a small body so tests always have context.
 * @returns the definition.
 */
export function fakeScraper(
  contentByUrl: Record<string, string> = {},
): ScraperDefinition {
  return {
    name: 'fake',
    keys: [],
    keyless: true,
    description: 'fake scraper',
    async scrape(urls: readonly string[]): Promise<ScrapedContent[]> {
      return urls.map((url) => {
        const body =
          contentByUrl[url] ??
          `Content about ${url} with enough words to pass the minimum length filter. ` +
            'It discusses the research topic in detail so the compressor keeps it. '.repeat(4)
        return {
          url,
          raw_content: body,
          title: `Title of ${url}`,
        }
      })
    },
  }
}

/**
 * Build a scraper registry containing only fakes.
 *
 * @param definitions - the fakes to register.
 * @returns the registry.
 */
export function fakeScraperRegistry(
  definitions: readonly ScraperDefinition[],
): ScraperRegistry {
  return new ScraperRegistry(definitions)
}

/** Options for {@link makeDeps}. */
export interface MakeDepsOptions {
  llm: ChatClient
  http?: Runtime['http']
  env?: Record<string, string | undefined>
  web?: WebSeam | undefined
  progress?: (event: ProgressEvent) => void
  logger?: Logger
  config?: Record<string, unknown>
  configPath?: string
  signal?: AbortSignal
  now?: () => number
}

/** The built deps plus the pieces tests like to assert on. */
export interface TestDeps {
  deps: EngineDeps
  config: Config
  costs: CostTracker
  progressEvents: ProgressEvent[]
}

/**
 * Assemble engine dependencies for a test.
 *
 * @param options - the seams and config overrides.
 * @returns the deps bundle.
 */
export function makeDeps(options: MakeDepsOptions): TestDeps {
  const progressEvents: ProgressEvent[] = []
  const config = new Config({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    overrides: {
      EMBEDDING: 'local:hash',
      MEMORY_BACKEND: 'memory',
      RETRIEVER: 'fake',
      SCRAPER: 'fake',
      ...(options.config ?? {}),
    },
    env: (name) => options.env?.[name],
  })
  const costs = new CostTracker()
  const runtime: Runtime = {
    llm: options.llm,
    http: options.http ?? (async () => ({ ok: false, status: 404, header: () => null, text: async () => '', json: async () => ({}) })),
    env: (name) => options.env?.[name],
    log: options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    progress: (event) => {
      progressEvents.push(event)
      options.progress?.(event)
    },
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
  return {
    deps: { runtime, config, prompts: new PromptFamily(config), costs },
    config,
    costs,
    progressEvents,
  }
}

/** A web seam returning canned sources and pages. */
export function fakeWebSeam(params: {
  sources?: SearchResult[]
  pages?: Record<string, string>
  /** Latency, so a timeout or abort can win the race as it does over the network. */
  delayMs?: number
}): WebSeam & { searchCalls: string[]; fetchCalls: string[] } {
  const searchCalls: string[] = []
  const fetchCalls: string[] = []
  /** Reject like a real provider when the composed signal aborts. */
  const honour = async (signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted) {
      const reason = signal.reason
      throw reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError')
    }
    if (params.delayMs === undefined || params.delayMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, params.delayMs as number)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          const reason = signal.reason
          reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }
  return {
    searchCalls,
    fetchCalls,
    available: () => true,
    async search(query, _maxResults, signal) {
      searchCalls.push(query)
      await honour(signal)
      return params.sources ?? []
    },
    async fetch(url, signal) {
      fetchCalls.push(url)
      await honour(signal)
      return {
        url,
        status: 200,
        body:
          params.pages?.[url] ??
          `<html><head><title>${url}</title></head><body><main><p>Page about ${url}.</p></main></body></html>`,
        kind: 'html',
      }
    },
  }
}

/**
 * Distinctive substrings of the real prompt templates.
 *
 * Scripted replies match on these instead of on paraphrases, so a test fails
 * loudly if a prompt is ever replaced rather than silently answering the wrong
 * call.
 */
export const PROMPT_MATCHERS = {
  agentSelection: 'This task involves researching a given topic',
  searchQueries: 'search queries to research the following task',
  report: 'Using the above information, answer the following query or task',
  subtopicReport: 'construct a detailed report on the subtopic',
  curation: 'evaluate and curate the provided scraped content',
  quickSummary: 'Synthesize a comprehensive answer',
  subtopics: 'Construct a list of subtopics',
  draftTitles: 'construct a draft section title headers',
  introduction: 'Prepare a detailed report introduction on the topic',
  conclusion: 'please write a concise conclusion',
  deepResearch: 'Using the following hierarchically researched information',
  deepResearchQueries: 'unique search queries to research the topic thoroughly',
  learnings: 'Learnings:',
  followUp: 'Follow-up questions:',
} as const

/** The canned agent-selection reply every engine test needs. */
export const AGENT_REPLY = JSON.stringify({
  server: 'Default Agent',
  agent_role_prompt:
    'You are a research assistant that writes structured, objective reports.',
})

