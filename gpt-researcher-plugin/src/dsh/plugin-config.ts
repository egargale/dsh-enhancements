/**
 * Plugin configuration schema and defaults.
 *
 * Every field is optional in configuration and defaulted here, because a DSH
 * deployment should be able to mount the plugin with no configuration at all
 * and still get a working keyless research stack.
 *
 * @module gpt-researcher/dsh/plugin-config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration as authored in the DSH profile patch. */
export interface GptResearcherPluginConfig {
  /** Primary retriever (upstream `RETRIEVER`). */
  retriever?: string
  /** Extra retriever names to run alongside the primary one. */
  retrievers?: string[]
  /** Scraper implementation (upstream `SCRAPER`). */
  scraper?: string
  /** Embedding provider/model, `provider:model` (upstream `EMBEDDING`). */
  embedding?: string
  /** Vector store: `memory` or `local`. */
  memoryBackend?: string
  /** Report directory, relative to the working directory unless absolute. */
  outputDir?: string
  /** Default tone name (`Objective`, `Analytical`, …). */
  tone?: string
  /** Default report format (upstream `REPORT_FORMAT`). */
  reportFormat?: string
  /** Default report language (upstream `LANGUAGE`). */
  language?: string
  /** Target report length in words (upstream `TOTAL_WORDS`). */
  totalWords?: number
  /** Results per query (upstream `MAX_SEARCH_RESULTS_PER_QUERY`). */
  maxSearchResultsPerQuery?: number
  /** Sub-queries per query (upstream `MAX_ITERATIONS`). */
  maxIterations?: number
  /** Curate sources with the model (upstream `CURATE_SOURCES`). */
  curateSources?: boolean
  /** Deep-research breadth (upstream `DEEP_RESEARCH_BREADTH`). */
  deepResearchBreadth?: number
  /** Deep-research depth (upstream `DEEP_RESEARCH_DEPTH`). */
  deepResearchDepth?: number
  /** Deep-research concurrency (upstream `DEEP_RESEARCH_CONCURRENCY`). */
  deepResearchConcurrency?: number
  /** Model provider route; defaults to the session's provider. */
  provider?: string
  /** Model for the FAST tier; defaults to the session's model. */
  fastModel?: string
  /** Model for the SMART tier; defaults to the session's model. */
  smartModel?: string
  /** Model for the STRATEGIC tier; defaults to the session's model. */
  strategicModel?: string
  /** Output-token ceiling per model call. */
  maxTokens?: number
  /** Per-request HTTP timeout in milliseconds. */
  timeoutMs?: number
  /** Whether report artifacts are written to disk by default. */
  writeArtifacts?: boolean
  /**
   * Permit fetching loopback/private/link-local addresses (default false).
   * Enable only when the deployment genuinely researches internal hosts.
   */
  allowPrivateHosts?: boolean
}

/** Loader schema for the plugin configuration. */
export const PluginConfigSchema = z.object({
  retriever: z.string().default('dsh_web'),
  retrievers: z.array(z.string()).default([]),
  scraper: z.string().default('bs'),
  embedding: z.string().default('local:hash'),
  memoryBackend: z.string().default('memory'),
  outputDir: z.string().default('gptr-reports'),
  tone: z.string().default('Objective'),
  reportFormat: z.string().default('APA'),
  language: z.string().default('english'),
  totalWords: z.number().default(1200),
  maxSearchResultsPerQuery: z.number().default(5),
  maxIterations: z.number().default(3),
  curateSources: z.boolean().default(false),
  deepResearchBreadth: z.number().default(3),
  deepResearchDepth: z.number().default(2),
  deepResearchConcurrency: z.number().default(4),
  provider: z.string(),
  fastModel: z.string(),
  smartModel: z.string(),
  strategicModel: z.string(),
  maxTokens: z.number(),
  timeoutMs: z.number().default(120_000),
  writeArtifacts: z.boolean().default(true),
  allowPrivateHosts: z.boolean().default(false),
})

/**
 * Normalise a possibly-partial loader config into a fully-defaulted object.
 *
 * @param config - the loader-supplied configuration.
 * @returns the effective configuration.
 */
export function normalisePluginConfig(
  config: GptResearcherPluginConfig | undefined,
): Required<
  Pick<
    GptResearcherPluginConfig,
    | 'retriever'
    | 'scraper'
    | 'embedding'
    | 'memoryBackend'
    | 'outputDir'
    | 'tone'
    | 'reportFormat'
    | 'language'
    | 'totalWords'
    | 'maxSearchResultsPerQuery'
    | 'maxIterations'
    | 'curateSources'
    | 'deepResearchBreadth'
    | 'deepResearchDepth'
    | 'deepResearchConcurrency'
    | 'timeoutMs'
    | 'writeArtifacts'
    | 'allowPrivateHosts'
  >
> &
  GptResearcherPluginConfig {
  return {
    ...config,
    retriever: config?.retriever ?? 'dsh_web',
    scraper: config?.scraper ?? 'bs',
    embedding: config?.embedding ?? 'local:hash',
    memoryBackend: config?.memoryBackend ?? 'memory',
    outputDir: config?.outputDir ?? 'gptr-reports',
    tone: config?.tone ?? 'Objective',
    reportFormat: config?.reportFormat ?? 'APA',
    language: config?.language ?? 'english',
    totalWords: config?.totalWords ?? 1200,
    maxSearchResultsPerQuery: config?.maxSearchResultsPerQuery ?? 5,
    maxIterations: config?.maxIterations ?? 3,
    curateSources: config?.curateSources ?? false,
    deepResearchBreadth: config?.deepResearchBreadth ?? 3,
    deepResearchDepth: config?.deepResearchDepth ?? 2,
    deepResearchConcurrency: config?.deepResearchConcurrency ?? 4,
    timeoutMs: config?.timeoutMs ?? 120_000,
    writeArtifacts: config?.writeArtifacts ?? true,
    allowPrivateHosts: config?.allowPrivateHosts ?? false,
  }
}
