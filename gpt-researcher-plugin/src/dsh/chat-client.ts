/**
 * DSH LLM adapter: a {@link ChatClient} backed by `ctx.llm.stream()`.
 *
 * This is the only place in the plugin that knows about the harness LLM
 * service. It assembles the chunk stream into text with DSH's own
 * `BlockAssembler`, so the provider's real `usage` counters reach the cost
 * tracker instead of an estimate.
 *
 * @module gpt-researcher/dsh/chat-client
 */

import { BlockAssembler, LlmError, type ContentBlock } from '@deepseek-ai/dsh-llm'

import type { CompleteFn } from '../llm/chat.ts'
import type { ModelRoute } from '../runtime.ts'
import type { ChatRequest, ChatResult } from '../types.ts'

/** The minimal `ctx.llm` surface this adapter uses. */
export interface LlmStreamService {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: Array<{ role: 'user'; content: ContentBlock[] }>
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/**
 * Build the completion function for a DSH deployment.
 *
 * System-role messages are lifted into `GenerateOptions.system` (the one-shot
 * caller contract) and the remaining messages become user inputs, because a
 * hand-built one-shot request has no session history to replay.
 *
 * @param llm - the `ctx.llm` service.
 * @returns a {@link CompleteFn} to hand to the tiered chat client.
 */
export function createDshComplete(llm: LlmStreamService): CompleteFn {
  return async (route: ModelRoute, request: ChatRequest): Promise<ChatResult> => {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const userMessages = request.messages.filter((message) => message.role !== 'system')
    const messages = (
      userMessages.length > 0 ? userMessages : [{ role: 'user' as const, content: '' }]
    ).map((message) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: message.content }] as ContentBlock[],
    }))

    // Omit `maxTokens` when nothing specifies a limit so the adapter applies its
    // own default, instead of silently capping every call at 4096 tokens (which
    // truncated long reports and multi-agent section drafts without any signal).
    const maxTokens = request.maxTokens ?? route.maxTokens
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(system.length > 0 ? { system } : {}),
      messages,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })) {
      assembler.push(chunk as never)
    }

    const blocks = assembler.blocks()
    const text = blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')

    // A failed model call arrives as an `error`/`aborted` FINISH CHUNK, not as a
    // thrown exception: the harness encodes provider failures in the stream so a
    // partially streamed response stays usable. Ignoring that would turn a hard
    // failure (no adapter, bad key, rate limit) into an empty completion, and the
    // engine's fallback ladders would treat it as a valid empty answer — the
    // caller would see "no report text" instead of the real reason. Fail loudly
    // here so callers get the harness's own code and message.
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = finish.failure
      throw new LlmError(
        failure?.message ?? `model call ${finish.kind} for ${route.provider}/${route.model}`,
        failure?.code ?? 'LLM_STREAM_FAILED',
        {
          ...(failure?.status === undefined ? {} : { status: failure.status }),
          ...(failure?.requestId === undefined ? {} : { requestId: failure.requestId }),
        },
      )
    }

    const usage = assembler.usage
    return {
      text,
      provider: route.provider,
      model: route.model,
      ...(usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            },
          }),
    }
  }
}
