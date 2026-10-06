/**
 * Shared plumbing for every DSH tool in the plugin.
 *
 * Each tool has the same job at the edges: turn tool arguments plus the plugin
 * configuration into an {@link EngineDeps}, run a piece of the engine, then
 * project the result into a canonical value with a rendering. Doing that in one
 * place keeps the individual tools readable.
 *
 * @module gpt-researcher/tools/shared
 */

import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import { Config, resolveReportType, canonicalToneName } from '../config.ts'
import type { EngineDeps } from '../deps.ts'
import { TieredChatClient } from '../llm/chat.ts'
import { PromptFamily } from '../prompts.ts'
import type { Logger, ResearchOutcome } from '../types.ts'
import { CostTracker } from '../utils/costs.ts'
import {
  createDshRuntime,
  resolveModelRoutes,
  type ExecutionLike,
  type RouteOverrides,
  type WebServiceLike,
} from '../dsh/session.ts'
import { createDshComplete, type LlmStreamService } from '../dsh/chat-client.ts'
import { normalisePluginConfig, type GptResearcherPluginConfig } from '../dsh/plugin-config.ts'
import { writeArtifacts, type ArtifactResult } from './artifacts.ts'

/** The `ctx` slice the tools use. */
export interface ToolContext {
  llm?: LlmStreamService
  web?: WebServiceLike
}

/** Arguments shared by every research tool. */
export interface CommonArgs {
  query: string
  report_type?: string
  tone?: string
  retrievers?: string[]
  report_source?: string
  max_search_results?: number
  max_iterations?: number
  total_words?: number
  language?: string
  report_format?: string
  curate_sources?: boolean
  output_path?: string
  write_artifacts?: boolean
}

/** The canonical result every research tool returns. */
export interface ResearchToolResult {
  ok: boolean
  query: string
  report_type: string
  report: string
  report_path?: string
  sources_path?: string
  sources: Array<{ url: string; title: string; characters: number }>
  visited_urls: string[]
  subtopics?: string[]
  costs: { total: number; per_step: Record<string, number>; currency: string }
  stats: {
    sources: number
    characters: number
    context_characters: number
    elapsed_ms: number
    retrievers: string[]
    scraper: string
    embedding: string
    report_source: string
    tone: string
    provider?: string
    model?: string
  }
  warnings: string[]
}

/**
 * Output schema shared by the research tools.
 *
 * Declared with `as const` (not a `ValueSchemaSpec` annotation) on purpose:
 * `defineTool` infers its canonical output type from the literal schema, and a
 * widened annotation erases that into `never`.
 */
export const RESEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    query: { type: 'string' },
    report_type: { type: 'string' },
    report: { type: 'string' },
    report_path: { type: 'string' },
    sources_path: { type: 'string' },
    sources: { type: 'json' },
    visited_urls: { type: 'json' },
    subtopics: { type: 'json' },
    costs: { type: 'json' },
    stats: { type: 'json' },
    warnings: { type: 'json' },
  },
} as const

/**
 * Render a research result for the model: the report body, then a compact
 * footer with the artifact path, source count, and cost.
 *
 * @param value - the canonical result.
 * @returns the content blocks.
 */
export function renderResearchResult(value: ResearchToolResult): ContentBlock[] {
  // The summary header comes FIRST on purpose: an oversized tool result is
  // previewed/truncated in the durable session log, and a trailing footer was
  // the first thing lost — taking the artifact path with it. Leading with the
  // locator and the cost keeps them visible for any report length.
  const header: string[] = []
  header.push(
    `gpt-researcher: ${value.report_type} on ${JSON.stringify(value.query)} — ` +
      `${value.stats.sources} sources scraped, ${value.visited_urls.length} URLs visited, ` +
      `~$${value.costs.total.toFixed(6)} estimated model cost, ${(value.stats.elapsed_ms / 1000).toFixed(1)}s.`,
  )
  if (value.report_path) header.push(`report written to ${value.report_path}`)
  if (value.sources_path) header.push(`sources written to ${value.sources_path}`)
  header.push(
    `retrievers=[${value.stats.retrievers.join(', ')}] scraper=${value.stats.scraper} ` +
      `embedding=${value.stats.embedding} source=${value.stats.report_source} tone=${value.stats.tone}` +
      (value.stats.model === undefined ? '' : ` model=${value.stats.model}`),
  )
  for (const warning of value.warnings) header.push(`warning: ${warning}`)

  const body =
    value.report.trim().length > 0
      ? value.report.trim()
      : 'The research produced no report text (no sources were found, or the model returned nothing).'

  return [{ type: 'text', text: `${header.join('\n')}\n\n---\n\n${body}` }]
}

/** Everything a tool needs for one execution. */
export interface EngineSetup {
  deps: EngineDeps
  config: Config
  pluginConfig: ReturnType<typeof normalisePluginConfig>
  routes: ReturnType<typeof resolveModelRoutes>
}

/**
 * Build engine dependencies from the execution context, plugin config, and the
 * tool's own argument overrides.
 *
 * @param params.ctx - the cordis context (for `ctx.llm`, `ctx.web`).
 * @param params.exec - the tool execution (agent, signal, deferred context).
 * @param params.pluginConfig - the raw plugin configuration.
 * @param params.overrides - config overrides derived from tool arguments.
 * @param params.logger - logger whose records join the session log.
 * @returns the assembled engine setup.
 */
export function setupEngine(params: {
  ctx: ToolContext
  exec: ExecutionLike
  pluginConfig: GptResearcherPluginConfig | undefined
  overrides?: Record<string, unknown>
  logger?: Logger
}): EngineSetup {
  const pluginConfig = normalisePluginConfig(params.pluginConfig)
  const routeOverrides: RouteOverrides = {
    ...(pluginConfig.provider === undefined ? {} : { provider: pluginConfig.provider }),
    ...(pluginConfig.fastModel === undefined ? {} : { fastModel: pluginConfig.fastModel }),
    ...(pluginConfig.smartModel === undefined ? {} : { smartModel: pluginConfig.smartModel }),
    ...(pluginConfig.strategicModel === undefined
      ? {}
      : { strategicModel: pluginConfig.strategicModel }),
    ...(pluginConfig.maxTokens === undefined ? {} : { maxTokens: pluginConfig.maxTokens }),
  }
  const routes = resolveModelRoutes(params.exec, routeOverrides)

  const llm = params.ctx.llm
  if (!llm) {
    throw new Error(
      'The gpt-researcher plugin needs the harness LLM service (ctx.llm); none is mounted in this deployment.',
    )
  }
  const chatClient = new TieredChatClient(routes, createDshComplete(llm))

  // Only keys the deployment actually configured become engine overrides.
  // Passing the *defaulted* config here made every plugin default an explicit
  // override, which beat CONFIG_PATH and the environment — so a deployment that
  // set RETRIEVER=tavily or MAX_ITERATIONS=8 saw the plugin defaults instead.
  const config = new Config({
    // The plugin's stack defaults (keyless retriever/scraper/embedder) outrank
    // upstream's, but a deployment's CONFIG_PATH or environment still wins.
    defaults: configDefaultsFromPlugin(pluginConfig),
    overrides: {
      ...configOverridesFromPlugin(params.pluginConfig),
      ...(params.overrides ?? {}),
    },
  })
  const costs = new CostTracker()
  const runtime = createDshRuntime({
    exec: params.exec,
    llm: chatClient,
    ...(params.ctx.web === undefined ? {} : { web: params.ctx.web }),
    ...(params.logger === undefined ? {} : { log: params.logger }),
    allowPrivateHosts: pluginConfig.allowPrivateHosts,
  })
  return {
    deps: { runtime, config, prompts: new PromptFamily(config), costs },
    config,
    pluginConfig,
    routes,
  }
}

/**
 * The plugin's own defaults, as a config layer that sits below the file and the
 * environment but above upstream's `DEFAULT_CONFIG`.
 *
 * @param pluginConfig - the fully defaulted plugin configuration.
 * @returns the uppercase default record.
 */
export function configDefaultsFromPlugin(
  pluginConfig: ReturnType<typeof normalisePluginConfig>,
): Record<string, unknown> {
  const retrievers =
    pluginConfig.retrievers && pluginConfig.retrievers.length > 0
      ? [pluginConfig.retriever, ...pluginConfig.retrievers].join(',')
      : pluginConfig.retriever
  return {
    RETRIEVER: retrievers,
    SCRAPER: pluginConfig.scraper,
    EMBEDDING: pluginConfig.embedding,
    MEMORY_BACKEND: pluginConfig.memoryBackend,
    REPORT_FORMAT: pluginConfig.reportFormat,
    LANGUAGE: pluginConfig.language,
    TOTAL_WORDS: pluginConfig.totalWords,
    MAX_SEARCH_RESULTS_PER_QUERY: pluginConfig.maxSearchResultsPerQuery,
    MAX_ITERATIONS: pluginConfig.maxIterations,
    CURATE_SOURCES: pluginConfig.curateSources,
    DEEP_RESEARCH_BREADTH: pluginConfig.deepResearchBreadth,
    DEEP_RESEARCH_DEPTH: pluginConfig.deepResearchDepth,
    DEEP_RESEARCH_CONCURRENCY: pluginConfig.deepResearchConcurrency,
    TIMEOUT_MS: pluginConfig.timeoutMs,
  }
}

/**
 * Map explicitly configured plugin fields onto engine config keys.
 *
 * Only *present* fields are returned: absent fields must fall through to
 * `CONFIG_PATH` and the environment (upstream's configuration path) rather than
 * being pinned to the plugin's own defaults.
 *
 * @param pluginConfig - the raw loader configuration, before defaulting.
 * @returns the overrides to apply.
 */
export function configOverridesFromPlugin(
  pluginConfig: GptResearcherPluginConfig | undefined,
): Record<string, unknown> {
  const raw = pluginConfig ?? {}
  const retrievers =
    raw.retrievers && raw.retrievers.length > 0
      ? [raw.retriever, ...raw.retrievers].filter((name): name is string => Boolean(name)).join(',')
      : raw.retriever
  return {
    ...(retrievers === undefined ? {} : { RETRIEVER: retrievers }),
    ...(raw.scraper === undefined ? {} : { SCRAPER: raw.scraper }),
    ...(raw.embedding === undefined ? {} : { EMBEDDING: raw.embedding }),
    ...(raw.memoryBackend === undefined ? {} : { MEMORY_BACKEND: raw.memoryBackend }),
    ...(raw.reportFormat === undefined ? {} : { REPORT_FORMAT: raw.reportFormat }),
    ...(raw.language === undefined ? {} : { LANGUAGE: raw.language }),
    ...(raw.totalWords === undefined ? {} : { TOTAL_WORDS: raw.totalWords }),
    ...(raw.maxSearchResultsPerQuery === undefined
      ? {}
      : { MAX_SEARCH_RESULTS_PER_QUERY: raw.maxSearchResultsPerQuery }),
    ...(raw.maxIterations === undefined ? {} : { MAX_ITERATIONS: raw.maxIterations }),
    ...(raw.curateSources === undefined ? {} : { CURATE_SOURCES: raw.curateSources }),
    ...(raw.deepResearchBreadth === undefined
      ? {}
      : { DEEP_RESEARCH_BREADTH: raw.deepResearchBreadth }),
    ...(raw.deepResearchDepth === undefined ? {} : { DEEP_RESEARCH_DEPTH: raw.deepResearchDepth }),
    ...(raw.deepResearchConcurrency === undefined
      ? {}
      : { DEEP_RESEARCH_CONCURRENCY: raw.deepResearchConcurrency }),
    ...(raw.timeoutMs === undefined ? {} : { TIMEOUT_MS: raw.timeoutMs }),
  }
}

/** Map common tool arguments onto engine config keys. */
export function configOverridesFromArgs(args: CommonArgs): Record<string, unknown> {
  return {
    ...(args.retrievers && args.retrievers.length > 0
      ? { RETRIEVER: args.retrievers.join(',') }
      : {}),
    ...(args.report_source === undefined ? {} : { REPORT_SOURCE: args.report_source }),
    ...(args.max_search_results === undefined
      ? {}
      : { MAX_SEARCH_RESULTS_PER_QUERY: args.max_search_results }),
    ...(args.max_iterations === undefined ? {} : { MAX_ITERATIONS: args.max_iterations }),
    ...(args.total_words === undefined ? {} : { TOTAL_WORDS: args.total_words }),
    ...(args.language === undefined ? {} : { LANGUAGE: args.language }),
    ...(args.report_format === undefined ? {} : { REPORT_FORMAT: args.report_format }),
    ...(args.curate_sources === undefined ? {} : { CURATE_SOURCES: args.curate_sources }),
  }
}

/**
 * Project a finished research outcome into the canonical tool result, writing
 * artifacts when the config (or the call) asks for them.
 *
 * @param outcome - the research outcome.
 * @param setup - the engine setup (for config and routes).
 * @param options - artifact policy, tone, elapsed time, and extra warnings.
 * @returns the canonical tool result.
 */
export async function projectOutcome(
  outcome: ResearchOutcome,
  setup: EngineSetup,
  options: {
    cwd?: string
    outputPath?: string
    writeArtifacts?: boolean
    warnings?: string[]
    tone?: string
    elapsedMs?: number
  } = {},
): Promise<ResearchToolResult> {
  const shouldWrite = options.writeArtifacts ?? setup.pluginConfig.writeArtifacts ?? true
  let artifacts: ArtifactResult = {}
  if (shouldWrite || options.outputPath) {
    artifacts = await writeArtifacts(outcome, {
      outputDir: setup.pluginConfig.outputDir,
      cwd: options.cwd ?? process.cwd(),
      ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
    })
  }

  const warnings = [...(options.warnings ?? [])]
  if (artifacts.warning) warnings.push(artifacts.warning)

  return {
    ok: outcome.report.trim().length > 0,
    query: outcome.query,
    report_type: outcome.reportType,
    report: outcome.report,
    ...(artifacts.reportPath === undefined ? {} : { report_path: artifacts.reportPath }),
    ...(artifacts.sourcesPath === undefined ? {} : { sources_path: artifacts.sourcesPath }),
    sources: outcome.sources.map((source) => ({
      url: source.url,
      title: source.title ?? '',
      characters: source.raw_content.length,
    })),
    visited_urls: outcome.visitedUrls,
    ...(outcome.subtopics === undefined ? {} : { subtopics: outcome.subtopics }),
    costs: {
      total: outcome.costs.total,
      per_step: outcome.costs.perStep,
      currency: outcome.costs.currency,
    },
    stats: {
      sources: outcome.sources.length,
      characters: outcome.report.length,
      context_characters: outcome.context.length,
      elapsed_ms: options.elapsedMs ?? 0,
      retrievers: setup.config.retrievers,
      scraper: setup.config.scraper,
      embedding: setup.config.embedding,
      report_source: setup.config.reportSource,
      tone: canonicalToneName(options.tone ?? setup.pluginConfig.tone),
      provider: setup.routes.smart.provider,
      model: setup.routes.smart.model,
    },
    warnings,
  }
}

/**
 * Assert that a structured value satisfies the tool-output JSON contract.
 *
 * The canonical output schema is enforced by the registry at runtime; this
 * helper only bridges the compiler, which cannot prove an arbitrary
 * application interface has an index signature. It performs no conversion.
 *
 * @param value - the value to return as tool output.
 * @returns the same value, typed as lossless JSON.
 */
export function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

/** Canonical report type from a tool argument. */
export function reportTypeValue(reportTypeValue: string | undefined): string {
  return resolveReportType(reportTypeValue)
}

/**
 * A logger whose warnings and errors join the session as deferred context, so
 * a partially-failed research run explains itself in the UI, and whose
 * warnings are also collected for the tool result.
 *
 * `debug`/`info` are dropped: the engine emits them at a volume that would
 * drown the session.
 *
 * @param exec - the tool execution.
 * @returns the logger plus the collected warning strings.
 */
export function createSessionLogger(exec: ExecutionLike): Logger & { warnings: string[] } {
  const warnings: string[] = []
  const emit = (level: 'warn' | 'error', message: string, data?: unknown): void => {
    const line =
      data === undefined
        ? `[gpt-researcher] ${level}: ${message}`
        : `[gpt-researcher] ${level}: ${message} ${safeJson(data)}`
    if (level === 'warn') warnings.push(message)
    if (!exec.deferContext) return
    try {
      exec.deferContext(
        createUserMessage({
          content: [{ type: 'text', text: line }],
          source: { kind: 'user' },
        }),
      )
    } catch {
      // A missing deferral path must never fail a research run.
    }
  }
  const logger: Logger & { warnings: string[] } = {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message) => emit('warn', message),
    error: (message, data) => emit('error', message, data),
  }
  return logger
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
