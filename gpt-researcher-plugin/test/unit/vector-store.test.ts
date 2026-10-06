/**
 * Unit tests for the vector stores (offline; embeddings are table stubs).
 *
 * @module test/unit/vector-store.test
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { makeRuntime } from '../../src/runtime.ts'
import { EmbeddingDimensionMismatchError, cosineSimilarity } from '../../src/vector_store/index.ts'
import { createVectorStoreRegistry } from '../../src/vector_store/index.ts'
import { InMemoryVectorStore } from '../../src/vector_store/memory.ts'
import { LocalJsonVectorStore } from '../../src/vector_store/local_json.ts'

import type { Embeddings } from '../../src/embeddings/index.ts'
import type { Runtime } from '../../src/runtime.ts'
import type { Logger, ScrapedContent } from '../../src/types.ts'

/** Embeddings driven by an exact text → vector table; unknown text throws. */
class TableEmbeddings implements Embeddings {
  readonly provider = 'table'
  readonly model = 'table'
  private readonly table: Record<string, number[]>

  constructor(table: Record<string, number[]>) {
    this.table = table
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text))
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vectorFor(text)
  }

  private vectorFor(text: string): number[] {
    const vector = this.table[text]
    if (vector === undefined) throw new Error(`TableEmbeddings has no vector for '${text}'.`)
    return [...vector]
  }
}

/** Embeddings that accept any text, so chunk boundaries cannot break a fixture. */
class LengthEmbeddings implements Embeddings {
  readonly provider = 'length'
  readonly model = 'length'

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => [text.length, 1])
  }

  async embedQuery(text: string): Promise<number[]> {
    return [text.length, 1]
  }
}

/**
 * Table embeddings that also declare a {@link Embeddings.dimension}, the way a
 * real provider (`local:hash` is 512-d) does, so dimension validation can be
 * exercised.
 */
class DimensionEmbeddings implements Embeddings {
  readonly provider = 'dimension'
  readonly model = 'dimension'
  readonly dimension: number
  private readonly table: Record<string, number[]>

  constructor(dimension: number, table: Record<string, number[]>) {
    this.dimension = dimension
    this.table = table
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text))
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vectorFor(text)
  }

  private vectorFor(text: string): number[] {
    const vector = this.table[text]
    if (vector === undefined) throw new Error(`DimensionEmbeddings has no vector for '${text}'.`)
    if (vector.length !== this.dimension) {
      throw new Error(
        `DimensionEmbeddings is declared as ${this.dimension}-d but returned ${vector.length} dims for '${text}'.`,
      )
    }
    return [...vector]
  }
}

/**
 * Embeddings whose vector length comes from a per-text table, so a batch can mix
 * dimensions.
 */
class VariableLengthEmbeddings implements Embeddings {
  readonly provider = 'variable'
  readonly model = 'variable'
  private readonly lengths: Record<string, number>

  constructor(lengths: Record<string, number>) {
    this.lengths = lengths
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text))
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vectorFor(text)
  }

  private vectorFor(text: string): number[] {
    const length = this.lengths[text]
    if (length === undefined) throw new Error(`VariableLengthEmbeddings has no length for '${text}'.`)
    return new Array<number>(length).fill(1)
  }
}

/** Collects every `warn()` call, so tests can assert on diagnostics. */
function collectingLogger(warnings: string[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message)
    },
    error: () => {},
  }
}

/** A runtime with a recording logger and, optionally, a fixed clock. */
function loggingRuntime(warnings: string[], now?: number): Runtime {
  return {
    llm: { complete: async () => ({ text: '' }) },
    http: async () => {
      throw new Error('unexpected HTTP request')
    },
    env: () => undefined,
    log: collectingLogger(warnings),
    progress: () => {},
    ...(now === undefined ? {} : { now: () => now }),
  }
}

function createRuntime(): Runtime {
  return makeRuntime({ llm: { complete: async () => ({ text: '' }) }, env: () => undefined })
}

const alpha: ScrapedContent = { url: 'https://example.com/alpha', raw_content: 'alpha', title: 'Alpha' }
const beta: ScrapedContent = { url: 'https://example.com/beta', raw_content: 'beta' }
const gamma: ScrapedContent = { url: 'https://example.com/gamma', raw_content: 'gamma' }

/** Query [1,0,0] → alpha 1.0, gamma 0.6, beta 0.0. */
const ORDERING_TABLE: Record<string, number[]> = {
  alpha: [1, 0, 0],
  beta: [0, 1, 0],
  gamma: [3, 4, 0],
  query: [1, 0, 0],
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gptr-vector-store-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('cosineSimilarity handles identical, orthogonal and zero vectors', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
  assert.ok(Math.abs(cosineSimilarity([3, 4], [1, 0]) - 0.6) < 1e-12)
})

test('cosineSimilarity throws on mismatched lengths but keeps zero vectors at 0', () => {
  assert.throws(
    () => cosineSimilarity([1, 2, 3], [1, 2, 3, 4, 5, 6]),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingDimensionMismatchError, String(error))
      assert.match(error.message, /3/)
      assert.match(error.message, /6/)
      return true
    },
  )
  // Same-length zero vectors still score 0 instead of NaN.
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0)
  assert.equal(cosineSimilarity([], []), 0)
})

test('InMemoryVectorStore loads documents and counts them', async () => {
  const store = new InMemoryVectorStore({ embeddings: new TableEmbeddings(ORDERING_TABLE) })
  assert.equal(store.name, 'memory')
  assert.equal(store.count(), 0)

  await store.load([alpha, beta, gamma])
  assert.equal(store.count(), 3)
})

test('InMemoryVectorStore ranks results best-first for a crafted fixture', async () => {
  const store = new InMemoryVectorStore({ embeddings: new TableEmbeddings(ORDERING_TABLE) })
  await store.load([beta, gamma, alpha])

  const results = await store.similaritySearch('query', { k: 3 })
  assert.deepEqual(
    results.map((result) => result.metadata.url),
    [alpha.url, gamma.url, beta.url],
  )
  assert.equal(results[0]?.page_content, 'alpha')
  assert.equal(results[0]?.metadata.chunk_index, 0)
  assert.equal(results[0]?.metadata.source, alpha.url)
  assert.equal(typeof results[0]?.metadata.content_hash, 'string')
})

test('InMemoryVectorStore caps results at k and tolerates k beyond the store', async () => {
  const store = new InMemoryVectorStore({ embeddings: new TableEmbeddings(ORDERING_TABLE) })
  await store.load([alpha, beta, gamma])

  const capped = await store.similaritySearch('query', { k: 1 })
  assert.equal(capped.length, 1)
  assert.equal(capped[0]?.metadata.url, alpha.url)
  assert.deepEqual(await store.similaritySearch('query', { k: 0 }), [])

  const generous = await store.similaritySearch('query', { k: 50 })
  assert.equal(generous.length, 3)
})

test('InMemoryVectorStore applies exact-match metadata filters', async () => {
  const store = new InMemoryVectorStore({ embeddings: new TableEmbeddings(ORDERING_TABLE) })
  await store.load([alpha, beta, gamma])

  const filtered = await store.similaritySearch('query', { k: 5, filter: { url: gamma.url } })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]?.page_content, 'gamma')

  const byTitle = await store.similaritySearch('query', { k: 5, filter: { title: 'Alpha' } })
  assert.deepEqual(
    byTitle.map((result) => result.page_content),
    ['alpha'],
  )

  assert.deepEqual(await store.similaritySearch('query', { k: 5, filter: { url: 'missing' } }), [])
  assert.equal((await store.similaritySearch('query', { k: 5, filter: { chunk_index: 0 } })).length, 3)
  assert.deepEqual(
    await store.similaritySearch('query', { k: 5, filter: { chunk_index: 7 } }),
    [],
  )
})

test('InMemoryVectorStore clear resets count and search', async () => {
  const store = new InMemoryVectorStore({ embeddings: new TableEmbeddings(ORDERING_TABLE) })
  await store.load([alpha, beta, gamma])
  store.clear()

  assert.equal(store.count(), 0)
  assert.deepEqual(await store.similaritySearch('query', { k: 3 }), [])
})

test('InMemoryVectorStore rejects embeddings whose length differs from the first document', async () => {
  const acrossBatches = new InMemoryVectorStore({
    embeddings: new VariableLengthEmbeddings({ alpha: 2, beta: 3, query: 2 }),
  })
  await acrossBatches.load([alpha])
  assert.equal(acrossBatches.count(), 1)

  await assert.rejects(
    () => acrossBatches.load([beta]),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingDimensionMismatchError, String(error))
      assert.match(error.message, /2/)
      assert.match(error.message, /3/)
      return true
    },
  )
  // Fail closed: the rejected batch left the store untouched.
  assert.equal(acrossBatches.count(), 1)

  const withinOneBatch = new InMemoryVectorStore({
    embeddings: new VariableLengthEmbeddings({ alpha: 2, beta: 3 }),
  })
  await assert.rejects(
    () => withinOneBatch.load([alpha, beta]),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingDimensionMismatchError, String(error))
      assert.match(error.message, /2/)
      assert.match(error.message, /3/)
      return true
    },
  )
  assert.equal(withinOneBatch.count(), 0)
})

test('loading splits long documents into overlapping chunks', async () => {
  const store = new InMemoryVectorStore({ embeddings: new LengthEmbeddings() })
  const content = 'abcdefghij'.repeat(250)
  await store.load([{ url: 'https://example.com/long', raw_content: content }])

  assert.equal(store.count(), 3)
  const results = await store.similaritySearch('query', { k: 3 })
  assert.equal(results.length, 3)
  for (const result of results) {
    assert.ok(result.page_content.length <= 1000, `chunk was ${result.page_content.length} chars`)
    assert.equal(result.metadata.chunk_count, 3)
  }

  const byIndex = new Map(
    results.map((result) => [Number(result.metadata.chunk_index), result.page_content]),
  )
  assert.deepEqual([...byIndex.keys()].sort((a, b) => a - b), [0, 1, 2])
  assert.equal(byIndex.get(1)?.slice(0, 100), byIndex.get(0)?.slice(-100))
  assert.equal(byIndex.get(2)?.slice(0, 100), byIndex.get(1)?.slice(-100))
})

test('LocalJsonVectorStore persists across store instances', async () => {
  await withTempDir(async (directory) => {
    const first = new LocalJsonVectorStore({
      embeddings: new TableEmbeddings(ORDERING_TABLE),
      path: directory,
    })
    await first.load([alpha, beta, gamma])
    assert.equal(first.count(), 3)

    const payload = JSON.parse(await readFile(join(directory, 'vector-store.json'), 'utf8')) as {
      version: number
      dimension: number
      documents: unknown[]
    }
    assert.equal(payload.version, 1)
    assert.equal(payload.dimension, 3)
    assert.equal(payload.documents.length, 3)

    // The second store only knows how to embed the query: documents come from disk.
    const second = new LocalJsonVectorStore({
      embeddings: new TableEmbeddings({ query: [1, 0, 0] }),
      path: directory,
    })
    assert.equal(second.name, 'local')
    assert.equal(second.count(), 3)

    const results = await second.similaritySearch('query', { k: 2 })
    assert.deepEqual(
      results.map((result) => result.metadata.url),
      [alpha.url, gamma.url],
    )
    assert.equal(second.filePath, join(directory, 'vector-store.json'))
  })
})

test('LocalJsonVectorStore de-duplicates by URL plus content hash', async () => {
  await withTempDir(async (directory) => {
    const embeddings = new TableEmbeddings(ORDERING_TABLE)
    const store = new LocalJsonVectorStore({ embeddings, path: directory })

    await store.load([alpha, beta])
    assert.equal(store.count(), 2)

    // Same sources again: no new chunks, even from a fresh process.
    await store.load([alpha, beta])
    assert.equal(store.count(), 2)

    const reloaded = new LocalJsonVectorStore({ embeddings, path: directory })
    assert.equal(reloaded.count(), 2)
    await reloaded.load([alpha, beta])
    assert.equal(reloaded.count(), 2)

    // Different URL, identical content: a distinct source.
    await reloaded.load([{ url: 'https://example.com/alpha-copy', raw_content: 'alpha' }])
    assert.equal(reloaded.count(), 3)
  })
})

test('LocalJsonVectorStore clear empties the file after flush', async () => {
  await withTempDir(async (directory) => {
    const embeddings = new TableEmbeddings(ORDERING_TABLE)
    const store = new LocalJsonVectorStore({ embeddings, path: directory })
    await store.load([alpha, beta])
    assert.equal(store.count(), 2)

    store.clear()
    await store.flush()
    assert.equal(store.count(), 0)

    const onDisk = new LocalJsonVectorStore({ embeddings, path: directory })
    assert.equal(onDisk.count(), 0)
  })
})

test('LocalJsonVectorStore tolerates a malformed file without destroying it', async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, 'vector-store.json')
    const original = '{ not valid json'
    await writeFile(file, original, 'utf8')
    const warnings: string[] = []
    const store = new LocalJsonVectorStore({
      embeddings: new LengthEmbeddings(),
      path: directory,
      runtime: loggingRuntime(warnings, 1_700_000_000_000),
    })
    assert.equal(store.count(), 0)
    assert.ok(warnings.some((warning) => warning.includes('malformed JSON')))

    await store.load([alpha])
    await store.flush()
    const backupName = 'vector-store.json.corrupt-1700000000000'
    assert.ok((await readdir(directory)).includes(backupName), `expected ${backupName}`)
    assert.equal(await readFile(join(directory, backupName), 'utf8'), original)
  })
})

test('LocalJsonVectorStore refuses a file written with another embedding dimension', async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, 'vector-store.json')
    const writer = new LocalJsonVectorStore({
      embeddings: new DimensionEmbeddings(3, ORDERING_TABLE),
      path: directory,
    })
    await writer.load([alpha, beta, gamma])
    assert.equal(writer.count(), 3)
    const onDisk = await readFile(file, 'utf8')
    assert.equal((JSON.parse(onDisk) as { dimension: number }).dimension, 3)

    const warnings: string[] = []
    const reader = new LocalJsonVectorStore({
      embeddings: new DimensionEmbeddings(2, { query: [1, 0] }),
      path: directory,
      runtime: loggingRuntime(warnings),
    })

    assert.equal(reader.count(), 0)
    assert.deepEqual(await reader.similaritySearch('query', { k: 3 }), [])
    assert.ok(
      warnings.some(
        (warning) => warning.includes('3-dimensional') && warning.includes('produce 2 dimensions'),
      ),
      `expected a warning naming both dimensions, got ${JSON.stringify(warnings)}`,
    )
    // Neither construction nor the failed search rewrote the persisted file.
    assert.equal(await readFile(file, 'utf8'), onDisk)
    assert.deepEqual(await readdir(directory), ['vector-store.json'])
  })
})

test('LocalJsonVectorStore keeps valid entries when one entry is corrupt', async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, 'vector-store.json')
    const writer = new LocalJsonVectorStore({
      embeddings: new TableEmbeddings(ORDERING_TABLE),
      path: directory,
    })
    await writer.load([alpha])

    const payload = JSON.parse(await readFile(file, 'utf8')) as { documents: unknown[] }
    payload.documents.push({ document: { page_content: 7, metadata: {} }, embedding: [1, 0, 0] })
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')

    const warnings: string[] = []
    const store = new LocalJsonVectorStore({
      embeddings: new TableEmbeddings({ query: [1, 0, 0] }),
      path: directory,
      runtime: loggingRuntime(warnings),
    })

    assert.equal(store.count(), 1)
    const results = await store.similaritySearch('query', { k: 5 })
    assert.deepEqual(
      results.map((result) => result.metadata.url),
      [alpha.url],
    )
    assert.ok(
      warnings.some(
        (warning) => warning.includes('persisted entry 1') && warning.includes('page_content'),
      ),
      `expected a warning about the skipped index, got ${JSON.stringify(warnings)}`,
    )
    // The valid entry is still on disk, so a fresh store finds it too.
    assert.deepEqual(await readdir(directory), ['vector-store.json'])
    const reopened = new LocalJsonVectorStore({
      embeddings: new TableEmbeddings({ query: [1, 0, 0] }),
      path: directory,
    })
    assert.equal(reopened.count(), 1)
  })
})

test('LocalJsonVectorStore backs up an unusable payload before overwriting it', async () => {
  await withTempDir(async (directory) => {
    const file = join(directory, 'vector-store.json')
    const original = JSON.stringify({ unexpected: true })
    await writeFile(file, original, 'utf8')

    const warnings: string[] = []
    const fixedNow = 1_700_000_000_000
    const store = new LocalJsonVectorStore({
      embeddings: new DimensionEmbeddings(3, ORDERING_TABLE),
      path: directory,
      runtime: loggingRuntime(warnings, fixedNow),
    })
    assert.equal(store.count(), 0)
    assert.ok(
      warnings.some((warning) => warning.includes('unexpected payload')),
      `expected a warning about the payload, got ${JSON.stringify(warnings)}`,
    )
    // Reading alone must not touch the file.
    assert.equal(await readFile(file, 'utf8'), original)

    await store.load([alpha])
    await store.flush()

    const backupName = `vector-store.json.corrupt-${fixedNow}`
    assert.ok((await readdir(directory)).includes(backupName), `expected ${backupName}`)
    assert.equal(await readFile(join(directory, backupName), 'utf8'), original)
    assert.ok(
      warnings.some((warning) => warning.includes(backupName)),
      `expected a loud warning naming the backup, got ${JSON.stringify(warnings)}`,
    )
    assert.equal((await readFile(file, 'utf8')).includes('alpha'), true)
  })
})

test('LocalJsonVectorStore de-duplicates by URL plus content hash across a checked reload', async () => {
  await withTempDir(async (directory) => {
    const embeddings = new DimensionEmbeddings(3, ORDERING_TABLE)
    const store = new LocalJsonVectorStore({ embeddings, path: directory })
    await store.load([alpha, beta])
    assert.equal(store.count(), 2)
    await store.load([alpha, beta])
    assert.equal(store.count(), 2)

    const reloaded = new LocalJsonVectorStore({ embeddings, path: directory })
    assert.equal(reloaded.count(), 2)
    await reloaded.load([alpha, beta])
    assert.equal(reloaded.count(), 2)

    // Different URL, identical content: a distinct source.
    await reloaded.load([{ url: 'https://example.com/alpha-copy', raw_content: 'alpha' }])
    assert.equal(reloaded.count(), 3)
  })
})

test('vector store registry exposes memory and local, and rejects the rest', async () => {
  await withTempDir(async (directory) => {
    const registry = createVectorStoreRegistry()
    const runtime = createRuntime()

    const memory = registry.create('memory', { runtime }, { embeddings: new LengthEmbeddings() })
    assert.equal(memory.name, 'memory')
    assert.equal(memory.count(), 0)

    const local = registry.create(
      'local',
      { runtime },
      { embeddings: new LengthEmbeddings(), path: directory },
    )
    assert.equal(local.name, 'local')

    assert.throws(
      () => registry.create('nope', { runtime }, { embeddings: new LengthEmbeddings() }),
      /Unsupported vector store 'nope'/,
    )
    for (const name of ['chroma', 'qdrant', 'pinecone']) {
      assert.throws(
        () => registry.create(name, { runtime }, { embeddings: new LengthEmbeddings() }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, new RegExp(`'${name}'`))
          assert.match(error.message, /not bundled/)
          assert.match(error.message, /memory/)
          assert.match(error.message, /local/)
          return true
        },
      )
    }

    const overriding = createVectorStoreRegistry([
      {
        name: 'memory',
        keys: [],
        keyless: true,
        description: 'test stub',
        create: () => memory,
      },
    ])
    assert.equal(
      overriding.create('memory', { runtime }, { embeddings: new LengthEmbeddings() }),
      memory,
    )
  })
})
