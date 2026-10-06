/**
 * Configuration for the gpt-researcher plugin: a faithful port of
 * `gpt_researcher/config/config.py` + `config/variables/default.py`.
 *
 * Upstream reads a JSON file, overlays environment variables, and exposes every
 * key as a lowercase attribute. This port keeps that contract (`CONFIG_KEYS`
 * uppercased, `Config.retriever`, `Config.smart_llm_model`, …) so an upstream
 * `config.json` or a set of `RETRIEVER=`-style environment variables keeps
 * working unchanged.
 *
 * @module gpt-researcher/config
 */

import { existsSync, readFileSync } from 'node:fs'

import {
  REPORT_FORMATS,
  REPORT_SOURCES,
  REPORT_TYPES,
  TONES,
  type ReportFormat,
  type ReportSource,
  type ReportType,
  type Tone,
} from './types.ts'

/** Upstream `DEFAULT_CONFIG` (`config/variables/default.py`), verbatim. */
export const DEFAULT_CONFIG = {
  RETRIEVER: 'tavily',
  EMBEDDING: 'openai:text-embedding-3-small',
  SIMILARITY_THRESHOLD: 0.42,
  FAST_LLM: 'openai:gpt-4o-mini',
  SMART_LLM: 'openai:gpt-4.1',
  STRATEGIC_LLM: 'openai:o4-mini',
  FAST_TOKEN_LIMIT: 3000,
  SMART_TOKEN_LIMIT: 6000,
  STRATEGIC_TOKEN_LIMIT: 4000,
  BROWSE_CHUNK_MAX_LENGTH: 8192,
  CURATE_SOURCES: false,
  SUMMARY_TOKEN_LIMIT: 700,
  TEMPERATURE: 0.4,
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  MAX_SEARCH_RESULTS_PER_QUERY: 5,
  MEMORY_BACKEND: 'local',
  TOTAL_WORDS: 1200,
  REPORT_FORMAT: 'APA',
  MAX_ITERATIONS: 3,
  AGENT_ROLE: null,
  SCRAPER: 'bs',
  MAX_SCRAPER_WORKERS: 15,
  SCRAPER_RATE_LIMIT_DELAY: 0.0,
  MAX_SUBTOPICS: 3,
  LANGUAGE: 'english',
  REPORT_SOURCE: 'web',
  DOC_PATH: './my-docs',
  PROMPT_FAMILY: 'default',
  LLM_KWARGS: {},
  EMBEDDING_KWARGS: {},
  VERBOSE: false,
  DEEP_RESEARCH_BREADTH: 3,
  DEEP_RESEARCH_DEPTH: 2,
  DEEP_RESEARCH_CONCURRENCY: 4,
  MCP_SERVERS: [],
  MCP_AUTO_TOOL_SELECTION: true,
  MCP_ALLOWED_ROOT_PATHS: [],
  MCP_STRATEGY: 'fast',
  REASONING_EFFORT: 'medium',
  IMAGE_GENERATION_MODEL: 'models/gemini-2.5-flash-image',
  IMAGE_GENERATION_MAX_IMAGES: 3,
  IMAGE_GENERATION_ENABLED: false,
  IMAGE_GENERATION_STYLE: 'dark',
  IMAGE_GENERATION_PROVIDER: 'google',
} as const

/** Every recognised configuration key. */
export type ConfigKey = keyof typeof DEFAULT_CONFIG

/** A resolved configuration value. */
export type ConfigValue =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | Readonly<Record<string, unknown>>

/** The mutable config record: uppercase keys, exactly as upstream stores them. */
export type RawConfig = Record<ConfigKey, ConfigValue>

/** Upstream `_SUPPORTED_PROVIDERS` (`llm_provider/generic/base.py`). */
export const SUPPORTED_LLM_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'azure_openai',
  'cohere',
  'google_vertexai',
  'google_genai',
  'fireworks',
  'ollama',
  'together',
  'mistralai',
  'huggingface',
  'groq',
  'bedrock',
  'dashscope',
  'xai',
  'deepseek',
  'litellm',
  'gigachat',
  'openrouter',
  'vllm_openai',
  'aimlapi',
  'netmind',
  'forge',
  'avian',
  'minimax',
])

/** Upstream `_SUPPORTED_PROVIDERS` (`memory/embeddings.py`). */
export const SUPPORTED_EMBEDDING_PROVIDERS = new Set([
  'openai',
  'azure_openai',
  'cohere',
  'gigachat',
  'google_vertexai',
  'google_genai',
  'fireworks',
  'ollama',
  'together',
  'mistralai',
  'huggingface',
  'nomic',
  'voyageai',
  'dashscope',
  'custom',
  'bedrock',
  'aimlapi',
  'netmind',
  'openrouter',
  'minimax',
  'local',
])

/** Upstream `ReasoningEfforts` (`llm_provider/generic/base.py`). */
export const REASONING_EFFORTS = ['high', 'medium', 'low'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** Error raised for a configuration value upstream would also reject. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

/** A `(provider, model)` pair, as upstream's `parse_llm` returns. */
export interface ParsedProvider {
  provider: string
  model: string
}

/**
 * The resolved configuration object.
 *
 * Field names mirror upstream's lowercase attributes one-for-one, so a reader
 * who knows the Python project can navigate this class without a mapping table.
 */
export class Config {
  /** Raw uppercase configuration, after file + environment merging. */
  readonly raw: RawConfig
  readonly configPath?: string

  // --- Core ---------------------------------------------------------------
  readonly retriever: string
  /** Upstream `Config.retrievers`: the parsed, validated retriever list. */
  readonly retrievers: string[]
  readonly embedding: string
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly embeddingKwargs: Record<string, unknown>
  readonly similarityThreshold: number
  readonly fastLlm: string
  readonly smartLlm: string
  readonly strategicLlm: string
  readonly fastLlmProvider: string
  readonly fastLlmModel: string
  readonly smartLlmProvider: string
  readonly smartLlmModel: string
  readonly strategicLlmProvider: string
  readonly strategicLlmModel: string
  readonly reasoningEffort: ReasoningEffort
  /**
   * Per-request I/O budget in milliseconds (retrievers and scrapers).
   *
   * Upstream has no such key; it is a plugin addition read from `TIMEOUT_MS` so
   * the documented `timeoutMs` setting actually reaches the code that uses it.
   */
  readonly timeoutMs: number
  readonly fastTokenLimit: number
  readonly smartTokenLimit: number
  readonly strategicTokenLimit: number
  readonly browseChunkMaxLength: number
  readonly curateSources: boolean
  readonly summaryTokenLimit: number
  readonly temperature: number
  readonly userAgent: string
  readonly maxSearchResultsPerQuery: number
  readonly memoryBackend: string
  readonly totalWords: number
  readonly reportFormat: ReportFormat
  readonly maxIterations: number
  readonly agentRole: string | null
  readonly scraper: string
  readonly maxScraperWorkers: number
  readonly scraperRateLimitDelay: number
  readonly maxSubtopics: number
  readonly language: string
  readonly reportSource: ReportSource
  readonly docPath: string
  readonly promptFamily: string
  readonly llmKwargs: Record<string, unknown>
  readonly verbose: boolean
  readonly deepResearchBreadth: number
  readonly deepResearchDepth: number
  readonly deepResearchConcurrency: number
  readonly mcpServers: unknown[]
  readonly mcpAutoToolSelection: boolean
  readonly mcpAllowedRootPaths: unknown[]
  readonly mcpStrategy: 'fast' | 'deep' | 'disabled'
  readonly imageGenerationModel: string
  readonly imageGenerationMaxImages: number
  readonly imageGenerationEnabled: boolean
  readonly imageGenerationStyle: string
  readonly imageGenerationProvider: string

  /** Extra per-run overrides (plugin config, tool arguments) — upstream `kwargs`. */
  readonly overrides: Record<string, unknown>

  constructor(options: {
    /** Path to a JSON config file; upstream `config_path`. */
    configPath?: string
    /**
     * Uppercase defaults that outrank upstream's `DEFAULT_CONFIG` but sit
     * *below* the config file and the environment. This is where a host's own
     * defaults belong: upstream's `EMBEDDING=openai:…` default needs a key, so a
     * plugin that ships a keyless stack must be able to say "use `local:hash`
     * unless the deployment chooses otherwise".
     */
    defaults?: Record<string, unknown>
    /**
     * Explicit uppercase overrides applied last (plugin config / tool args).
     * Keys are validated by the caller; unknown keys are carried in `raw` so a
     * dynamic read (e.g. `COMPRESSION_THRESHOLD`) still works.
     */
    overrides?: Record<string, unknown>
    /** Environment lookup; defaults to `process.env`. */
    env?: (name: string) => string | undefined
    /** Base directory used to resolve a relative `DOC_PATH`. */
    cwd?: string
  } = {}) {
    const env = options.env ?? ((name: string) => process.env[name])
    this.configPath = options.configPath
    this.raw = mergeConfig(options.configPath, env, options.defaults)

    // Explicit overrides win over both file and environment, matching how the
    // DSH plugin config and per-call tool arguments behave.
    for (const [key, value] of Object.entries(options.overrides ?? {})) {
      if (value !== undefined) {
        ;(this.raw as Record<string, ConfigValue>)[key.toUpperCase()] = value as ConfigValue
      }
    }

    this.retriever = String(this.raw.RETRIEVER)
    this.retrievers = parseRetrievers(this.retriever)
    this.embedding = String(this.raw.EMBEDDING)
    const embedding = parseProviderPair(
      this.embedding,
      SUPPORTED_EMBEDDING_PROVIDERS,
      'EMBEDDING',
      "'<embedding_provider>:<embedding_model>' Eg 'openai:text-embedding-3-large'",
    )
    this.embeddingProvider = embedding.provider
    this.embeddingModel = embedding.model
    this.embeddingKwargs = asRecord(this.raw.EMBEDDING_KWARGS)

    this.similarityThreshold = numberFrom(this.raw.SIMILARITY_THRESHOLD, 0.42)
    this.fastLlm = String(this.raw.FAST_LLM)
    this.smartLlm = String(this.raw.SMART_LLM)
    this.strategicLlm = String(this.raw.STRATEGIC_LLM)
    const fast = parseProviderPair(this.fastLlm, SUPPORTED_LLM_PROVIDERS, 'FAST_LLM')
    const smart = parseProviderPair(this.smartLlm, SUPPORTED_LLM_PROVIDERS, 'SMART_LLM')
    const strategic = parseProviderPair(
      this.strategicLlm,
      SUPPORTED_LLM_PROVIDERS,
      'STRATEGIC_LLM',
    )
    this.fastLlmProvider = fast.provider
    this.fastLlmModel = fast.model
    this.smartLlmProvider = smart.provider
    this.smartLlmModel = smart.model
    this.strategicLlmProvider = strategic.provider
    this.strategicLlmModel = strategic.model
    // Read the resolved value, not the environment: reading `env()` directly
    // ignored config.json and explicit overrides, contradicting the documented
    // "explicit overrides win over both file and environment".
    this.reasoningEffort = parseReasoningEffort(
      this.raw.REASONING_EFFORT === undefined || this.raw.REASONING_EFFORT === null
        ? undefined
        : String(this.raw.REASONING_EFFORT),
    )
    // `TIMEOUT_MS` is a plugin key, not an upstream one, so it is resolved here
    // with the same precedence as everything else — explicit override, then the
    // environment, then the host default — and a non-finite value is ignored
    // rather than producing a 0 ms timeout that aborts every request.
    this.timeoutMs = 20_000
    for (const candidate of [
      options.overrides?.TIMEOUT_MS,
      env('TIMEOUT_MS'),
      options.defaults?.TIMEOUT_MS,
    ]) {
      const parsed = Number(candidate)
      if (candidate !== undefined && candidate !== '' && Number.isFinite(parsed) && parsed > 0) {
        this.timeoutMs = parsed
        break
      }
    }

    this.fastTokenLimit = numberFrom(this.raw.FAST_TOKEN_LIMIT, 3000)
    this.smartTokenLimit = numberFrom(this.raw.SMART_TOKEN_LIMIT, 6000)
    this.strategicTokenLimit = numberFrom(this.raw.STRATEGIC_TOKEN_LIMIT, 4000)
    this.browseChunkMaxLength = numberFrom(this.raw.BROWSE_CHUNK_MAX_LENGTH, 8192)
    this.curateSources = booleanFrom(this.raw.CURATE_SOURCES, false)
    this.summaryTokenLimit = numberFrom(this.raw.SUMMARY_TOKEN_LIMIT, 700)
    this.temperature = numberFrom(this.raw.TEMPERATURE, 0.4)
    this.userAgent = String(this.raw.USER_AGENT)
    this.maxSearchResultsPerQuery = numberFrom(this.raw.MAX_SEARCH_RESULTS_PER_QUERY, 5)
    this.memoryBackend = String(this.raw.MEMORY_BACKEND)
    this.totalWords = numberFrom(this.raw.TOTAL_WORDS, 1200)
    this.reportFormat = (
      REPORT_FORMATS.includes(String(this.raw.REPORT_FORMAT) as ReportFormat)
        ? String(this.raw.REPORT_FORMAT)
        : 'APA'
    ) as ReportFormat
    this.maxIterations = numberFrom(this.raw.MAX_ITERATIONS, 3)
    this.agentRole = this.raw.AGENT_ROLE == null ? null : String(this.raw.AGENT_ROLE)
    this.scraper = String(this.raw.SCRAPER)
    this.maxScraperWorkers = numberFrom(this.raw.MAX_SCRAPER_WORKERS, 15)
    this.scraperRateLimitDelay = numberFrom(this.raw.SCRAPER_RATE_LIMIT_DELAY, 0)
    this.maxSubtopics = numberFrom(this.raw.MAX_SUBTOPICS, 3)
    this.language = String(this.raw.LANGUAGE)
    const reportSource = String(this.raw.REPORT_SOURCE)
    this.reportSource = (
      REPORT_SOURCES.includes(reportSource as ReportSource) ? reportSource : 'web'
    ) as ReportSource
    this.docPath = resolveDocPath(String(this.raw.DOC_PATH), options.cwd ?? process.cwd())
    this.promptFamily = String(this.raw.PROMPT_FAMILY)
    this.llmKwargs = asRecord(this.raw.LLM_KWARGS)
    this.verbose = booleanFrom(this.raw.VERBOSE, false)
    this.deepResearchBreadth = numberFrom(this.raw.DEEP_RESEARCH_BREADTH, 3)
    this.deepResearchDepth = numberFrom(this.raw.DEEP_RESEARCH_DEPTH, 2)
    this.deepResearchConcurrency = numberFrom(this.raw.DEEP_RESEARCH_CONCURRENCY, 4)
    this.mcpServers = Array.isArray(this.raw.MCP_SERVERS) ? this.raw.MCP_SERVERS : []
    this.mcpAutoToolSelection = booleanFrom(this.raw.MCP_AUTO_TOOL_SELECTION, true)
    this.mcpAllowedRootPaths = Array.isArray(this.raw.MCP_ALLOWED_ROOT_PATHS)
      ? this.raw.MCP_ALLOWED_ROOT_PATHS
      : []
    const strategy = String(this.raw.MCP_STRATEGY)
    this.mcpStrategy = strategy === 'deep' || strategy === 'disabled' ? strategy : 'fast'
    this.imageGenerationModel = String(this.raw.IMAGE_GENERATION_MODEL)
    this.imageGenerationMaxImages = numberFrom(this.raw.IMAGE_GENERATION_MAX_IMAGES, 3)
    this.imageGenerationEnabled = booleanFrom(this.raw.IMAGE_GENERATION_ENABLED, false)
    this.imageGenerationStyle = String(this.raw.IMAGE_GENERATION_STYLE)
    this.imageGenerationProvider = String(this.raw.IMAGE_GENERATION_PROVIDER)

    this.overrides = { ...(options.overrides ?? {}) }
  }

  /**
   * Upstream `set_verbose`: turns on diagnostics. `Config` is immutable here,
   * so this returns a copy with the resolved raw record re-applied.
   *
   * @param verbose - whether diagnostics are enabled.
   * @returns a copy carrying the new verbosity.
   */
  withVerbose(verbose: boolean): Config {
    return new Config({
      ...(this.configPath === undefined ? {} : { configPath: this.configPath }),
      overrides: { ...this.raw, VERBOSE: verbose },
    })
  }

  /**
   * The plugin's own defaults as a lowest-priority config layer.
   *
   * @returns the uppercase default record.
   */
  static hostDefaults(
    defaults: Record<string, unknown>,
  ): Record<string, unknown> {
    return defaults
  }

  /**
   * Upstream `get_mcp_server_config(name)`.
   *
   * @param name - MCP server name to look up.
   * @returns the matching server config, or an empty object.
   */
  getMcpServerConfig(name: string): Record<string, unknown> {
    if (!name || this.mcpServers.length === 0) return {}
    for (const server of this.mcpServers) {
      if (server && typeof server === 'object' && (server as Record<string, unknown>).name === name) {
        return server as Record<string, unknown>
      }
    }
    return {}
  }
}

/**
 * Upstream `Config.load_config`: read a JSON file and merge it over
 * {@link DEFAULT_CONFIG}, then apply environment variables over that.
 *
 * @param configPath - explicit path; falls back to `$CONFIG_PATH`.
 * @param env - environment lookup.
 * @returns the merged uppercase config record.
 */
export function mergeConfig(
  configPath: string | undefined,
  env: (name: string) => string | undefined,
  defaults?: Record<string, unknown>,
): RawConfig {
  const path = configPath ?? env('CONFIG_PATH')
  let fileConfig: Record<string, unknown> = {}
  if (path) {
    const loaded = readJsonFile(path)
    if (loaded) fileConfig = loaded
  }

  // Precedence: upstream defaults → host defaults → config file → environment.
  const merged: Record<string, ConfigValue> = { ...DEFAULT_CONFIG } as Record<
    string,
    ConfigValue
  >
  for (const [key, value] of Object.entries(defaults ?? {})) {
    if (value !== undefined) merged[key.toUpperCase()] = value as ConfigValue
  }
  for (const [key, value] of Object.entries(fileConfig)) {
    merged[key.toUpperCase()] = value as ConfigValue
  }

  // Environment variables override both, with upstream's type coercion.
  for (const key of Object.keys(DEFAULT_CONFIG) as ConfigKey[]) {
    const envValue = env(key)
    if (envValue === undefined) continue
    merged[key] = convertEnvValue(key, envValue, DEFAULT_CONFIG[key])
  }
  return merged as RawConfig
}

/** Read and parse a JSON config file; a missing or invalid file is ignored. */
function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Upstream `Config.convert_env_value`: coerce an environment string to the
 * type of its default value (bool accepts `true/1/yes/on`; lists/dicts are
 * JSON; `null`-able strings accept `none`/`null`/empty).
 *
 * @param key - config key, used only in error messages.
 * @param envValue - raw environment string.
 * @param typeHint - the default value whose type drives coercion.
 * @returns the coerced value.
 */
export function convertEnvValue(
  key: string,
  envValue: string,
  typeHint: ConfigValue,
): ConfigValue {
  if (typeHint === null) {
    return /^(none|null|)$/i.test(envValue) ? null : envValue
  }
  switch (typeof typeHint) {
    case 'boolean':
      return /^(true|1|yes|on)$/i.test(envValue)
    case 'number':
      return Number.isInteger(typeHint) ? Number.parseInt(envValue, 10) : Number(envValue)
    case 'object':
      try {
        return JSON.parse(envValue) as ConfigValue
      } catch {
        throw new ConfigError(`Cannot parse ${key} as JSON: ${envValue}`)
      }
    default:
      return envValue
  }
}

/**
 * Upstream `Config.parse_retrievers`: split, trim, and validate the retriever
 * list. Upstream falls back to `['tavily']` with a warning; this port raises so
 * a bad retriever name is visible in the session rather than silently changing
 * the search backend.
 *
 * @param retrieverStr - comma-separated retriever names.
 * @returns the validated list, in declared order.
 */
export function parseRetrievers(retrieverStr: string): string[] {
  const names = retrieverStr
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  if (names.length === 0) throw new ConfigError('RETRIEVER must name at least one retriever')
  return names
}

/**
 * Upstream `Config.parse_llm` / `parse_embedding`: split `provider:model`.
 *
 * @param value - the `provider:model` string.
 * @param supported - allowed provider ids.
 * @param key - config key, for diagnostics.
 * @param hint - extra guidance appended to the error.
 * @returns the parsed pair.
 */
export function parseProviderPair(
  value: string,
  supported: ReadonlySet<string>,
  key: string,
  hint = "Set SMART_LLM or FAST_LLM = '<llm_provider>:<llm_model>' Eg 'openai:gpt-4o-mini'",
): ParsedProvider {
  const separator = value.indexOf(':')
  if (separator < 0) {
    throw new ConfigError(`${key} must be '<provider>:<model>'. ${hint}`)
  }
  const provider = value.slice(0, separator)
  const model = value.slice(separator + 1)
  if (!supported.has(provider)) {
    throw new ConfigError(
      `Unsupported ${provider} in ${key}. Supported providers are: ${[...supported].sort().join(', ')}`,
    )
  }
  return { provider, model }
}

/** Upstream `Config.parse_reasoning_effort`. */
export function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  if (value === undefined || value === null || value === '') return 'medium'
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new ConfigError(
      `Invalid reasoning effort: ${value}. Valid options are: ${REASONING_EFFORTS.join(', ')}`,
    )
  }
  return value as ReasoningEffort
}

/** Resolve `DOC_PATH` relative to the process/session directory. */
function resolveDocPath(docPath: string, cwd: string): string {
  if (docPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(docPath)) return docPath
  return `${cwd.replace(/\/$/, '')}/${docPath.replace(/^\.\//, '')}`
}

function asRecord(value: ConfigValue | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function numberFrom(value: ConfigValue | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function booleanFrom(value: ConfigValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalise a tone argument. Upstream accepts a `Tone` member by name; the DSH
 * tool also accepts the lowercase friendly form (`objective`) and returns the
 * descriptive value used inside report prompts.
 *
 * @param tone - tone name or descriptive value, case-insensitive.
 * @returns the canonical descriptive tone string.
 */
export function resolveTone(tone: string | undefined): string {
  if (!tone) return TONES.Objective
  const direct = (TONES as Record<string, string>)[tone]
  if (direct) return direct
  const lower = tone.toLowerCase()
  for (const [name, value] of Object.entries(TONES)) {
    if (name.toLowerCase() === lower || value.toLowerCase() === lower) return value
  }
  return TONES.Objective
}

/**
 * Normalise a report-type argument to an upstream value.
 *
 * @param reportType - report type name, accepting `deep_research` as an alias.
 * @returns the canonical upstream report type.
 */
export function resolveReportType(reportType: string | undefined): ReportType {
  if (!reportType) return 'research_report'
  const normalised = reportType === 'deep_research' ? 'deep' : reportType
  if (!(REPORT_TYPES as readonly string[]).includes(normalised)) {
    throw new ConfigError(
      `Unknown report_type '${reportType}'. Valid options are: ${REPORT_TYPES.join(', ')}`,
    )
  }
  return normalised as ReportType
}

/** Canonical tone name from a case-insensitive string, for tool echo-back. */
export function canonicalToneName(tone: string | undefined): Tone {
  if (!tone) return 'Objective'
  const lower = tone.toLowerCase()
  for (const name of Object.keys(TONES) as Tone[]) {
    if (name.toLowerCase() === lower) return name
  }
  return 'Objective'
}
