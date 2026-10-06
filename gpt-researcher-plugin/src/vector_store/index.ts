/**
 * Vector store registry.
 *
 * `createVectorStoreRegistry()` returns the backends this plugin can actually
 * run: `memory` (process-lifetime, the default) and `local` (a JSON file under
 * the configured path). Every other backend upstream supports is registered as
 * a definition whose `create` throws an actionable error — that way a request
 * for `qdrant` fails with "use memory/local" instead of a module-not-found far
 * from the configuration that caused it.
 *
 * @module gpt-researcher/vector_store
 */

import { UNSUPPORTED_VECTOR_STORES } from './base.ts'
import { LocalJsonVectorStore } from './local_json.ts'
import { InMemoryVectorStore } from './memory.ts'

import type { Runtime } from '../runtime.ts'
import type { VectorStore, VectorStoreDefinition, VectorStoreOptions } from './base.ts'
import type { LocalJsonVectorStoreOptions } from './local_json.ts'
import type { InMemoryVectorStoreOptions } from './memory.ts'

// The store contract and its helpers are part of this module's public surface:
// consumers import `VectorStore`/`cosineSimilarity` from the barrel.
export { EmbeddingDimensionMismatchError, UNSUPPORTED_VECTOR_STORES, cosineSimilarity } from './base.ts'
export type {
  VectorSearchOptions,
  VectorStore,
  VectorStoreDefinition,
  VectorStoreDocument,
  VectorStoreOptions,
} from './base.ts'
export { InMemoryVectorStore } from './memory.ts'
export { LocalJsonVectorStore } from './local_json.ts'
export type {
  InMemoryVectorStoreInit,
  InMemoryVectorStoreOptions,
  VectorStoreEntry,
} from './memory.ts'
export type { LocalJsonVectorStoreOptions } from './local_json.ts'

/** Backends this plugin bundles, in recommendation order. */
export const BUNDLED_VECTOR_STORES = ['memory', 'local'] as const

/** One of the bundled backend names. */
export type BundledVectorStore = (typeof BUNDLED_VECTOR_STORES)[number]

/** Human-readable list of working backends, reused in error messages. */
export const BUNDLED_VECTOR_STORE_HINT =
  'memory (default, process-lifetime) or local (JSON file under the configured path)'

/**
 * The registry of vector stores.
 *
 * Mirrors {@link import('../embeddings/base.ts').EmbeddingsRegistry}: a name →
 * definition map with a `create` that reports unknown names and missing
 * credentials precisely.
 */
export class VectorStoreRegistry {
  private readonly definitions = new Map<string, VectorStoreDefinition>()

  /**
   * @param definitions - initial definitions, in registration order.
   */
  constructor(definitions: readonly VectorStoreDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  /**
   * Add or replace one definition.
   *
   * @param definition - the definition to register.
   */
  register(definition: VectorStoreDefinition): void {
    this.definitions.set(definition.name, definition)
  }

  /**
   * Look up one definition.
   *
   * @param name - backend name (`MEMORY_BACKEND`).
   * @returns the definition, or `undefined` when unknown.
   */
  get(name: string): VectorStoreDefinition | undefined {
    return this.definitions.get(name)
  }

  /** All definitions, in registration order. */
  all(): VectorStoreDefinition[] {
    return [...this.definitions.values()]
  }

  /** All registered names, in registration order. */
  names(): string[] {
    return this.all().map((definition) => definition.name)
  }

  /**
   * Resolve and instantiate one backend.
   *
   * @param name - backend name.
   * @param ctx - injected runtime.
   * @param options - embeddings plus the configured path/kwargs.
   * @returns a ready-to-use store.
   * @throws Error when the name is unknown, a credential is missing, or the
   * backend is declared by upstream but not bundled.
   */
  create(name: string, ctx: { runtime: Runtime }, options: VectorStoreOptions): VectorStore {
    const definition = this.get(name)
    if (!definition) {
      throw new Error(
        `Unsupported vector store '${name}'. Supported vector stores are: ${this.names().join(', ')}.`,
      )
    }
    if (!definition.keyless) {
      const missing = definition.keys.filter((key) => !ctx.runtime.env(key))
      if (missing.length > 0) {
        throw new Error(
          `Vector store '${name}' requires ${missing.join(', ')}. ` +
            `Set the environment variable(s), or use ${BUNDLED_VECTOR_STORE_HINT}.`,
        )
      }
    }
    return definition.create(ctx, options)
  }
}

/**
 * Error message for an upstream backend this port does not bundle.
 *
 * @param name - the upstream backend name.
 * @returns the message, naming the working options.
 */
export function unsupportedVectorStoreMessage(name: string): string {
  return (
    `Vector store '${name}' is declared by upstream gpt-researcher but is not bundled in this ` +
    `TypeScript port (it needs a server or a vector-store SDK that is not shipped here). ` +
    `Working options: ${BUNDLED_VECTOR_STORE_HINT}.`
  )
}

/**
 * The in-memory backend definition.
 *
 * @returns the `memory` definition.
 */
export function memoryVectorStoreDefinition(): VectorStoreDefinition {
  return {
    name: 'memory',
    keys: [],
    keyless: true,
    description:
      'In-process vector store; documents live for the lifetime of the run and are dropped when it ends.',
    create(_ctx, options) {
      return new InMemoryVectorStore(options as InMemoryVectorStoreOptions)
    },
  }
}

/**
 * The JSON-file backend definition.
 *
 * @returns the `local` definition.
 */
export function localStorageDefinition(): VectorStoreDefinition {
  return {
    name: 'local',
    keys: [],
    keyless: true,
    description:
      'JSON-file vector store; reuses the in-memory store and persists to <path>/vector-store.json, de-duplicating sources by URL + content hash.',
    create(ctx, options) {
      return new LocalJsonVectorStore({
        ...(options as LocalJsonVectorStoreOptions),
        runtime: ctx.runtime,
      })
    },
  }
}

/**
 * A definition for an upstream backend that is not bundled; `create` always
 * throws {@link unsupportedVectorStoreMessage}.
 *
 * @param name - the upstream backend name.
 * @returns the placeholder definition.
 */
export function unsupportedVectorStoreDefinition(name: string): VectorStoreDefinition {
  return {
    name,
    keys: [],
    keyless: true,
    description: `Upstream '${name}' vector store (not bundled in this port).`,
    create() {
      throw new Error(unsupportedVectorStoreMessage(name))
    },
  }
}

/**
 * Build the registry the plugin uses everywhere: `memory`, `local`, and a
 * throwing placeholder for every upstream-only backend.
 *
 * @param extra - additional definitions, registered last so a caller can
 * override a bundled backend (this is how tests inject fakes).
 * @returns the populated registry.
 */
export function createVectorStoreRegistry(
  extra: readonly VectorStoreDefinition[] = [],
): VectorStoreRegistry {
  const registry = new VectorStoreRegistry()
  registry.register(memoryVectorStoreDefinition())
  registry.register(localStorageDefinition())
  for (const name of UNSUPPORTED_VECTOR_STORES) {
    registry.register(unsupportedVectorStoreDefinition(name))
  }
  for (const definition of extra) registry.register(definition)
  return registry
}
