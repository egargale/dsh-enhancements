/**
 * Embedding contract and registry.
 *
 * Upstream `memory/embeddings.py` exposes a single `Memory` class that builds a
 * LangChain `Embeddings` object from `EMBEDDING=<provider>:<model>`. This port
 * splits the two concerns: a provider registry (here) and the `Memory` facade
 * that the engine uses.
 *
 * A keyless `local` provider is included so the whole pipeline — including
 * embedding-based compression — runs with no credentials. It is a deterministic
 * hashed bag-of-words embedder, which is honest about being lexical rather than
 * semantic; deployments that need real semantics configure `openai`/`ollama`.
 *
 * @module gpt-researcher/embeddings/base
 */

import type { Runtime } from '../runtime.ts'
import type { Embedding } from '../types.ts'

/** Everything an embedding provider may use. */
export interface EmbeddingContext {
  runtime: Runtime
}

/** One embedding provider implementation. */
export interface EmbeddingsDefinition {
  /** Registry name, as used in `EMBEDDING=<name>:<model>`. */
  name: string
  keys: string[]
  keyless: boolean
  description: string
  /** Default model id when the config omits one. */
  defaultModel: string
  create(ctx: EmbeddingContext, model: string, kwargs: Record<string, unknown>): Embeddings
}

/** A batch embedding client. */
export interface Embeddings {
  /** Provider name, for diagnostics and cost attribution. */
  readonly provider: string
  /** Model id in use. */
  readonly model: string
  /** Vector length, when the provider reports it up front. */
  readonly dimension?: number
  /** Embed many texts, preserving input order. */
  embedDocuments(texts: readonly string[]): Promise<Embedding[]>
  /** Embed one query text. */
  embedQuery(text: string): Promise<Embedding>
}

/** The registry of embedding providers. */
export class EmbeddingsRegistry {
  private readonly definitions = new Map<string, EmbeddingsDefinition>()

  constructor(definitions: readonly EmbeddingsDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: EmbeddingsDefinition): void {
    this.definitions.set(definition.name, definition)
  }

  get(name: string): EmbeddingsDefinition | undefined {
    return this.definitions.get(name)
  }

  all(): EmbeddingsDefinition[] {
    return [...this.definitions.values()]
  }

  names(): string[] {
    return this.all().map((definition) => definition.name)
  }

  /** Resolve and instantiate a provider, failing loudly on unknown/misconfigured. */
  create(
    name: string,
    model: string | undefined,
    ctx: EmbeddingContext,
    kwargs: Record<string, unknown> = {},
  ): Embeddings {
    const definition = this.get(name)
    if (!definition) {
      throw new Error(
        `Unsupported embedding provider '${name}'. Supported providers are: ${this.names().join(', ')}.`,
      )
    }
    if (!definition.keyless) {
      const missing = definition.keys.filter((key) => !ctx.runtime.env(key))
      if (missing.length > 0) {
        throw new Error(
          `Embedding provider '${name}' requires ${missing.join(', ')}. ` +
            `Set the environment variable(s), or use EMBEDDING=local:hash (keyless).`,
        )
      }
    }
    return definition.create(ctx, model && model.length > 0 ? model : definition.defaultModel, kwargs)
  }
}
