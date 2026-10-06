/**
 * Source curator skill — the port of `gpt_researcher/skills/curator.py`.
 *
 * One LLM call ranks the gathered sources by credibility and relevance and
 * returns a filtered list. Upstream parses with a strict `json.loads` and
 * returns the *original* source data when parsing fails; both behaviours are
 * kept, because a silently-empty curated list would be worse than no curation.
 *
 * @module gpt-researcher/skills/curator
 */

import type { GptResearcher } from '../agent.ts'
import { callLlm, isAbortError } from '../llm/call.ts'
import { parseJsonLoose } from '../utils/json.ts'

/** The curated source shape upstream's prompt asks for. */
export interface CuratedSource {
  Title: string
  Content: string
  Source: string
}

/** LLM-based source ranking. */
export class SourceCurator {
  readonly #agent: GptResearcher

  constructor(agent: GptResearcher) {
    this.#agent = agent
  }

  /**
   * Rank and filter sources (upstream `curate_sources`).
   *
   * @param sourceData - the gathered sources, as strings or documents.
   * @param maxResults - how many sources to keep.
   * @returns the curated sources, or `sourceData` unchanged when curation fails.
   */
  async curateSources(
    sourceData: unknown,
    maxResults = 10,
  ): Promise<CuratedSource[] | unknown> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'research_plan',
      message: '⚖️ Evaluating and curating sources by credibility and relevance...',
    })
    const sourceCount = Array.isArray(sourceData) ? sourceData.length : 1
    agent.deps.runtime.log.debug(`curating ${sourceCount} sources`)

    let response = ''
    try {
      const result = await callLlm(agent.deps, {
        tier: 'smart',
        messages: [
          { role: 'system', content: agent.role },
          {
            role: 'user',
            content: agent.deps.prompts.curate_sources(agent.query, sourceData, maxResults),
          },
        ],
        temperature: 0.2,
        maxTokens: 8000,
        step: 'research',
      })
      response = result.text

      // Upstream is strict here: `json.loads`, not `json_repair`. The strict
      // path is attempted first so a well-formed response behaves identically.
      let curated: unknown
      try {
        curated = JSON.parse(response) as unknown
      } catch {
        curated = parseJsonLoose(response)
      }
      if (!Array.isArray(curated)) {
        throw new Error('curate_sources response was not a JSON array')
      }
      const normalised = curated.map((item) => normaliseCurated(item))
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'research_plan',
        message: `🏅 Verified and ranked top ${normalised.length} most reliable sources`,
      })
      return normalised
    } catch (error) {
      if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
      agent.deps.runtime.log.warn(
        `source curation failed, keeping the original sources: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'research_plan',
        message: `🚫 Source verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      return sourceData
    }
  }
}

/** Coerce one curated entry into upstream's `{Title, Content, Source}` shape. */
function normaliseCurated(item: unknown): CuratedSource {
  if (typeof item === 'string') return { Title: '', Content: item, Source: '' }
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>
    return {
      Title: String(record.Title ?? record.title ?? ''),
      Content: String(record.Content ?? record.content ?? ''),
      Source: String(record.Source ?? record.source ?? record.url ?? ''),
    }
  }
  return { Title: '', Content: String(item), Source: '' }
}

/**
 * Render curated sources the way upstream's `researcher.context` ends up:
 * `Title: …\nContent: …\nSource: …` blocks joined by blank lines.
 *
 * @param curated - the curated list.
 * @returns the joined context string.
 */
export function curatedToContext(curated: readonly unknown[]): string {
  return curated
    .map((entry) => {
      const source = normaliseCurated(entry)
      return `Title: ${source.Title}\nContent: ${source.Content}\nSource: ${source.Source}`
    })
    .join('\n\n')
}
