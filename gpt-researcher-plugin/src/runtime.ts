/**
 * Injected runtime seams for the gpt-researcher plugin.
 *
 * The engine never imports a provider SDK, never touches `process.env` for
 * credentials directly, and never writes to stdout: it receives an
 * {@link Runtime} whose parts are supplied by the DSH plugin entry (real
 * implementations) or by tests (fakes). This is what makes the same engine
 * code runnable both inside a live DSH session and under `node --test`.
 *
 * @module gpt-researcher/runtime
 */

import type {
  ChatClient,
  Logger,
  ProgressSink,
  SearchResult,
} from './types.ts'

/**
 * Minimal HTTP response surface. Deliberately narrower than the global
 * `Response` type so a fake is trivial to write and so no DOM lib is required.
 */
export interface HttpResponse {
  readonly ok: boolean
  readonly status: number
  /** Case-insensitive header lookup, as `Headers.get` behaves. */
  header(name: string): string | null
  text(): Promise<string>
  json(): Promise<unknown>
}

/** Options for one HTTP request. */
export interface HttpRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  redirect?: 'follow' | 'manual' | 'error'
}

/**
 * The HTTP seam. Defaults to the global `fetch`; tests inject a recorder that
 * returns canned bodies, which is how every keyed retriever is tested offline.
 */
export type HttpFetch = (
  url: string,
  init?: HttpRequestInit,
) => Promise<HttpResponse>

/**
 * DSH's native web seam (`ctx.web`), exposed as an optional capability.
 *
 * When present it becomes the `dsh_web` retriever and the `dsh_web` scraper,
 * which is how the plugin reuses the deployment's configured search/fetch
 * providers (DeepSeek search, Exa, …) instead of requiring its own API keys.
 */
export interface WebSeam {
  search(query: string, maxResults?: number, signal?: AbortSignal): Promise<SearchResult[]>
  fetch(url: string, signal?: AbortSignal): Promise<{ url: string; status: number; body: string; kind: 'html' | 'text' }>
  /** Cheap capability probe; must not perform network I/O. */
  available(): boolean
}

/** One resolved model route for an LLM tier. */
export interface ModelRoute {
  provider: string
  model: string
  maxTokens?: number
}

/**
 * Model routes per tier. The DSH entry resolves these from the session's
 * routed model (falling back to the deployment default), so an in-session run
 * uses exactly the model the user selected.
 */
export interface ModelRoutes {
  fast: ModelRoute
  smart: ModelRoute
  strategic: ModelRoute
}

/** Everything the engine needs from its host. */
export interface Runtime {
  /** Tiered completion client. */
  llm: ChatClient
  /** HTTP seam used by retrievers and scrapers. */
  http: HttpFetch
  /** Environment/credentials lookup (never a secret literal in config). */
  env: (name: string) => string | undefined
  log: Logger
  /** Progress sink; the DSH tool forwards these into the session. */
  progress: ProgressSink
  /** Native DSH web seam, when the deployment has one. */
  web?: WebSeam
  /** Cancellation for the whole run. */
  signal?: AbortSignal
  /**
   * Permit fetching loopback/private/link-local addresses.
   *
   * Off by default: the URLs this plugin fetches are model-controlled, so
   * fetching the private network is an SSRF primitive (cloud metadata, the local
   * harness port, internal wikis). A deployment that deliberately researches
   * internal hosts sets this (plugin config `allowPrivateHosts`).
   */
  allowPrivateHosts?: boolean
  /** Injectable clock, for tests of cost/timing behaviour. */
  now?: () => number
}

/** A no-op logger, used as the default when a host supplies none. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** A progress sink that drops every event. */
export const noProgress: ProgressSink = () => {}

/** Build a runtime from partial parts; every omitted seam gets a safe default. */
export function makeRuntime(parts: Partial<Runtime> & { llm: ChatClient }): Runtime {
  return {
    llm: parts.llm,
    http: parts.http ?? defaultHttpFetch,
    env: parts.env ?? ((name: string) => process.env[name]),
    log: parts.log ?? silentLogger,
    progress: parts.progress ?? noProgress,
    ...(parts.web === undefined ? {} : { web: parts.web }),
    ...(parts.signal === undefined ? {} : { signal: parts.signal }),
    ...(parts.allowPrivateHosts === undefined ? {} : { allowPrivateHosts: parts.allowPrivateHosts }),
    ...(parts.now === undefined ? {} : { now: parts.now }),
  }
}

/**
 * The default HTTP seam: global `fetch`, with the wide-open redirect policy a
 * scraper wants and a response adapter that hides the DOM `Response` type.
 */
export const defaultHttpFetch: HttpFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.body === undefined ? {} : { body: init.body }),
    ...(init?.signal === undefined ? {} : { signal: init.signal }),
    redirect: init?.redirect ?? 'follow',
  })
  return {
    ok: response.ok,
    status: response.status,
    header: (name: string) => response.headers.get(name),
    text: () => response.text(),
    json: () => response.json() as Promise<unknown>,
  }
}

/**
 * Combine the run signal with an optional per-request timeout. Retrievers
 * must accept the composed signal so a canceled session also cancels I/O.
 */
export function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
