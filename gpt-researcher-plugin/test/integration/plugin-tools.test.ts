/**
 * Integration test of the DSH layer: the plugin entry, the tool definitions,
 * the model-route resolution, the `ctx.llm` adapter, and the artifact writer.
 *
 * It runs the tools the way the harness does — `execute(args, exec)` against a
 * fake `ctx` — with a fake `ctx.llm` chunk stream and a fake `ctx.web` seam, and
 * validates every canonical result against the tool's own declared output
 * schema. That is the strongest offline proof available that a mounted plugin
 * will behave in a real session.
 *
 * @module test/integration/plugin-tools.test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'

import { apply } from '../../src/index.ts'
import { PROMPT_MATCHERS } from '../helpers/harness.ts'

/** The tools this plugin registers. */
const EXPECTED_TOOLS = [
  'gptr_research',
  'gptr_deep_research',
  'gptr_multi_agent_research',
  'gptr_quick_search',
  'gptr_write_report',
  'gptr_search_sources',
  'gptr_get_subtopics',
  'gptr_capabilities',
]

/**
 * A fake `ctx.llm` that streams a canned reply chosen by prompt content.
 *
 * `failure` makes it stream an `error` finish chunk — the shape the harness uses
 * for a failed model call — instead of text.
 */
function fakeLlmStream(
  replies: Array<{ match: string; reply: string }>,
  fallback = '{}',
  failure?: { message: string; code: string },
) {
  const calls: Array<{ system?: string; messages: Array<{ content: unknown }> }> = []
  return {
    calls,
    stream(options: {
      provider: string
      model: string
      system?: string
      messages: Array<{ role: 'user'; content: unknown }>
    }): AsyncIterable<unknown> {
      if (failure) {
        const finish = { type: 'finish', reason: { kind: 'error', failure } }
        return (async function* fail() {
          yield finish
        })()
      }
      calls.push({ ...(options.system === undefined ? {} : { system: options.system }), messages: options.messages })
      const text = [
        options.system ?? '',
        ...options.messages.map((message) =>
          JSON.stringify(message.content),
        ),
      ].join('\n')
      const hit = replies.find((rule) => text.includes(rule.match))
      const reply = hit?.reply ?? fallback
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 60 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * A fake `ctx.web` seam that honours the real `WebServiceLike` contract —
 * `search(request, signal)` — and rejects on abort the way undici does.
 *
 * `delayMs` matters: fakes that always resolve in a microtask hid a defect where
 * `gptr_search_sources` passed the wrong context object and therefore composed a
 * ~2 ms timeout that aborted every real request.
 */
function fakeWeb(
  sources: Array<{ url: string; title?: string; snippet?: string }>,
  delayMs = 0,
) {
  const searchCalls: string[] = []
  const honour = async (signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted) {
      const reason = signal.reason
      throw reason instanceof Error ? reason : new Error('aborted')
    }
    if (delayMs <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        },
        { once: true },
      )
    })
  }
  return {
    searchCalls,
    async search(request: { query: string; maxResults?: number }, signal?: AbortSignal) {
      searchCalls.push(request.query)
      await honour(signal)
      return { sources }
    },
    async fetch(request: { url: string }, signal?: AbortSignal) {
      await honour(signal)
      return {
        url: request.url,
        statusCode: 200,
        body: { kind: 'text' as const, content: `Fetched body for ${request.url} `.repeat(30) },
      }
    },
  }
}

/** Collect the registered definitions from a fake context. */
function fakeContext(llm: unknown, web: unknown) {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = { llm, web }
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition)
        return () => {}
      },
    },
    // The plugin reads optional services through `ctx.reflect.get`, never as
    // plain properties (cordis forbids undeclared property access).
    reflect: {
      get(name: string) {
        return services[name]
      },
    },
    // The plugin registers its tools inside a cordis effect.
    effect(generator: () => Generator<unknown>) {
      const iterator = generator()
      for (const disposer of iterator) void disposer
      return () => {}
    },
  }
  return { ctx, registered }
}

/** Build a minimal ToolRunContext stand-in for direct dispatch. */
function fakeExec() {
  const notices: string[] = []
  return {
    notices,
    agent: {
      options: { provider: 'fake-provider', model: 'fake-model' },
      session: {
        requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
      },
    },
    signal: new AbortController().signal,
    deferContext: (message: { content: Array<{ text?: string }> }) => {
      const text = message.content.map((block) => block.text ?? '').join('')
      if (text.length > 0) notices.push(text)
    },
  }
}

/**
 * Assert a canonical tool value satisfies the tool's declared output schema.
 *
 * `defineTool` compiles the authored spec at definition time, so
 * `output.schema` is already a JSON Schema — it is validated directly rather
 * than recompiled.
 */
function assertMatchesOutputSchema(definition: ToolDefinition, value: unknown): void {
  const schema = definition.output.schema
  assertObjectJsonSchema(schema)
  // `validateJsonSchemaValue` returns path-qualified violations; empty is valid.
  const violations = validateJsonSchemaValue(schema, value)
  assert.deepEqual(
    violations,
    [],
    `${definition.name} output violated its schema: ${JSON.stringify(violations)}`,
  )
}

describe('DSH plugin tools (offline)', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'gptr-plugin-'))
  const originalFetch = globalThis.fetch

  before(() => {
    // The default HTTP seam is global fetch; the `bs` scraper uses it, so the
    // test stands in for the network rather than replacing the seam.
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url)
      return new Response(
        `<html><head><title>Doc ${target}</title></head><body><main>` +
          `<p>Body for ${target} with useful research content and detail.</p>`.repeat(10) +
          '</main></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      )
    }) as typeof fetch
  })

  after(() => {
    globalThis.fetch = originalFetch
    rmSync(workDir, { recursive: true, force: true })
  })

  it('registers every tool with a valid schema', () => {
    const llm = fakeLlmStream([])
    const { ctx, registered } = fakeContext(llm, fakeWeb([]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })

    const names = registered.map((definition) => definition.name).sort()
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort())
    for (const definition of registered) {
      assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
      assert.ok(definition.output, `${definition.name} must declare an output`)
      // A registered tool's output schema is always a compiled object schema.
      assertObjectJsonSchema(definition.output.schema)
    }
  })

  it('gptr_search_sources returns canonical results from the native web seam', async () => {
    const { ctx, registered } = fakeContext(fakeLlmStream([]), fakeWeb([
      { url: 'https://a.example/1', title: 'A1', snippet: 'snippet one' },
      { url: 'https://b.example/2', title: 'B2', snippet: 'snippet two' },
    ]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_search_sources')
    assert.ok(tool)

    const value = await tool.execute(
      { query: 'anything', retrievers: ['dsh_web'] },
      fakeExec() as never,
    )

    assertMatchesOutputSchema(tool, value)
    const result = value as { results: Array<{ url: string; retriever: string }>; errors: unknown[] }
    assert.equal(result.results.length, 2)
    assert.equal(result.results[0]?.url, 'https://a.example/1')
    assert.equal(result.results[0]?.retriever, 'dsh_web')
    assert.deepEqual(result.errors, [])
  })

  it('gptr_search_sources works against a provider with real latency', async () => {
    // Regression for a defect this test used to hide: the tool passed
    // `EngineDeps` where a `RetrieverContext` is required, so `config.timeoutMs`
    // was undefined and `withTimeout(signal, undefined)` aborted after ~2 ms.
    const { ctx, registered } = fakeContext(
      fakeLlmStream([]),
      fakeWeb([{ url: 'https://a.example/1', title: 'A1', snippet: 'snippet one' }], 30),
    )
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_search_sources')
    assert.ok(tool)

    const value = await tool.execute(
      { query: 'anything', retrievers: ['dsh_web'] },
      fakeExec() as never,
    )

    const result = value as { results: Array<{ url: string }>; errors: Array<{ message: string }> }
    assert.deepEqual(result.errors, [], `unexpected errors: ${JSON.stringify(result.errors)}`)
    assert.equal(result.results.length, 1)
  })

  it('aborts a run in flight instead of reporting an empty success', async () => {
    const controller = new AbortController()
    // Abort during the first model call, then assert nothing else is attempted.
    let calls = 0
    const llm = {
      stream() {
        calls += 1
        controller.abort(new Error('user cancelled'))
        return (async function* generate() {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'user cancelled', code: 'ABORTED' } } }
        })()
      },
      calls: () => calls,
    }
    const { ctx, registered } = fakeContext(llm, fakeWeb([]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_research')
    assert.ok(tool)
    const exec = { ...fakeExec(), signal: controller.signal }

    await assert.rejects(
      () => tool.execute({ query: 'cancel me', max_iterations: 1 }, exec as never),
      /cancel|abort/i,
    )
    assert.equal(llm.calls(), 1, 'no further model calls may happen after an abort')
  })

  it('gptr_quick_search summarises when asked', async () => {
    const llm = fakeLlmStream([{ match: PROMPT_MATCHERS.quickSummary, reply: 'Synthesised answer.' }])
    const { ctx, registered } = fakeContext(llm, fakeWeb([
      { url: 'https://a.example/1', title: 'A1', snippet: 'snippet one' },
    ]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_quick_search')
    assert.ok(tool)

    const value = await tool.execute(
      { query: 'quick question', aggregated_summary: true },
      fakeExec() as never,
    )

    assertMatchesOutputSchema(tool, value)
    const result = value as { summary: string; results: unknown[] }
    assert.equal(result.summary, 'Synthesised answer.')
    assert.equal(result.results.length, 1)
  })

  it('gptr_get_subtopics plans sections', async () => {
    const llm = fakeLlmStream([
      {
        match: PROMPT_MATCHERS.subtopics,
        reply: JSON.stringify({ subtopics: [{ task: 'History' }, { task: 'Economics' }] }),
      },
    ])
    const { ctx, registered } = fakeContext(llm, fakeWeb([]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_get_subtopics')
    assert.ok(tool)

    const value = await tool.execute(
      { query: 'the topic', context: 'some context', max_subtopics: 2 },
      fakeExec() as never,
    )

    assertMatchesOutputSchema(tool, value)
    assert.deepEqual((value as { subtopics: string[] }).subtopics, ['History', 'Economics'])
  })

  it('gptr_research runs the whole pipeline and writes artifacts', async () => {
    const llm = fakeLlmStream([
      {
        match: PROMPT_MATCHERS.agentSelection,
        reply: JSON.stringify({ server: 'Default Agent', agent_role_prompt: 'You are a researcher.' }),
      },
      { match: PROMPT_MATCHERS.searchQueries, reply: JSON.stringify(['planned sub query']) },
      { match: PROMPT_MATCHERS.report, reply: '# Final report\n\nBody with ([cite](https://a.example/1)).' },
    ])
    const web = fakeWeb([
      { url: 'https://a.example/1', title: 'A1', snippet: 'snippet one' },
      { url: 'https://b.example/2', title: 'B2', snippet: 'snippet two' },
    ])
    const { ctx, registered } = fakeContext(llm, web)
    apply(ctx as never, {
      outputDir: workDir,
      retriever: 'dsh_web',
      scraper: 'bs',
      writeArtifacts: true,
      tone: 'Objective',
    })
    const tool = registered.find((definition) => definition.name === 'gptr_research')
    assert.ok(tool)
    const exec = fakeExec()

    const value = await tool.execute({ query: 'a real research question' }, exec as never)

    assertMatchesOutputSchema(tool, value)
    const result = value as {
      ok: boolean
      report: string
      report_path?: string
      sources: Array<{ url: string }>
      visited_urls: string[]
      costs: { total: number }
      stats: { retrievers: string[]; scraper: string; provider?: string; model?: string }
      warnings: string[]
    }
    assert.equal(result.ok, true)
    assert.match(result.report, /Final report/)
    assert.ok(result.sources.length >= 2, `expected scraped sources, got ${result.sources.length}`)
    assert.ok(result.visited_urls.length >= 2)
    assert.ok(result.costs.total > 0, 'real usage tokens should produce a non-zero cost')
    assert.deepEqual(result.stats.retrievers, ['dsh_web'])
    assert.equal(result.stats.scraper, 'bs')
    assert.equal(result.stats.provider, 'fake-provider')
    assert.equal(result.stats.model, 'fake-model')

    // The report and its sources were written to disk.
    assert.ok(result.report_path, 'a report path should be returned')
    const written = readFileSync(result.report_path, 'utf8')
    assert.match(written, /# Research report: a real research question/)
    assert.match(written, /Final report/)

    // Progress and warnings reached the session as deferred context, throttled
    // to phase milestones: the engine emitted 41 progress events for a run this
    // size before the throttle existed, and each one is a user-role message the
    // model re-reads on later turns.
    assert.ok(
      exec.notices.some((notice) => notice.includes('planning_research')),
      `expected planning progress, got ${exec.notices.join(' | ')}`,
    )
    assert.ok(
      exec.notices.length <= 15,
      `progress must be throttled, got ${exec.notices.length} session notices: ${exec.notices.join(' | ')}`,
    )
  })

  it('gptr_write_report writes from supplied context without searching', async () => {
    const llm = fakeLlmStream([
      { match: PROMPT_MATCHERS.report, reply: '# Written from context\n\nContent.' },
    ])
    const web = fakeWeb([])
    const { ctx, registered } = fakeContext(llm, web)
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_write_report')
    assert.ok(tool)

    const value = await tool.execute(
      {
        query: 'write from context',
        context: 'Title: Provided\nContent: Provided research context about the topic.',
        report_type: 'research_report',
        write_artifacts: false,
      },
      fakeExec() as never,
    )

    assertMatchesOutputSchema(tool, value)
    assert.match((value as { report: string }).report, /Written from context/)
    assert.equal(web.searchCalls.length, 0, 'no search should happen')
  })

  it('surfaces a failed model call instead of returning an empty answer', async () => {
    const llm = fakeLlmStream([], '{}', {
      message: 'no adapter registered for provider "nope"',
      code: 'NO_ADAPTER',
    })
    const { ctx, registered } = fakeContext(llm, fakeWeb([
      { url: 'https://a.example/1', title: 'A1', snippet: 'snippet one' },
    ]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_quick_search')
    assert.ok(tool)

    // Aggregated summary is the one engine path with no upstream fallback, so a
    // model failure must reach the caller rather than becoming an empty string.
    await assert.rejects(
      () => tool.execute({ query: 'x', aggregated_summary: true }, fakeExec() as never),
      /no adapter registered for provider/,
    )
  })

  it('gptr_capabilities reports what the deployment can run', async () => {
    const { ctx, registered } = fakeContext(fakeLlmStream([]), fakeWeb([]))
    apply(ctx as never, { outputDir: workDir, retriever: 'dsh_web', scraper: 'bs' })
    const tool = registered.find((definition) => definition.name === 'gptr_capabilities')
    assert.ok(tool)

    const value = await tool.execute({}, fakeExec() as never)

    assertMatchesOutputSchema(tool, value)
    const result = value as {
      executable: boolean
      text: string
      capabilities: {
        retrievers: Array<{ name: string; usable: boolean }>
        report_types: string[]
        tones: string[]
      }
    }
    assert.equal(result.executable, true)
    assert.ok(result.capabilities.retrievers.some((item) => item.name === 'dsh_web' && item.usable))
    assert.ok(result.capabilities.report_types.includes('research_report'))
    assert.ok(result.capabilities.tones.includes('Objective'))
    assert.match(result.text, /usable retrievers/)
  })
})
