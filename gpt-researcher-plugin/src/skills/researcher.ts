/**
 * Research conductor skill — the port of
 * `gpt_researcher/skills/researcher.py`, minus the MCP retriever branch
 * (a DSH deployment reaches MCP tools natively, so the plugin does not
 * re-implement an MCP client).
 *
 * This is the pipeline's core loop:
 *
 * 1. choose an agent role (unless one was supplied),
 * 2. gather context according to `report_type` + `report_source`,
 * 3. optionally curate the sources,
 * 4. store the context on the researcher and return it.
 *
 * Web gathering is two-level: plan sub-queries with the strategic model, then
 * for each sub-query harvest URLs from *all* configured retrievers, scrape the
 * new ones concurrently, and compress the scraped documents down to the text
 * most relevant to that sub-query.
 *
 * @module gpt-researcher/skills/researcher
 */

import type { GptResearcher } from '../agent.ts'
import { chooseAgent } from '../actions/agent-creator.ts'
import { getSearchResults, planResearchOutline } from '../actions/query-processing.ts'
import { isAbortError } from '../llm/call.ts'
import type { DocumentLoaderDefinition } from '../document/base.ts'
import { curatedToContext } from './curator.ts'
import type { SearchResult, ScrapedContent } from '../types.ts'
import { dedupeStrings } from '../utils/json.ts'
import { resultBody, resultUrl } from '../types.ts'
import { WorkerPool } from '../utils/workers.ts'

/** The two-level research loop. */
export class ResearchConductor {
  readonly #agent: GptResearcher

  constructor(agent: GptResearcher) {
    this.#agent = agent
  }

  /**
   * Plan sub-queries for a query (upstream `plan_research`): a seed search with
   * the *first* configured retriever informs the strategic model.
   *
   * @param query - the query (or sub-query) to plan for.
   * @param queryDomains - optional domain restriction.
   * @returns the planned sub-queries.
   */
  async planResearch(query: string, queryDomains: readonly string[] = []): Promise<string[]> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'planning_research',
      message: `🌐 Browsing the web to learn more about the task: ${query}...`,
    })

    const seed = agent.retrievers.definitions[0]
    let searchResults: SearchResult[] = []
    if (seed) {
      searchResults = await getSearchResults(seed, agent.retrievers.context, query, {
        queryDomains: [...queryDomains],
      })
    }
    agent.deps.runtime.log.info(`initial search results obtained: ${searchResults.length}`)

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'planning_research',
      message: '🤔 Planning the research strategy and subtasks...',
    })

    const outline = await planResearchOutline(agent.deps, {
      query,
      parentQuery: agent.parentQuery,
      reportType: agent.reportType,
      searchResults,
      retrieverNames: agent.retrievers.definitions.map((definition) => definition.name),
    })
    agent.deps.runtime.log.info(`research outline planned: ${outline.join(' | ')}`)
    return outline
  }

  /**
   * Run the research step (upstream `conduct_research`).
   *
   * @returns the gathered context.
   */
  async conductResearch(): Promise<string> {
    const agent = this.#agent
    agent.visitedUrls.clear()
    let researchData: string | string[] = []

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'starting_research',
      message: `🔍 Starting the research task for '${agent.query}'...`,
    })

    if (!agent.agentName || !agent.role) {
      agent.deps.costs.setStep('agent_selection')
      const choice = await chooseAgent(agent.deps, {
        query: agent.query,
        ...(agent.parentQuery ? { parentQuery: agent.parentQuery } : {}),
      })
      agent.agentName = choice.server
      agent.role = choice.agentRolePrompt
    }
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'agent_generated',
      message: agent.agentName,
    })

    agent.deps.costs.setStep('research')
    const cfg = agent.deps.config

    if (agent.sourceUrls.length > 0) {
      agent.deps.runtime.log.info('using provided source URLs')
      let context = await this.#getContextByUrls(agent.sourceUrls)
      if (!context) {
        agent.deps.runtime.progress({
          type: 'logs',
          step: 'answering_from_memory',
          message: '🧐 I was unable to find relevant context in the provided sources...',
        })
        context = await this.#answerFromMemory()
      }
      researchData = context
      if (agent.complementSourceUrls) {
        agent.deps.runtime.log.info('complementing with web search')
        const additional = await this.#getContextByWebSearch(agent.query, [], agent.queryDomains)
        researchData = `${researchData} ${additional}`
      }
    } else if (agent.reportSource === 'web') {
      agent.deps.runtime.log.info('using web search with all configured retrievers')
      researchData = await this.#getContextByWebSearch(agent.query, [], agent.queryDomains)
    } else if (agent.reportSource === 'local') {
      const documentData = await agent.loadDocuments('local', { source: cfg.docPath })
      if (agent.vectorStore) await agent.vectorStore.load(documentData.map(toScraped))
      researchData = await this.#getContextByWebSearch(
        agent.query,
        documentData.map(toScraped),
        agent.queryDomains,
      )
    } else if (agent.reportSource === 'hybrid') {
      const documentData =
        agent.documentUrls.length > 0
          ? await agent.loadDocuments('online', { source: agent.documentUrls })
          : await agent.loadDocuments('local', { source: cfg.docPath })
      if (agent.vectorStore) await agent.vectorStore.load(documentData.map(toScraped))
      const docsContext = await this.#getContextByWebSearch(
        agent.query,
        documentData.map(toScraped),
        agent.queryDomains,
      )
      const webContext = await this.#getContextByWebSearch(agent.query, [], agent.queryDomains)
      researchData = agent.deps.prompts.join_local_web_documents(docsContext, webContext)
    } else if (agent.reportSource === 'azure') {
      const azureFiles = await agent.loadDocuments('azure', {})
      const documentData = await agent.loadDocuments('local', {
        documents: azureFiles.map(toScraped),
      })
      researchData = await this.#getContextByWebSearch(
        agent.query,
        documentData.map(toScraped),
      )
    } else if (agent.reportSource === 'langchain_documents') {
      const documentData = await agent.loadDocuments('documents', {
        documents: agent.documents,
      })
      if (agent.vectorStore) await agent.vectorStore.load(documentData.map(toScraped))
      researchData = await this.#getContextByWebSearch(
        agent.query,
        documentData.map(toScraped),
        agent.queryDomains,
      )
    } else if (agent.reportSource === 'langchain_vectorstore') {
      researchData = await this.#getContextByVectorstore(agent.query, agent.vectorStoreFilter)
    } else if (agent.reportSource === 'static') {
      researchData = agent.context
    }

    agent.context = Array.isArray(researchData) ? researchData.join(' ') : researchData

    if (cfg.curateSources) {
      agent.deps.runtime.log.info('curating sources')
      const curated = await agent.sourceCurator.curateSources(agent.context, 10)
      // Upstream: a list result replaces the context with `Title/Content/Source`
      // blocks; anything else (including the original data on failure) is used
      // as-is.
      agent.context = Array.isArray(curated) ? curatedToContext(curated) : String(curated)
      agent.applyCuratedSources(curated)
    }

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'research_step_finalized',
      message: `Finalized research step.\n💸 Total Research Costs: $${agent.getCosts()}`,
    })
    agent.deps.runtime.log.info(`research completed. context size: ${agent.context.length}`)
    return agent.context
  }

  async #answerFromMemory(): Promise<string> {
    const agent = this.#agent
    if (agent.context.length > 0) return agent.context
    return ''
  }

  async #getContextByUrls(urls: readonly string[]): Promise<string> {
    const agent = this.#agent
    const newUrls = await this.getNewUrls(urls)
    const scraped = await agent.scraperManager.browseUrls(newUrls)
    if (agent.vectorStore) await agent.vectorStore.load(scraped)
    return agent.contextManager.getSimilarContentByQuery(agent.query, scraped)
  }

  async #getContextByVectorstore(
    query: string,
    filter?: Record<string, unknown>,
  ): Promise<string[]> {
    const agent = this.#agent
    const subQueries = await this.planResearch(query)
    if (agent.reportType !== 'subtopic_report') subQueries.push(query)
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'subqueries',
      message: `🗂️  I will conduct my research based on the following queries: ${subQueries.join(', ')}...`,
      data: subQueries,
    })
    return Promise.all(
      subQueries.map((subQuery) =>
        agent.contextManager.getSimilarContentByQueryWithVectorstore(subQuery, filter),
      ),
    )
  }

  async #getContextByWebSearch(
    query: string,
    scrapedData: ScrapedContent[] = [],
    queryDomains: readonly string[] = [],
  ): Promise<string> {
    const agent = this.#agent
    agent.deps.runtime.log.info(`starting web search for query: ${query}`)

    const subQueries = await this.planResearch(query, queryDomains)
    agent.deps.runtime.log.info(`generated sub-queries: ${subQueries.join(' | ')}`)
    if (agent.reportType !== 'subtopic_report') subQueries.push(query)

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'subqueries',
      message: `🗂️ I will conduct my research based on the following queries: ${subQueries.join(', ')}...`,
      data: subQueries,
    })

    try {
      const contexts = await Promise.all(
        subQueries.map(async (subQuery) =>
          this.processSubQuery(subQuery, scrapedData, queryDomains),
        ),
      )
      const nonEmpty = contexts.filter((context) => context.length > 0)
      return nonEmpty.length > 0 ? nonEmpty.join(' ') : ''
    } catch (error) {
      if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
      agent.deps.runtime.log.error(
        `error during web search: ${error instanceof Error ? error.message : String(error)}`,
      )
      return ''
    }
  }

  /**
   * Scrape and compress one sub-query (upstream `_process_sub_query`).
   *
   * @param subQuery - the sub-query.
   * @param scrapedData - documents already gathered (local/hybrid sources).
   * @param queryDomains - optional domain restriction.
   * @returns the compressed context for the sub-query.
   */
  async processSubQuery(
    subQuery: string,
    scrapedData: ScrapedContent[] = [],
    queryDomains: readonly string[] = [],
  ): Promise<string> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'running_subquery_research',
      message: `\n🔍 Running research for '${subQuery}'...`,
    })

    try {
      let scraped = scrapedData
      if (scraped.length === 0) {
        scraped = await this.scrapeDataByUrls(subQuery, queryDomains)
        agent.deps.runtime.log.info(`scraped data size: ${scraped.length}`)
      }
      if (scraped.length === 0) {
        agent.deps.runtime.progress({
          type: 'logs',
          step: 'subquery_context_not_found',
          message: `🤷 No content found for '${subQuery}'...`,
        })
        return ''
      }
      const context = await agent.contextManager.getSimilarContentByQuery(subQuery, scraped)
      if (context.length === 0) {
        agent.deps.runtime.log.warn(`no context found for sub-query: ${subQuery}`)
      } else {
        agent.deps.runtime.progress({
          type: 'logs',
          step: 'context_combined',
          message: `📚 Combined research context for '${subQuery}' (${context.length} chars)`,
        })
      }
      return context
    } catch (error) {
      if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
      agent.deps.runtime.log.error(
        `error processing sub-query ${subQuery}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'subquery_error',
        message: `❌ Error processing '${subQuery}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      return ''
    }
  }

  /**
   * Record new URLs and return them (upstream `_get_new_urls`).
   *
   * @param urls - candidate URLs.
   * @returns the URLs not yet visited.
   */
  async getNewUrls(urls: Iterable<string>): Promise<string[]> {
    const agent = this.#agent
    const newUrls: string[] = []
    for (const url of urls) {
      if (agent.visitedUrls.has(url)) continue
      agent.visitedUrls.add(url)
      newUrls.push(url)
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'added_source_url',
        message: `✅ Added source url to research: ${url}\n`,
        data: url,
      })
    }
    return newUrls
  }

  /**
   * Harvest URLs from every configured retriever (upstream
   * `_search_relevant_source_urls`), keeping content that a retriever already
   * fetched so it is not scraped twice.
   *
   * @param query - the sub-query.
   * @param queryDomains - optional domain restriction.
   * @returns new URLs to scrape, plus prefetched documents.
   */
  async searchRelevantSourceUrls(
    query: string,
    queryDomains: readonly string[] = [],
  ): Promise<{ urls: string[]; prefetched: ScrapedContent[] }> {
    const agent = this.#agent
    const collected: string[] = []
    const prefetched: ScrapedContent[] = []

    for (const definition of agent.retrievers.definitions) {
      if (definition.name.toLowerCase().includes('mcp')) continue
      try {
        const results = await getSearchResults(definition, agent.retrievers.context, query, {
          queryDomains: [...queryDomains],
        })
        for (const result of results) {
          const url = resultUrl(result)
          const rawContent = resultBody(result)
          if (url && rawContent && rawContent.length > 100) {
            // Retriever already returned the full text (e.g. PubMed Central).
            prefetched.push({
              url,
              raw_content: rawContent,
              ...(result.title === undefined ? {} : { title: result.title }),
              ...(definition.name === undefined ? {} : { source_type: definition.name }),
            })
            agent.addResearchSources([{ url, raw_content: rawContent }])
          } else if (url) {
            collected.push(url)
          }
        }
      } catch (error) {
        if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
        agent.deps.runtime.log.error(
          `error searching with ${definition.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    const urls = await this.getNewUrls(dedupeStrings(collected))
    return { urls, prefetched }
  }

  /**
   * Search + scrape for one sub-query (upstream `_scrape_data_by_urls`).
   *
   * @param subQuery - the sub-query.
   * @param queryDomains - optional domain restriction.
   * @returns the scraped documents.
   */
  async scrapeDataByUrls(
    subQuery: string,
    queryDomains: readonly string[] = [],
  ): Promise<ScrapedContent[]> {
    const agent = this.#agent
    const { urls, prefetched } = await this.searchRelevantSourceUrls(subQuery, queryDomains)

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'researching',
      message: '🤔 Researching for relevant information across multiple sources...\n',
    })

    const scraped = await agent.scraperManager.browseUrls(urls)
    scraped.push(...prefetched)
    if (agent.vectorStore) await agent.vectorStore.load(scraped)
    return scraped
  }

  /**
   * Load documents through the configured loader (upstream's `DocumentLoader`
   * branches).
   *
   * @param loaderName - registry name of the loader.
   * @param request - loader inputs.
   * @returns loaded documents.
   */
  async loadDocuments(
    loaderName: string,
    request: Parameters<DocumentLoaderDefinition['load']>[1],
  ): Promise<ScrapedContent[]> {
    return this.#agent.loadDocuments(loaderName, request)
  }
}

/** A pooled bulk search, exposed for callers that need many sub-queries at once. */
export function createSearchPool(concurrency: number): WorkerPool {
  return new WorkerPool(concurrency)
}

/** Narrow a loader result to the scraped-content shape. */
function toScraped(document: ScrapedContent): ScrapedContent {
  return document
}
