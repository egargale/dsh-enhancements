/**
 * Research memory: the recursive text splitter and the `Memory` facade.
 *
 * Upstream, `gpt_researcher/memory/embeddings.py` builds a LangChain
 * `Embeddings` object and `gpt_researcher/vector_store/vector_store.py`
 * (`VectorStoreWrapper`) splits scraped pages with
 * `RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)` before
 * adding them to a vector store. This port keeps the same division of labour:
 *
 *  - {@link splitText} is a faithful re-implementation of LangChain's
 *    `RecursiveCharacterTextSplitter` (see `langchain_text_splitters`), so
 *    chunk boundaries, overlap and the "keep separator at the start of the next
 *    piece" rule match upstream. The vector stores call it from `load()`.
 *  - {@link Memory} is the facade the engine talks to. It receives the
 *    {@link Embeddings} and {@link VectorStore} it should use (upstream's
 *    `Memory` only knew about embeddings because LangChain owned the rest), and
 *    exposes upstream's public names (`get_embeddings` → `getEmbeddings`).
 *
 * @module gpt-researcher/memory
 */

import type { Embeddings } from '../embeddings/base.ts'
import type { Runtime } from '../runtime.ts'
import type { DocumentChunk, ScrapedContent } from '../types.ts'
import type { VectorSearchOptions, VectorStore } from '../vector_store/base.ts'

/** Upstream `RecursiveCharacterTextSplitter(chunk_size=1000)`. */
export const DEFAULT_CHUNK_SIZE = 1000

/** Upstream `RecursiveCharacterTextSplitter(chunk_overlap=100)`. */
export const DEFAULT_CHUNK_OVERLAP = 100

/**
 * Upstream `RecursiveCharacterTextSplitter` separators, in priority order. The
 * trailing empty string means "split into individual code points".
 */
export const DEFAULT_SEPARATORS: readonly string[] = ['\n\n', '\n', ' ', '']

/** Default `max_results` for a memory query (upstream context compressors use 5). */
export const DEFAULT_MAX_RESULTS = 5

/** Options accepted by {@link splitText}. */
export interface SplitTextOptions {
  /** Maximum chunk length in characters; defaults to {@link DEFAULT_CHUNK_SIZE}. */
  chunkSize?: number
  /** Characters of overlap between consecutive chunks; defaults to {@link DEFAULT_CHUNK_OVERLAP}. */
  chunkOverlap?: number
  /** Separator priority list; defaults to {@link DEFAULT_SEPARATORS}. */
  separators?: readonly string[]
}

/**
 * Split text exactly like LangChain's `RecursiveCharacterTextSplitter`.
 *
 * The algorithm, ported from `langchain_text_splitters.character`:
 *
 * 1. Pick the first separator that occurs in the text (falling back to the
 *    last one, `''`, which splits into code points).
 * 2. Split on it, keeping the separator at the *start* of the following piece.
 * 3. Greedily merge pieces up to `chunkSize`; when a chunk is emitted, drop
 *    leading pieces until the remainder is at most `chunkOverlap` characters.
 * 4. Recurse into any single piece that is still longer than `chunkSize`, using
 *    the lower-priority separators.
 *
 * @param text - the text to split.
 * @param options - splitter overrides.
 * @returns the chunks, in document order; empty for empty/whitespace-only text.
 * @throws Error when `chunkSize`/`chunkOverlap` are not sane.
 */
export function splitText(text: string, options: SplitTextOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP
  const separators = options.separators ?? DEFAULT_SEPARATORS
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be a positive integer, got ${chunkSize}.`)
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > chunkSize) {
    throw new Error(
      `chunkOverlap must be an integer between 0 and chunkSize (${chunkSize}), got ${chunkOverlap}.`,
    )
  }
  if (text.length === 0) return []
  return splitRecursive(text, chunkSize, chunkOverlap, separators)
}

/** One recursive step of {@link splitText}; mirrors `_split_text`. */
function splitRecursive(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  separators: readonly string[],
): string[] {
  const finalChunks: string[] = []
  let separator = separators.length > 0 ? (separators[separators.length - 1] ?? '') : ''
  let remaining: readonly string[] = []
  for (let index = 0; index < separators.length; index += 1) {
    const candidate = separators[index] ?? ''
    if (candidate === '') {
      separator = candidate
      break
    }
    if (text.includes(candidate)) {
      separator = candidate
      remaining = separators.slice(index + 1)
      break
    }
  }

  const splits = splitKeepingSeparator(text, separator)
  let goodSplits: string[] = []
  for (const piece of splits) {
    if (piece.length < chunkSize) {
      goodSplits.push(piece)
      continue
    }
    if (goodSplits.length > 0) {
      finalChunks.push(...mergeSplits(goodSplits, chunkSize, chunkOverlap))
      goodSplits = []
    }
    if (remaining.length === 0) {
      finalChunks.push(piece)
    } else {
      finalChunks.push(...splitRecursive(piece, chunkSize, chunkOverlap, remaining))
    }
  }
  if (goodSplits.length > 0) {
    finalChunks.push(...mergeSplits(goodSplits, chunkSize, chunkOverlap))
  }
  return finalChunks
}

/**
 * Split on a literal separator with `keep_separator: "start"` semantics: each
 * piece is `separator + following text`, and the text before the first
 * separator is the leading piece. Empty pieces are dropped, exactly as
 * `_split_text_with_regex` does with `keep_separator=True`.
 *
 * @param text - text to split.
 * @param separator - literal separator; `''` splits into code points.
 * @returns the non-empty pieces.
 */
function splitKeepingSeparator(text: string, separator: string): string[] {
  if (separator === '') return [...text]
  const firstIndex = text.indexOf(separator)
  if (firstIndex < 0) return text.length > 0 ? [text] : []
  const pieces: string[] = [text.slice(0, firstIndex)]
  let cursor = firstIndex
  while (cursor >= 0) {
    const after = cursor + separator.length
    const next = text.indexOf(separator, after)
    pieces.push(text.slice(cursor, next < 0 ? text.length : next))
    cursor = next
  }
  return pieces.filter((piece) => piece.length > 0)
}

/**
 * Greedy merge with overlap, mirroring `TextSplitter._merge_splits`. Pieces
 * already carry their separators, so the join separator is the empty string
 * (`keep_separator=True` upstream).
 *
 * @param splits - pieces to merge.
 * @param chunkSize - maximum chunk length.
 * @param chunkOverlap - characters retained when a chunk is cut.
 * @returns the merged chunks.
 */
function mergeSplits(
  splits: readonly string[],
  chunkSize: number,
  chunkOverlap: number,
): string[] {
  const docs: string[] = []
  let current: string[] = []
  let total = 0
  for (const piece of splits) {
    const length = piece.length
    if (total + length > chunkSize) {
      if (current.length > 0) {
        const joined = joinDocs(current)
        if (joined !== undefined) docs.push(joined)
        // Keep popping leading pieces until the retained overlap is small
        // enough and the next piece fits again.
        while (total > chunkOverlap || (total + length > chunkSize && total > 0)) {
          total -= (current[0] ?? '').length
          current = current.slice(1)
        }
      }
    }
    current.push(piece)
    total += length
  }
  const joined = joinDocs(current)
  if (joined !== undefined) docs.push(joined)
  return docs
}

/** `TextSplitter._join_docs`: join, strip, and treat blank chunks as absent. */
function joinDocs(pieces: readonly string[]): string | undefined {
  const text = pieces.join('').trim()
  return text.length > 0 ? text : undefined
}

/**
 * The research memory facade.
 *
 * @example
 * ```ts
 * const memory = new Memory(embeddings, vectorStore, runtime)
 * await memory.addDocuments(scraped)
 * const chunks = await memory.getRelevantDocuments('vector databases', 5)
 * ```
 */
export class Memory {
  /** The embedding client in use (`EMBEDDING=<provider>:<model>`). */
  readonly embeddings: Embeddings
  /** The store documents are written to and read from (`MEMORY_BACKEND`). */
  readonly vectorStore: VectorStore
  /** The run's runtime, kept for diagnostics and cancellation. */
  readonly runtime: Runtime

  /**
   * @param embeddings - the embedding client the memory should use.
   * @param vectorStore - the store the memory should use.
   * @param runtime - the run's injected runtime.
   */
  constructor(embeddings: Embeddings, vectorStore: VectorStore, runtime: Runtime) {
    this.embeddings = embeddings
    this.vectorStore = vectorStore
    this.runtime = runtime
  }

  /**
   * Upstream `Memory.get_embeddings()`: hand back the configured embeddings
   * client so a caller that needs raw vectors (e.g. a compressor port) can
   * reuse exactly the instance the memory uses.
   *
   * @returns the embedding client.
   */
  getEmbeddings(): Embeddings {
    return this.embeddings
  }

  /**
   * Ingest scraped documents: split into chunks, embed them, and store them.
   *
   * Splitting happens inside {@link VectorStore.load}, which is this port's
   * stand-in for upstream `VectorStoreWrapper.load` (convert → split → add).
   * Identical input therefore produces identical chunks in every backend.
   *
   * @param documents - scraped pages to remember.
   */
  async addDocuments(documents: readonly ScrapedContent[]): Promise<void> {
    await this.vectorStore.load(documents)
  }

  /**
   * Upstream `VectorStoreWrapper.load` under its own name, kept because the
   * engine calls it that way in a few places.
   *
   * @param documents - scraped pages to remember.
   */
  async load(documents: readonly ScrapedContent[]): Promise<void> {
    await this.addDocuments(documents)
  }

  /**
   * Upstream `VectorstoreCompressor.async_get_context`'s retrieval half: the
   * chunks most relevant to `query`, best-first.
   *
   * @param query - the question or sub-query to match against.
   * @param maxResults - maximum number of chunks; defaults to {@link DEFAULT_MAX_RESULTS}.
   * @returns the matching chunks, most relevant first.
   */
  async getRelevantDocuments(
    query: string,
    maxResults: number = DEFAULT_MAX_RESULTS,
  ): Promise<DocumentChunk[]> {
    return this.similaritySearch(query, maxResults)
  }

  /**
   * Similarity search with an optional metadata filter.
   *
   * @param query - the text to embed and match.
   * @param k - maximum number of chunks to return.
   * @param filter - metadata equality filter; every key must match exactly.
   * @returns the matching chunks, most relevant first.
   */
  async similaritySearch(
    query: string,
    k: number = DEFAULT_MAX_RESULTS,
    filter?: Record<string, unknown>,
  ): Promise<DocumentChunk[]> {
    const options: VectorSearchOptions = filter === undefined ? { k } : { k, filter }
    const documents = await this.vectorStore.similaritySearch(query, options)
    return documents.map((document) => ({
      page_content: document.page_content,
      metadata: { ...document.metadata },
    }))
  }

  /** Drop every remembered chunk. */
  clear(): void {
    this.vectorStore.clear()
  }

  /** Number of stored chunks (upstream `vector_store` length). */
  count(): number {
    return this.vectorStore.count()
  }
}
