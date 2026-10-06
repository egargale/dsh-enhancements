/**
 * `gptr_research` — the flagship tool: a complete research run that ends in a
 * report, exactly like upstream's `BasicReport.run()`.
 *
 * @module gpt-researcher/tools/research
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { GptResearcher } from '../agent.ts'
import { TONES } from '../types.ts'
import { REPORT_TYPES } from '../types.ts'
import {
  RESEARCH_OUTPUT_SCHEMA,
  configOverridesFromArgs,
  createSessionLogger,
  projectOutcome,
  renderResearchResult,
  reportTypeValue,
  setupEngine,
  type ResearchToolResult,
  type ToolContext,
} from './shared.ts'
import type { GptResearcherPluginConfig } from '../dsh/plugin-config.ts'

const TONE_NAMES = Object.keys(TONES)

/**
 * Register `gptr_research`.
 *
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 * @returns a disposer that unregisters the tool.
 */
export function registerResearchTool(
  ctx: { tools: { register(definition: never): () => void } },
  toolContext: ToolContext,
  config: GptResearcherPluginConfig | undefined,
): () => void {
  const tool = defineTool({
    name: 'gptr_research',
    description:
      'Run a full autonomous research task (the gpt-researcher pipeline) and return a cited report. ' +
      'Plans sub-queries with the strategic model, searches several retrievers, scrapes the sources, ' +
      'compresses the context, and writes the report. Use this when the user wants a researched, ' +
      'source-backed answer rather than a quick lookup. Reports are also written to disk.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The research question or task.',
      },
      report_type: {
        type: 'string',
        enum: REPORT_TYPES.filter((type) => type !== 'deep' && type !== 'subtopic_report'),
        description:
          'Report shape: research_report (default), resource_report (annotated links), ' +
          'outline_report (bullets), detailed_report (multi-section with subtopic research), ' +
          'custom_report (uses custom_prompt).',
      },
      tone: {
        type: 'string',
        enum: TONE_NAMES,
        description: 'Writing tone (default Objective).',
      },
      retrievers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Retriever names to use, in order. Defaults to the deployment configuration. ' +
          'Keyless options include dsh_web, duckduckgo, arxiv, semantic_scholar, pubmed_central.',
      },
      report_source: {
        type: 'string',
        enum: ['web', 'local', 'hybrid', 'static'],
        description: 'Where context comes from (default web).',
      },
      source_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Research these URLs instead of searching the web.',
      },
      query_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict the search to these domains.',
      },
      complement_source_urls: {
        type: 'boolean',
        description: 'Search the web in addition to source_urls.',
      },
      max_search_results: {
        type: 'integer',
        description: 'Results per query (default 5).',
      },
      max_iterations: {
        type: 'integer',
        description: 'Sub-queries to plan per query (default 3).',
      },
      total_words: {
        type: 'integer',
        description: 'Target report length in words (default 1200).',
      },
      language: { type: 'string', description: 'Report language (default english).' },
      report_format: {
        type: 'string',
        enum: ['APA', 'MLA', 'Chicago', 'Harvard', 'IEEE', 'markdown'],
        description: 'Citation format (default APA).',
      },
      curate_sources: {
        type: 'boolean',
        description: 'Have the model rank and filter sources before writing (default false).',
      },
      custom_prompt: {
        type: 'string',
        description: 'Replaces the report prompt for report_type=custom_report.',
      },
      output_path: {
        type: 'string',
        description: 'Write the report to this exact path instead of the default outputs directory.',
      },
      write_artifacts: {
        type: 'boolean',
        description: 'Write the report + sources to disk (default true).',
      },
    },
    output: {
      schema: RESEARCH_OUTPUT_SCHEMA,
      render: (_args, value) => renderResearchResult(value as ResearchToolResult),
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: `gpt-researcher: ${args.query.slice(0, 80)}`,
      rawInput: {
        report_type: args.report_type ?? 'research_report',
        retrievers: args.retrievers,
        tone: args.tone,
      },
    }),
    isConcurrencySafe: () => false,
    timeoutMs: 30 * 60 * 1000,
    async execute(args, exec) {
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
        ...(args.source_urls === undefined ? {} : { sourceUrls: args.source_urls }),
        ...(args.query_domains === undefined ? {} : { queryDomains: args.query_domains }),
        ...(args.report_source === undefined
          ? {}
          : { reportSource: args.report_source as never }),
        complementSourceUrls: args.complement_source_urls ?? false,
      })
      const outcome = await researcher.run(
        args.custom_prompt === undefined ? {} : { customPrompt: args.custom_prompt },
      )
      return projectOutcome(outcome, setup, {
        ...(args.output_path === undefined ? {} : { outputPath: args.output_path }),
        ...(args.write_artifacts === undefined ? {} : { writeArtifacts: args.write_artifacts }),
        ...(args.tone === undefined ? {} : { tone: args.tone }),
        elapsedMs: researcher.elapsedMs,
        warnings: logger.warnings,
      })
    },
  })
  return ctx.tools.register(tool as never)
}
