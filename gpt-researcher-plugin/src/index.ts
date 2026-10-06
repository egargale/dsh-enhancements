/**
 * DSH plugin entry: a faithful TypeScript port of
 * [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher)
 * as native harness tools.
 *
 * What the plugin adds to a session:
 *
 * | tool | upstream equivalent |
 * |---|---|
 * | `gptr_research` | `GPTResearcher.conduct_research()` + `write_report()` (all non-deep report types) |
 * | `gptr_deep_research` | `ReportType.DeepResearch` / `DeepResearchSkill` |
 * | `gptr_multi_agent_research` | `multi_agents/` LangGraph flow |
 * | `gptr_quick_search` | `GPTResearcher.quick_search()` |
 * | `gptr_write_report` | `write_report(ext_context=…)` |
 * | `gptr_search_sources` | the retriever layer (`actions/retriever.py`) |
 * | `gptr_get_subtopics` | `get_subtopics()` / `construct_subtopics` |
 * | `gptr_capabilities` | configuration/credential introspection |
 *
 * Mount it by inserting this package into a DSH profile patch; see README.md.
 *
 * @module gpt-researcher
 */

import type { Context } from '@deepseek-ai/cordis'

import { PluginConfigSchema, type GptResearcherPluginConfig } from './dsh/plugin-config.ts'
import { resolveOptionalService, type WebServiceLike } from './dsh/session.ts'
import type { LlmStreamService } from './dsh/chat-client.ts'
import type { ToolContext } from './tools/shared.ts'
import { registerDeepResearchTool } from './tools/deep-research.ts'
import { registerMultiAgentTool } from './tools/multi-agent.ts'
import { registerReportTools } from './tools/report-tools.ts'
import { registerResearchTool } from './tools/research.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'gpt-researcher'

/** Services this plugin requires before `apply` runs. */
export const inject = ['tools']

/** Loader schema for the plugin configuration. */
export const Config = PluginConfigSchema

/**
 * Register every gpt-researcher tool.
 *
 * @param ctx - the cordis context, with `ctx.tools` (and ideally `ctx.llm`
 *   plus `ctx.web`) mounted.
 * @param config - the plugin configuration; every field is optional.
 */
export function apply(ctx: Context, config: GptResearcherPluginConfig = {}): void {
  // `llm` and `web` are resolved lazily per call through `ctx.reflect.get`, so
  // the plugin loads even when a deployment omits either capability, and picks
  // up a provider that is mounted after this plugin.
  const tools = ctx as unknown as { tools: { register(definition: never): () => void } }
  const toolContext: ToolContext = {
    get llm(): LlmStreamService | undefined {
      return resolveOptionalService<LlmStreamService>(ctx, 'llm')
    },
    get web(): WebServiceLike | undefined {
      return resolveOptionalService<WebServiceLike>(ctx, 'web')
    },
  }

  ctx.effect(function* registerGptResearcherTools() {
    yield registerResearchTool(tools, toolContext, config)
    yield registerDeepResearchTool(tools, toolContext, config)
    yield registerReportTools(tools, toolContext, config)
    yield registerMultiAgentTool(tools, toolContext, config)
  }, 'gpt-researcher tools')
}

export { GptResearcher } from './agent.ts'
export { Config as EngineConfig, DEFAULT_CONFIG } from './config.ts'
export type { EngineDeps } from './deps.ts'
export type { ResearchOutcome, ReportType, Tone, ReportSource } from './types.ts'
export { createRetrieverRegistry } from './retrievers/index.ts'
export { createScraperRegistry } from './scraper/index.ts'
export { createEmbeddingsRegistry } from './embeddings/index.ts'
export { createVectorStoreRegistry } from './vector_store/index.ts'
export { createDocumentLoaderRegistry } from './document/index.ts'
