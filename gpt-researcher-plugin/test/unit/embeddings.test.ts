/**
 * Unit tests for the embedding providers (offline; the HTTP seam is faked).
 *
 * @module test/unit/embeddings.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SUPPORTED_EMBEDDING_PROVIDERS } from '../../src/config.ts'
import {
  BUNDLED_EMBEDDING_PROVIDERS,
  LOCAL_EMBEDDING_DIMENSION,
  createEmbeddingsRegistry,
  embedLocalText,
  fnv1aHash32,
  tokenize,
} from '../../src/embeddings/index.ts'
import { makeRuntime } from '../../src/runtime.ts'
import { cosineSimilarity } from '../../src/vector_store/base.ts'

import type { Embeddings } from '../../src/embeddings/index.ts'
import type { HttpFetch, HttpRequestInit, HttpResponse, Runtime } from '../../src/runtime.ts'

interface RecordedRequest {
  url: string
  init: HttpRequestInit | undefined
}

/** A runtime with a scripted env and (optionally) a recording HTTP seam. */
function createRuntime(options: { env?: Record<string, string>; http?: HttpFetch } = {}): Runtime {
  const env = options.env ?? {}
  const parts = {
    llm: { complete: async () => ({ text: '' }) },
    env: (name: string) => env[name],
  }
  return options.http === undefined ? makeRuntime(parts) : makeRuntime({ ...parts, http: options.http })
}

/** A minimal HttpResponse with a JSON body. */
function jsonResponse(body: unknown, status = 200): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    header: () => null,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  }
}

/** Recorder that answers every request from a body-aware factory. */
function recordingHttp(
  calls: RecordedRequest[],
  answer: (body: { input?: string[]; prompt?: string; model?: string }) => unknown,
): HttpFetch {
  return async (url, init) => {
    calls.push({ url, init })
    const body = JSON.parse(String(init?.body)) as {
      input?: string[]
      prompt?: string
      model?: string
    }
    return jsonResponse(answer(body))
  }
}

test('local embedder is deterministic and independent of call order', async () => {
  const runtime = createRuntime()
  const embedder = createEmbeddingsRegistry().create('local', 'hash', { runtime })

  const first = await embedder.embedQuery('Vector databases store embeddings for similarity search')
  const second = await embedder.embedQuery('Vector databases store embeddings for similarity search')
  assert.equal(first.length, LOCAL_EMBEDDING_DIMENSION)
  assert.deepEqual(second, first)

  const batched = await embedder.embedDocuments([
    'Vector databases store embeddings for similarity search',
    'an unrelated sentence about gardening',
  ])
  assert.deepEqual(batched[0], first)
  assert.notDeepEqual(batched[1], first)
  assert.equal(fnv1aHash32('vector'), fnv1aHash32('vector'))
  assert.notEqual(fnv1aHash32('vector'), fnv1aHash32('vectors'))
  assert.deepEqual(tokenize('Vector-databases, store! EMBEDDINGS.'), [
    'vector',
    'databases',
    'store',
    'embeddings',
  ])
})

test('local embedder L2-normalises its vectors', () => {
  const vector = embedLocalText('retrieval augmented generation over a corpus of documents')
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected a unit vector, got norm ${norm}`)
})

test('local embedder ranks related text above unrelated text', () => {
  const query = embedLocalText('vector database embeddings similarity search')
  const related = embedLocalText(
    'a vector database stores embeddings and answers similarity search queries',
  )
  const unrelated = embedLocalText('the cat sat on the windowsill watching birds in the garden')

  const relatedScore = cosineSimilarity(query, related)
  const unrelatedScore = cosineSimilarity(query, unrelated)
  assert.ok(relatedScore > unrelatedScore, `${relatedScore} !> ${unrelatedScore}`)
  assert.ok(relatedScore > 0.5, `related text only scored ${relatedScore}`)
  assert.ok(unrelatedScore < 0.2, `unrelated text scored ${unrelatedScore}`)
})

test('local embedder handles empty and token-free text without NaN', () => {
  const empty = embedLocalText('')
  const punctuation = embedLocalText('   !!! ??? ---   ')
  assert.equal(empty.length, LOCAL_EMBEDDING_DIMENSION)
  assert.ok(empty.every((value) => value === 0))
  assert.ok(!empty.some((value) => Number.isNaN(value)))
  assert.deepEqual(punctuation, empty)
  assert.equal(cosineSimilarity(empty, empty), 0)
})

test('local provider is keyless and defaults to the hash model', () => {
  const embedder = createEmbeddingsRegistry().create('local', undefined, {
    runtime: createRuntime(),
  })
  assert.equal(embedder.provider, 'local')
  assert.equal(embedder.model, 'hash')
  assert.equal(embedder.dimension, LOCAL_EMBEDDING_DIMENSION)
})

test('every upstream provider name resolves to a registered definition', () => {
  const registry = createEmbeddingsRegistry()
  for (const name of SUPPORTED_EMBEDDING_PROVIDERS) {
    assert.ok(registry.get(name), `provider '${name}' is not registered`)
  }
  for (const name of BUNDLED_EMBEDDING_PROVIDERS) {
    assert.ok(registry.get(name), `bundled provider '${name}' is not registered`)
  }
})

test('registry names the supported providers for an unknown name', () => {
  const registry = createEmbeddingsRegistry()
  assert.throws(
    () => registry.create('bogus', undefined, { runtime: createRuntime() }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Unsupported embedding provider 'bogus'/)
      for (const name of BUNDLED_EMBEDDING_PROVIDERS) {
        assert.match(error.message, new RegExp(name))
      }
      return true
    },
  )
})

test('keyed providers report the exact missing environment variable', () => {
  const registry = createEmbeddingsRegistry()
  assert.throws(
    () => registry.create('openai', undefined, { runtime: createRuntime() }),
    /OPENAI_API_KEY/,
  )
  assert.throws(
    () => registry.create('azure_openai', undefined, { runtime: createRuntime() }),
    /AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT/,
  )
  // `custom` keeps upstream's literal fallback key, so it needs no variables.
  assert.equal(
    registry.create('custom', undefined, { runtime: createRuntime() }).provider,
    'custom',
  )
})

test('unbundled upstream providers fail with the working options', () => {
  const registry = createEmbeddingsRegistry()
  for (const name of ['cohere', 'google_genai', 'voyageai', 'bedrock']) {
    assert.throws(
      () => registry.create(name, undefined, { runtime: createRuntime() }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, new RegExp(`'${name}'`))
        assert.match(error.message, /not bundled/)
        assert.match(error.message, /local/)
        assert.match(error.message, /openai/)
        assert.match(error.message, /ollama/)
        return true
      },
    )
  }
})

test('extra definitions override a bundled provider', () => {
  const stub: Embeddings = {
    provider: 'stub',
    model: 'stub',
    async embedDocuments() {
      return []
    },
    async embedQuery() {
      return []
    },
  }
  const registry = createEmbeddingsRegistry([
    {
      name: 'local',
      keys: [],
      keyless: true,
      description: 'test stub',
      defaultModel: 'stub',
      create: () => stub,
    },
  ])
  assert.equal(registry.create('local', undefined, { runtime: createRuntime() }), stub)
})

test('openai posts the model and a batched input array, and maps data in order', async () => {
  const calls: RecordedRequest[] = []
  const http = recordingHttp(calls, (body) => ({
    data: (body.input ?? []).map((text, index) => ({ embedding: [text.length, index] })),
  }))
  const runtime = createRuntime({ env: { OPENAI_API_KEY: 'test-key' }, http })
  const embedder = createEmbeddingsRegistry().create('openai', undefined, { runtime })

  const vectors = await embedder.embedDocuments(['alpha', 'beta beta'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/embeddings')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.equal(calls[0]?.init?.headers?.['content-type'], 'application/json')
  assert.equal(calls[0]?.init?.headers?.['authorization'], 'Bearer test-key')

  const body = JSON.parse(String(calls[0]?.init?.body)) as { model: string; input: string[] }
  assert.equal(body.model, 'text-embedding-3-small')
  assert.deepEqual(body.input, ['alpha', 'beta beta'])
  assert.deepEqual(vectors, [
    [5, 0],
    [9, 1],
  ])
})

test('openai honours OPENAI_BASE_URL and the requested model', async () => {
  const calls: RecordedRequest[] = []
  const http = recordingHttp(calls, (body) => ({
    data: (body.input ?? []).map(() => ({ embedding: [1] })),
  }))
  const runtime = createRuntime({
    env: { OPENAI_API_KEY: 'key', OPENAI_BASE_URL: 'https://llm.example.test/v1/' },
    http,
  })
  const embedder = createEmbeddingsRegistry().create('openai', 'text-embedding-3-large', {
    runtime,
  })
  await embedder.embedQuery('hello')

  assert.equal(calls[0]?.url, 'https://llm.example.test/v1/embeddings')
  const body = JSON.parse(String(calls[0]?.init?.body)) as { model: string }
  assert.equal(body.model, 'text-embedding-3-large')
  assert.equal(embedder.model, 'text-embedding-3-large')
})

test('openai batches at 100 inputs per request and preserves global order', async () => {
  const calls: RecordedRequest[] = []
  const http = recordingHttp(calls, (body) => ({
    data: (body.input ?? []).map((text) => ({ embedding: [Number(text.slice('text-'.length))] })),
  }))
  const runtime = createRuntime({ env: { OPENAI_API_KEY: 'key' }, http })
  const embedder = createEmbeddingsRegistry().create('openai', undefined, { runtime })

  const texts = Array.from({ length: 101 }, (_value, index) => `text-${index}`)
  const vectors = await embedder.embedDocuments(texts)

  assert.equal(calls.length, 2)
  const first = JSON.parse(String(calls[0]?.init?.body)) as { input: string[] }
  const second = JSON.parse(String(calls[1]?.init?.body)) as { input: string[] }
  assert.equal(first.input.length, 100)
  assert.equal(second.input.length, 1)
  assert.equal(vectors.length, 101)
  assert.equal(vectors[0]?.[0], 0)
  assert.equal(vectors[99]?.[0], 99)
  assert.equal(vectors[100]?.[0], 100)
})

test('a 401 from openai throws an error naming the provider and status', async () => {
  const http: HttpFetch = async () =>
    jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401)
  const runtime = createRuntime({ env: { OPENAI_API_KEY: 'bad-key' }, http })
  const embedder = createEmbeddingsRegistry().create('openai', undefined, { runtime })

  await assert.rejects(
    () => embedder.embedQuery('hello'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /openai/)
      assert.match(error.message, /401/)
      assert.match(error.message, /Incorrect API key/)
      return true
    },
  )
})

test('a malformed openai payload is rejected instead of silently truncated', async () => {
  const http: HttpFetch = async () => jsonResponse({ data: [] })
  const runtime = createRuntime({ env: { OPENAI_API_KEY: 'key' }, http })
  const embedder = createEmbeddingsRegistry().create('openai', undefined, { runtime })
  await assert.rejects(() => embedder.embedQuery('hello'), /returned 0 vectors for 1 input/)
})

test('ollama embeds one text per call against /api/embeddings', async () => {
  const calls: RecordedRequest[] = []
  const http = recordingHttp(calls, (body) => ({ embedding: [(body.prompt ?? '').length] }))
  const runtime = createRuntime({ env: { OLLAMA_BASE_URL: 'http://ollama.test:11434/' }, http })
  const embedder = createEmbeddingsRegistry().create('ollama', undefined, { runtime })

  const vectors = await embedder.embedDocuments(['one', 'four'])
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.url, 'http://ollama.test:11434/api/embeddings')
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    model: 'nomic-embed-text',
    prompt: 'one',
  })
  assert.deepEqual(vectors, [[3], [4]])
})

test('azure_openai targets the deployment URL with the api-key header', async () => {
  const calls: RecordedRequest[] = []
  const http = recordingHttp(calls, () => ({ data: [{ embedding: [1, 2] }] }))
  const runtime = createRuntime({
    env: {
      AZURE_OPENAI_API_KEY: 'azure-key',
      AZURE_OPENAI_ENDPOINT: 'https://resource.openai.azure.com/',
      AZURE_OPENAI_API_VERSION: '2024-06-01',
    },
    http,
  })
  const embedder = createEmbeddingsRegistry().create('azure_openai', 'my-deployment', { runtime })

  assert.deepEqual(await embedder.embedQuery('hi'), [1, 2])
  assert.equal(
    calls[0]?.url,
    'https://resource.openai.azure.com/openai/deployments/my-deployment/embeddings?api-version=2024-06-01',
  )
  assert.equal(calls[0]?.init?.headers?.['api-key'], 'azure-key')
})
