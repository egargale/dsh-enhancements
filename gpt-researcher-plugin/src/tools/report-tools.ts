/**
 * Secondary tools: quick search, report writing from supplied material,
 * single-shot source search, subtopic planning, and capability discovery.
 *
 * These mirror the parts of upstream that are useful on their own — the
 * `quick_search` API, `write_report(ext_context=…)`, `get_subtopics()`, the
 * retriever layer, and the MCP server's introspection value.
 *
 * @module gpt-researcher/tools/report-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { GptResearcher } from '../agent.ts'
import { getSearchResults, retrieverContext } from '../actions/query-processing.ts'
import { createRetrieverRegistry } from '../retrievers/index.ts'
import { createScraperRegistry } from '../scraper/index.ts'
import { createEmbeddingsRegistry } from '../embeddings/index.ts'
import { createVectorStoreRegistry, UNSUPPORTED_VECTOR_STORES } from '../vector_store/index.ts'
import { REPORT_SOURCES, REPORT_TYPES, TONES } from '../types.ts'
import type { SearchResult } from '../types.ts'
import type { GptResearcherPluginConfig } from '../dsh/plugin-config.ts'
import {
  configOverridesFromArgs,
  createSessionLogger,
  projectOutcome,
  reportTypeValue,
  setupEngine,
  toJsonValue,
  type ToolContext,
} from './shared.ts'
import { resultBody, resultUrl } from '../types.ts'

const TONE_NAMES = Object.keys(TONES)

/** Output schema of `gptr_quick_search`. */
const QUICK_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    summary: { type: 'string' },
    results: { type: 'json' },
    stats: { type: 'json' },
    warnings: { type: 'json' },
  },
} as const

/** Output schema shared by `gptr_write_report` and the research tools. */
const WRITE_REPORT_SCHEMA = {
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
    costs: { type: 'json' },
    stats: { type: 'json' },
    warnings: { type: 'json' },
  },
} as const

/** Output schema of `gptr_search_sources`. */
const SEARCH_SOURCES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    retrievers: { type: 'json' },
    results: { type: 'json' },
    errors: { type: 'json' },
  },
} as const

/** Output schema of `gptr_get_subtopics`. */
const SUBTOPICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    subtopics: { type: 'json' },
    warnings: { type: 'json' },
  },
} as const

/** Output schema of `gptr_capabilities`. */
const CAPABILITIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executable: { type: 'boolean' },
    text: { type: 'string' },
    capabilities: { type: 'json' },
  },
} as const

/**
 * Shape of one search result as the tools return it.
 *
 * Declared as a type alias rather than an interface on purpose: alias object
 * types get an implicit index signature, so they are assignable to the
 * tool-output `JsonValue` contract, which interfaces are not.
 */
type FlatResult = {
  url: string
  title: string
  content: string
  score?: number
  published_date?: string
  retriever: string
}

/**
 * Register the secondary tools.
 *
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 * @returns a disposer that unregisters every tool it added.
 */
export function registerReportTools(
  ctx: { tools: { register(definition: never): () => void } },
  toolContext: ToolContext,
  config: GptResearcherPluginConfig | undefined,
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'gptr_quick_search',
        description:
          'One search across the configured retrievers with optional LLM summarisation — no scraping, ' +
          'no report. Use it to check a fact or find candidate sources cheaply before committing to a ' +
          'full research run.',
        parameters: {
          query: { type: 'string', required: true, description: 'The search query.' },
          retrievers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Retriever names; defaults to the deployment configuration.',
          },
          query_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict the search to these domains.',
          },
          max_results: { type: 'integer', description: 'Results per retriever (default 5).' },
          aggregated_summary: {
            type: 'boolean',
            description: 'Also synthesise a short answer from the results (default false).',
          },
        },
        output: {
          schema: QUICK_SEARCH_SCHEMA,
          render: (args, value) => {
            const result = value as unknown as {
              summary: string
              results: FlatResult[]
              stats: { elapsed_ms: number }
              warnings: string[]
            }
            const lines: string[] = []
            if (result.summary) lines.push(result.summary, '')
            lines.push(`## Sources (${result.results.length})`, '')
            result.results.forEach((item, index) => {
              lines.push(
                `${index + 1}. [${item.title || item.url}](${item.url}) — ${item.retriever}` +
                  (item.published_date ? ` (${item.published_date})` : ''),
              )
              if (item.content) lines.push(`   ${item.content.slice(0, 300)}`)
            })
            lines.push('', `---`, `quick search: ${result.results.length} results in ${(result.stats.elapsed_ms / 1000).toFixed(1)}s`)
            for (const warning of result.warnings) lines.push(`warning: ${warning}`)
            void args
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'search',
          title: `gpt-researcher quick: ${args.query.slice(0, 70)}`,
        }),
        timeoutMs: 5 * 60 * 1000,
        async execute(args, exec) {
          const started = Date.now()
          const logger = createSessionLogger(exec)
          const setup = setupEngine({
            ctx: toolContext,
            exec,
            pluginConfig: config,
            overrides: configOverridesFromArgs(args),
            logger,
          })
          const researcher = new GptResearcher({
            deps: setup.deps,
            query: args.query,
            ...(args.max_results === undefined
              ? {}
              : { overrides: { MAX_SEARCH_RESULTS_PER_QUERY: args.max_results } }),
          })
          // One search, not two: the summary used to re-run `retrievers[0]`
          // after `collectResults` had already queried every retriever, doubling
          // provider calls and letting the summary describe sources absent from
          // `results`.
          let results: FlatResult[] = []
          let summary = ''
          if (args.aggregated_summary) {
            const combined = await researcher.quickSearch(args.query, {
              queryDomains: args.query_domains ?? [],
              aggregatedSummary: true,
              withResults: true,
            })
            if (typeof combined === 'object' && combined !== null && 'results' in combined) {
              results = combined.results.map((item) =>
                flatten(item, researcher.retrievers.definitions[0]?.name ?? 'retriever'),
              )
              summary = combined.summary
            } else {
              summary = typeof combined === 'string' ? combined : ''
              results = await collectResults(researcher, args.query, args.query_domains ?? [])
            }
          } else {
            results = await collectResults(researcher, args.query, args.query_domains ?? [])
          }
          return {
            query: args.query,
            summary,
            results,
            stats: {
              elapsed_ms: Date.now() - started,
              retrievers: setup.config.retrievers,
              results: results.length,
            },
            warnings: logger.warnings,
          }
        },
      }) as never,
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'gptr_write_report',
        description:
          'Write a report from material you already have — a context string and/or a list of source ' +
          'URLs to fetch. No search planning and no sub-query generation: this is the report-writing ' +
          'half of gpt-researcher, for when the sources are already known (or were gathered in a ' +
          'previous call).',
        parameters: {
          query: { type: 'string', required: true, description: 'The report question or topic.' },
          context: {
            type: 'string',
            description: 'Research context to write from. Combined with any scraped source_urls.',
          },
          source_urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs to fetch and add to the context before writing.',
          },
          report_type: {
            type: 'string',
            enum: REPORT_TYPES.filter((type) => type !== 'deep' && type !== 'detailed_report'),
            description: 'Report shape (default research_report).',
          },
          custom_prompt: { type: 'string', description: 'Replaces the report prompt entirely.' },
          tone: { type: 'string', enum: TONE_NAMES, description: 'Writing tone.' },
          total_words: { type: 'integer', description: 'Target length in words (default 1200).' },
          language: { type: 'string', description: 'Report language (default english).' },
          report_format: {
            type: 'string',
            enum: ['APA', 'MLA', 'Chicago', 'Harvard', 'IEEE', 'markdown'],
            description: 'Citation format (default APA).',
          },
          output_path: { type: 'string', description: 'Exact path for the written report.' },
        },
        output: {
          schema: WRITE_REPORT_SCHEMA,
          render: (args, value) => {
            const result = value as unknown as {
              report: string
              stats: { sources: number; elapsed_ms: number }
              costs: { total: number }
              report_path?: string
              warnings: string[]
            }
            const lines = [
              result.report.trim().length > 0
                ? result.report.trim()
                : `No report was produced for "${args.query}".`,
              '',
              '---',
              `gpt-researcher write_report: ${result.stats.sources} sources, ~$${result.costs.total.toFixed(6)}`,
            ]
            if (result.report_path) lines.push(`report written to ${result.report_path}`)
            for (const warning of result.warnings) lines.push(`warning: ${warning}`)
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        presentCall: (args) => ({
          card: 'generic',
          kind: 'edit',
          title: `gpt-researcher write report: ${args.query.slice(0, 60)}`,
        }),
        timeoutMs: 20 * 60 * 1000,
        async execute(args, exec) {
          const started = Date.now()
          const logger = createSessionLogger(exec)
          const setup = setupEngine({
            ctx: toolContext,
            exec,
            pluginConfig: config,
            overrides: configOverridesFromArgs(args),
            logger,
          })
          const researcher = new GptResearcher({
            deps: setup.deps,
            query: args.query,
            reportType: reportTypeValue(args.report_type) as never,
            ...(args.tone === undefined ? {} : { tone: args.tone as never }),
          })
          let context = args.context ?? ''
          if (args.source_urls && args.source_urls.length > 0) {
            const scraped = await researcher.scraperManager.browseUrls(args.source_urls)
            const scrapedText = scraped
              .map((source) => `Title: ${source.title ?? source.url}\nContent: ${source.raw_content}`)
              .join('\n\n')
            context = context.length > 0 ? `${context}\n\n${scrapedText}` : scrapedText
          }
          researcher.context = context
          researcher.mergeContextEntries(
            researcher.contextManager.normaliseContext(context),
          )
          const report = await researcher.writeReport(
            args.custom_prompt === undefined ? {} : { customPrompt: args.custom_prompt },
          )
          const outcome = {
            query: args.query,
            reportType: researcher.reportType,
            report,
            sources: researcher.getResearchSources(),
            visitedUrls: [...researcher.visitedUrls],
            context,
            costs: researcher.costs.report(),
          }
          return projectOutcome(outcome, setup, {
            ...(args.output_path === undefined ? {} : { outputPath: args.output_path }),
            ...(args.tone === undefined ? {} : { tone: args.tone }),
            elapsedMs: Date.now() - started,
            warnings: logger.warnings,
          })
        },
      }) as never,
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'gptr_search_sources',
        description:
          'Run raw searches across one or more retrievers and return the sources without scraping, ' +
          'planning, or writing. Useful for auditing which search backends return what, and for ' +
          'gathering candidate URLs to hand to gptr_write_report.',
        parameters: {
          query: { type: 'string', required: true, description: 'The search query.' },
          retrievers: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Retriever names to run, in order.',
          },
          query_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Restrict the search to these domains.',
          },
          max_results: { type: 'integer', description: 'Results per retriever (default 5).' },
        },
        output: {
          schema: SEARCH_SOURCES_SCHEMA,
          render: (args, value) => {
            const result = value as unknown as {
              results: FlatResult[]
              errors: Array<{ retriever: string; message: string }>
            }
            const lines = [`## ${args.query}`, '']
            result.results.forEach((item, index) => {
              lines.push(
                `${index + 1}. [${item.title || item.url}](${item.url}) — ${item.retriever}`,
              )
              if (item.content) lines.push(`   ${item.content.slice(0, 300)}`)
            })
            if (result.results.length === 0) lines.push('No results.')
            for (const error of result.errors) {
              lines.push(`- ${error.retriever} failed: ${error.message}`)
            }
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        timeoutMs: 5 * 60 * 1000,
        async execute(args, exec) {
          const logger = createSessionLogger(exec)
          const setup = setupEngine({
            ctx: toolContext,
            exec,
            pluginConfig: config,
            overrides: { RETRIEVER: args.retrievers.join(',') },
            logger,
          })
          const registry = createRetrieverRegistry()
          const definitions = registry.resolve(args.retrievers, setup.deps.runtime)
          const results: FlatResult[] = []
          const errors: Array<{ retriever: string; message: string }> = []
          // A real RetrieverContext, not `EngineDeps`: the retrievers read
          // `config.timeoutMs`/`config.maxSearchResultsPerQuery`, and
          // `EngineDeps.config` is a `Config` with neither — passing it made
          // `withTimeout(signal, undefined)` abort every request immediately.
          const retrieverCtx = retrieverContext(setup.deps)
          for (const definition of definitions) {
            try {
              const found = await getSearchResults(definition, retrieverCtx, args.query, {
                queryDomains: args.query_domains ?? [],
                ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
              })
              for (const item of found) results.push(flatten(item, definition.name))
            } catch (error) {
              errors.push({
                retriever: definition.name,
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }
          return { query: args.query, retrievers: args.retrievers, results, errors }
        },
      }) as never,
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'gptr_get_subtopics',
        description:
          'Plan the section list for a report on a topic, from an optional research context. This is ' +
          'the subtopic step gpt-researcher uses before writing a detailed report; use it to review ' +
          'the outline before committing to a long run.',
        parameters: {
          query: { type: 'string', required: true, description: 'The report topic.' },
          context: { type: 'string', description: 'Research context to plan from.' },
          max_subtopics: {
            type: 'integer',
            description: 'Maximum number of subtopics (default 3, upstream MAX_SUBTOPICS).',
          },
        },
        output: {
          schema: SUBTOPICS_SCHEMA,
          render: (args, value) => {
            const result = value as unknown as { subtopics: string[]; warnings: string[] }
            const lines = [
              `## Planned sections for ${args.query}`,
              '',
              ...result.subtopics.map((topic, index) => `${index + 1}. ${topic}`),
            ]
            if (result.subtopics.length === 0) lines.push('No subtopics were produced.')
            for (const warning of result.warnings) lines.push(`warning: ${warning}`)
            return [{ type: 'text', text: lines.join('\n') }]
          },
        },
        timeoutMs: 5 * 60 * 1000,
        async execute(args, exec) {
          const logger = createSessionLogger(exec)
          const setup = setupEngine({
            ctx: toolContext,
            exec,
            pluginConfig: config,
            overrides: {
              ...(args.max_subtopics === undefined ? {} : { MAX_SUBTOPICS: args.max_subtopics }),
            },
            logger,
          })
          const researcher = new GptResearcher({ deps: setup.deps, query: args.query })
          researcher.context = args.context ?? ''
          const subtopics = await researcher.getSubtopics()
          return { query: args.query, subtopics, warnings: logger.warnings }
        },
      }) as never,
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'gptr_capabilities',
        description:
          'Report what this gpt-researcher deployment can do right now: available retrievers and ' +
          'which of them have credentials, scrapers, embedding providers, vector stores, report ' +
          'types, tones, and the configured defaults. Call this before a research run when a ' +
          'credential or provider problem is plausible.',
        parameters: {},
        output: {
          schema: CAPABILITIES_SCHEMA,
          render: (_args, value) => [
            { type: 'text', text: (value as { text: string }).text },
          ],
        },
        timeoutMs: 30 * 1000,
        async execute(_args, exec) {
          const env = (name: string) => process.env[name]
          const retrievers = createRetrieverRegistry().all().map((definition) => ({
            name: definition.name,
            keyless: definition.keyless,
            keys: definition.keys,
            missing: definition.keys.filter((key) => !env(key)),
            description: definition.description,
            usable: definition.keyless || definition.keys.every((key) => Boolean(env(key))),
          }))
          const scrapers = createScraperRegistry().all().map((definition) => ({
            name: definition.name,
            keyless: definition.keyless,
            keys: definition.keys,
            missing: definition.keys.filter((key) => !env(key)),
            usable: definition.keyless || definition.keys.every((key) => Boolean(env(key))),
          }))
          const embeddings = createEmbeddingsRegistry().all().map((definition) => ({
            name: definition.name,
            keyless: definition.keyless,
            keys: definition.keys,
            usable: definition.keyless || definition.keys.every((key) => Boolean(env(key))),
          }))
          const stores = createVectorStoreRegistry().all().map((definition) => ({
            name: definition.name,
            keyless: definition.keyless,
          }))
          const capabilities = {
            report_types: [...REPORT_TYPES],
            report_sources: [...REPORT_SOURCES],
            tones: TONE_NAMES,
            retrievers,
            scrapers,
            embeddings,
            vector_stores: stores,
            unsupported_vector_stores: [...UNSUPPORTED_VECTOR_STORES],
            defaults: config ?? {},
            has_web_seam: Boolean(toolContext.web),
          }
          const usableRetrievers = retrievers.filter((item) => item.usable).map((item) => item.name)
          const text = [
            '# gpt-researcher capabilities',
            '',
            `- usable retrievers: ${usableRetrievers.length > 0 ? usableRetrievers.join(', ') : 'NONE'}`,
            `- scrapers: ${scrapers.filter((s) => s.usable).map((s) => s.name).join(', ') || 'NONE'}`,
            `- embedding providers: ${embeddings.filter((e) => e.usable).map((e) => e.name).join(', ') || 'NONE'}`,
            `- vector stores: ${stores.map((s) => s.name).join(', ')}`,
            `- report types: ${REPORT_TYPES.join(', ')}`,
            `- default retriever: ${config?.retriever ?? 'dsh_web'}`,
            `- default scraper: ${config?.scraper ?? 'bs'}`,
            `- default embedding: ${config?.embedding ?? 'local:hash'}`,
            '',
            'Retrievers needing credentials that are missing:',
            ...retrievers
              .filter((item) => !item.usable)
              .map((item) => `- ${item.name}: set ${item.missing.join(', ')}`),
          ].join('\n')
          void exec
          return {
            executable: usableRetrievers.length > 0,
            text,
            capabilities: toJsonValue(capabilities),
          }
        },
      }) as never,
    ),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Map one search result to the flat tool shape. */
function flatten(result: SearchResult, retriever: string): FlatResult {
  return {
    url: resultUrl(result),
    title: result.title ?? '',
    content: (result.content ?? resultBody(result) ?? '').slice(0, 2000),
    ...(result.score === undefined ? {} : { score: result.score }),
    ...(result.published_date === undefined ? {} : { published_date: result.published_date }),
    retriever,
  }
}

/** Search with every configured retriever, tolerating individual failures. */
async function collectResults(
  researcher: GptResearcher,
  query: string,
  queryDomains: readonly string[],
): Promise<FlatResult[]> {
  const results: FlatResult[] = []
  for (const definition of researcher.retrievers.definitions) {
    try {
      const found = await getSearchResults(definition, researcher.retrievers.context, query, {
        queryDomains: [...queryDomains],
      })
      for (const item of found) results.push(flatten(item, definition.name))
    } catch (error) {
      researcher.deps.runtime.log.warn(
        `retriever ${definition.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return results
}
