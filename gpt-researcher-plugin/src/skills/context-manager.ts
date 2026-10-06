/**
 * Context manager skill — the port of
 * `gpt_researcher/skills/context_manager.py`.
 *
 * It is deliberately thin: every method here is a policy choice (how many
 * results, which compressor, which threshold) wrapped around the compression
 * module. Keeping it separate means the "how much context" question is answered
 * in one readable place.
 *
 * @module gpt-researcher/skills/context-manager
 */

import type { GptResearcher } from '../agent.ts'
import {
  ContextCompressor,
  VectorstoreCompressor,
  WrittenContentCompressor,
  type CompressorDocument,
} from '../context/compression.ts'
import type { ContextEntry } from '../types.ts'
import { contextSize } from '../utils/workers.ts'

/** Retrieval and compression of research context. */
export class ContextManager {
  readonly #agent: GptResearcher

  constructor(agent: GptResearcher) {
    this.#agent = agent
  }

  /**
   * Find the content most relevant to a query (upstream
   * `get_similar_content_by_query`).
   *
   * @param query - the (sub-)query.
   * @param pages - scraped documents to search.
   * @returns the compressed context string.
   */
  async getSimilarContentByQuery(
    query: string,
    pages: readonly CompressorDocument[],
    maxResults = 10,
  ): Promise<string> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'fetching_query_content',
      message: `📚 Getting relevant content based on query: ${query}...`,
    })
    const compressor = new ContextCompressor({
      documents: pages,
      embeddings: agent.embeddings,
      prompts: agent.deps.prompts,
      runtime: agent.deps.runtime,
      options: {
        maxResults,
        similarityThreshold: agent.similarityThreshold,
        compressionThreshold: agent.compressionThreshold,
      },
    })
    return compressor.asyncGetContext(query, {
      maxResults,
      chargeCost: (usd) => agent.addCosts(usd),
    })
  }

  /**
   * Find content in the user-supplied vector store (upstream
   * `get_similar_content_by_query_with_vectorstore`).
   *
   * @param query - the (sub-)query.
   * @param filter - optional metadata filter.
   * @returns the compressed context string.
   */
  async getSimilarContentByQueryWithVectorstore(
    query: string,
    filter?: Record<string, unknown>,
  ): Promise<string> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'fetching_query_format',
      message: ` Getting relevant content based on query: ${query}...`,
    })
    if (!agent.vectorStore) {
      throw new Error(
        'report_source requires a vector store, but none is configured (MEMORY_BACKEND)',
      )
    }
    const compressor = new VectorstoreCompressor({
      vectorStore: agent.vectorStore,
      prompts: agent.deps.prompts,
      ...(filter === undefined ? {} : { filter }),
    })
    return compressor.asyncGetContext(query, { maxResults: 8 })
  }

  /**
   * Find previously written sections relevant to a subtopic (upstream
   * `get_similar_written_contents_by_draft_section_titles`).
   *
   * @param currentSubtopic - the subtopic being written.
   * @param draftSectionTitles - candidate section titles.
   * @param writtenContents - sections already written.
   * @param maxResults - cap on returned sections.
   * @returns the relevant written sections.
   */
  async getSimilarWrittenContentsByDraftSectionTitles(
    currentSubtopic: string,
    draftSectionTitles: readonly string[],
    writtenContents: readonly Record<string, unknown>[],
    maxResults = 10,
  ): Promise<string[]> {
    const agent = this.#agent
    const deduped = dedupeWrittenContents(writtenContents)
    if (deduped.length === 0) return []
    const perQuery = await Promise.all(
      [currentSubtopic, ...draftSectionTitles].map((query) =>
        this.#similarWrittenByQuery(query, deduped, 0.5, maxResults),
      ),
    )
    const union = new Set<string>()
    for (const list of perQuery) for (const item of list) union.add(item)
    return [...union].slice(0, maxResults)
  }

  async #similarWrittenByQuery(
    query: string,
    writtenContents: readonly Record<string, unknown>[],
    similarityThreshold: number,
    maxResults: number,
  ): Promise<string[]> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'fetching_relevant_written_content',
      message: `🔎 Getting relevant written content based on query: ${query}...`,
    })
    const compressor = new WrittenContentCompressor({
      documents: writtenContents,
      embeddings: agent.embeddings,
      similarityThreshold,
    })
    return compressor.asyncGetContext(query, {
      maxResults,
      chargeCost: (usd) => agent.addCosts(usd),
    })
  }

  /**
   * Normalise a mixed context (strings, dicts, lists) into
   * {@link ContextEntry}s — upstream's `_hashable_context` equivalent.
   *
   * @param input - the context to normalise.
   * @returns deterministic entries, de-duplicated.
   */
  normaliseContext(input: unknown): ContextEntry[] {
    const raw = Array.isArray(input) ? input : input == null ? [] : [input]
    const entries: ContextEntry[] = []
    const seen = new Set<string>()
    let index = 0
    for (const item of raw) {
      index += 1
      if (typeof item === 'string') {
        const key = item
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({ Title: `Source ${index}`, Content: item, Source: '' })
        continue
      }
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        const title = String(record.title ?? record.Title ?? `Source ${index}`)
        const source = String(record.url ?? record.Source ?? record.source ?? '')
        const content = String(
          record.content ?? record.Content ?? record.body ?? record.raw_content ?? '',
        )
        const key = `${source}\u0000${content}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({ Title: title, Content: content, Source: source })
      }
    }
    return entries
  }

  /** Character size of a mixed context, for diagnostics. */
  size(input: unknown): number {
    return contextSize(input)
  }
}

/** De-duplicate written sections by their content hash, preserving order. */
function dedupeWrittenContents(
  writtenContents: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  const seen = new Set<string>()
  const out: Array<Record<string, unknown>> = []
  for (const section of writtenContents) {
    if (!section || typeof section !== 'object') continue
    const key = JSON.stringify(section)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(section)
  }
  return out
}
