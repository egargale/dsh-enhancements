/**
 * Bundled embedding providers.
 *
 * Port of the provider switch in `gpt_researcher/memory/embeddings.py`. Every
 * name in upstream's `_SUPPORTED_PROVIDERS` is registered so the failure mode
 * for an unbundled SDK is an error message, not a silent no-op:
 *
 * | name           | transport                                                       |
 * | -------------- | --------------------------------------------------------------- |
 * | `local`        | keyless deterministic hashed bag-of-words (512-d), the default   |
 * | `openai`       | `POST {OPENAI_BASE_URL}/embeddings`, 100 inputs per request      |
 * | `custom`       | the same REST shape against `CUSTOM_EMBEDDING_BASE_URL`          |
 * | `azure_openai` | `POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{deployment}/…` |
 * | `ollama`       | keyless `POST {OLLAMA_BASE_URL}/api/embeddings`, one text/call   |
 *
 * All network access goes through `ctx.runtime.http`, all credentials through
 * `ctx.runtime.env`, and every request honours the run's `AbortSignal` plus a
 * timeout. Nothing here uses `Math.random` or `Date.now`, so an embedding is a
 * pure function of its input and configuration.
 *
 * @module gpt-researcher/embeddings
 */

import { SUPPORTED_EMBEDDING_PROVIDERS } from '../config.ts'
import { withTimeout } from '../runtime.ts'
import { EmbeddingsRegistry } from './base.ts'

import type { HttpResponse, Runtime } from '../runtime.ts'
import type { Embedding } from '../types.ts'
import type { EmbeddingContext, Embeddings, EmbeddingsDefinition } from './base.ts'

// The registry types are part of this module's public surface: consumers import
// `Embeddings`/`EmbeddingsRegistry` from the module barrel, not from `base.ts`.
export { EmbeddingsRegistry } from './base.ts'
export type { EmbeddingContext, Embeddings, EmbeddingsDefinition } from './base.ts'

/** Vector length of the bundled keyless `local` embedder. */
export const LOCAL_EMBEDDING_DIMENSION = 512

/** Upstream `OPENAI_EMBEDDING_MODEL` default. */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

/** Default Ollama model (upstream docs: `EMBEDDING=ollama:nomic-embed-text`). */
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text'

/** Default Azure OpenAI deployment when the config omits one. */
export const DEFAULT_AZURE_EMBEDDING_MODEL = 'text-embedding-3-small'

/** Inputs per OpenAI-compatible request (upstream LangChain batches at 100). */
export const EMBEDDING_BATCH_SIZE = 100

/** Per-request timeout in milliseconds. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000

/** Azure OpenAI API version used when no environment variable is set. */
export const DEFAULT_AZURE_API_VERSION = '2024-02-01'

/** OpenAI API root. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Default base URL for the keyless `custom` provider (upstream's LM Studio default). */
export const DEFAULT_CUSTOM_BASE_URL = 'http://localhost:1234/v1'

/** Default base URL for a local Ollama server. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

/** Backends this plugin bundles, in recommendation order. */
export const BUNDLED_EMBEDDING_PROVIDERS = [
  'local',
  'openai',
  'ollama',
  'custom',
  'azure_openai',
] as const

/** One of the bundled provider names. */
export type BundledEmbeddingProvider = (typeof BUNDLED_EMBEDDING_PROVIDERS)[number]

/** Human-readable list of working providers and the variables they need. */
export const BUNDLED_EMBEDDING_HINT =
  'local (keyless, default recommendation), ollama (keyless, OLLAMA_BASE_URL optional), ' +
  'openai (OPENAI_API_KEY, OPENAI_BASE_URL optional), custom (CUSTOM_EMBEDDING_BASE_URL, ' +
  'OPENAI_API_KEY optional), azure_openai (AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT)'

/** Upstream providers this port does not bundle, sorted for stable messages. */
export const UNSUPPORTED_EMBEDDING_PROVIDERS: readonly string[] = [
  ...SUPPORTED_EMBEDDING_PROVIDERS,
]
  .filter((name) => !(BUNDLED_EMBEDDING_PROVIDERS as readonly string[]).includes(name))
  .sort()

/**
 * 32-bit FNV-1a hash over the UTF-16 code units of `text`.
 *
 * A fixed, published algorithm with no runtime state: the same token always
 * lands in the same bucket, in every process and on every platform.
 *
 * @param text - the string to hash.
 * @returns the unsigned 32-bit digest.
 */
export function fnv1aHash32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Tokenise text the way the `local` embedder does: lowercase, then split on
 * every run of non-alphanumeric characters (Unicode-aware, so accented and
 * CJK letters are kept as tokens rather than dropped).
 *
 * @param text - the text to tokenise.
 * @returns the tokens, in order of appearance.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
}

/**
 * The deterministic keyless embedding function.
 *
 * Bag of words hashed into {@link LOCAL_EMBEDDING_DIMENSION} buckets with
 * sublinear term frequency (`1 + ln tf`), then L2-normalised. It is lexical,
 * not semantic — "car" and "automobile" are unrelated to it — but it is
 * reproducible, credential-free, and similar text really does score higher
 * than unrelated text, which is all the memory and the context compressor need.
 *
 * @param text - the text to embed.
 * @param dimension - bucket count; defaults to {@link LOCAL_EMBEDDING_DIMENSION}.
 * @returns the unit vector (all zeros for text with no tokens).
 */
export function embedLocalText(
  text: string,
  dimension: number = LOCAL_EMBEDDING_DIMENSION,
): Embedding {
  const vector: Embedding = new Array<number>(dimension).fill(0)
  const counts = new Map<number, number>()
  for (const token of tokenize(text)) {
    const bucket = fnv1aHash32(token) % dimension
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }

  // Iterate buckets in ascending order: floating-point sums are
  // order-dependent, and this makes the vector a function of the token
  // multiset alone, not of word order in the input.
  let squaredNorm = 0
  for (const [bucket, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const weight = 1 + Math.log(count)
    vector[bucket] = weight
    squaredNorm += weight * weight
  }
  if (squaredNorm === 0) return vector

  const scale = 1 / Math.sqrt(squaredNorm)
  for (let index = 0; index < dimension; index += 1) {
    vector[index] = (vector[index] ?? 0) * scale
  }
  return vector
}

/** The keyless `local` embedder. */
class LocalEmbeddings implements Embeddings {
  readonly provider = 'local'
  readonly model: string
  readonly dimension = LOCAL_EMBEDDING_DIMENSION

  /**
   * @param model - label reported to callers (`local:hash` by default).
   */
  constructor(model: string) {
    this.model = model
  }

  /**
   * @param texts - texts to embed, order preserved.
   * @returns one unit vector per text.
   */
  async embedDocuments(texts: readonly string[]): Promise<Embedding[]> {
    return texts.map((text) => embedLocalText(text, LOCAL_EMBEDDING_DIMENSION))
  }

  /**
   * @param text - the query text.
   * @returns the query's unit vector.
   */
  async embedQuery(text: string): Promise<Embedding> {
    return embedLocalText(text, LOCAL_EMBEDDING_DIMENSION)
  }
}

/** Configuration for one OpenAI-compatible REST embedder. */
interface RestEmbeddingsConfig {
  provider: string
  model: string
  baseUrl: string
  pathSuffix: string
  headers: Record<string, string>
  query?: Record<string, string>
  batchSize: number
  timeoutMs: number
  dimensions?: number
  runtime: Runtime
}

/** An embedder that speaks the OpenAI `POST /embeddings` REST dialect. */
class RestEmbeddings implements Embeddings {
  readonly provider: string
  readonly model: string
  readonly dimension: number | undefined
  private readonly config: RestEmbeddingsConfig

  /**
   * @param config - endpoint, credentials and batching options.
   */
  constructor(config: RestEmbeddingsConfig) {
    this.config = config
    this.provider = config.provider
    this.model = config.model
    this.dimension = config.dimensions
  }

  /**
   * Embed many texts, one request per {@link EMBEDDING_BATCH_SIZE} inputs.
   *
   * @param texts - texts to embed, order preserved.
   * @returns one vector per input, in input order.
   */
  async embedDocuments(texts: readonly string[]): Promise<Embedding[]> {
    const vectors: Embedding[] = []
    for (let index = 0; index < texts.length; index += this.config.batchSize) {
      const batch = texts.slice(index, index + this.config.batchSize)
      vectors.push(...(await this.request(batch)))
    }
    return vectors
  }

  /**
   * @param text - the query text.
   * @returns the query embedding.
   */
  async embedQuery(text: string): Promise<Embedding> {
    const [vector] = await this.request([text])
    if (vector === undefined) {
      throw new Error(`${this.provider} embeddings API returned no vector for the query text.`)
    }
    return vector
  }

  /** Build the request URL, including any provider query string. */
  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const query = new URLSearchParams(this.config.query ?? {}).toString()
    return `${base}${this.config.pathSuffix}${query.length > 0 ? `?${query}` : ''}`
  }

  /** POST one batch, wrapping transport failures with the provider name. */
  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<HttpResponse> {
    try {
      return await this.config.runtime.http(this.endpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.config.headers },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw new Error(`${this.provider} embeddings request failed: ${messageOf(error)}`, {
        cause: error,
      })
    }
  }

  /** One batch request: build body, send, check status, parse vectors. */
  private async request(inputs: readonly string[]): Promise<Embedding[]> {
    const body: Record<string, unknown> = { model: this.model, input: [...inputs] }
    if (this.config.dimensions !== undefined) body.dimensions = this.config.dimensions

    const { signal, dispose } = withTimeout(this.config.runtime.signal, this.config.timeoutMs)
    try {
      const response = await this.post(body, signal)
      if (!response.ok) {
        const detail = await safeText(response)
        throw new Error(
          `${this.provider} embeddings request failed with HTTP ${response.status}` +
            (detail.length > 0 ? `: ${detail}` : ''),
        )
      }
      return await parseEmbeddingList(this.provider, inputs.length, response)
    } finally {
      dispose()
    }
  }
}

/** The keyless `ollama` embedder (one text per `/api/embeddings` call). */
class OllamaEmbeddings implements Embeddings {
  readonly provider = 'ollama'
  readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly runtime: Runtime

  /**
   * @param model - the Ollama model tag (e.g. `nomic-embed-text`).
   * @param baseUrl - Ollama server root, without a trailing slash.
   * @param timeoutMs - per-request timeout.
   * @param runtime - injected runtime (HTTP seam, env, signal, log).
   */
  constructor(model: string, baseUrl: string, timeoutMs: number, runtime: Runtime) {
    this.model = model
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.runtime = runtime
  }

  /**
   * Embed many texts. Ollama's single-text endpoint is used one call per text
   * — deliberately, so older servers that lack the batch `/api/embed` route
   * keep working; `nomic-embed-text` is small enough for this to be cheap on
   * localhost.
   *
   * @param texts - texts to embed, order preserved.
   * @returns one vector per input, in input order.
   */
  async embedDocuments(texts: readonly string[]): Promise<Embedding[]> {
    const vectors: Embedding[] = []
    for (const text of texts) vectors.push(await this.embedQuery(text))
    return vectors
  }

  /**
   * @param text - the query text.
   * @returns the query embedding.
   */
  async embedQuery(text: string): Promise<Embedding> {
    const { signal, dispose } = withTimeout(this.runtime.signal, this.timeoutMs)
    try {
      let response: HttpResponse
      try {
        response = await this.runtime.http(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
          signal,
        })
      } catch (error) {
        throw new Error(`ollama embeddings request failed: ${messageOf(error)}`, { cause: error })
      }
      if (!response.ok) {
        const detail = await safeText(response)
        throw new Error(
          `ollama embeddings request failed with HTTP ${response.status}` +
            (detail.length > 0 ? `: ${detail}` : ''),
        )
      }
      return await parseSingleEmbedding('ollama', response)
    } finally {
      dispose()
    }
  }
}

/**
 * The `local` provider definition: keyless, deterministic, no network.
 *
 * @returns the definition.
 */
export function localEmbeddingsDefinition(): EmbeddingsDefinition {
  return {
    name: 'local',
    keys: [],
    keyless: true,
    description:
      'Keyless deterministic hashed bag-of-words embedder (512 dimensions, FNV-1a buckets, sublinear term frequency, L2-normalised). Lexical rather than semantic, but reproducible and credential-free, so it is the default.',
    defaultModel: 'hash',
    create(_ctx: EmbeddingContext, model: string): Embeddings {
      return new LocalEmbeddings(model)
    },
  }
}

/**
 * The `openai` provider definition.
 *
 * @returns the definition.
 */
export function openaiEmbeddingsDefinition(): EmbeddingsDefinition {
  return {
    name: 'openai',
    keys: ['OPENAI_API_KEY'],
    keyless: false,
    description:
      'OpenAI embeddings: POST {OPENAI_BASE_URL|https://api.openai.com/v1}/embeddings with the API key from OPENAI_API_KEY, batched 100 inputs per request.',
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    create(ctx: EmbeddingContext, model: string, kwargs: Record<string, unknown>): Embeddings {
      return new RestEmbeddings({
        provider: 'openai',
        model,
        baseUrl:
          stringOption(kwargs, 'baseUrl') ??
          ctx.runtime.env('OPENAI_BASE_URL') ??
          DEFAULT_OPENAI_BASE_URL,
        pathSuffix: '/embeddings',
        headers: { authorization: `Bearer ${ctx.runtime.env('OPENAI_API_KEY') ?? ''}` },
        batchSize: numberOption(kwargs, 'batchSize') ?? EMBEDDING_BATCH_SIZE,
        timeoutMs: numberOption(kwargs, 'timeoutMs') ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
        ...dimensionsOption(kwargs),
        runtime: ctx.runtime,
      })
    },
  }
}

/**
 * The `custom` provider definition: any OpenAI-compatible endpoint (LM Studio,
 * vLLM, llama.cpp server, a gateway). Base URL resolution matches upstream:
 * `CUSTOM_EMBEDDING_BASE_URL`, then `OPENAI_BASE_URL`, then
 * `http://localhost:1234/v1`; the key falls back to the literal `custom` so a
 * local server with no auth works out of the box.
 *
 * @returns the definition.
 */
export function customEmbeddingsDefinition(): EmbeddingsDefinition {
  return {
    name: 'custom',
    keys: [],
    keyless: true,
    description:
      'Any OpenAI-compatible embeddings endpoint: base URL from CUSTOM_EMBEDDING_BASE_URL, else OPENAI_BASE_URL, else http://localhost:1234/v1 (LM Studio); key from OPENAI_API_KEY, else the literal "custom" as upstream does.',
    defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    create(ctx: EmbeddingContext, model: string, kwargs: Record<string, unknown>): Embeddings {
      return new RestEmbeddings({
        provider: 'custom',
        model,
        baseUrl:
          stringOption(kwargs, 'baseUrl') ??
          ctx.runtime.env('CUSTOM_EMBEDDING_BASE_URL') ??
          ctx.runtime.env('OPENAI_BASE_URL') ??
          DEFAULT_CUSTOM_BASE_URL,
        pathSuffix: '/embeddings',
        headers: { authorization: `Bearer ${ctx.runtime.env('OPENAI_API_KEY') ?? 'custom'}` },
        batchSize: numberOption(kwargs, 'batchSize') ?? EMBEDDING_BATCH_SIZE,
        timeoutMs: numberOption(kwargs, 'timeoutMs') ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
        ...dimensionsOption(kwargs),
        runtime: ctx.runtime,
      })
    },
  }
}

/**
 * The `azure_openai` provider definition. The configured model is the Azure
 * deployment name, exactly as upstream passes `model` to
 * `AzureOpenAIEmbeddings`.
 *
 * @returns the definition.
 */
export function azureOpenAiEmbeddingsDefinition(): EmbeddingsDefinition {
  return {
    name: 'azure_openai',
    keys: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'],
    keyless: false,
    description:
      'Azure OpenAI embeddings: POST {AZURE_OPENAI_ENDPOINT}/openai/deployments/{model}/embeddings?api-version={AZURE_OPENAI_API_VERSION|OPENAI_API_VERSION|2024-02-01}, authenticated with the api-key header from AZURE_OPENAI_API_KEY.',
    defaultModel: DEFAULT_AZURE_EMBEDDING_MODEL,
    create(ctx: EmbeddingContext, model: string, kwargs: Record<string, unknown>): Embeddings {
      const endpoint = (
        stringOption(kwargs, 'endpoint') ??
        ctx.runtime.env('AZURE_OPENAI_ENDPOINT') ??
        ''
      ).replace(/\/+$/, '')
      const apiVersion =
        stringOption(kwargs, 'apiVersion') ??
        ctx.runtime.env('AZURE_OPENAI_API_VERSION') ??
        ctx.runtime.env('OPENAI_API_VERSION') ??
        DEFAULT_AZURE_API_VERSION
      return new RestEmbeddings({
        provider: 'azure_openai',
        model,
        baseUrl: endpoint,
        pathSuffix: `/openai/deployments/${encodeURIComponent(model)}/embeddings`,
        headers: { 'api-key': ctx.runtime.env('AZURE_OPENAI_API_KEY') ?? '' },
        query: { 'api-version': apiVersion },
        batchSize: numberOption(kwargs, 'batchSize') ?? EMBEDDING_BATCH_SIZE,
        timeoutMs: numberOption(kwargs, 'timeoutMs') ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
        ...dimensionsOption(kwargs),
        runtime: ctx.runtime,
      })
    },
  }
}

/**
 * The `ollama` provider definition: keyless, local, one text per request.
 *
 * @returns the definition.
 */
export function ollamaEmbeddingsDefinition(): EmbeddingsDefinition {
  return {
    name: 'ollama',
    keys: [],
    keyless: true,
    description:
      'Ollama embeddings: one text per POST {OLLAMA_BASE_URL|http://localhost:11434}/api/embeddings call. The batch /api/embed route is intentionally not used so older servers keep working.',
    defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    create(ctx: EmbeddingContext, model: string, kwargs: Record<string, unknown>): Embeddings {
      return new OllamaEmbeddings(
        model,
        stringOption(kwargs, 'baseUrl') ??
          ctx.runtime.env('OLLAMA_BASE_URL') ??
          DEFAULT_OLLAMA_BASE_URL,
        numberOption(kwargs, 'timeoutMs') ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
        ctx.runtime,
      )
    },
  }
}

/**
 * Every bundled definition, in recommendation order.
 *
 * @returns the definitions.
 */
export function bundledEmbeddingsDefinitions(): EmbeddingsDefinition[] {
  return [
    localEmbeddingsDefinition(),
    openaiEmbeddingsDefinition(),
    ollamaEmbeddingsDefinition(),
    customEmbeddingsDefinition(),
    azureOpenAiEmbeddingsDefinition(),
  ]
}

/**
 * Error message for an upstream provider this port does not bundle.
 *
 * @param name - the upstream provider name.
 * @returns the message, naming the working options.
 */
export function unsupportedEmbeddingMessage(name: string): string {
  return (
    `Embedding provider '${name}' is declared by upstream gpt-researcher but is not bundled in ` +
    `this TypeScript port (it would need a provider SDK that is not shipped here). ` +
    `Working options: ${BUNDLED_EMBEDDING_HINT}.`
  )
}

/**
 * A definition for an upstream provider that is not bundled; `create` always
 * throws {@link unsupportedEmbeddingMessage}.
 *
 * @param name - the upstream provider name.
 * @returns the placeholder definition.
 */
export function unsupportedEmbeddingDefinition(name: string): EmbeddingsDefinition {
  return {
    name,
    keys: [],
    keyless: true,
    description: `Upstream '${name}' embeddings (not bundled in this port).`,
    defaultModel: '',
    create(): Embeddings {
      throw new Error(unsupportedEmbeddingMessage(name))
    },
  }
}

/**
 * Build the embedding registry: the five bundled providers, a throwing
 * placeholder per upstream-only provider, then any caller-supplied definitions
 * (registered last, so a caller or a test can override a bundled name).
 *
 * @param extra - additional definitions.
 * @returns the populated registry.
 */
export function createEmbeddingsRegistry(
  extra: readonly EmbeddingsDefinition[] = [],
): EmbeddingsRegistry {
  const registry = new EmbeddingsRegistry()
  for (const definition of bundledEmbeddingsDefinitions()) registry.register(definition)
  for (const name of UNSUPPORTED_EMBEDDING_PROVIDERS) {
    registry.register(unsupportedEmbeddingDefinition(name))
  }
  for (const definition of extra) registry.register(definition)
  return registry
}

/** Read an optional non-empty string kwarg. */
function stringOption(kwargs: Record<string, unknown>, key: string): string | undefined {
  const value = kwargs[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read an optional positive number kwarg. */
function numberOption(kwargs: Record<string, unknown>, key: string): number | undefined {
  const value = kwargs[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read the optional `dimensions` kwarg, as a spreadable partial config. */
function dimensionsOption(kwargs: Record<string, unknown>): { dimensions?: number } {
  const dimensions = numberOption(kwargs, 'dimensions')
  return dimensions === undefined ? {} : { dimensions }
}

/** Whether a value is a usable finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `error.message` for anything throwable. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read a response body for an error message, tolerating a broken body. */
async function safeText(response: HttpResponse): Promise<string> {
  try {
    const text = (await response.text()).trim()
    return text.length <= 300 ? text : `${text.slice(0, 300)}…`
  } catch {
    return ''
  }
}

/** Parse `{ data: [{ embedding: number[] }] }`, preserving response order. */
async function parseEmbeddingList(
  provider: string,
  expected: number,
  response: HttpResponse,
): Promise<Embedding[]> {
  const payload = await jsonOf(provider, response)
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(
      `${provider} embeddings response was not an OpenAI-compatible payload: missing a 'data' array.`,
    )
  }
  const data: unknown[] = payload.data
  if (data.length !== expected) {
    throw new Error(
      `${provider} embeddings response returned ${data.length} vectors for ${expected} input(s).`,
    )
  }
  return data.map((item, index) => {
    const embedding = isRecord(item) ? item.embedding : undefined
    if (!Array.isArray(embedding) || !embedding.every(isFiniteNumber)) {
      throw new Error(
        `${provider} embeddings response data[${index}].embedding was not an array of finite numbers.`,
      )
    }
    return embedding
  })
}

/** Parse Ollama's `{ embedding: number[] }`. */
async function parseSingleEmbedding(provider: string, response: HttpResponse): Promise<Embedding> {
  const payload = await jsonOf(provider, response)
  const embedding = isRecord(payload) ? payload.embedding : undefined
  if (!Array.isArray(embedding) || !embedding.every(isFiniteNumber)) {
    throw new Error(
      `${provider} embeddings response did not contain an 'embedding' array of finite numbers.`,
    )
  }
  return embedding
}

/** Decode a response body, reporting a decode failure against the provider. */
async function jsonOf(provider: string, response: HttpResponse): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new Error(`${provider} embeddings response was not valid JSON: ${messageOf(error)}`, {
      cause: error,
    })
  }
}
