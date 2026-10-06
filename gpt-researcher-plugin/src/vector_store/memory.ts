/**
 * In-process vector store.
 *
 * This is the `memory` backend and the reference implementation for every other
 * store: it owns chunking (upstream `VectorStoreWrapper._split_documents`),
 * embedding, cosine ranking and metadata filtering, all in memory for the
 * lifetime of the process. `LocalJsonVectorStore` reuses it unchanged and only
 * adds persistence.
 *
 * @module gpt-researcher/vector_store/memory
 */

import { createHash } from 'node:crypto'

import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, splitText } from '../memory/index.ts'
import { EmbeddingDimensionMismatchError, cosineSimilarity } from './base.ts'

import type { Embeddings } from '../embeddings/base.ts'
import type { Embedding, ScrapedContent } from '../types.ts'
import type {
  VectorSearchOptions,
  VectorStore,
  VectorStoreDocument,
  VectorStoreOptions,
} from './base.ts'

/** One stored chunk plus its vector. */
export interface VectorStoreEntry {
  document: VectorStoreDocument
  embedding: Embedding
}

/** Options for {@link InMemoryVectorStore}. */
export interface InMemoryVectorStoreOptions extends VectorStoreOptions {
  /** Splitter chunk size; defaults to upstream's 1000. */
  chunkSize?: number
  /** Splitter overlap; defaults to upstream's 100. */
  chunkOverlap?: number
}

/**
 * What {@link InMemoryVectorStore} accepts at construction: the canonical
 * options object, or a bare {@link Embeddings} as shorthand for
 * `{ embeddings }` (the engine uses the shorthand when it needs a default
 * store).
 */
export type InMemoryVectorStoreInit = InMemoryVectorStoreOptions | Embeddings

/** Distinguish a bare `Embeddings` from an options object. */
function isEmbeddings(value: InMemoryVectorStoreInit): value is Embeddings {
  return typeof (value as Embeddings).embedDocuments === 'function'
}

/**
 * Content fingerprint used for de-duplication (`metadata.content_hash`).
 *
 * SHA-256 of the exact text is deterministic across runs and processes, which
 * is what makes "same URL + same content" a stable identity for a source
 * document even after it has been split into chunks.
 *
 * @param content - the document text to fingerprint.
 * @returns the hex digest.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Build the searchable chunk documents for a batch of scraped pages.
 *
 * Metadata mirrors upstream's `Document(page_content=..., metadata={"source": url})`
 * plus the fields this port needs: `url`, `title`, `content_hash` (of the whole
 * source text, not the chunk) and `chunk_index`.
 *
 * @param documents - scraped pages.
 * @param chunkSize - splitter chunk size; defaults to upstream's 1000.
 * @param chunkOverlap - splitter overlap; defaults to upstream's 100.
 * @returns one entry per chunk, in source order then chunk order.
 */
export function chunkDocuments(
  documents: readonly ScrapedContent[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
): VectorStoreDocument[] {
  const chunks: VectorStoreDocument[] = []
  for (const document of documents) {
    const content =
      typeof document.raw_content === 'string' ? document.raw_content : String(document.raw_content ?? '')
    const pieces = splitText(content, { chunkSize, chunkOverlap })
    const contentHash = hashContent(content)
    pieces.forEach((piece, chunkIndex) => {
      chunks.push({
        page_content: piece,
        metadata: {
          source: document.url,
          url: document.url,
          ...(document.title === undefined ? {} : { title: document.title }),
          ...(document.source_type === undefined ? {} : { source_type: document.source_type }),
          content_hash: contentHash,
          chunk_index: chunkIndex,
          chunk_count: pieces.length,
        },
      })
    })
  }
  return chunks
}

/**
 * Upstream `VectorStore.asimilarity_search(filter=...)` semantics: every filter
 * key must equal the stored metadata value exactly (deep equality for objects
 * and arrays, strict equality otherwise).
 *
 * @param metadata - the stored chunk metadata.
 * @param filter - the filter to apply; `undefined` matches everything.
 * @returns whether the document passes the filter.
 */
export function matchesMetadataFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (filter === undefined) return true
  for (const [key, expected] of Object.entries(filter)) {
    if (!valuesEqual(metadata[key], expected)) return false
  }
  return true
}

/** Deep-ish equality: `Object.is` first, JSON comparison for plain objects. */
function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true
  if (actual === null || expected === null) return false
  if (typeof actual !== 'object' || typeof expected !== 'object') return false
  return JSON.stringify(actual) === JSON.stringify(expected)
}

/**
 * Never let a non-finite score poison the sort comparator. A dimension mismatch
 * is not swallowed here: it propagates as
 * {@link import('./base.ts').EmbeddingDimensionMismatchError}, because a
 * truncated comparison is worse than a failed search.
 */
function scoreOf(query: readonly number[], document: readonly number[]): number {
  const score = cosineSimilarity(query, document)
  return Number.isFinite(score) ? score : 0
}

/** Return a defensive copy so callers cannot mutate stored documents. */
function cloneDocument(document: VectorStoreDocument): VectorStoreDocument {
  return { page_content: document.page_content, metadata: { ...document.metadata } }
}

/**
 * A vector store that lives entirely in memory.
 *
 * @example
 * ```ts
 * const store = new InMemoryVectorStore({ embeddings })
 * await store.load(scraped)
 * const hits = await store.similaritySearch('vector databases', { k: 3 })
 * ```
 */
export class InMemoryVectorStore implements VectorStore {
  /** Registry name (`memory`). */
  readonly name: string
  /** The embedding client used for documents and queries. */
  protected readonly embeddings: Embeddings
  /** Stored chunks, in insertion order. */
  protected readonly entries: VectorStoreEntry[] = []
  /**
   * Embedding length fixed by the first document ever ingested, or `undefined`
   * while the store is empty. Every later document (and every query) must use
   * this length, so vectors from two embedding models can never be mixed.
   */
  protected vectorDimension: number | undefined = undefined
  private readonly chunkSize: number
  private readonly chunkOverlap: number

  /**
   * @param options - the embedding client plus optional splitter overrides, or
   * the embedding client on its own.
   * @param name - registry name to report; subclasses pass their own.
   */
  constructor(options: InMemoryVectorStoreInit, name = 'memory') {
    const resolved: InMemoryVectorStoreOptions = isEmbeddings(options)
      ? { embeddings: options }
      : options
    this.name = name
    this.embeddings = resolved.embeddings
    this.chunkSize = resolved.chunkSize ?? DEFAULT_CHUNK_SIZE
    this.chunkOverlap = resolved.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP
  }

  /**
   * Split, embed and append documents (upstream `VectorStoreWrapper.load`).
   *
   * The first ingested document fixes the store's embedding dimension; every
   * later document must match it, otherwise the batch is rejected before
   * anything is stored (mixing vectors from two models would make every score
   * meaningless).
   *
   * @param documents - scraped pages to ingest.
   * @throws {EmbeddingDimensionMismatchError} when a document's embedding has a
   * different length from the store's established dimension.
   */
  async load(documents: readonly ScrapedContent[]): Promise<void> {
    const chunks = chunkDocuments(documents, this.chunkSize, this.chunkOverlap)
    if (chunks.length === 0) return
    const vectors = await this.embeddings.embedDocuments(chunks.map((chunk) => chunk.page_content))
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Embedding provider '${this.embeddings.provider}' returned ${vectors.length} vectors for ${chunks.length} chunks.`,
      )
    }
    const expected = this.vectorDimension ?? vectors[0]?.length
    vectors.forEach((vector, index) => {
      const actual = vector.length
      if (expected !== undefined && actual !== expected) {
        throw new EmbeddingDimensionMismatchError(
          expected,
          actual,
          `${this.name} vector store cannot ingest document ${index} of this batch: ` +
            `the store holds ${expected}-dimensional embeddings but the embedding provider ` +
            `'${this.embeddings.provider}' returned ${actual} dimensions. ` +
            `Re-embed the store or configure a single EMBEDDING provider.`,
        )
      }
    })
    if (this.vectorDimension === undefined) this.vectorDimension = expected
    chunks.forEach((document, index) => {
      this.entries.push({ document, embedding: vectors[index] ?? [] })
    })
  }

  /**
   * Rank stored chunks against the query by cosine similarity.
   *
   * @param query - text to embed and match.
   * @param options - `k` and an optional metadata filter.
   * @returns up to `k` documents, best-first; ties keep insertion order.
   * @throws {EmbeddingDimensionMismatchError} when the query embedding does not
   * match the dimension of the stored embeddings, which means the configured
   * `EMBEDDING` provider is not the one that wrote this store.
   */
  async similaritySearch(
    query: string,
    options: VectorSearchOptions,
  ): Promise<VectorStoreDocument[]> {
    const k = Math.max(0, Math.floor(options.k))
    if (k === 0) return []
    const queryEmbedding = await this.embeddings.embedQuery(query)
    if (this.vectorDimension !== undefined && queryEmbedding.length !== this.vectorDimension) {
      throw new EmbeddingDimensionMismatchError(
        this.vectorDimension,
        queryEmbedding.length,
        `${this.name} vector store was built with ${this.vectorDimension}-dimensional embeddings but the ` +
          `query provider '${this.embeddings.provider}' returned ${queryEmbedding.length} dimensions; ` +
          `refusing to compare vectors from different embedding models.`,
      )
    }
    return this.entries
      .map((entry, index) => ({
        document: entry.document,
        index,
        score: scoreOf(queryEmbedding, entry.embedding),
      }))
      .filter((candidate) => matchesMetadataFilter(candidate.document.metadata, options.filter))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, k)
      .map((candidate) => cloneDocument(candidate.document))
  }

  /** Number of stored chunks. */
  count(): number {
    return this.entries.length
  }

  /** Drop every stored chunk and forget the established embedding dimension. */
  clear(): void {
    this.entries.length = 0
    this.vectorDimension = undefined
  }

  /**
   * Copy of the stored entries, used by durable subclasses when persisting.
   *
   * @returns deep-enough copies of every entry.
   */
  protected snapshot(): VectorStoreEntry[] {
    return this.entries.map((entry) => ({
      document: cloneDocument(entry.document),
      embedding: [...entry.embedding],
    }))
  }
}
