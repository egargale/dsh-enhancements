/**
 * Tiered chat client: the bridge between upstream's FAST/SMART/STRATEGIC model
 * tiers and whatever completion function the host provides.
 *
 * Upstream calls `create_chat_completion(model=cfg.smart_llm_model, …)` at ~15
 * call sites. The port keeps the call sites but routes every one through this
 * client, so a host (DSH's `ctx.llm`, or a test's scripted responder) decides
 * how a tier maps to a real model.
 *
 * @module gpt-researcher/llm/chat
 */

import type { ModelRoute, ModelRoutes } from '../runtime.ts'
import type { ChatClient, ChatRequest, ChatResult, LlmTier } from '../types.ts'

/** The host-supplied completion primitive; one call, one result. */
export type CompleteFn = (route: ModelRoute, request: ChatRequest) => Promise<ChatResult>

/**
 * A {@link ChatClient} that resolves a tier to a route and delegates.
 *
 * The client is deliberately thin: it adds no retries (the host's adapter
 * already owns them) and no prompt logic (that lives in `prompts.ts`).
 */
export class TieredChatClient implements ChatClient {
  /** The route table this client resolves tiers against. */
  readonly modelRoutes: ModelRoutes
  readonly #complete: CompleteFn

  constructor(routes: ModelRoutes, complete: CompleteFn) {
    this.modelRoutes = routes
    this.#complete = complete
  }

  /** The route a tier resolves to; useful for diagnostics and cost display. */
  routeFor(tier: LlmTier): ModelRoute {
    return this.modelRoutes[tier]
  }

  /** {@link ChatClient.complete}. */
  async complete(request: ChatRequest): Promise<ChatResult> {
    const route = this.modelRoutes[request.tier]
    if (!route) {
      throw new Error(`No model route configured for tier '${request.tier}'`)
    }
    const result = await this.#complete(route, request)
    return {
      ...result,
      provider: result.provider ?? route.provider,
      model: result.model ?? route.model,
    }
  }
}

/**
 * Build a route table from a base route, so a deployment that exposes only one
 * model still satisfies every tier.
 *
 * @param base - the resolved session model.
 * @param overrides - optional per-tier overrides.
 * @returns a complete route table.
 */
export function routesFromBase(
  base: ModelRoute,
  overrides: Partial<ModelRoutes> = {},
): ModelRoutes {
  return {
    fast: overrides.fast ?? base,
    smart: overrides.smart ?? base,
    strategic: overrides.strategic ?? base,
  }
}

/**
 * Concatenate message contents into the single string a cost estimate needs.
 *
 * @param messages - the request messages.
 * @returns the joined text.
 */
export function messagesToText(messages: readonly { content: string }[]): string {
  return messages.map((message) => message.content).join('\n')
}
