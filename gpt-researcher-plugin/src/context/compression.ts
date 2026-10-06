/**
 * Context compression — the port of `gpt_researcher/context/compression.py`.
 *
 * Upstream builds a LangChain `ContextualCompressionRetriever` per call: split
 * documents into 1000/100 chunks, drop chunks below an embedding-similarity
 * threshold, and format the survivors. The port keeps the algorithm and the two
 * real optimisations upstream added — the small-input fast path and the
 * `pretty_print_docs` formatting — without the LangChain indirection:
 *
 * - {@link ContextCompressor} — raw documents → relevant chunks
 * - {@link VectorstoreCompressor} — an existing store → relevant chunks
 * - {@link WrittenContentCompressor} — previously written sections → titles+content
 *
 * These are pure functions of the injected {@link Embeddings}, so the whole
 * compression stage is unit-testable without a model.
 *
 * @module gpt-researcher/context/compression
 */

import type { Embeddings } from '../embeddings/base.ts'
import type { PromptFamily } from '../prompts.ts'
import type { Runtime } from '../runtime.ts'
import type { DocumentChunk } from '../types.ts'
import type { VectorStore, VectorStoreDocument } from '../vector_store/base.ts'
import { estimateEmbeddingCost } from '../utils/costs.ts'
import { contextSize } from '../utils/workers.ts'

/**
 * Recursive character splitter, ported from LangChain's
 * `RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)`, which is
 * what upstream configures. Later chunks overlap the previous one by
 * `chunkOverlap` characters.
 *
 * @param text - the document text.
 * @param chunkSize - maximum characters per chunk.
 * @param chunkOverlap - characters repeated at each chunk boundary.
 * @returns the chunks, in order.
 */
export function splitText(text: string, chunkSize = 1000, chunkOverlap = 100): string[] {
  if (text.length <= chunkSize) return text.length === 0 ? [] : [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = end - chunkOverlap
  }
  return chunks
}

/** Any document shape the pipeline hands to the compressor. */
export type CompressorDocument = Record<string, unknown> | object

/** Convert scraped/context documents to chunks, matching upstream's `Document` fields. */
export function toDocumentChunks(
  documents: readonly CompressorDocument[],
  chunkSize = 1000,
  chunkOverlap = 100,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = []
  for (const item of documents) {
    const document = item as Record<string, unknown>
    const content = String(document.raw_content ?? document.page_content ?? document.content ?? '')
    if (content.length === 0) continue
    for (const piece of splitText(content, chunkSize, chunkOverlap)) {
      chunks.push({ page_content: piece, metadata: { ...document } })
    }
  }
  return chunks
}

/** Shared options for the compressors. */
export interface CompressorOptions {
  maxResults?: number
  /** Minimum cosine similarity for a chunk to survive (`SIMILARITY_THRESHOLD`). */
  similarityThreshold?: number
  /** Character count under which compression is skipped (`COMPRESSION_THRESHOLD`). */
  compressionThreshold?: number
  signal?: AbortSignal
  /** Charge embedding cost, mirroring upstream's `cost_callback`. */
  chargeCost?: (usd: number) => void
}

/**
 * Compresses raw documents to the chunks most relevant to a query
 * (upstream `ContextCompressor`).
 */
export class ContextCompressor {
  readonly #documents: DocumentChunk[]
  readonly #embeddings: Embeddings
  readonly #prompts: PromptFamily
  readonly #runtime: Runtime
  readonly #options: Required<Pick<CompressorOptions, 'maxResults' | 'similarityThreshold' | 'compressionThreshold'>>

  constructor(params: {
    documents: readonly CompressorDocument[]
    embeddings: Embeddings
    prompts: PromptFamily
    runtime: Runtime
    options?: CompressorOptions
  }) {
    this.#documents = toDocumentChunks(params.documents)
    this.#embeddings = params.embeddings
    this.#prompts = params.prompts
    this.#runtime = params.runtime
    this.#options = {
      maxResults: params.options?.maxResults ?? 5,
      similarityThreshold: params.options?.similarityThreshold ?? 0.42,
      compressionThreshold: params.options?.compressionThreshold ?? 8000,
    }
  }

  /** Number of chunks produced from the input documents. */
  get chunkCount(): number {
    return this.#documents.length
  }

  /**
   * Upstream `async_get_context`.
   *
   * Fast path: when the raw input is small, upstream returns the documents
   * directly instead of paying for embeddings. That path is kept, because it is
   * the common case for a handful of search results.
   *
   * @param query - the (sub-)query to rank against.
   * @param options - per-call overrides.
   * @returns the formatted relevant context.
   */
  async asyncGetContext(query: string, options: CompressorOptions = {}): Promise<string> {
    const maxResults = options.maxResults ?? this.#options.maxResults
    const threshold = options.similarityThreshold ?? this.#options.similarityThreshold
    const compressionThreshold =
      options.compressionThreshold ?? this.#options.compressionThreshold

    const totalChars = this.#documents.reduce((sum, doc) => sum + doc.page_content.length, 0)
    if (totalChars < compressionThreshold && this.#documents.length <= maxResults) {
      return this.#prompts.pretty_print_docs(this.#documents, maxResults)
    }
    if (this.#documents.length === 0) return ''

    options.chargeCost?.(
      estimateEmbeddingCost(this.#documents.map((doc) => doc.page_content)),
    )

    const [queryVector, docVectors] = await Promise.all([
      this.#embeddings.embedQuery(query),
      this.#embeddings.embedDocuments(this.#documents.map((doc) => doc.page_content)),
    ])

    const scored = this.#documents
      .map((document, index) => ({
        document,
        score: cosine(queryVector, docVectors[index] ?? []),
        index,
      }))
      .filter((entry) => entry.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)

    const selected = scored.length > 0 ? scored : this.#documents.slice(0, maxResults).map((document, index) => ({ document, score: 0, index }))
    this.#runtime.log.debug('context compressed', {
      query,
      chunks: this.#documents.length,
      kept: selected.length,
      threshold,
    })
    return this.#prompts.pretty_print_docs(
      selected.map((entry) => entry.document),
      maxResults,
    )
  }
}

/**
 * Retrieves context from an existing vector store (upstream
 * `VectorstoreCompressor`).
 */
export class VectorstoreCompressor {
  readonly #store: VectorStore
  readonly #prompts: PromptFamily
  readonly #maxResults: number
  readonly #filter?: Record<string, unknown>

  constructor(params: {
    vectorStore: VectorStore
    prompts: PromptFamily
    maxResults?: number
    filter?: Record<string, unknown>
  }) {
    this.#store = params.vectorStore
    this.#prompts = params.prompts
    this.#maxResults = params.maxResults ?? 7
    this.#filter = params.filter
  }

  /**
   * Upstream `async_get_context`.
   *
   * @param query - the query to search for.
   * @param options - result-count override.
   * @returns formatted context.
   */
  async asyncGetContext(query: string, options: { maxResults?: number } = {}): Promise<string> {
    const results = await this.#store.similaritySearch(query, {
      k: options.maxResults ?? this.#maxResults,
      ...(this.#filter === undefined ? {} : { filter: this.#filter }),
    })
    return this.#prompts.pretty_print_docs(results.map(toChunk))
  }
}

/**
 * Ranks previously written report sections (upstream
 * `WrittenContentCompressor`), returning upstream's exact
 * `Title: …\nContent: …\n` format.
 */
export class WrittenContentCompressor {
  readonly #sections: Array<{ section_title: string; written_content: string }>
  readonly #embeddings: Embeddings
  readonly #threshold: number

  constructor(params: {
    documents: readonly Record<string, unknown>[]
    embeddings: Embeddings
    similarityThreshold?: number
  }) {
    this.#sections = params.documents.map((document) => ({
      section_title: String(document.section_title ?? document.title ?? ''),
      written_content: String(document.written_content ?? document.raw_content ?? ''),
    }))
    this.#embeddings = params.embeddings
    this.#threshold = params.similarityThreshold ?? 0.5
  }

  /**
   * Upstream `async_get_context`.
   *
   * @param query - the query to rank sections against.
   * @param options - result-count override.
   * @returns formatted `Title`/`Content` strings.
   */
  async asyncGetContext(query: string, options: CompressorOptions = {}): Promise<string[]> {
    const maxResults = options.maxResults ?? 10
    if (this.#sections.length === 0) return []
    // Embedding every written section costs money like any other embedding call;
    // the callback was accepted but never invoked, so a detailed report's
    // per-subtopic passes were free in the cost report.
    options.chargeCost?.(
      estimateEmbeddingCost(this.#sections.map((section) => section.written_content)),
    )
    const [queryVector, sectionVectors] = await Promise.all([
      this.#embeddings.embedQuery(query),
      this.#embeddings.embedDocuments(this.#sections.map((section) => section.written_content)),
    ])
    return this.#sections
      .map((section, index) => ({
        section,
        score: cosine(queryVector, sectionVectors[index] ?? []),
      }))
      .filter((entry) => entry.score >= this.#threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(
        (entry) =>
          `Title: ${entry.section.section_title}\nContent: ${entry.section.written_content}\n`,
      )
  }
}

/** Convert a store document to a chunk. */
function toChunk(document: VectorStoreDocument): DocumentChunk {
  return { page_content: document.page_content, metadata: document.metadata }
}

/** Cosine similarity, re-exported from the vector-store layer for locality. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Re-export so callers can size a context without importing two modules. */
export { contextSize }
