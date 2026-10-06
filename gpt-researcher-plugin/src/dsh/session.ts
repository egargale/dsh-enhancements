/**
 * DSH session wiring: model routes, runtime seams, and the native web bridge.
 *
 * Everything harness-specific lives under `src/dsh/` so the engine stays
 * portable and unit-testable. The three adapters here are:
 *
 * 1. {@link resolveModelRoutes} — the session's routed model becomes the
 *    FAST/SMART/STRATEGIC default, so an in-session run uses the model the user
 *    actually selected.
 * 2. {@link createDshRuntime} — `fetch`, environment, logging, cancellation,
 *    and progress (forwarded into the session as deferred context).
 * 3. {@link createWebSeam} — `ctx.web`, exposed as the `dsh_web` retriever and
 *    scraper so a deployment's configured search provider is reused rather
 *    than re-keyed.
 *
 * @module gpt-researcher/dsh/session
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

import type { ModelRoute, ModelRoutes, Runtime, WebSeam } from '../runtime.ts'
import { defaultHttpFetch, silentLogger } from '../runtime.ts'
import type { Logger, ProgressEvent, SearchResult } from '../types.ts'

/** The slice of a DSH tool execution this module needs. */
export interface ExecutionLike {
  agent?: {
    options?: { provider?: string; model?: string; maxTokens?: number }
    session?: {
      requestHeader(): { config?: { provider?: string; model?: string; maxTokens?: number } } | undefined
    }
  }
  signal: AbortSignal
  deferContext?: (context: UserMessage) => void
}

/** The slice of `ctx.web` this module uses. */
export interface WebServiceLike {
  search(
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{ sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }> }>
  fetch(
    request: { url: string },
    signal?: AbortSignal,
  ): Promise<{
    url: string
    statusCode: number
    body: { kind: 'html'; content: string } | { kind: 'text'; content: string }
  }>
}

/**
 * Read a service without declaring it in `inject`.
 *
 * Cordis throws `cannot get property "x" without inject` for an undeclared
 * service, and `ctx.reflect.get(name)` is its sanctioned read-without-inject
 * path. The plugin must use it because `llm` and `web` are *optional*
 * capabilities: a deployment may mount the tools without a web seam (search
 * disabled) or without an LLM adapter (introspection only), and the plugin
 * should still load and report what it cannot do.
 *
 * @param ctx - any context (the cordis context or a test double).
 * @param name - service name.
 * @returns the service, or undefined when it is absent or inactive.
 */
export function resolveOptionalService<T>(ctx: unknown, name: string): T | undefined {
  const reflect = (ctx as { reflect?: { get(name: string): unknown } }).reflect
  if (!reflect || typeof reflect.get !== 'function') return undefined
  try {
    return reflect.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Progress steps worth a durable session message.
 *
 * Deferred context becomes a **user-role message** the model reads on later
 * turns, so forwarding every engine event is both noisy and misleading: a
 * measured single-query `gptr_research` run emitted 41 events (scraping
 * per-URL ×4, planning ×2, …) and a deep-research run emits hundreds. Only
 * phase-level milestones are forwarded, at most once each per run; failures
 * (`…_error`, `…_not_found`) always pass through.
 */
const MILESTONE_STEPS: ReadonlySet<string> = new Set([
  'start',
  'starting_research',
  'agent_generated',
  'planning_research',
  'subqueries',
  'researching',
  'scraping_urls',
  'scraping_content',
  'research_step_finalized',
  'writing_report',
  'report_written',
  'writing_introduction',
  'writing_conclusion',
  'generating_subtopics',
  'subtopics_generated',
  'no_source_material',
  'deep_research',
  'deep_research_queries',
  'deep_research_start',
  'deep_research_complete',
  'cost_update',
])

/** Always worth forwarding, whatever the step vocabulary grows into. */
function isFailureStep(step: string): boolean {
  return step.includes('error') || step.includes('not_found') || step.includes('failed')
}

/** Explicit route overrides from the plugin configuration. */
export interface RouteOverrides {
  provider?: string
  fastModel?: string
  smartModel?: string
  strategicModel?: string
  maxTokens?: number
}

/**
 * Resolve the per-tier model routes.
 *
 * Priority (documented so a surprising model choice is always explicable):
 * 1. an explicit plugin-config model for the tier (with its provider),
 * 2. the session's routed model (`session.requestHeader().config`),
 * 3. the agent's own options,
 * 4. the plugin-config provider with no model → the caller must supply one.
 *
 * @param exec - the tool execution (carries the calling agent).
 * @param overrides - plugin-config provider/model overrides.
 * @returns a complete route table.
 * @throws when no provider/model can be determined at all.
 */
export function resolveModelRoutes(
  exec: ExecutionLike,
  overrides: RouteOverrides = {},
): ModelRoutes {
  const sessionConfig = exec.agent?.session?.requestHeader()?.config
  const agentOptions = exec.agent?.options
  const provider = overrides.provider ?? sessionConfig?.provider ?? agentOptions?.provider
  const baseModel = sessionConfig?.model ?? agentOptions?.model
  if (!provider) {
    throw new Error(
      'No model provider available: set the plugin config provider/model, or route a model in the session.',
    )
  }
  // The session's own output budget must reach the routes: dropping it silently
  // capped every un-specified completion at the adapter fallback, truncating
  // long reports and the multi-agent section drafts.
  const maxTokens = overrides.maxTokens ?? sessionConfig?.maxTokens ?? agentOptions?.maxTokens
  const make = (model: string | undefined, label: string): ModelRoute => {
    if (!model) {
      throw new Error(
        `No model resolved for the ${label} tier: route a session model or set the plugin config model.`,
      )
    }
    return { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) }
  }
  return {
    fast: make(overrides.fastModel ?? baseModel, 'fast'),
    smart: make(overrides.smartModel ?? baseModel, 'smart'),
    strategic: make(overrides.strategicModel ?? baseModel, 'strategic'),
  }
}

/**
 * Build the runtime the engine uses inside a DSH session.
 *
 * @param params.exec - the tool execution, for cancellation and progress.
 * @param params.llm - the tiered chat client built from the resolved routes.
 * @param params.web - optional `ctx.web` service.
 * @param params.log - optional harness logger bridge.
 * @param params.env - environment lookup; defaults to `process.env`.
 * @param params.fetch - HTTP seam override (tests).
 * @returns the runtime.
 */
export function createDshRuntime(params: {
  exec: ExecutionLike
  llm: Runtime['llm']
  web?: WebServiceLike | undefined
  log?: Logger | undefined
  env?: ((name: string) => string | undefined) | undefined
  fetch?: Runtime['http'] | undefined
  allowPrivateHosts?: boolean | undefined
}): Runtime {
  const exec = params.exec
  const logger = params.log ?? silentLogger
  const emitted = new Set<string>()
  const progress = (event: ProgressEvent): void => {
    logger.debug(`gptr ${event.step}: ${event.message}`)
    // Progress reaches the session as deferred context, which is DSH's
    // equivalent of upstream's websocket streaming: it does not interrupt the
    // model, but it is durable in the session log and visible in the UI.
    // Throttled to one message per milestone step per run (see MILESTONE_STEPS).
    if (!MILESTONE_STEPS.has(event.step) && !isFailureStep(event.step)) return
    if (emitted.has(event.step) && !isFailureStep(event.step)) return
    emitted.add(event.step)
    if (!exec.deferContext) return
    try {
      exec.deferContext(
        createUserMessage({
          content: [{ type: 'text', text: `[gpt-researcher] ${event.step}: ${event.message}` }],
          source: { kind: 'user' },
        }),
      )
    } catch (error) {
      logger.warn(
        `could not defer research progress: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  const webSeam = params.web ? createWebSeam(params.web) : undefined
  return {
    llm: params.llm,
    http: params.fetch ?? defaultHttpFetch,
    env: params.env ?? ((name: string) => process.env[name]),
    log: logger,
    progress,
    ...(webSeam === undefined ? {} : { web: webSeam }),
    ...(params.allowPrivateHosts === undefined
      ? {}
      : { allowPrivateHosts: params.allowPrivateHosts }),
    signal: exec.signal,
  }
}

/**
 * Adapt `ctx.web` to the engine's {@link WebSeam}.
 *
 * @param web - the harness web service.
 * @returns the seam.
 */
export function createWebSeam(web: WebServiceLike): WebSeam {
  return {
    available: () => true,
    async search(query, maxResults, signal) {
      const result = await web.search(
        maxResults === undefined ? { query } : { query, maxResults },
        signal,
      )
      const sources: SearchResult[] = result.sources.map((source) => ({
        url: source.url,
        ...(source.title === undefined ? {} : { title: source.title }),
        ...(source.snippet === undefined ? {} : { content: source.snippet }),
        ...(source.publishedAt === undefined ? {} : { published_date: source.publishedAt }),
      }))
      return sources
    },
    async fetch(url, signal) {
      const result = await web.fetch({ url }, signal)
      return {
        url: result.url,
        status: result.statusCode,
        body: result.body.content,
        kind: result.body.kind,
      }
    },
  }
}
