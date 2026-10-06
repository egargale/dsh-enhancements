/**
 * Durable JSON vector store.
 *
 * `LocalJsonVectorStore` is the `local` backend: the in-memory store plus a
 * single JSON file (`<path>/vector-store.json`) that survives process restarts,
 * so a research memory is not thrown away between runs. It reuses
 * {@link InMemoryVectorStore} for chunking, embedding, ranking and filtering,
 * and only adds three things:
 *
 *  - **reload on construction** — a new store finds the documents written by an
 *    earlier one, so `count()` and search work immediately;
 *  - **de-duplication** — a source is identified by `metadata.url` plus the
 *    SHA-256 of its content, so re-ingesting the same page (a very common case:
 *    search results overlap between iterations) is a no-op;
 *  - **atomic-ish persistence** — write to a sibling temp file, then `rename`,
 *    so a crash mid-write cannot truncate the existing store.
 *
 * @module gpt-researcher/vector_store/local_json
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { InMemoryVectorStore, hashContent } from './memory.ts'

import type { Runtime } from '../runtime.ts'
import type { ScrapedContent } from '../types.ts'
import type { VectorStoreDocument } from './base.ts'
import type { InMemoryVectorStoreOptions, VectorStoreEntry } from './memory.ts'

/** File name written inside the store directory. */
export const VECTOR_STORE_FILE_NAME = 'vector-store.json'

/** Default store directory, relative to the working directory. */
export const DEFAULT_VECTOR_STORE_DIR = '.gpt-researcher'

/** Schema version of the persisted payload. */
export const VECTOR_STORE_SCHEMA_VERSION = 1

/** Options for {@link LocalJsonVectorStore}. */
export interface LocalJsonVectorStoreOptions extends InMemoryVectorStoreOptions {
  /**
   * Directory the store lives in. Defaults to `<cwd>/.gpt-researcher`; the
   * directory is created (`mkdir -p`) if it does not exist.
   */
  path?: string
  /** Injected runtime, used only for diagnostics. */
  runtime?: Runtime
}

/** The on-disk payload. */
interface PersistedVectorStore {
  version: number
  /**
   * Length of every stored embedding. Written so a later run can detect that it
   * is configured with a different `EMBEDDING` provider before it compares a
   * query against the first N components of the stored vectors.
   */
  dimension?: number
  documents: VectorStoreEntry[]
}

/** One persisted entry that could not be used, with the reason it was dropped. */
interface SkippedPersistedEntry {
  /** Position in the persisted `documents` array. */
  index: number
  /** Human-readable reason, included in the warning. */
  reason: string
}

/** Outcome of validating one persisted payload. */
interface PersistedReadResult {
  /** Structurally valid entries whose embedding matches the file dimension. */
  entries: VectorStoreEntry[]
  /** How many entries the payload contained before validation. */
  declared: number
  /** Entries dropped because they were malformed or of the wrong dimension. */
  skipped: SkippedPersistedEntry[]
  /** Dimension the payload declares, or the first usable entry's length. */
  dimension: number | undefined
}

/** Identity of a source document: URL + content fingerprint. */
function sourceKey(document: ScrapedContent): string {
  return `${document.url}\u0000${hashContent(document.raw_content ?? '')}`
}

/** Identity of a persisted chunk, re-derived from its metadata. */
function documentKey(document: VectorStoreDocument): string {
  const url = document.metadata.url
  const contentHash = document.metadata.content_hash
  if (typeof url === 'string' && url.length > 0 && typeof contentHash === 'string' && contentHash.length > 0) {
    return `${url}\u0000${contentHash}`
  }
  return `\u0000${hashContent(document.page_content)}`
}

/** Whether an error is a missing-file error (an empty store, not a failure). */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** Whether a parsed JSON value is a plain object (not `null`, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A JSON-file-backed vector store.
 *
 * @example
 * ```ts
 * const store = new LocalJsonVectorStore({ embeddings, path: '/tmp/memory' })
 * await store.load(scraped)          // persisted to /tmp/memory/vector-store.json
 * await store.flush()                // optional: await the write queue
 * ```
 */
export class LocalJsonVectorStore extends InMemoryVectorStore {
  /** Directory holding {@link filePath}. */
  readonly directory: string
  /** Absolute path of the JSON file. */
  readonly filePath: string
  /** Source identities already ingested, so re-loads are no-ops. */
  private readonly seen = new Set<string>()
  /** Serialises writes so two `load()` calls cannot interleave. */
  private pending: Promise<void> = Promise.resolve()
  private readonly runtime: Runtime | undefined
  /**
   * True when the file exists but yielded no usable entry, so the next write
   * must move it aside before overwriting it. Set for malformed JSON, an
   * unexpected top-level payload, entries that were all corrupt, or a
   * dimension mismatch; never for a legitimately empty store.
   */
  private preserveFileBeforeWrite = false

  /**
   * @param options - embeddings, directory and optional splitter overrides.
   */
  constructor(options: LocalJsonVectorStoreOptions) {
    super(options, 'local')
    this.directory =
      options.path !== undefined && options.path.length > 0
        ? options.path
        : join(process.cwd(), DEFAULT_VECTOR_STORE_DIR)
    this.filePath = join(this.directory, VECTOR_STORE_FILE_NAME)
    this.runtime = options.runtime
    mkdirSync(this.directory, { recursive: true })
    this.reload()
  }

  /**
   * Append documents, skipping any source whose URL + content hash was already
   * ingested, then persist.
   *
   * @param documents - scraped pages to ingest.
   */
  override async load(documents: readonly ScrapedContent[]): Promise<void> {
    const batch: ScrapedContent[] = []
    const batchKeys = new Set<string>()
    for (const document of documents) {
      const key = sourceKey(document)
      if (this.seen.has(key) || batchKeys.has(key)) continue
      batchKeys.add(key)
      batch.push(document)
    }
    if (batch.length === 0) return
    await super.load(batch)
    for (const key of batchKeys) this.seen.add(key)
    await this.persist()
  }

  /**
   * Drop every stored chunk and persist the empty store.
   *
   * The write is queued; `await flush()` if the process may exit immediately. A
   * failed write is logged rather than thrown, because this method cannot
   * report an error synchronously.
   */
  override clear(): void {
    super.clear()
    this.seen.clear()
    void this.persist().catch((error: unknown) => {
      this.runtime?.log.warn(
        `LocalJsonVectorStore could not persist the cleared store at ${this.filePath}.`,
        error,
      )
    })
  }

  /**
   * Wait for every queued write to finish.
   *
   * @returns a promise that settles when the store on disk is up to date.
   */
  async flush(): Promise<void> {
    await this.pending
  }

  /**
   * Read the JSON file (if any) and rebuild the in-memory entries.
   *
   * Validation is per entry: one corrupt record no longer discards the whole
   * store. A file that yields no usable entry at all is left untouched and
   * flagged for a backup before the next write, so a subsequent persist can
   * never destroy the only copy of the data.
   */
  private reload(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (!isMissingFile(error)) {
        this.runtime?.log.warn(
          `LocalJsonVectorStore could not read ${this.filePath}; starting with an empty store.`,
          error,
        )
      }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.runtime?.log.warn(
        `LocalJsonVectorStore found malformed JSON in ${this.filePath}; starting with an empty store ` +
          `(the file will be backed up before it is overwritten).`,
        error,
      )
      this.preserveFileBeforeWrite = true
      return
    }

    const result = readPersistedDocuments(parsed)
    if (result === undefined) {
      this.runtime?.log.warn(
        `LocalJsonVectorStore found an unexpected payload in ${this.filePath} (expected a document ` +
          `array or an object with a 'documents' array); starting with an empty store ` +
          `(the file will be backed up before it is overwritten).`,
      )
      this.preserveFileBeforeWrite = true
      return
    }

    for (const skip of result.skipped) {
      this.runtime?.log.warn(
        `LocalJsonVectorStore skipped persisted entry ${skip.index} in ${this.filePath}: ${skip.reason}.`,
      )
    }

    if (result.entries.length === 0) {
      if (result.declared > 0) {
        this.runtime?.log.warn(
          `LocalJsonVectorStore could not use any of the ${result.declared} persisted entries in ` +
            `${this.filePath}; the file is kept and will be backed up before it is overwritten.`,
        )
        this.preserveFileBeforeWrite = true
      }
      return
    }

    const configured = this.embeddings.dimension
    if (result.dimension !== undefined && configured !== undefined && result.dimension !== configured) {
      this.runtime?.log.warn(
        `LocalJsonVectorStore at ${this.filePath} holds ${result.dimension}-dimensional embeddings but the ` +
          `configured embeddings '${this.embeddings.provider}:${this.embeddings.model}' produce ` +
          `${configured} dimensions; starting with an empty store so no truncated comparison is made. ` +
          `The file is kept and will be backed up before it is overwritten.`,
      )
      this.preserveFileBeforeWrite = true
      return
    }

    this.entries.push(...result.entries)
    this.vectorDimension = result.dimension ?? result.entries[0]?.embedding.length
    for (const entry of result.entries) this.seen.add(documentKey(entry.document))
  }

  /** Queue one atomic-ish write of the whole store. */
  private persist(): Promise<void> {
    const write = this.pending.then(
      () => this.writeToDisk(),
      () => this.writeToDisk(),
    )
    // Keep the chain alive even if a caller ignores the returned rejection.
    this.pending = write.catch(() => {})
    return write
  }

  /** Write temp file + rename, so readers never observe a partial JSON file. */
  private async writeToDisk(): Promise<void> {
    await this.backupUnusableFile()
    const dimension = this.persistableDimension()
    const payload: PersistedVectorStore = {
      version: VECTOR_STORE_SCHEMA_VERSION,
      ...(dimension === undefined ? {} : { dimension }),
      documents: this.snapshot(),
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await mkdir(this.directory, { recursive: true })
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }

  /** Length to record on disk: the stored vectors', else the provider's. */
  private persistableDimension(): number | undefined {
    return this.vectorDimension ?? this.embeddings.dimension
  }

  /**
   * Move a file we could not use aside (`<file>.corrupt-<timestamp>`) before the
   * first write that would overwrite it, so a corrupt or foreign-dimension store
   * is never silently destroyed. A failed rename aborts the write: keeping the
   * old file is always better than losing it.
   */
  private async backupUnusableFile(): Promise<void> {
    if (!this.preserveFileBeforeWrite) return
    this.preserveFileBeforeWrite = false
    const backupPath = `${this.filePath}.corrupt-${this.clock()}`
    try {
      await rename(this.filePath, backupPath)
      this.runtime?.log.warn(
        `LocalJsonVectorStore could not use ${this.filePath}; moved the original file to ${backupPath} ` +
          `before writing a fresh store.`,
      )
    } catch (error) {
      if (isMissingFile(error)) return
      this.preserveFileBeforeWrite = true
      throw error
    }
  }

  /** The injected runtime clock, so timestamped names are deterministic in tests. */
  private clock(): number {
    return this.runtime?.now?.() ?? Date.now()
  }
}

/**
 * Validate and normalise a persisted payload. A bare document array is accepted
 * as well as the versioned object, so a hand-written file still loads.
 *
 * Invalid entries are skipped individually and reported in `skipped`; only a
 * wrong top-level shape makes the whole payload unusable.
 *
 * @param parsed - the parsed JSON value.
 * @returns the usable entries plus what was skipped, or `undefined` when the
 * top-level payload shape itself is wrong.
 */
function readPersistedDocuments(parsed: unknown): PersistedReadResult | undefined {
  const documents = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.documents)
      ? parsed.documents
      : undefined
  if (documents === undefined) return undefined

  const declaredDimension =
    isRecord(parsed) && typeof parsed.dimension === 'number' && Number.isFinite(parsed.dimension)
      ? parsed.dimension
      : undefined

  const skipped: SkippedPersistedEntry[] = []
  const staged: { index: number; entry: VectorStoreEntry }[] = []
  documents.forEach((item, index) => {
    if (!isRecord(item)) {
      skipped.push({ index, reason: 'entry is not an object' })
      return
    }
    const document = item.document
    const embedding = item.embedding
    if (!isRecord(document)) {
      skipped.push({ index, reason: 'document is missing or is not an object' })
      return
    }
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
      skipped.push({ index, reason: 'embedding is missing or is not an array of numbers' })
      return
    }
    const { page_content: pageContent, metadata } = document
    if (typeof pageContent !== 'string') {
      skipped.push({ index, reason: 'page_content is missing or is not a string' })
      return
    }
    if (!isRecord(metadata)) {
      skipped.push({ index, reason: 'metadata is missing or is not a plain object' })
      return
    }
    staged.push({
      index,
      entry: {
        document: { page_content: pageContent, metadata: { ...metadata } },
        embedding: [...embedding],
      },
    })
  })

  const dimension = declaredDimension ?? staged[0]?.entry.embedding.length
  const entries: VectorStoreEntry[] = []
  for (const { index, entry } of staged) {
    if (dimension !== undefined && entry.embedding.length !== dimension) {
      skipped.push({
        index,
        reason: `embedding has ${entry.embedding.length} dimensions but the store declares ${dimension}`,
      })
      continue
    }
    entries.push(entry)
  }
  skipped.sort((a, b) => a.index - b.index)
  return { entries, declared: documents.length, skipped, dimension }
}
