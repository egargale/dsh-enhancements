/**
 * End-to-end integration test of the research pipeline with every I/O seam
 * faked. This is the test that proves the port actually runs: it drives the
 * real `GptResearcher`, the real retriever/scraper registries, the real context
 * compressor, and the real prompt builders, and asserts on the observable
 * behaviour of a complete run.
 *
 * @module test/integration/research-pipeline.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GptResearcher } from '../../src/agent.ts'
import {
  AGENT_REPLY,
  PROMPT_MATCHERS,
  fakeRetriever,
  fakeRetrieverRegistry,
  fakeScraper,
  fakeScraperRegistry,
  makeDeps,
  scriptedChatClient,
} from '../helpers/harness.ts'

describe('research pipeline (offline, faked seams)', () => {
  it('runs the full web research flow and returns a report with sources and costs', async () => {
    const llm = scriptedChatClient([
      { match: PROMPT_MATCHERS.agentSelection, reply: AGENT_REPLY },
      {
        match: PROMPT_MATCHERS.searchQueries,
        reply: JSON.stringify(['quantum computing hardware', 'quantum error correction']),
      },
      {
        match: PROMPT_MATCHERS.report,
        reply: '# Quantum computing\n\nSuperposition and error correction matter.',
        usage: { inputTokens: 1000, outputTokens: 500 },
      },
    ])
    const retriever = fakeRetriever('fake', (query) => [
      { url: `https://example.com/${encodeURIComponent(query)}`, title: query, content: `snippet for ${query}` },
      { url: 'https://example.com/extra', title: 'Extra', content: 'snippet' },
    ])
    const harness = makeDeps({ llm, config: { MAX_ITERATIONS: 2 } })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'How does quantum computing work?',
      reportType: 'research_report',
      retrieverRegistry: fakeRetrieverRegistry([retriever]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    const outcome = await researcher.run()

    // The report came back and was written by the writer prompt.
    assert.match(outcome.report, /Quantum computing/)
    assert.equal(outcome.reportType, 'research_report')

    // Retrieval actually happened: two URLs per sub-query, and the seed search
    // for planning is not counted as visited (it is a hit list, not a scrape).
    assert.ok(outcome.visitedUrls.length >= 2, `expected visited urls, got ${outcome.visitedUrls.length}`)
    assert.ok(outcome.sources.length >= 2, `expected scraped sources, got ${outcome.sources.length}`)
    assert.ok(outcome.sources.every((source) => source.raw_content.length > 0))
    assert.ok(outcome.context.length > 0, 'context should be populated')

    // Costs were attributed to the real steps.
    assert.ok(outcome.costs.total > 0, 'costs should accumulate')
    assert.ok(
      Object.keys(outcome.costs.perStep).length > 0,
      `expected per-step costs, got ${JSON.stringify(outcome.costs.perStep)}`,
    )
    assert.ok(outcome.costs.perStep.report_writing !== undefined)

    // Progress events reached the sink (upstream's websocket equivalent).
    const steps = harness.progressEvents.map((event) => event.step)
    assert.ok(steps.includes('planning_research'), `steps were ${steps.join(', ')}`)
    assert.ok(steps.includes('subqueries'))
    assert.ok(steps.includes('writing_report'))

    // The scraped, compressed sources reached the writer prompt.
    const writerPrompt = llm
      .promptsSeen()
      .find((prompt) => prompt.includes(PROMPT_MATCHERS.report))
    assert.ok(writerPrompt, 'the report prompt should have been sent')
    assert.match(writerPrompt, /Content about https:\/\/example\.com\//)
    // Each planned sub-query was actually searched (the URLs carry the query).
    assert.ok(
      outcome.visitedUrls.some((url) => url.includes('quantum%20error%20correction')),
      `expected a URL for the second sub-query, got ${outcome.visitedUrls.join(', ')}`,
    )
  })

  it('skips agent selection when a role is supplied and merges the parent query', async () => {
    const llm = scriptedChatClient([
      { match: PROMPT_MATCHERS.searchQueries, reply: JSON.stringify(['sub']) },
      { match: PROMPT_MATCHERS.subtopicReport, reply: '## Section\n\nBody.' },
    ])
    const harness = makeDeps({ llm })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'subtopic question',
      parentQuery: 'main question',
      reportType: 'subtopic_report',
      agent: 'Default Agent',
      role: 'You are a research assistant.',
      retrieverRegistry: fakeRetrieverRegistry([
        fakeRetriever('fake', [{ url: 'https://example.com/a', title: 'A', content: 'body' }]),
      ]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    const outcome = await researcher.run()

    assert.match(outcome.report, /Section/)
    // The main query is carried into the planner prompt as the parent query.
    assert.ok(
      llm.promptsSeen().some((prompt) => prompt.includes('main question')),
      'the parent query should reach the prompt',
    )
    assert.ok(!llm.promptsSeen().some((prompt) => prompt.includes(PROMPT_MATCHERS.agentSelection)))
  })

  it('curates sources when CURATE_SOURCES is on and replaces the context', async () => {
    const curated = JSON.stringify([
      { Title: 'A', Content: 'curated content A', Source: 'https://example.com/a' },
      { Title: 'B', Content: 'curated content B', Source: 'https://example.com/b' },
    ])
    const llm = scriptedChatClient([
      { match: PROMPT_MATCHERS.agentSelection, reply: AGENT_REPLY },
      { match: PROMPT_MATCHERS.searchQueries, reply: JSON.stringify(['sub']) },
      { match: PROMPT_MATCHERS.curation, reply: curated },
      { match: PROMPT_MATCHERS.report, reply: '# Report' },
    ])
    const harness = makeDeps({ llm, config: { CURATE_SOURCES: true } })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'curation test',
      retrieverRegistry: fakeRetrieverRegistry([
        fakeRetriever('fake', [{ url: 'https://example.com/a', title: 'A', content: 'body' }]),
      ]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    await researcher.run()

    assert.ok(researcher.context.includes('curated content A'), researcher.context)
    assert.ok(researcher.context.includes('Title: A'), researcher.context)
    // The structured view is kept in step with the flat string.
    assert.equal(researcher.contextSources.length, 2)
    assert.equal(researcher.contextSources[0]?.Source, 'https://example.com/a')
  })

  it('keeps the original context when curation returns garbage', async () => {
    const llm = scriptedChatClient([
      { match: PROMPT_MATCHERS.agentSelection, reply: AGENT_REPLY },
      { match: PROMPT_MATCHERS.searchQueries, reply: JSON.stringify(['sub']) },
      { match: PROMPT_MATCHERS.curation, reply: 'not json at all' },
      { match: PROMPT_MATCHERS.report, reply: '# Report' },
    ])
    const harness = makeDeps({ llm, config: { CURATE_SOURCES: true } })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'curation failure test',
      retrieverRegistry: fakeRetrieverRegistry([
        fakeRetriever('fake', [{ url: 'https://example.com/a', title: 'A', content: 'body' }]),
      ]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    await researcher.run()

    // Upstream returns the original data on a parse failure, so the *scraped*
    // context must survive — asserting only "non-empty" would also pass for an
    // unrelated replacement.
    assert.match(researcher.context, /Content about https:\/\/example\.com\//)
  })

  it('keeps the original context when curation returns valid JSON of the wrong shape', async () => {
    const llm = scriptedChatClient([
      { match: PROMPT_MATCHERS.agentSelection, reply: AGENT_REPLY },
      { match: PROMPT_MATCHERS.searchQueries, reply: JSON.stringify(['sub']) },
      // Valid JSON, wrong shape: `curate_sources` must not replace the context.
      { match: PROMPT_MATCHERS.curation, reply: JSON.stringify({ Title: 1 }) },
      { match: PROMPT_MATCHERS.report, reply: '# Report' },
    ])
    const harness = makeDeps({ llm, config: { CURATE_SOURCES: true } })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'curation shape test',
      retrieverRegistry: fakeRetrieverRegistry([
        fakeRetriever('fake', [{ url: 'https://example.com/a', title: 'A', content: 'body' }]),
      ]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    await researcher.run()

    assert.match(researcher.context, /Content about https:\/\/example\.com\//)
  })

  it('climbs the strategic→smart fallback ladder when the strategic model fails', async () => {
    const plannerTiers: string[] = []
    let plannerCalls = 0
    const llm = {
      async complete(request: { tier: string; messages: Array<{ content: string }> }) {
        const text = request.messages.map((message) => message.content).join('\n')
        if (text.includes(PROMPT_MATCHERS.searchQueries)) {
          plannerTiers.push(request.tier)
          plannerCalls += 1
          // The first two rungs (strategic without and with a token cap) fail;
          // the third rung is the smart model, which must answer.
          if (plannerCalls <= 2) throw new Error('strategic model unavailable')
          return { text: JSON.stringify(['recovered query']) }
        }
        if (text.includes(PROMPT_MATCHERS.agentSelection)) {
          return { text: AGENT_REPLY }
        }
        return { text: '# Report' }
      },
    }
    const harness = makeDeps({ llm })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'ladder test',
      retrieverRegistry: fakeRetrieverRegistry([
        // Query-dependent, so the assertion proves *which* query was researched.
        fakeRetriever('fake', (query) => [
          { url: `https://e.test/${encodeURIComponent(query)}`, title: query, content: 'body' },
        ]),
      ]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    const outcome = await researcher.run()

    assert.equal(plannerCalls, 3, 'all three rungs must be attempted')
    assert.deepEqual(
      plannerTiers,
      ['strategic', 'strategic', 'smart'],
      'the ladder is strategic → strategic-with-cap → smart',
    )
    assert.match(outcome.report, /Report/)
    assert.ok(
      outcome.visitedUrls.some((url) => url.includes('recovered')),
      `the recovered query must be researched, got ${outcome.visitedUrls.join(', ')}`,
    )
  })

  it('degrades to the original query when every planning rung fails', async () => {
    const llm = {
      async complete(request: { messages: Array<{ content: string }> }) {
        const text = request.messages.map((message) => message.content).join('\n')
        if (text.includes(PROMPT_MATCHERS.agentSelection)) return { text: AGENT_REPLY }
        if (text.includes(PROMPT_MATCHERS.searchQueries)) throw new Error('all planning rungs down')
        return { text: '# Report' }
      },
    }
    const harness = makeDeps({ llm })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'degrade test',
      retrieverRegistry: fakeRetrieverRegistry([
        fakeRetriever('fake', [{ url: 'https://e.test/1', title: 'A', content: 'body' }]),
      ]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    const outcome = await researcher.run()
    // No sub-queries, but the original query still drives the run.
    assert.match(outcome.report, /Report/)
    assert.ok(outcome.visitedUrls.length >= 1, 'the original query must still be researched')
  })

  it('answers from supplied source URLs without searching', async () => {
    const llm = scriptedChatClient([{ match: PROMPT_MATCHERS.report, reply: '# From URLs' }])
    const harness = makeDeps({ llm })
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'url-only research',
      sourceUrls: ['https://example.com/one', 'https://example.com/two'],
      agent: 'Default Agent',
      role: 'role',
      retrieverRegistry: fakeRetrieverRegistry([fakeRetriever('fake', [])]),
      scraperRegistry: fakeScraperRegistry([fakeScraper()]),
    })

    const outcome = await researcher.run()

    assert.match(outcome.report, /From URLs/)
    assert.deepEqual(
      outcome.visitedUrls.sort(),
      ['https://example.com/one', 'https://example.com/two'],
    )
    assert.ok(outcome.sources.length === 2)
    // No planning happened: the planner prompt never ran.
    assert.ok(!llm.promptsSeen().some((prompt) => prompt.includes(PROMPT_MATCHERS.searchQueries)))
  })

  it('does not re-scrape a URL that a previous sub-query already visited', async () => {
    const llm = scriptedChatClient([
      { match: PROMPT_MATCHERS.agentSelection, reply: AGENT_REPLY },
      { match: PROMPT_MATCHERS.searchQueries, reply: JSON.stringify(['a', 'b']) },
      { match: PROMPT_MATCHERS.report, reply: '# Report' },
    ])
    const harness = makeDeps({ llm })
    const scrapeCounts = new Map<string, number>()
    const researcher = new GptResearcher({
      deps: harness.deps,
      query: 'dedupe test',
      retrieverRegistry: fakeRetrieverRegistry([
        fakeRetriever('fake', [{ url: 'https://example.com/same', title: 'Same', content: 'body' }]),
      ]),
      scraperRegistry: fakeScraperRegistry([
        {
          name: 'fake',
          keys: [],
          keyless: true,
          description: 'counting scraper',
          async scrape(urls) {
            return urls.map((url) => {
              scrapeCounts.set(url, (scrapeCounts.get(url) ?? 0) + 1)
              return { url, raw_content: `content for ${url} `.repeat(20), title: url }
            })
          },
        },
      ]),
    })

    await researcher.run()

    assert.equal(scrapeCounts.get('https://example.com/same'), 1)
  })
})
