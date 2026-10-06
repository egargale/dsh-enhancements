/**
 * Retriever contract and registry.
 *
 * Upstream, a retriever is a class instantiated as
 * `Retriever(query, query_domains=...)` exposing `search(max_results=...)`.
 * This port keeps the two-step shape (a factory closes over the query; the
 * instance performs the search) because it is what lets the registry stay a
 * plain name → factory map and lets tests substitute any entry.
 *
 * @module gpt-researcher/retrievers/base
 */

import type { Runtime } from '../runtime.ts'
import type { SearchResult } from '../types.ts'

/** Everything a retriever may use, injected rather than imported. */
export interface RetrieverContext {
  runtime: Runtime
  /** Config values the retriever needs, resolved by the caller. */
  config: RetrieverConfig
}

/** The configuration surface retrievers actually read. */
export interface RetrieverConfig {
  /** Upper bound on returned results (`MAX_SEARCH_RESULTS_PER_QUERY`). */
  maxSearchResultsPerQuery: number
  /** `USER_AGENT` header for HTML-scraping retrievers. */
  userAgent: string
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** `LANGUAGE` — some providers accept a language/market hint. */
  language: string
}

/** Options accepted when constructing a retriever instance. */
export interface RetrieverOptions {
  query: string
  /** Domains the search is restricted to (`site:` filters). */
  queryDomains?: string[]
  /** Abort signal for the run. */
  signal?: AbortSignal
}

/** One retriever instance, bound to a single query. */
export interface Retriever {
  /** `max_results` in upstream; defaults to the config bound when omitted. */
  search(maxResults?: number): Promise<SearchResult[]>
}

/**
 * A retriever implementation: named metadata plus a factory.
 *
 * `keys` names the environment variables the retriever needs; the registry
 * uses it to report a precise "missing credential" error instead of letting a
 * request fail with a 401.
 */
export interface RetrieverDefinition {
  /** Registry name, as used in `RETRIEVER=a,b`. */
  name: string
  /** Environment variables required before the retriever can run. */
  keys: string[]
  /** True when the retriever can run without credentials. */
  keyless: boolean
  /** Human-readable description, surfaced in tool results and diagnostics. */
  description: string
  /** Build an instance for one query. */
  create(ctx: RetrieverContext, options: RetrieverOptions): Retriever
}

/** Error raised when a retriever cannot run (missing key, unknown name). */
export class RetrieverError extends Error {
  override readonly name = 'RetrieverError'
}

/** The registry of available retrievers, keyed by upstream name. */
export class RetrieverRegistry {
  private readonly definitions = new Map<string, RetrieverDefinition>()

  constructor(definitions: readonly RetrieverDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  /** Add or replace one definition (replacement is how tests inject fakes). */
  register(definition: RetrieverDefinition): void {
    this.definitions.set(definition.name, definition)
  }

  /** Look up one definition. */
  get(name: string): RetrieverDefinition | undefined {
    return this.definitions.get(name)
  }

  /** All definitions, in registration order. */
  all(): RetrieverDefinition[] {
    return [...this.definitions.values()]
  }

  /** All registered names, in registration order. */
  names(): string[] {
    return this.all().map((definition) => definition.name)
  }

  /**
   * Resolve names to definitions, failing loudly on an unknown name and
   * reporting the exact missing environment variables for keyed retrievers.
   *
   * @param names - retriever names, in preference order.
   * @param runtime - the run's runtime, used for the credential probe.
   * @returns the resolved definitions.
   */
  resolve(names: readonly string[], runtime: Runtime): RetrieverDefinition[] {
    return names.map((name) => {
      const definition = this.get(name)
      if (!definition) {
        throw new RetrieverError(
          `Invalid retriever '${name}'. Valid options are: ${this.names().join(', ')}.`,
        )
      }
      if (!definition.keyless) {
        const missing = definition.keys.filter((key) => !runtime.env(key))
        if (missing.length > 0) {
          throw new RetrieverError(
            `Retriever '${name}' requires ${missing.join(', ')}. ` +
              `Set the environment variable(s), or use a keyless retriever (${this.keyless()
                .map((definition) => definition.name)
                .join(', ')}).`,
          )
        }
      }
      return definition
    })
  }

  /** Keyless retrievers, for suggestions in error messages and tool docs. */
  keyless(): RetrieverDefinition[] {
    return this.all().filter((definition) => definition.keyless)
  }
}
