/**
 * Offline integration test for the detailed report
 * (`src/report-type/detailed-report.ts`).
 *
 * A real `GptResearcher` runs the whole `detailed_report` flow against fakes of
 * the documented `Runtime` seams only:
 *
 * - `llm` — a scripted `ChatClient` matched on prompt content,
 * - `web` — a fake DSH web seam, which is what the keyless `dsh_web` retriever
 *   (`RETRIEVER=dsh_web`) and the `dsh_web` scraper (`SCRAPER=dsh_web`) use, so
 *   no retriever registry or scraper registry injection is needed,
 * - `env` — a recorder returning nothing.
 *
 * `Config` selects `EMBEDDING=local:hash` (the bundled keyless embedder) and
 * `MEMORY_BACKEND=none`, so the whole pipeline — including the context
 * compressor and the written-content compressor — runs with no credentials.
 *
 * @module gpt-researcher/test/integration/detailed-report
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { GptResearcher, type GptResearcherOptions } from '../../src/agent.ts'
import { Config } from '../../src/config.ts'
import type { EngineDeps } from '../../src/deps.ts'
import { PromptFamily } from '../../src/prompts.ts'
import { DetailedReport } from '../../src/report-type/detailed-report.ts'
import type { Runtime, WebSeam } from '../../src/runtime.ts'
import type {
  ChatClient,
  ChatRequest,
  ChatResult,
  ProgressEvent,
  ScrapedContent,
  SearchResult,
} from '../../src/types.ts'
import { CostTracker } from '../../src/utils/costs.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The extracted page text every fake fetch serves (well over 100 characters). */
const PAGE_TEXT =
  'Deep research traverses a breadth of search queries and a depth of follow-up questions, ' +
  'accumulating learnings with citations before the final detailed report is written.'

/** The scripted introduction. */
const INTRODUCTION = '# Comprehensive Report\n\nThis introduction frames the detailed report.'

/** The scripted conclusion. */
const CONCLUSION = 'The detailed report found that synthesis across subtopics improves coverage.'

/** The two subtopic tasks the scripted planner returns. */
const SUBTOPIC_TASKS = ['Subtopic One', 'Subtopic Two']

/** A page the `dsh_web` scraper can extract text from. */
function pageFor(url: string): string {
  return `<!doctype html><html><head><title>Page for ${url}</title></head><body><main><article>
  <h1>Stub page</h1>
  <p>${PAGE_TEXT}</p>
  <p>${PAGE_TEXT}</p>
  </article></main></body></html>`
}

/** Slugify a query into a URL path segment. */
function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9]+/g, '-')
}

/** One scripted LLM response, matched on the rendered prompt. */
interface ScriptedRule {
  match: RegExp | string
  respond: string | ((prompt: string) => string)
}

/** The fakes and recorders one test needs. */
interface Harness {
  agent: GptResearcher
  deps: EngineDeps
  /** Every prompt the scripted client was asked to complete. */
  prompts: string[]
  /** Every query the fake web seam searched for. */
  webSearches: string[]
  /** Every URL the fake web seam fetched. */
  webFetches: string[]
  /** Every URL the fake web seam returned as a search hit. */
  searchedUrls: string[]
  /** Every progress event. */
  progress: ProgressEvent[]
  warnings: string[]
  errors: string[]
}

/** Build one full offline harness with a real `GptResearcher`. */
function makeHarness(options: {
  query: string
  reportType?: 'detailed_report' | 'deep'
  subtopics?: string[]
  rules?: readonly ScriptedRule[]
  overrides?: Record<string, unknown>
}): Harness {
  const prompts: string[] = []
  const webSearches: string[] = []
  const webFetches: string[] = []
  const searchedUrls: string[] = []
  const progress: ProgressEvent[] = []
  const warnings: string[] = []
  const errors: string[] = []

  // Every research pass is asked for its own sub-queries: derive them from the
  // task embedded in the search-queries prompt, so each pass searches (and
  // therefore visits) a distinct set of URLs.
  const defaultRules: ScriptedRule[] = [
    {
      match: 'agent_role_prompt',
      respond: JSON.stringify({
        server: 'Default Agent',
        agent_role_prompt: 'You are an objective research assistant.',
      }),
    },
    {
      match: 'research the following task:',
      respond: (prompt) => {
        const task = /research the following task: "([^"]*)"/.exec(prompt)?.[1] ?? 'unknown'
        return JSON.stringify([`${task} alpha`, `${task} beta`])
      },
    },
    {
      match: 'Construct a list of subtopics',
      respond: JSON.stringify({ subtopics: SUBTOPIC_TASKS.map((task) => ({ task })) }),
    },
    {
      match: 'Prepare a detailed report introduction on the topic',
      respond: INTRODUCTION,
    },
    {
      match: 'construct a draft section title headers',
      respond: '### Section One\n### Section Two',
    },
    {
      match: 'construct a detailed report on the subtopic:',
      respond: (prompt) => {
        const subtopic =
          /construct a detailed report on the subtopic: ([^\n]*) under the main topic/.exec(prompt)?.[1] ??
          'Subtopic'
        return `## ${subtopic}\n\nBody for ${subtopic}.`
      },
    },
    {
      match: 'please write a concise conclusion',
      respond: CONCLUSION,
    },
  ]

  const llm: ChatClient = {
    async complete(request: ChatRequest): Promise<ChatResult> {
      const prompt = request.messages.map((message) => `${message.role}: ${message.content}`).join('\n')
      prompts.push(prompt)
      for (const rule of [...(options.rules ?? []), ...defaultRules]) {
        const matched =
          typeof rule.match === 'string' ? prompt.includes(rule.match) : rule.match.test(prompt)
        if (!matched) continue
        const text = typeof rule.respond === 'function' ? rule.respond(prompt) : rule.respond
        return { text, model: 'scripted', provider: 'fake' }
      }
      throw new Error(`unscripted prompt: ${prompt.slice(0, 200)}`)
    },
  }

  const web: WebSeam = {
    available: () => true,
    async search(query): Promise<SearchResult[]> {
      webSearches.push(query)
      const url = `https://web.test/${slug(query)}/0`
      searchedUrls.push(url)
      return [{ url, title: query }]
    },
    async fetch(url) {
      webFetches.push(url)
      return { url, status: 200, body: pageFor(url), kind: 'html' }
    },
  }

  const runtime: Runtime = {
    llm,
    http: async (url) => {
      throw new Error(`the dsh_web path must not use runtime.http (tried ${url})`)
    },
    env: () => undefined,
    log: {
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    },
    progress: (event) => progress.push(event),
    web,
    now: () => 1_700_000_000_000,
  }

  const config = new Config({
    env: () => undefined,
    overrides: {
      RETRIEVER: 'dsh_web',
      SCRAPER: 'dsh_web',
      MEMORY_BACKEND: 'none',
      EMBEDDING: 'local:hash',
      REPORT_SOURCE: 'web',
      MAX_SEARCH_RESULTS_PER_QUERY: 3,
      MAX_SUBTOPICS: 3,
      CURATE_SOURCES: false,
      TOTAL_WORDS: 300,
      ...(options.overrides ?? {}),
    },
  })

  const deps: EngineDeps = {
    runtime,
    config,
    prompts: new PromptFamily(config),
    costs: new CostTracker(),
  }

  const agent = new GptResearcher({
    deps,
    query: options.query,
    reportType: options.reportType ?? 'detailed_report',
    ...(options.subtopics === undefined ? {} : { subtopics: options.subtopics }),
  })

  return {
    agent,
    deps,
    prompts,
    webSearches,
    webFetches,
    searchedUrls,
    progress,
    warnings,
    errors,
  }
}

/** The reference block at the end of an assembled report. */
function referenceBlock(report: string): string {
  const index = report.lastIndexOf('## References')
  assert.ok(index >= 0, 'the report must end with a references section')
  return report.slice(index)
}

// ---------------------------------------------------------------------------
// End-to-end run
// ---------------------------------------------------------------------------

test('detailed report assembles introduction, TOC, subtopic sections, and references', async () => {
  const harness = makeHarness({ query: 'the detailed report parent query' })
  const outcome = await harness.agent.run()

  assert.equal(outcome.reportType, 'detailed_report')
  const report = outcome.report

  // Starts with the introduction.
  assert.ok(report.startsWith(INTRODUCTION), 'the report must start with the introduction')
  // Contains the table of contents, before the subtopic sections.
  assert.ok(report.includes('## Table of Contents'))
  assert.ok(report.indexOf('## Table of Contents') < report.indexOf('## Subtopic One'))
  assert.ok(report.indexOf(INTRODUCTION) < report.indexOf('## Table of Contents'))
  // Each subtopic has its own section, in planner order.
  assert.ok(report.includes('## Subtopic One'))
  assert.ok(report.includes('## Subtopic Two'))
  assert.ok(report.indexOf('## Subtopic One') < report.indexOf('## Subtopic Two'))
  // The conclusion precedes the references, which end the document.
  const references = referenceBlock(report)
  assert.ok(report.indexOf(CONCLUSION) < report.indexOf('## References'))
  assert.ok(references.includes('## References'))
  assert.ok(report.trimEnd().endsWith(references.trimEnd()))

  // The outcome carries the subtopics and their reports.
  assert.deepEqual(outcome.subtopics, SUBTOPIC_TASKS)
  assert.deepEqual(
    outcome.subtopicReports?.map((entry) => entry.subtopic),
    SUBTOPIC_TASKS,
  )
  assert.ok(outcome.subtopicReports?.[0]?.report.includes('## Subtopic One'))

  // The engine never wrote a plain research report for the parent.
  assert.ok(harness.prompts.every((prompt) => !prompt.includes('Write a research report')))
  assert.deepEqual(harness.errors, [])
})

test('the visited-URL set is merged across the parent and every subtopic researcher', async () => {
  const harness = makeHarness({ query: 'the visited url parent query' })
  const outcome = await harness.agent.run()

  assert.ok(harness.webFetches.length >= 3, 'each research pass must scrape at least one URL')
  assert.equal(
    new Set(outcome.visitedUrls).size,
    outcome.visitedUrls.length,
    'visited URLs must be unique',
  )

  // The parent's own research URLs are present...
  assert.ok(
    outcome.visitedUrls.some((url) => url.includes(slug('the visited url parent query'))),
    'the parent research URLs must be in the visited set',
  )
  // ...and so is every subtopic's (they ran on their own child researchers).
  for (const task of SUBTOPIC_TASKS) {
    assert.ok(
      outcome.visitedUrls.some((url) => url.includes(slug(task))),
      `subtopic '${task}' visited URLs must be merged into the parent set`,
    )
  }

  // The reference list is built from the merged set.
  const references = referenceBlock(outcome.report)
  for (const url of outcome.visitedUrls) {
    assert.ok(references.includes(`- [${url}](${url})`), `missing reference for ${url}`)
  }

  // Scraped sources are merged onto the owner too.
  const sourceUrls = new Set(outcome.sources.map((source: ScrapedContent) => source.url))
  assert.ok(sourceUrls.size >= 3, `expected scraped sources from every pass, got ${sourceUrls.size}`)
  for (const url of sourceUrls) {
    assert.ok(outcome.visitedUrls.includes(url), `scraped source ${url} must be a visited URL`)
  }
  // The owner agent itself ends up holding the merged state.
  assert.deepEqual([...harness.agent.visitedUrls].sort(), [...outcome.visitedUrls].sort())
  assert.equal(harness.agent.context, outcome.context)
})

// ---------------------------------------------------------------------------
// Child-researcher construction
// ---------------------------------------------------------------------------

test('subtopic children are real researchers seeded with the parent context', async () => {
  const harness = makeHarness({
    query: 'the child seeding parent query',
    subtopics: ['Candidate Subtopic'],
  })

  const created: GptResearcherOptions[] = []
  const detailedReport = new DetailedReport(harness.agent, {
    subtopics: ['Candidate Subtopic'],
    createResearcher: (childOptions) => {
      created.push(childOptions)
      return new GptResearcher(childOptions)
    },
  })

  const result = await detailedReport.run()

  // One main researcher plus one child per subtopic.
  assert.equal(created.length, SUBTOPIC_TASKS.length + 1)

  const mainOptions = created[0] as GptResearcherOptions
  assert.equal(mainOptions.reportType, 'research_report')
  assert.equal(mainOptions.query, 'the child seeding parent query')
  // The main researcher is a distinct object from the agent it was built for.
  assert.notEqual(detailedReport.gptResearcher, harness.agent)

  const childOptions = created.slice(1)
  assert.deepEqual(
    childOptions.map((options) => options.query),
    SUBTOPIC_TASKS,
  )
  for (const options of childOptions) {
    assert.equal(options.reportType, 'subtopic_report')
    assert.equal(options.parentQuery, 'the child seeding parent query')
    assert.deepEqual(options.subtopics, ['Candidate Subtopic'])
    assert.ok(options.visitedUrls instanceof Set)
    // DEVIATION: each child gets its own copy of the parent's set (upstream
    // shares one object, which the child's clear() then destroys).
    assert.notEqual(options.visitedUrls, harness.agent.visitedUrls)
    // The child is seeded with the parent's research context.
    const seeded = String(options.context ?? '')
    assert.ok(
      seeded.includes('Deep research traverses a breadth of search queries'),
      'the child must receive the parent research context',
    )
  }

  // Upstream *replaces* `global_context` with each child's context (it does not
  // accumulate), so the second child is seeded with the first child's research
  // context rather than with the parent's.
  const firstSeeded = String((childOptions[0] as GptResearcherOptions).context ?? '')
  const secondSeeded = String((childOptions[1] as GptResearcherOptions).context ?? '')
  assert.notEqual(secondSeeded, firstSeeded)
  assert.ok(!firstSeeded.includes(slug('Subtopic One')))
  assert.ok(secondSeeded.includes(slug('Subtopic One')))

  // Headers are recorded per subtopic, and the report was assembled.
  assert.deepEqual(
    detailedReport.existingHeaders.map((entry) => entry['subtopic task']),
    SUBTOPIC_TASKS,
  )
  const firstHeaders = detailedReport.existingHeaders[0]?.headers as Array<{ text?: string }>
  assert.equal(firstHeaders[0]?.text, 'Subtopic One')
  assert.ok(detailedReport.globalWrittenSections.length >= SUBTOPIC_TASKS.length)
  assert.match(detailedReport.researchId, /^detailed_\d+_[0-9a-f]{8}$/)
  assert.ok(result.report.includes('## Table of Contents'))
  assert.deepEqual(result.subtopics, SUBTOPIC_TASKS)

  // The visited-URL union landed on the owning agent as well.
  for (const task of SUBTOPIC_TASKS) {
    assert.ok(
      [...harness.agent.visitedUrls].some((url) => url.includes(slug(task))),
      `subtopic '${task}' URLs must reach the owning agent`,
    )
  }
  assert.ok(harness.agent.researchSources.length > 0)
})

// ---------------------------------------------------------------------------
// Deep owners
// ---------------------------------------------------------------------------

test('a deep owner takes upstream deep wrapper flow and keeps its trace', async () => {
  const harness = makeHarness({
    query: 'the deep research query',
    reportType: 'deep',
    overrides: { DEEP_RESEARCH_BREADTH: 1, DEEP_RESEARCH_DEPTH: 1, DEEP_RESEARCH_CONCURRENCY: 1 },
    rules: [
      {
        match: 'Format each question on a new line starting with',
        respond: 'Question: what does deeper research add?',
      },
      {
        match: 'unique search queries to research the topic thoroughly',
        respond: 'Query: deep sub query\nGoal: deepen the topic',
      },
      {
        match: 'extract key learnings and suggest follow-up questions',
        respond: 'Learning [https://cite.test/deep]: Deeper levels add specificity.',
      },
      {
        match: 'Using the following hierarchically researched information and citations',
        respond: '# Deep Report\n\nDeep report body.',
      },
    ],
  })

  const outcome = await harness.agent.run()

  // `GptResearcher.run()` routes `deep` to DetailedReport; a deep owner must run
  // the deep wrapper (`conduct_research` → `write_report`), not subtopic assembly.
  assert.equal(outcome.report, '# Deep Report\n\nDeep report body.')
  assert.deepEqual(outcome.subtopics, [])
  assert.deepEqual(outcome.subtopicReports, [])

  const deepPrompt = harness.prompts.find((prompt) =>
    prompt.includes('Using the following hierarchically researched information and citations'),
  )
  assert.ok(deepPrompt !== undefined, 'the deep report prompt must be used')
  assert.ok(deepPrompt.includes('[Source: https://cite.test/deep]'))

  // The deep-research trace is propagated from the main researcher to the owner.
  assert.equal(outcome.researchTrace?.length, 1)
  assert.equal(outcome.researchTrace?.[0]?.query, 'deep sub query')
  // Learings keep their full text: this port fixes upstream's first-colon split
  // (see the DEVIATION note in src/skills/deep-research.ts).
  assert.deepEqual(outcome.researchTrace?.[0]?.learnings, ['Deeper levels add specificity.'])
  assert.ok(outcome.visitedUrls.some((url) => url.includes('deep-sub-query')))
  assert.deepEqual(harness.errors, [])
})
