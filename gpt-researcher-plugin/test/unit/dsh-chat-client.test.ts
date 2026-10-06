/**
 * Unit tests for the harness LLM adapter (`src/dsh/chat-client.ts`).
 *
 * The important behaviour here is failure propagation. The harness reports a
 * model failure as an `error` *finish chunk* rather than a thrown exception, so
 * an adapter that only reads the assembled text turns "no adapter registered"
 * into an empty — but successful-looking — completion. These tests pin the
 * translation from chunk to exception.
 *
 * @module test/unit/dsh-chat-client
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDshComplete, type LlmStreamService } from '../../src/dsh/chat-client.ts'
import type { ModelRoute } from '../../src/runtime.ts'
import type { ChatRequest } from '../../src/types.ts'

/** One recorded stream call. */
interface RecordedCall {
  provider: string
  model: string
  system?: string
  messages: Array<{ role: 'user'; content: Array<{ type: string; text?: string }> }>
  maxTokens?: number
  temperature?: number
}

/** A fake `ctx.llm` that yields a fixed chunk sequence. */
function fakeLlm(chunks: readonly unknown[]): LlmStreamService & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    stream(options: RecordedCall): AsyncIterable<unknown> {
      calls.push(options)
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const ROUTE: ModelRoute = { provider: 'test-provider', model: 'test-model' }

const REQUEST: ChatRequest = {
  tier: 'smart',
  messages: [
    { role: 'system', content: 'you are a researcher' },
    { role: 'user', content: 'find things' },
  ],
  temperature: 0.35,
  maxTokens: 512,
}

const TEXT_STREAM = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hello ' },
  { type: 'text-delta', index: 0, text: 'world' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('createDshComplete', () => {
  it('assembles text and reported usage from a normal stream', async () => {
    const complete = createDshComplete(fakeLlm(TEXT_STREAM))

    const result = await complete(ROUTE, REQUEST)

    assert.equal(result.text, 'hello world')
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 })
    assert.equal(result.provider, 'test-provider')
    assert.equal(result.model, 'test-model')
  })

  it('lifts system messages into the one-shot system slot and sends user inputs', async () => {
    const llm = fakeLlm(TEXT_STREAM)
    const complete = createDshComplete(llm)

    await complete(ROUTE, REQUEST)

    const call = llm.calls[0]
    assert.ok(call)
    assert.equal(call.system, 'you are a researcher')
    assert.equal(call.messages.length, 1)
    assert.deepEqual(call.messages[0]?.content, [{ type: 'text', text: 'find things' }])
    assert.equal(call.temperature, 0.35)
    assert.equal(call.maxTokens, 512)
    assert.equal(call.provider, 'test-provider')
    assert.equal(call.model, 'test-model')
  })

  it('throws with the harness failure code when the stream finishes with an error', async () => {
    const complete = createDshComplete(
      fakeLlm([
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'no adapter registered for provider "nope"', code: 'NO_ADAPTER' },
          },
        },
      ]),
    )

    await assert.rejects(
      () => complete(ROUTE, REQUEST),
      (error: unknown) => {
        const typed = error as { code?: string; message?: string }
        assert.equal(typed.code, 'NO_ADAPTER')
        assert.match(typed.message ?? '', /no adapter registered/)
        return true
      },
    )
  })

  it('throws when the stream finishes as aborted', async () => {
    const complete = createDshComplete(
      fakeLlm([
        {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'caller cancelled', code: 'ABORTED' } },
        },
      ]),
    )

    await assert.rejects(() => complete(ROUTE, REQUEST), /caller cancelled/)
  })

  it('omits maxTokens when nothing specifies a limit, so the adapter decides', async () => {
    const llm = fakeLlm(TEXT_STREAM)
    const complete = createDshComplete(llm)

    await complete({ provider: 'p', model: 'm' }, { tier: 'smart', messages: [{ role: 'user', content: 'hi' }] })

    const call = llm.calls[0] as unknown as { maxTokens?: number }
    assert.equal(
      call.maxTokens,
      undefined,
      'a hardcoded 4096 fallback silently truncated long reports and multi-agent drafts',
    )
  })

  it('prefers the request limit and falls back to the route limit', async () => {
    const requestLlm = fakeLlm(TEXT_STREAM)
    await createDshComplete(requestLlm)(ROUTE, { ...REQUEST, maxTokens: 12_000 })
    assert.equal((requestLlm.calls[0] as unknown as { maxTokens?: number }).maxTokens, 12_000)

    const routeLlm = fakeLlm(TEXT_STREAM)
    const { maxTokens: _ignored, ...withoutRequestLimit } = REQUEST
    await createDshComplete(routeLlm)({ ...ROUTE, maxTokens: 9_000 }, withoutRequestLimit)
    assert.equal((routeLlm.calls[0] as unknown as { maxTokens?: number }).maxTokens, 9_000)
  })

  it('returns partial text when a stream stops at max tokens', async () => {
    const complete = createDshComplete(
      fakeLlm([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'truncated' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'truncated' } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ]),
    )

    const result = await complete(ROUTE, REQUEST)
    assert.equal(result.text, 'truncated')
  })
})
