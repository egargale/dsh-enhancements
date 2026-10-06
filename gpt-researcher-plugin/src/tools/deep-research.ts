/**
 * `gptr_deep_research` — recursive breadth/depth research (upstream
 * `ReportType.DeepResearch`, value `"deep"`), plus the research-trace payload
 * that upstream streams over its websocket.
 *
 * @module gpt-researcher/tools/deep-research
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { GptResearcher } from '../agent.ts'
import type { GptResearcherPluginConfig } from '../dsh/plugin-config.ts'
import type { DeepResearchNode } from '../types.ts'
import { TONES } from '../types.ts'
import {
  configOverridesFromArgs,
  createSessionLogger,
  projectOutcome,
  setupEngine,
  type ToolContext,
} from './shared.ts'

const TONE_NAMES = Object.keys(TONES)

const DEEP_OUTPUT_SCHEMA = {
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
    research_trace: { type: 'json' },
    learnings: { type: 'json' },
  },
} as const

/** One node of the deep-research trace, as the tool returns it. */
interface TraceNode {
  query: string
  depth: number
  learnings: string[]
  followed_up_questions: string[]
  sources: string[]
}

/**
 * Register `gptr_deep_research`.
 *
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 * @returns a disposer that unregisters the tool.
 */
export function registerDeepResearchTool(
  ctx: { tools: { register(definition: never): () => void } },
  toolContext: ToolContext,
  config: GptResearcherPluginConfig | undefined,
): () => void {
  const tool = defineTool({
    name: 'gptr_deep_research',
    description:
      'Run recursive deep research: breadth-first rounds of query generation, search, scraping, and ' +
      'learning extraction, descending `depth` levels. Slower and more expensive than gptr_research, ' +
      'and the right tool for open-ended questions that need several rounds of follow-up. Returns the ' +
      'report plus the full research trace (queries, learnings, follow-up questions, sources).',
    parameters: {
      query: { type: 'string', required: true, description: 'The research question.' },
      breadth: {
        type: 'integer',
        description: 'Queries generated per research round (default 3, maximum 10).',
      },
      depth: {
        type: 'integer',
        description: 'Recursion depth; 0 means one round (default 2, maximum 4).',
      },
      concurrency: {
        type: 'integer',
        description: 'Parallel research tasks (default 4, maximum 16).',
      },
      tone: { type: 'string', enum: TONE_NAMES, description: 'Writing tone (default Objective).' },
      retrievers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Retriever names, in order; defaults to the deployment configuration.',
      },
      max_search_results: { type: 'integer', description: 'Results per query (default 5).' },
      total_words: { type: 'integer', description: 'Target report length in words (default 1200).' },
      language: { type: 'string', description: 'Report language (default english).' },
      output_path: { type: 'string', description: 'Exact path for the written report.' },
      write_artifacts: { type: 'boolean', description: 'Write the report to disk (default true).' },
    },
    output: {
      schema: DEEP_OUTPUT_SCHEMA,
      render: (args, value) => {
        const result = value as {
          report: string
          stats: { sources: number; elapsed_ms: number }
          costs: { total: number }
          warnings: string[]
          research_trace?: TraceNode[]
          report_path?: string
        }
        // Locator and cost first: an oversized result is truncated in the log
        // and a trailing footer would be the first thing lost.
        const header = [
          `gpt-researcher deep research on ${JSON.stringify(args.query)}: ` +
            `${result.research_trace?.length ?? 0} traced queries, ${result.stats.sources} sources, ` +
            `~$${result.costs.total.toFixed(6)}, ${(result.stats.elapsed_ms / 1000).toFixed(1)}s`,
        ]
        if (result.report_path) header.push(`report written to ${result.report_path}`)
        for (const warning of result.warnings) header.push(`warning: ${warning}`)
        const body =
          result.report.trim().length > 0
            ? result.report.trim()
            : `Deep research on "${args.query}" produced no report text.`
        return [{ type: 'text', text: `${header.join('\n')}\n\n---\n\n${body}` }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: `gpt-researcher deep: ${args.query.slice(0, 70)}`,
      rawInput: { breadth: args.breadth, depth: args.depth, concurrency: args.concurrency },
    }),
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      const logger = createSessionLogger(exec)
      const setup = setupEngine({
        ctx: toolContext,
        exec,
        pluginConfig: config,
        overrides: {
          ...configOverridesFromArgs(args),
          ...(args.breadth === undefined ? {} : { DEEP_RESEARCH_BREADTH: args.breadth }),
          ...(args.depth === undefined ? {} : { DEEP_RESEARCH_DEPTH: args.depth }),
          ...(args.concurrency === undefined
            ? {}
            : { DEEP_RESEARCH_CONCURRENCY: args.concurrency }),
        },
        logger,
      })
      const researcher = new GptResearcher({
        deps: setup.deps,
        query: args.query,
        reportType: 'deep',
        ...(args.tone === undefined ? {} : { tone: args.tone as never }),
      })
      const outcome = await researcher.run()
      const projected = await projectOutcome(outcome, setup, {
        ...(args.output_path === undefined ? {} : { outputPath: args.output_path }),
        ...(args.write_artifacts === undefined ? {} : { writeArtifacts: args.write_artifacts }),
        ...(args.tone === undefined ? {} : { tone: args.tone }),
        elapsedMs: researcher.elapsedMs,
        warnings: logger.warnings,
      })
      const trace = (outcome.researchTrace ?? []) as DeepResearchNode[]
      return {
        ...projected,
        research_trace: trace.map((node) => ({
          query: node.query,
          depth: node.depth,
          learnings: node.learnings,
          followed_up_questions: node.followedUpQuestions,
          sources: node.sources,
        })),
        learnings: [...new Set(trace.flatMap((node) => node.learnings))],
      }
    },
  })
  return ctx.tools.register(tool as never)
}
