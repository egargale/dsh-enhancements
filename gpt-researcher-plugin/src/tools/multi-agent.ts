/**
 * `gptr_multi_agent_research` — the multi-agent flow (upstream `multi_agents/`):
 * a chief editor orchestrates initial research, an editor plans sections,
 * parallel section researchers draft each one under review/revision, and a
 * publisher assembles the final document.
 *
 * @module gpt-researcher/tools/multi-agent
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { GptResearcherPluginConfig } from '../dsh/plugin-config.ts'
import { TONES } from '../types.ts'
import {
  configOverridesFromArgs,
  createSessionLogger,
  setupEngine,
  type ToolContext,
} from './shared.ts'

const TONE_NAMES = Object.keys(TONES)

/**
 * Register `gptr_multi_agent_research`.
 *
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 * @returns a disposer that unregisters the tool.
 */
export function registerMultiAgentTool(
  ctx: { tools: { register(definition: never): () => void } },
  toolContext: ToolContext,
  config: GptResearcherPluginConfig | undefined,
): () => void {
  const tool = defineTool({
    name: 'gptr_multi_agent_research',
    description:
      'Run the multi-agent research pipeline: an orchestrator does initial research, an editor plans ' +
      'the section outline, each section is researched and then reviewed and revised in a loop, and a ' +
      'publisher assembles the final report. Slower than gptr_research but produces a longer, ' +
      'editorially reviewed document. Runs unattended: it does not pause for feedback.',
    parameters: {
      query: { type: 'string', required: true, description: 'The research topic.' },
      max_sections: {
        type: 'integer',
        description: 'Maximum number of section headers the editor may plan (default 5).',
      },
      tone: { type: 'string', enum: TONE_NAMES, description: 'Writing tone (default Objective).' },
      follow_guidelines: {
        type: 'boolean',
        description: 'Ask the writer to follow the supplied style guidelines (default true).',
      },
      guidelines: {
        type: 'string',
        description: 'Editorial guidelines the writer must follow.',
      },
      retrievers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Retriever names for the initial research; defaults to the configuration.',
      },
      output_path: { type: 'string', description: 'Exact path for the written report.' },
      write_artifacts: { type: 'boolean', description: 'Write the report to disk (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          title: { type: 'string' },
          report: { type: 'string' },
          report_path: { type: 'string' },
          sections: { type: 'json' },
          costs: { type: 'json' },
          stats: { type: 'json' },
          warnings: { type: 'json' },
        },
      },
      render: (args, value) => {
        const result = value as {
          report: string
          title: string
          sections: string[]
          costs: { total: number }
          stats: { elapsed_ms: number; sources: number; sections: number }
          report_path?: string
          warnings: string[]
        }
        const header = [
          `gpt-researcher multi-agent: ${JSON.stringify(result.title || args.query)} with ` +
            `${result.sections.length} sections, ~$${result.costs.total.toFixed(6)}, ` +
            `${(result.stats.elapsed_ms / 1000).toFixed(1)}s`,
        ]
        if (result.report_path) header.push(`report written to ${result.report_path}`)
        for (const warning of result.warnings) header.push(`warning: ${warning}`)
        const body =
          result.report.trim().length > 0
            ? result.report.trim()
            : `The multi-agent run for "${args.query}" produced no document.`
        return [{ type: 'text', text: `${header.join('\n')}\n\n---\n\n${body}` }]
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'search',
      title: `gpt-researcher multi-agent: ${args.query.slice(0, 60)}`,
      rawInput: { max_sections: args.max_sections },
    }),
    timeoutMs: 60 * 60 * 1000,
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
      const { ChiefEditorAgent } = await import('../multi-agents/index.ts')
      const agent = new ChiefEditorAgent(
        setup.deps,
        {
          query: args.query,
          // Upstream's task.json supplies a model name; this port routes every
          // tier through the session model, so the resolved model is recorded
          // for the prompt-compatible `model` field.
          model: setup.routes.strategic.model,
          max_sections: args.max_sections ?? 5,
          include_human_feedback: false,
          follow_guidelines: args.follow_guidelines ?? true,
          guidelines: args.guidelines === undefined ? [] : [args.guidelines],
          ...(args.tone === undefined ? {} : { tone: args.tone as never }),
        },
        {},
      )
      const result = await agent.runResearchTask()
      const report = result.report
      const shouldWrite = args.write_artifacts ?? setup.pluginConfig.writeArtifacts
      const { writeArtifacts } = await import('./artifacts.ts')
      const artifacts = shouldWrite
        ? await writeArtifacts(
            {
              query: args.query,
              reportType: 'multi_agent_report',
              report,
              sources: [],
              visitedUrls: [],
              context: '',
              costs: setup.deps.costs.report(),
            },
            {
              outputDir: setup.pluginConfig.outputDir,
              cwd: process.cwd(),
              ...(args.output_path === undefined ? {} : { outputPath: args.output_path }),
              writeSources: false,
            },
          )
        : {}
      return {
        ok: report.trim().length > 0,
        query: args.query,
        title: result.title,
        report,
        ...(artifacts.reportPath === undefined ? {} : { report_path: artifacts.reportPath }),
        sections: result.sections,
        costs: {
          total: setup.deps.costs.getCosts(),
          per_step: setup.deps.costs.getStepCosts(),
          currency: 'USD',
        },
        stats: {
          elapsed_ms: Date.now() - started,
          sections: result.sections.length,
          sources: result.sources.length,
          model: setup.routes.strategic.model,
        },
        warnings: [
          ...logger.warnings,
          ...(artifacts.warning === undefined ? [] : [artifacts.warning]),
        ],
      }
    },
  })
  return ctx.tools.register(tool as never)
}
