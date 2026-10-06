/**
 * Unit tests for the research memory: the recursive splitter and the facade.
 *
 * @module test/unit/memory.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEmbeddingsRegistry } from '../../src/embeddings/index.ts'
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_RESULTS,
  Memory,
  splitText,
} from '../../src/memory/index.ts'
import { makeRuntime } from '../../src/runtime.ts'
import { InMemoryVectorStore } from '../../src/vector_store/memory.ts'

import type { Runtime } from '../../src/runtime.ts'
import type { ScrapedContent } from '../../src/types.ts'

function createRuntime(): Runtime {
  return makeRuntime({ llm: { complete: async () => ({ text: '' }) }, env: () => undefined })
}

const vectorDoc: ScrapedContent = {
  url: 'https://example.com/vector-databases',
  raw_content:
    'A vector database stores embeddings and answers similarity search queries over vectors.',
  title: 'Vector databases',
}
const catsDoc: ScrapedContent = {
  url: 'https://example.com/cats',
  raw_content: 'The cat sat on the windowsill watching birds in the garden all afternoon.',
}
const vectorDoc2: ScrapedContent = {
  url: 'https://example.com/embeddings',
  raw_content: 'Embedding vectors let a vector database rank documents by similarity search.',
}

test('splitText leaves a short text in a single chunk', () => {
  assert.deepEqual(splitText('A short sentence about retrieval.'), [
    'A short sentence about retrieval.',
  ])
  assert.deepEqual(splitText('word'), ['word'])
})

test('splitText returns nothing for empty or whitespace-only text', () => {
  assert.deepEqual(splitText(''), [])
  assert.deepEqual(splitText('   \n\n  '), [])
})

test('splitText splits a long text into overlapping 1000-character chunks', () => {
  const text = 'abcdefghij'.repeat(250)
  const chunks = splitText(text)

  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [1000, 1000, 700],
  )
  for (const chunk of chunks) {
    assert.ok(chunk.length <= DEFAULT_CHUNK_SIZE)
  }
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(
      chunks[index]?.slice(0, DEFAULT_CHUNK_OVERLAP),
      chunks[index - 1]?.slice(-DEFAULT_CHUNK_OVERLAP),
      `chunks ${index - 1}/${index} do not share the expected overlap`,
    )
  }
})

test('splitText prefers paragraph boundaries and still overlaps', () => {
  const paragraph = 'Retrieval augmented generation combines a retriever with a generator.'
  const text = Array.from({ length: 40 }, () => paragraph).join('\n\n')
  const chunks = splitText(text)

  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`)
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0)
    assert.ok(chunk.length <= DEFAULT_CHUNK_SIZE, `chunk was ${chunk.length} chars`)
  }
  assert.ok(chunks[0]?.includes(paragraph))
  assert.ok(chunks[1]?.includes(chunks[0]?.slice(-60) ?? ''))
})

test('splitText honours custom chunk sizes and rejects impossible ones', () => {
  const chunks = splitText('one two three four five six seven eight nine ten', {
    chunkSize: 20,
    chunkOverlap: 5,
  })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 20, `chunk '${chunk}' is too long`)
  assert.ok(chunks.join(' ').includes('ten'))

  assert.throws(() => splitText('text', { chunkSize: 0 }), /chunkSize/)
  assert.throws(() => splitText('text', { chunkSize: 10, chunkOverlap: 11 }), /chunkOverlap/)
})

test('Memory stores chunks and ranks the most relevant one first', async () => {
  const runtime = createRuntime()
  const embeddings = createEmbeddingsRegistry().create('local', 'hash', { runtime })
  const memory = new Memory(embeddings, new InMemoryVectorStore({ embeddings }), runtime)

  assert.equal(memory.getEmbeddings(), embeddings)
  assert.equal(DEFAULT_MAX_RESULTS, 5)
  assert.equal(memory.count(), 0)

  await memory.addDocuments([vectorDoc, catsDoc, vectorDoc2])
  assert.equal(memory.count(), 3)

  const relevant = await memory.getRelevantDocuments(
    'vector database embeddings similarity search',
    3,
  )
  assert.equal(relevant.length, 3)
  assert.deepEqual(Object.keys(relevant[0] ?? {}).sort(), ['metadata', 'page_content'])
  assert.equal(relevant[0]?.metadata.url, vectorDoc.url)
  assert.equal(relevant[1]?.metadata.url, vectorDoc2.url)
  assert.equal(relevant[2]?.metadata.url, catsDoc.url)

  // The default cap is larger than the store, so everything comes back.
  assert.equal((await memory.getRelevantDocuments('vector database')).length, 3)
})

test('Memory.similaritySearch caps k and filters by metadata', async () => {
  const runtime = createRuntime()
  const embeddings = createEmbeddingsRegistry().create('local', 'hash', { runtime })
  const memory = new Memory(embeddings, new InMemoryVectorStore({ embeddings }), runtime)
  await memory.load([vectorDoc, catsDoc, vectorDoc2])

  const capped = await memory.similaritySearch('vector database embeddings', 1)
  assert.equal(capped.length, 1)
  assert.equal(capped[0]?.metadata.url, vectorDoc.url)

  const cats = await memory.similaritySearch('cat windowsill garden birds', 3, {
    url: catsDoc.url,
  })
  assert.equal(cats.length, 1)
  assert.equal(cats[0]?.page_content, catsDoc.raw_content)

  assert.deepEqual(await memory.similaritySearch('anything', 3, { url: 'https://example.com/none' }), [])
})

test('Memory.count reflects the stored chunks, including split ones', async () => {
  const runtime = createRuntime()
  const embeddings = createEmbeddingsRegistry().create('local', 'hash', { runtime })
  const memory = new Memory(embeddings, new InMemoryVectorStore({ embeddings }), runtime)

  await memory.addDocuments([vectorDoc, catsDoc, vectorDoc2])
  assert.equal(memory.count(), 3)

  await memory.addDocuments([{ url: 'https://example.com/long', raw_content: 'abcdefghij'.repeat(250) }])
  assert.equal(memory.count(), 6)

  memory.clear()
  assert.equal(memory.count(), 0)
  assert.deepEqual(await memory.getRelevantDocuments('vector database'), [])
})
