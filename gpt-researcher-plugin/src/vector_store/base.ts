/**
 * Vector store contract and registry.
 *
 * Upstream `VectorStoreWrapper` adapts any LangChain vector store to the two
 * methods the engine needs (`load`, `asimilarity_search`). This port keeps that
 * thin-wrapper idea: a store knows how to hold documents and answer a
 * similarity query, and receives the {@link Embeddings} it should use.
 *
 * The registry ships the two stores that need no external service:
 * `memory` (process-lifetime) and `local` (JSON file, durable across runs).
 * Server-backed stores are declared in {@link UNSUPPORTED_VECTOR_STORES} so a
 * request for one fails with an actionable message instead of a silent no-op.
 *
 * @module gpt-researcher/vector_store/base
 */

import type { Embeddings } from '../embeddings/base.ts'
import type { Runtime } from '../runtime.ts'
import type { ScrapedContent } from '../types.ts'

/** One stored document, mirroring the LangChain `Document` shape upstream uses. */
export interface VectorStoreDocument {
  page_content: string
  metadata: Record<string, unknown>
}

/** Query options for a similarity search. */
export interface VectorSearchOptions {
  k: number
  /** Metadata filter; keys must equal the stored metadata value exactly. */
  filter?: Record<string, unknown>
}

/** A vector store instance. */
export interface VectorStore {
  readonly name: string
  /** Ingest one batch of scraped documents (upstream `VectorStoreWrapper.load`). */
  load(documents: readonly ScrapedContent[]): Promise<void>
  /** Similarity search, best-first (upstream `asimilarity_search`). */
  similaritySearch(
    query: string,
    options: VectorSearchOptions,
  ): Promise<VectorStoreDocument[]>
  /** Number of stored documents. */
  count(): number
  /** Drop every stored document. */
  clear(): void
}

/** Construction options passed to a store factory. */
export interface VectorStoreOptions {
  embeddings: Embeddings
  /** `MEMORY_BACKEND`-style path or namespace for durable stores. */
  path?: string
  /** Extra provider kwargs from config. */
  kwargs?: Record<string, unknown>
}

/** One store implementation. */
export interface VectorStoreDefinition {
  name: string
  keys: string[]
  keyless: boolean
  description: string
  create(ctx: { runtime: Runtime }, options: VectorStoreOptions): VectorStore
}

/**
 * Vector stores upstream supports but this plugin does not bundle, because
 * each one needs a server or a heavyweight SDK. Listed explicitly so the error
 * message can say what to do instead.
 */
export const UNSUPPORTED_VECTOR_STORES = [
  'chroma',
  'qdrant',
  'pinecone',
  'weaviate',
  'milvus',
  'elasticsearch',
  'redis',
  'azuresearch',
  'faiss',
  'supabase',
  'mongodb',
  'pgvector',
  'surrealdb',
  'valkey',
  'astradb',
  'singlestoredb',
  'marqo',
  'turbopuffer',
] as const

/**
 * Raised when two embeddings have different lengths and therefore live in
 * different vector spaces.
 *
 * Comparing a 1536-d `openai` vector with a 512-d `local` vector by their first
 * 512 components yields a plausible-looking score in `[-1, 1]` and a completely
 * meaningless ranking, so this port treats the mismatch as an error instead of
 * truncating.
 */
export class EmbeddingDimensionMismatchError extends Error {
  override readonly name = 'EmbeddingDimensionMismatchError'
  /** Length of the first (expected) vector. */
  readonly expected: number
  /** Length of the second (actual) vector. */
  readonly actual: number

  /**
   * @param expected - length of the first vector.
   * @param actual - length of the second vector.
   * @param message - optional more specific message; defaults to a message
   * naming both lengths and the likely cause.
   */
  constructor(expected: number, actual: number, message?: string) {
    super(
      message ??
        `Embedding dimension mismatch: expected ${expected} dimensions but received ${actual}. ` +
          `Vectors produced by different embedding models cannot be compared; re-embed the store ` +
          `or configure the EMBEDDING provider that produced it.`,
    )
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Cosine similarity of two vectors of equal length.
 *
 * A zero-length or all-zero operand has no direction, so the result is `0`
 * rather than `NaN`, matching the previous behaviour that callers rely on.
 *
 * @param a - the first vector.
 * @param b - the second vector.
 * @returns the cosine of the angle between `a` and `b`, in `[-1, 1]`.
 * @throws {EmbeddingDimensionMismatchError} when the lengths differ, so a
 * truncated comparison can never happen silently.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingDimensionMismatchError(
      a.length,
      b.length,
      `cosineSimilarity requires vectors of equal length but received ${a.length} and ${b.length} dimensions.`,
    )
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
