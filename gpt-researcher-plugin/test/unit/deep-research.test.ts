/**
 * Offline unit tests for the deep-research skill (`src/skills/deep-research.ts`).
 *
 * Everything runs against fakes of the `Runtime` seams:
 *
 * - a scripted `ChatClient` matched on prompt content,
 * - a recording `http` seam that serves a small HTML page (the `bs` scraper's
 *   transport — the scraper *registry* itself has no injection point, because
 *   `GptResearcher` calls `createScraperRegistry()` with no extras),
 * - a stub retriever registered into a fresh `RetrieverRegistry`,
 * - a fake embeddings registry. Note the compressor's *fast path* is what runs
 *   here (the per-query page is small); the threshold boundary, the slow
 *   embedding path and the below-threshold fallback are covered by
 *   `test/unit/compression.test.ts` instead.
 *
 * @module gpt-researcher/test/unit/deep-research
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { GptResearcher } from '../../src/agent.ts'
import { Config } from '../../src/config.ts'
import type { EngineDeps } from '../../src/deps.ts'
import {
  EmbeddingsRegistry,
  type Embeddings,
  type EmbeddingsDefinition,
} from '../../src/embeddings/index.ts'
import { PromptFamily } from '../../src/prompts.ts'
import { RetrieverRegistry, type RetrieverDefinition } from '../../src/retrievers/base.ts'
import type { HttpFetch, HttpResponse, Runtime } from '../../src/runtime.ts'
import { DeepResearchSkill, formatLocalTimestamp } from '../../src/skills/deep-research.ts'
import type {
  ChatClient,
  ChatRequest,
  ChatResult,
  ProgressEvent,
  SearchResult,
} from '../../src/types.ts'
import { CostTracker } from '../../src/utils/costs.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Extracted text comfortably above the scraper's 100-character minimum. */
const PAGE_TEXT =
  'Deep research traverses a breadth of search queries and a depth of follow-up questions, ' +
  'accumulating learnings with citations before the final report is written.'

/** A page the fake `bs` scraper can extract text from. */
function pageFor(url: string): string {
  return `<!doctype html><html><head><title>Page for ${url}</title></head><body><main><article>
  <h1>Stub page</h1>
  <p>${PAGE_TEXT}</p>
  <p>${PAGE_TEXT}</p>
  </article></main></body></html>`
}

/** One scripted LLM response, matched on the rendered prompt. */
interface ScriptedRule {
  match: RegExp | string
  respond: string | ((prompt: string, callIndex: number) => string)
}

/** The fakes and recorders one test needs. */
interface Harness {
  agent: GptResearcher
  skill: DeepResearchSkill
  /** Every prompt the scripted client was asked to complete. */
  prompts: string[]
  /** Every retriever search, as `<retriever>:<query>`. */
  searches: string[]
  /** Every URL the fake http seam served. */
  httpUrls: string[]
  /** Every environment variable name read through the runtime seam. */
  envReads: string[]
  /** Every progress event. */
  progress: ProgressEvent[]
  /** Warnings and errors the engine logged. */
  warnings: string[]
  errors: string[]
  /** Peak concurrent retriever searches. */
  peakInFlight: () => number
}

/** Render a chat request the way the scripted matcher sees it. */
function renderPrompt(request: ChatRequest): string {
  return request.messages.map((message) => `${message.role}: ${message.content}`).join('\n')
}

/** A small deterministic vector, so the compressor's embedding path is offline. */
function vectorFor(text: string): number[] {
  const vector = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const word of text.toLowerCase().split(/\s+/)) {
    const hash = [...word].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 7)
    const index = hash % vector.length
    vector[index] = (vector[index] ?? 0) + 1
  }
  return vector
}

/** A hard-coded embedding provider (`local`), so no credentials are needed. */
function fakeEmbeddings(): EmbeddingsDefinition {
  const embeddings: Embeddings = {
    provider: 'local',
    model: 'hash',
    dimension: 8,
    embedDocuments: async (texts) => texts.map(vectorFor),
    embedQuery: async (text) => vectorFor(text),
  }
  return {
    name: 'local',
    keys: [],
    keyless: true,
    description: 'deterministic test embedder',
    defaultModel: 'hash',
    create: () => embeddings,
  }
}

/** Build one stub retriever that answers with `hitsFor` results. */
function stubRetriever(
  name: string,
  hitsFor: (query: string) => SearchResult[],
  onSearch: (name: string, query: string) => Promise<void>,
): RetrieverDefinition {
  return {
    name,
    keys: [],
    keyless: true,
    description: `offline stub retriever ${name}`,
    create(_ctx, options) {
      return {
        async search(maxResults) {
          await onSearch(name, options.query)
          const hits = hitsFor(options.query)
          return maxResults === undefined ? hits : hits.slice(0, maxResults)
        },
      }
    },
  }
}

/** Build a full offline harness around one `GptResearcher`. */
function makeHarness(options: {
  rules: readonly ScriptedRule[]
  /** Retriever names to register and resolve (defaults to one `stub`). */
  retrieverNames?: readonly string[]
  /** Results per retriever search (defaults to a single URL-only hit). */
  hitsFor?: (query: string) => SearchResult[]
  /** Delay inside the stub search, to make overlap observable. */
  searchDelayMs?: number
  /** Extra config overrides. */
  config?: Record<string, unknown>
}): Harness {
  const retrieverNames = options.retrieverNames ?? ['stub']
  const prompts: string[] = []
  const searches: string[] = []
  const httpUrls: string[] = []
  const envReads: string[] = []
  const progress: ProgressEvent[] = []
  const warnings: string[] = []
  const errors: string[] = []
  let inFlight = 0
  let peak = 0

  const hitsFor =
    options.hitsFor ??
    ((query: string): SearchResult[] => [
      { url: `https://stub.test/${query.replace(/[^a-zA-Z0-9]+/g, '-')}/0`, title: query },
    ])

  const onSearch = async (name: string, query: string): Promise<void> => {
    searches.push(`${name}:${query}`)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (options.searchDelayMs !== undefined && options.searchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.searchDelayMs))
      } else {
        await Promise.resolve()
      }
    } finally {
      inFlight -= 1
    }
  }

  const llm: ChatClient = {
    async complete(request: ChatRequest): Promise<ChatResult> {
      const prompt = renderPrompt(request)
      const callIndex = prompts.length
      prompts.push(prompt)
      for (const rule of options.rules) {
        const matched =
          typeof rule.match === 'string' ? prompt.includes(rule.match) : rule.match.test(prompt)
        if (!matched) continue
        const text = typeof rule.respond === 'function' ? rule.respond(prompt, callIndex) : rule.respond
        return { text, model: 'scripted', provider: 'fake' }
      }
      throw new Error(`unscripted prompt: ${prompt.slice(0, 200)}`)
    },
  }

  const http: HttpFetch = async (url): Promise<HttpResponse> => {
    httpUrls.push(url)
    const body = pageFor(url)
    return {
      ok: true,
      status: 200,
      header: (name) => (name.toLowerCase() === 'content-type' ? 'text/html' : null),
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    }
  }

  const runtime: Runtime = {
    llm,
    http,
    env: (name) => {
      envReads.push(name)
      return undefined
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    },
    progress: (event) => progress.push(event),
    now: () => 1_700_000_000_000,
  }

  const deps: EngineDeps = {
    runtime,
    config: new Config({
      env: () => undefined,
      overrides: {
        RETRIEVER: retrieverNames.join(','),
        SCRAPER: 'bs',
        MEMORY_BACKEND: 'none',
        EMBEDDING: 'local:hash',
        MAX_SEARCH_RESULTS_PER_QUERY: 3,
        CURATE_SOURCES: false,
        DEEP_RESEARCH_BREADTH: 2,
        DEEP_RESEARCH_DEPTH: 1,
        DEEP_RESEARCH_CONCURRENCY: 2,
        ...(options.config ?? {}),
      },
    }),
    prompts: new PromptFamily(
      new Config({ env: () => undefined, overrides: { RETRIEVER: retrieverNames.join(',') } }),
    ),
    costs: new CostTracker(),
  }

  const retrieverRegistry = new RetrieverRegistry(
    retrieverNames.map((name) => stubRetriever(name, hitsFor, onSearch)),
  )
  const embeddingsRegistry = new EmbeddingsRegistry([fakeEmbeddings()])

  const agent = new GptResearcher({
    deps,
    query: 'the deep research topic',
    reportType: 'deep',
    retrieverRegistry,
    embeddingsRegistry,
  })

  return {
    agent,
    skill: new DeepResearchSkill(agent),
    prompts,
    searches,
    httpUrls,
    envReads,
    progress,
    warnings,
    errors,
    peakInFlight: () => peak,
  }
}

/** The rule matching `generateSearchQueries`' prompt. */
const SEARCH_QUERIES_MATCH = 'unique search queries to research the topic thoroughly'
/** The rule matching `generateResearchPlan`' prompt. */
const RESEARCH_PLAN_MATCH = 'Format each question on a new line starting with'
/** The rule matching `processResearchResults`' prompt. */
const PROCESS_RESULTS_MATCH = 'extract key learnings and suggest follow-up questions'

// ---------------------------------------------------------------------------
// generateSearchQueries
// ---------------------------------------------------------------------------

test('generateSearchQueries parses Query:/Goal: pairs and ignores surrounding prose', async () => {
  const harness = makeHarness({
    rules: [
      {
        match: SEARCH_QUERIES_MATCH,
        respond: [
          'Here are the queries you asked for:',
          '',
          'Goal: a goal line before any query is ignored',
          'Query: alpha',
          'Goal: understand alpha',
          'Query: beta',
          'Goal: understand beta',
          'Query: gamma',
          'Goal: understand gamma',
          'Query: delta',
          'Goal: understand delta',
        ].join('\n'),
      },
    ],
  })

  const queries = await harness.skill.generateSearchQueries('topic', 3)
  assert.deepEqual(queries, [
    { query: 'alpha', researchGoal: 'understand alpha' },
    { query: 'beta', researchGoal: 'understand beta' },
    { query: 'gamma', researchGoal: 'understand gamma' },
  ])
  assert.ok(harness.prompts[0]?.includes('generate 3 unique search queries'))
})

test('generateSearchQueries overwrites a repeated Goal, as upstream does', async () => {
  const harness = makeHarness({
    rules: [
      {
        match: SEARCH_QUERIES_MATCH,
        respond: 'Query: alpha\nGoal: first goal\nGoal: second goal',
      },
    ],
  })

  const queries = await harness.skill.generateSearchQueries('topic', 1)
  assert.deepEqual(queries, [{ query: 'alpha', researchGoal: 'second goal' }])
})

test('generateSearchQueries keeps a Query with no Goal (upstream drops it later)', async () => {
  const harness = makeHarness({
    rules: [{ match: SEARCH_QUERIES_MATCH, respond: 'Query: alone\nQuery: paired\nGoal: the goal' }],
  })

  const queries = await harness.skill.generateSearchQueries('topic', 3)
  assert.equal(queries.length, 2)
  assert.equal(queries[0]?.query, 'alone')
  assert.equal(queries[0]?.researchGoal, undefined)
  assert.deepEqual(queries[1], { query: 'paired', researchGoal: 'the goal' })
})

// ---------------------------------------------------------------------------
// generateResearchPlan
// ---------------------------------------------------------------------------

test('generateResearchPlan queries every retriever and parses Question: lines', async () => {
  const harness = makeHarness({
    retrieverNames: ['stub_a', 'stub_b'],
    rules: [
      {
        match: RESEARCH_PLAN_MATCH,
        respond: [
          'Some prose the model added.',
          'Question: What changed in 2024?',
          'question: lower case is ignored',
          'Question: How large is the effect?',
          'Question: What is still unknown?',
          'Question: A fourth question that gets sliced away.',
        ].join('\n'),
      },
    ],
  })

  const questions = await harness.skill.generateResearchPlan('the topic', 3)
  assert.deepEqual(questions, [
    'What changed in 2024?',
    'How large is the effect?',
    'What is still unknown?',
  ])
  assert.deepEqual(
    harness.searches.map((entry) => entry.split(':')[0]),
    ['stub_a', 'stub_b'],
  )
  // The plan prompt carries the gathered search results and a timestamp.
  assert.ok(harness.prompts[0]?.includes('https://stub.test/'))
  assert.match(harness.prompts[0] ?? '', /Current time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
})

test('formatLocalTimestamp matches Python strftime("%Y-%m-%d %H:%M:%S")', () => {
  const formatted = formatLocalTimestamp(Date.UTC(2024, 0, 2, 3, 4, 5))
  assert.match(formatted, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

// ---------------------------------------------------------------------------
// run: single round, trace shape, learnings, progress
// ---------------------------------------------------------------------------

test('run with depth=1 terminates after one round and returns the trace shape', async () => {
  const harness = makeHarness({
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: what about the first aspect?' },
      {
        match: SEARCH_QUERIES_MATCH,
        respond: 'Query: q1\nGoal: g1\nQuery: q2\nGoal: g2',
      },
      {
        match: /for the query 'q1'/,
        respond: 'Learning [https://cite.test/one]: Insight one\nQuestion: follow one?',
      },
      {
        match: /for the query 'q2'/,
        respond: 'Learning [https://cite.test/two]: Insight two\nQuestion: follow two?',
      },
    ],
  })

  const result = await harness.skill.run({ depth: 1, breadth: 2, concurrency: 2 })

  // One round: two nodes, both at the requested depth.
  assert.equal(result.trace.length, 2)
  assert.deepEqual(
    result.trace.map((node) => node.depth),
    [1, 1],
  )
  assert.deepEqual(
    result.trace.map((node) => node.query),
    ['q1', 'q2'],
  )
  // DEVIATION FROM UPSTREAM (bug fixed): upstream split `Learning [url]: text`
  // on the *first* colon — the one inside `https:` — so learnings came back as
  // `//cite.test/one]: Insight one`. This port takes the text after the
  // `[citation]` group, which is what the prompt asks for.
  assert.deepEqual(result.trace[0]?.learnings, ['Insight one'])
  assert.deepEqual(result.trace[0]?.followedUpQuestions, ['follow one?'])
  assert.deepEqual(result.trace[0]?.sources, ['https://stub.test/q1/0'])
  assert.deepEqual(result.trace[1]?.learnings, ['Insight two'])

  // Learnings accumulate (with their citations) into the researcher's context.
  assert.deepEqual(result.learnings, ['Insight one', 'Insight two'])
  assert.equal(result.context, harness.agent.context)
  assert.ok(
    harness.agent.context.includes('Insight one [Source: https://cite.test/one]'),
  )
  assert.ok(
    harness.agent.context.includes('Insight two [Source: https://cite.test/two]'),
  )
  assert.ok(harness.httpUrls.includes('https://stub.test/q1/0'))
  assert.ok(harness.httpUrls.includes('https://stub.test/q2/0'))

  // Every visited URL is on the researcher.
  assert.deepEqual(
    [...harness.agent.visitedUrls].sort(),
    ['https://stub.test/q1/0', 'https://stub.test/q2/0'],
  )

  // Progress uses upstream's emoji messages.
  const messages = harness.progress.map((event) => event.message)
  assert.ok(messages.some((message) => message.includes('🔍 DEEP RESEARCH: Starting with breadth=2, depth=1')))
  assert.ok(messages.some((message) => message.includes('📊 DEEP RESEARCH: depth=1, breadth=2')))
  assert.ok(messages.some((message) => message.includes('🔎 Generating 2 search queries')))
  assert.ok(messages.some((message) => message.includes('✅ Generated 2 queries')))
  assert.ok(harness.progress.every((event) => event.type === 'logs'))
})

test('run with depth=0 short-circuits to a single round', async () => {
  const harness = makeHarness({
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: any question?' },
      { match: SEARCH_QUERIES_MATCH, respond: 'Query: only\nGoal: the goal' },
      {
        match: PROCESS_RESULTS_MATCH,
        respond: 'Learning https://cite.test/only Insight only',
      },
    ],
  })

  const result = await harness.skill.run({ depth: 0, breadth: 1, concurrency: 1 })

  assert.equal(result.trace.length, 1)
  assert.equal(result.trace[0]?.depth, 0)
  // Only one query-generation call: nothing recursed.
  assert.equal(
    harness.prompts.filter((prompt) => prompt.includes(SEARCH_QUERIES_MATCH)).length,
    1,
  )
})

// ---------------------------------------------------------------------------
// run: depth/breadth limits
// ---------------------------------------------------------------------------

test('run respects the depth limit and the halved breadth per level', async () => {
  const harness = makeHarness({
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: the plan question?' },
      {
        match: SEARCH_QUERIES_MATCH,
        respond: ['q1', 'q2', 'q3', 'q4', 'q5'].map((q) => `Query: ${q}\nGoal: goal ${q}`).join('\n'),
      },
      {
        match: PROCESS_RESULTS_MATCH,
        respond: (prompt) => {
          const query = /for the query '([^']*)'/.exec(prompt)?.[1] ?? 'unknown'
          return `Learning https://cite.test/x Learning for ${query}`
        },
      },
    ],
  })

  const result = await harness.skill.run({ depth: 2, breadth: 5, concurrency: 5 })

  // Level 1: 5 queries. Level 2 (breadth = max(2, 5 // 2) = 2): 5 × 2 = 10 queries.
  assert.equal(result.trace.filter((node) => node.depth === 2).length, 5)
  assert.equal(result.trace.filter((node) => node.depth === 1).length, 10)
  assert.equal(result.trace.length, 15)

  // The recursion asked for the halved breadth, quoting the previous goal.
  const recursionPrompts = harness.prompts.filter((prompt) =>
    prompt.includes('Previous research goal: goal q'),
  )
  assert.equal(recursionPrompts.length, 5)
  assert.ok(recursionPrompts.every((prompt) => prompt.includes('generate 2 unique search queries')))
  assert.equal(
    harness.prompts.filter((prompt) => prompt.includes(SEARCH_QUERIES_MATCH)).length,
    6,
  )
  // Only 2 levels were ever requested, so the run terminated.
  assert.ok(result.trace.every((node) => node.depth === 1 || node.depth === 2))
})

test('run bounds concurrently running queries by the concurrency option', async () => {
  const harness = makeHarness({
    searchDelayMs: 2,
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: the plan question?' },
      {
        match: SEARCH_QUERIES_MATCH,
        respond: 'Query: q1\nGoal: g1\nQuery: q2\nGoal: g2\nQuery: q3\nGoal: g3',
      },
      { match: PROCESS_RESULTS_MATCH, respond: 'Learning https://cite.test/x Insight' },
    ],
  })

  await harness.skill.run({ depth: 1, breadth: 3, concurrency: 1 })
  assert.equal(harness.peakInFlight(), 1)

  const parallel = makeHarness({
    searchDelayMs: 2,
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: the plan question?' },
      {
        match: SEARCH_QUERIES_MATCH,
        respond: 'Query: q1\nGoal: g1\nQuery: q2\nGoal: g2\nQuery: q3\nGoal: g3',
      },
      { match: PROCESS_RESULTS_MATCH, respond: 'Learning https://cite.test/x Insight' },
    ],
  })

  await parallel.skill.run({ depth: 1, breadth: 3, concurrency: 3 })
  assert.ok(parallel.peakInFlight() <= 3, `peak ${parallel.peakInFlight()} exceeded the bound`)
  assert.ok(parallel.peakInFlight() >= 2, `expected overlap, peak was ${parallel.peakInFlight()}`)
})

// ---------------------------------------------------------------------------
// run: context trimming at the word limit
// ---------------------------------------------------------------------------

test('run trims the accumulated context to MAX_CONTEXT_WORDS, keeping the most recent items', async () => {
  const pad = 'padding '.repeat(13_000)
  const harness = makeHarness({
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: the plan question?' },
      { match: SEARCH_QUERIES_MATCH, respond: 'Query: q1\nGoal: g1\nQuery: q2\nGoal: g2' },
      {
        match: PROCESS_RESULTS_MATCH,
        respond: (prompt) => {
          const query = /for the query '([^']*)'/.exec(prompt)?.[1] ?? 'unknown'
          return [
            `Learning https://cite.test/${query}-a ${query}-A-MARKER ${pad}`,
            `Learning https://cite.test/${query}-b ${query}-B-MARKER ${pad}`,
            `Learning https://cite.test/${query}-c ${query}-C-MARKER ${pad}`,
          ].join('\n')
        },
      },
    ],
  })

  const result = await harness.skill.run({ depth: 1, breadth: 2, concurrency: 1 })

  const words = result.context.split(/\s+/).filter((word) => word.length > 0).length
  assert.ok(words <= 25_000, `context was ${words} words`)

  // Trimming keeps the most recent items and drops the earliest ones.
  assert.ok(result.context.includes('q2-C-MARKER'))
  assert.ok(!result.context.includes('q1-A-MARKER'))
  assert.ok(!result.context.includes('q1-B-MARKER'))
  // The embedded source is still cited on the surviving learnings.
  assert.ok(result.context.includes('[Source: https://cite.test/q2-c]'))
})

// ---------------------------------------------------------------------------
// run: a malformed query is dropped, not fatal
// ---------------------------------------------------------------------------

test('run drops a generated query that has no research goal and continues', async () => {
  const harness = makeHarness({
    rules: [
      { match: RESEARCH_PLAN_MATCH, respond: 'Question: the plan question?' },
      { match: SEARCH_QUERIES_MATCH, respond: 'Query: orphan\nQuery: q1\nGoal: g1' },
      {
        match: PROCESS_RESULTS_MATCH,
        respond: 'Learning https://cite.test/x Insight for the survivor',
      },
    ],
  })

  const result = await harness.skill.run({ depth: 1, breadth: 2, concurrency: 2 })

  assert.equal(result.trace.length, 1)
  assert.equal(result.trace[0]?.query, 'q1')
  assert.ok(harness.errors.some((message) => message.includes('has no research goal')))
  assert.ok(
    harness.progress.some((event) => event.message.includes('❌ DEEP RESEARCH ERROR')),
  )
  // The orphan query's research never ran.
  assert.ok(!harness.searches.some((entry) => entry.endsWith(':orphan')))
})
