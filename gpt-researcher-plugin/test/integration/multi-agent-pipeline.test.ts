/**
 * Offline end-to-end test of the multi-agent pipeline.
 *
 * `ChiefEditorAgent.runResearchTask()` is driven with:
 *
 * - a routed, scripted `ChatClient` (canned replies keyed by prompt content),
 *   which is the only model seam the engine has;
 * - a stub retriever registry: one result carries its full text (which upstream's
 *   `search_relevant_source_urls` treats as prefetched) and one carries only a
 *   URL, so the configured `bs` scraper has to run;
 * - a stub `HttpFetch` returning canned HTML, so the scraper itself stays
 *   offline (`GptResearcher` has no `scraperRegistry` option — see the note on
 *   `httpCalls` below);
 * - the bundled keyless `local` embeddings provider and `MEMORY_BACKEND=none`,
 *   so nothing reaches out for credentials.
 *
 * @module test/integration/multi-agent-pipeline
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config } from '../../src/config.ts'
import type { EngineDeps } from '../../src/deps.ts'
import { ChiefEditorAgent } from '../../src/multi-agents/orchestrator.ts'
import type { Task } from '../../src/multi-agents/state.ts'
import { get_prompt_family } from '../../src/prompts.ts'
import { RetrieverRegistry, type RetrieverDefinition } from '../../src/retrievers/index.ts'
import { makeRuntime, silentLogger, type HttpFetch } from '../../src/runtime.ts'
import type {
  ChatClient,
  ChatRequest,
  ChatResult,
  ProgressEvent,
} from '../../src/types.ts'
import { CostTracker } from '../../src/utils/costs.ts'

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

interface Route {
  tag: string
  match: (promptText: string) => boolean
  reply: (request: ChatRequest, call: number) => string
}

/** A `ChatClient` that answers by prompt content and records every request. */
class ScriptedChatClient implements ChatClient {
  readonly requests: Array<{ tag: string; request: ChatRequest }> = []
  readonly #routes: Route[]
  #calls = 0

  constructor(routes: Route[]) {
    this.#routes = routes
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const promptText = request.messages.map((message) => message.content).join('\n')
    const route = this.#routes.find((candidate) => candidate.match(promptText))
    if (route === undefined) {
      throw new Error(`unscripted prompt: ${promptText.slice(0, 200)}`)
    }
    this.#calls += 1
    this.requests.push({ tag: route.tag, request })
    return { text: route.reply(request, this.#calls) }
  }

  tags(): string[] {
    return this.requests.map((entry) => entry.tag)
  }

  /** Every prompt sent for one stage, joined system+user. */
  prompts(tag: string): string[] {
    return this.requests
      .filter((entry) => entry.tag === tag)
      .map((entry) => entry.request.messages.map((message) => message.content).join('\n'))
  }
}

// ---------------------------------------------------------------------------
// Offline retrievers / scraper seam
// ---------------------------------------------------------------------------

const PREFETCHED_BODY =
  'Prefetched research body. Multi-agent research runs an orchestrator, an editor, ' +
  'per-section researchers, a reviewer and reviser loop, a writer, and a publisher. ' +
  'This text is long enough that the retriever result is treated as a full document.'

const SCRAPED_HTML = `<!doctype html>
<html><head><title>Scraped Source</title>
<meta name="description" content="Canned offline test page"></head>
<body><article>
<h1>Scraped Source</h1>
<p>This canned page exists so the configured bs scraper runs against the injected HTTP
seam rather than the network. It contains enough prose for the extractor to keep.</p>
<p>The multi-agent pipeline plans sections with an editor, researches each section,
reviews and revises the draft, then writes and publishes the report.</p>
</article></body></html>`

/** A retriever that returns one prefetched document and one URL to scrape. */
const STUB_RETRIEVER: RetrieverDefinition = {
  name: 'stub',
  keys: [],
  keyless: true,
  description: 'Offline retriever used by the multi-agent pipeline test.',
  create: () => ({
    search: async () => [
      {
        url: 'https://example.test/prefetched',
        title: 'Prefetched Source',
        raw_content: PREFETCHED_BODY,
      },
      { url: 'https://example.test/scraped', title: 'Scraped Source' },
    ],
  }),
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('ChiefEditorAgent.runResearchTask completes the full multi-agent pipeline offline', async () => {
  // The first review sends work back to the reviser; every later review accepts.
  let reviewerCalls = 0
  const client = new ScriptedChatClient([
    {
      tag: 'orchestrator:agent',
      match: (text) => text.includes('This task involves researching a given topic'),
      reply: () =>
        '{"server": "Default Agent", "agent_role_prompt": "You are a research assistant."}',
    },
    {
      tag: 'orchestrator:subqueries',
      match: (text) => text.includes('search queries to research the following task'),
      reply: () => '["query one", "query two"]',
    },
    {
      tag: 'orchestrator:report',
      match: (text) => text.includes('Using the above information, answer the following query or task'),
      reply: () => '# Initial research report\n\nBody of the initial research report.',
    },
    {
      tag: 'editor:plan',
      match: (text) => text.includes('You are a research editor'),
      reply: () =>
        '{"title": "Multi-Agent Report", "date": "01/02/2026", "sections": ["Section One", "Section Two"]}',
    },
    {
      tag: 'researcher:section',
      match: (text) => text.includes('construct a detailed report on the subtopic'),
      reply: () => '## Section body\n\nDetailed section content written from research.',
    },
    {
      tag: 'reviewer',
      match: (text) => text.includes('expert research article reviewer'),
      reply: () => {
        reviewerCalls += 1
        return reviewerCalls === 1 ? 'Add more quantitative detail.' : 'None'
      },
    },
    {
      tag: 'reviser',
      match: (text) => text.includes('revise drafts based on reviewer notes'),
      reply: () =>
        '{"draft": "## Revised section body\\n\\nNow with numbers.", "revision_notes": "added numbers"}',
    },
    {
      tag: 'writer:headers',
      match: (text) => text.includes('revise the given headers JSON'),
      reply: () =>
        '{"title": "Multi-Agent Report", "date": "Date", "introduction": "Introduction", "table_of_contents": "Table of Contents", "conclusion": "Conclusion", "references": "References"}',
    },
    {
      tag: 'writer:sections',
      match: (text) => text.includes('Your sole purpose is to write a well-written'),
      reply: () =>
        '{"table_of_contents": "- Section One\\n- Section Two", "introduction": "Intro text", "conclusion": "Conclusion text", "sources": ["- Source, 2026, Author [url](url)"]}',
    },
  ])

  const config = new Config({
    env: () => undefined,
    overrides: {
      RETRIEVER: 'stub',
      EMBEDDING: 'local:local',
      MEMORY_BACKEND: 'none',
      VERBOSE: false,
    },
  })

  const httpCalls: string[] = []
  const http: HttpFetch = async (url) => {
    httpCalls.push(url)
    return {
      ok: true,
      status: 200,
      header: () => null,
      text: async () => SCRAPED_HTML,
      json: async () => ({}) as unknown,
    }
  }

  const events: ProgressEvent[] = []
  const deps: EngineDeps = {
    runtime: makeRuntime({
      llm: client,
      http,
      env: () => undefined,
      log: silentLogger,
      progress: (event) => events.push(event),
    }),
    config,
    prompts: get_prompt_family('default', config),
    costs: new CostTracker(),
  }

  const task: Task = {
    query: 'How does the multi-agent research pipeline work?',
    model: 'gpt-4o',
    max_sections: 2,
    include_human_feedback: false,
    follow_guidelines: true,
    guidelines: ['Cite sources', 'Be concise'],
    verbose: false,
    source: 'web',
    publish_formats: { markdown: true },
    max_revisions: 3,
  }

  const published: Array<{ format: string; layout: string }> = []
  const chiefEditor = new ChiefEditorAgent(deps, task, {
    retrieverRegistry: new RetrieverRegistry([STUB_RETRIEVER]),
    maxSectionWorkers: 2,
    onPublish: (format, layout) => {
      published.push({ format, layout })
    },
  })

  const result = await chiefEditor.runResearchTask()

  // --- every stage made a model call, asserted on the recorded prompts ------
  const stages = new Set(client.tags())
  for (const stage of [
    'orchestrator:agent',
    'orchestrator:subqueries',
    'orchestrator:report',
    'editor:plan',
    'researcher:section',
    'reviewer',
    'reviser',
    'writer:headers',
    'writer:sections',
  ]) {
    assert.ok(stages.has(stage), `expected a model call for stage '${stage}'`)
  }

  // The initial research report (orchestrator) flows into the editor prompt…
  assert.ok(
    client.prompts('editor:plan')[0]?.includes(
      "Research summary report: '# Initial research report",
    ),
  )
  // …the planned sections flow into the per-section researchers…
  const sectionPrompts = client.prompts('researcher:section').join('\n')
  assert.ok(sectionPrompts.includes('Section One'))
  assert.ok(sectionPrompts.includes('Section Two'))
  // …the reviewer's feedback flows into the reviser…
  assert.ok(client.prompts('reviser')[0]?.includes('Add more quantitative detail.'))
  // …and the collected drafts flow into the writer.
  assert.ok(client.prompts('writer:sections')[0]?.includes('Research data: ['))
  assert.ok(client.prompts('writer:sections')[0]?.includes('Section body'))

  // --- progress logging matches upstream's stream_output steps -------------
  const steps = new Set(events.map((event) => event.step))
  for (const step of [
    'starting_research',
    'initial_research',
    'parallel_research',
    'depth_research',
    'writing_report',
    'publishing',
  ]) {
    assert.ok(steps.has(step), `expected a progress event for step '${step}'`)
  }
  assert.ok(
    events.some(
      (event) =>
        event.step === 'starting_research' &&
        event.message ===
          "Starting the research process for query 'How does the multi-agent research pipeline work?'...",
    ),
  )

  // --- the result carries every upstream state field ----------------------
  assert.equal(result.task, task)
  assert.equal(result.initial_research, '# Initial research report\n\nBody of the initial research report.')
  assert.deepEqual(result.sections, ['Section One', 'Section Two'])
  assert.equal(result.title, 'Multi-Agent Report')
  assert.equal(result.date, '01/02/2026')
  assert.equal(result.human_feedback, null)
  assert.equal(result.introduction, 'Intro text')
  assert.equal(result.conclusion, 'Conclusion text')
  assert.equal(result.table_of_contents, '- Section One\n- Section Two')
  assert.deepEqual(result.sources, ['- Source, 2026, Author [url](url)'])
  assert.equal(result.references, '- Source, 2026, Author [url](url)')
  assert.equal(result.research_data.length, 2)
  // `drafts` are the per-section `DraftState.draft` values; `draft` is the
  // assembled document (upstream's publisher returns the layout it persists).
  assert.deepEqual(result.drafts, result.research_data)
  assert.equal(result.draft, result.report)
  assert.equal(result.headers.title, 'Multi-Agent Report')

  // --- the assembled document contains every upstream section -------------
  assert.ok(result.report.startsWith('# Multi-Agent Report\n#### Date: 01/02/2026\n\n'))
  assert.ok(result.report.includes('## Introduction\nIntro text'))
  assert.ok(result.report.includes('## Table of Contents\n- Section One\n- Section Two'))
  assert.ok(result.report.includes('## Conclusion\nConclusion text'))
  assert.ok(result.report.includes('## References\n- Source, 2026, Author [url](url)'))
  // Both sections contributed a body (one of them the reviser's rewrite).
  assert.equal(result.report.split('## Section body').length - 1, 1)
  assert.ok(result.report.includes('## Revised section body'))

  // --- offline guarantees -------------------------------------------------
  // The only HTTP requests were scrapes the stub retriever forced; every other
  // source was prefetched by the retriever. The same URL is fetched once per
  // `GptResearcher` instance (each section researcher owns its visited-URL set,
  // exactly as upstream's per-subtopic `GPTResearcher` does), so only the set of
  // hosts is asserted.
  assert.ok(httpCalls.length >= 1)
  assert.deepEqual([...new Set(httpCalls)], ['https://example.test/scraped'])
  assert.deepEqual(published.map((entry) => entry.format), ['markdown'])
  assert.equal(published[0]?.layout, result.report)
})
