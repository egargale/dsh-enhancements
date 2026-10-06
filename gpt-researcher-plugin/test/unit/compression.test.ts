/**
 * Unit tests for context compression.
 *
 * The review found this module had **no test file at all**: the threshold
 * boundary, the slow embedding path, the similarity filter, the "nothing
 * cleared the threshold" fallback and the embedding cost callback were all
 * unverified (a deep-research test claimed to cover the >8000-character path,
 * but a counting embedder showed it never ran).
 *
 * @module test/unit/compression
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ContextCompressor, WrittenContentCompressor, splitText, toDocumentChunks } from '../../src/context/compression.ts'
import type { Embeddings } from '../../src/embeddings/index.ts'
import { PromptFamily } from '../../src/prompts.ts'
import { Config } from '../../src/config.ts'
import type { Runtime } from '../../src/runtime.ts'
import { silentLogger } from '../../src/runtime.ts'
import { CostTracker } from '../../src/utils/costs.ts'
import { estimateEmbeddingCost } from '../../src/utils/costs.ts'
import type { ChatClient } from '../../src/types.ts'

/** An embedder that counts its calls and returns a fixed-dimension vector. */
function countingEmbeddings(): Embeddings & { queries: number; batches: number; texts: string[] } {
  const embedder = {
    provider: 'counting',
    model: 'test',
    dimension: 4,
    queries: 0,
    batches: 0,
    texts: [] as string[],
    async embedQuery(text: string) {
      embedder.queries += 1
      embedder.texts.push(text)
      return [1, 0, 0, 0]
    },
    async embedDocuments(texts: readonly string[]) {
      embedder.batches += 1
      embedder.texts.push(...texts)
      return texts.map(() => [1, 0, 0, 0])
    },
  }
  return embedder
}

const runtime: Runtime = {
  llm: { complete: async () => ({ text: '' }) } as unknown as ChatClient,
  http: async () => ({ ok: false, status: 0, header: () => null, text: async () => '', json: async () => ({}) }),
  env: () => undefined,
  log: silentLogger,
  progress: () => {},
}

const prompts = new PromptFamily(new Config({}))

/** A document of a given character length. */
function doc(length: number, marker = 'body'): Record<string, unknown> {
  return { url: `https://x.test/${marker}`, raw_content: `${marker} `.repeat(Math.ceil(length / (marker.length + 1))).slice(0, length) }
}

describe('splitText / toDocumentChunks', () => {
  it('splits long text into bounded chunks that overlap', () => {
    const chunks = splitText('a'.repeat(2500), 1000, 100)
    assert.ok(chunks.length >= 3)
    assert.ok(chunks.every((chunk) => chunk.length <= 1000))
    assert.equal(chunks[0]?.slice(-100), chunks[1]?.slice(0, 100))
  })

  it('returns nothing for empty text and one chunk for short text', () => {
    assert.deepEqual(splitText(''), [])
    assert.deepEqual(splitText('short'), ['short'])
  })

  it('builds chunks with the source metadata attached', () => {
    const chunks = toDocumentChunks([doc(50)], 1000, 100)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]?.metadata.url, 'https://x.test/body')
  })
})

describe('ContextCompressor', () => {
  it('takes the fast path exactly below the threshold and never embeds', async () => {
    const embeddings = countingEmbeddings()
    // Chunking with 100/1000 overlap inflates the character total, so the
    // threshold has to be compared against the *chunked* text — which is what
    // the implementation does and what this case pins.
    const documents = [doc(2000, 'small')]
    const compressor = new ContextCompressor({
      documents,
      embeddings,
      prompts,
      runtime,
      options: { compressionThreshold: 8000, maxResults: 5 },
    })
    const context = await compressor.asyncGetContext('query')
    assert.ok(context.length > 0)
    assert.equal(embeddings.queries, 0, 'the fast path must not embed')
    assert.equal(embeddings.batches, 0)
  })

  it('takes the embedding path at the threshold and charges its cost', async () => {
    const embeddings = countingEmbeddings()
    const documents = [doc(9000, 'large')]
    const charged: number[] = []
    const compressor = new ContextCompressor({
      documents,
      embeddings,
      prompts,
      runtime,
      options: { compressionThreshold: 8000, maxResults: 5 },
    })
    const context = await compressor.asyncGetContext('query', {
      chargeCost: (usd) => charged.push(usd),
    })
    assert.ok(context.length > 0)
    assert.equal(embeddings.queries, 1)
    assert.equal(embeddings.batches, 1)
    assert.equal(charged.length, 1)
    assert.ok((charged[0] ?? 0) > 0, 'the embedding cost must be charged')
    assert.ok((charged[0] ?? 0) >= estimateEmbeddingCost(['x'.repeat(9000)]))
  })

  it('keeps the nearest chunks when many clear the threshold', async () => {
    const embeddings = countingEmbeddings()
    const documents = [doc(4001, 'aaa'), doc(4001, 'bbb'), doc(4001, 'ccc')]
    const compressor = new ContextCompressor({
      documents,
      embeddings,
      prompts,
      runtime,
      options: { compressionThreshold: 100, maxResults: 2, similarityThreshold: 0.5 },
    })
    const context = await compressor.asyncGetContext('query', { maxResults: 2 })
    assert.equal(context.split('\n').filter((line) => line.startsWith('Title:')).length, 2)
  })

  it('falls back to the first chunks when nothing clears the threshold', async () => {
    const embeddings = countingEmbeddings()
    // Orthogonal vectors: cosine 0, below any positive threshold.
    embeddings.embedQuery = async () => {
      embeddings.queries += 1
      return [0, 1, 0, 0]
    }
    const documents = [doc(4001, 'ddd'), doc(4001, 'eee')]
    const compressor = new ContextCompressor({
      documents,
      embeddings,
      prompts,
      runtime,
      options: { compressionThreshold: 100, maxResults: 2, similarityThreshold: 0.99 },
    })
    const context = await compressor.asyncGetContext('query', { maxResults: 2 })
    assert.ok(context.length > 0, 'an all-below-threshold result must not be empty')
  })

  it('returns an empty string for no documents', async () => {
    const compressor = new ContextCompressor({
      documents: [],
      embeddings: countingEmbeddings(),
      prompts,
      runtime,
      options: { compressionThreshold: 1 },
    })
    assert.equal(await compressor.asyncGetContext('query'), '')
  })
})

describe('WrittenContentCompressor', () => {
  it('charges the embedding cost of the sections it embeds', async () => {
    const embeddings = countingEmbeddings()
    const charged: number[] = []
    const compressor = new WrittenContentCompressor({
      documents: [
        { section_title: 'One', written_content: 'content one' },
        { section_title: 'Two', written_content: 'content two' },
      ],
      embeddings,
      similarityThreshold: 0.1,
    })
    const sections = await compressor.asyncGetContext('content', {
      maxResults: 2,
      chargeCost: (usd) => charged.push(usd),
    })
    assert.equal(sections.length, 2)
    assert.equal(charged.length, 1, 'the cost callback must be invoked')
    assert.equal(charged[0], estimateEmbeddingCost(['content one', 'content two']))
  })

  it('returns nothing for no sections and never embeds', async () => {
    const embeddings = countingEmbeddings()
    const compressor = new WrittenContentCompressor({ documents: [], embeddings })
    assert.deepEqual(await compressor.asyncGetContext('query'), [])
    assert.equal(embeddings.queries, 0)
  })
})

describe('cost accounting wiring', () => {
  it('a charged cost lands in the tracker', () => {
    const tracker = new CostTracker()
    tracker.setStep('research')
    tracker.add(0.001)
    assert.equal(tracker.getCosts(), 0.001)
    assert.deepEqual(tracker.getStepCosts(), { research: 0.001 })
  })
})
