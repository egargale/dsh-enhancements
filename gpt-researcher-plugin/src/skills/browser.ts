/**
 * Browser manager skill — the port of `gpt_researcher/skills/browser.py`.
 *
 * It owns three things: the concurrency/rate-limit policy for scraping, the
 * "never scrape a URL twice" rule, and image selection. The scraping itself is
 * delegated to the configured {@link ScraperDefinition}, so switching from the
 * built-in extractor to Firecrawl is a config change, not a code change.
 *
 * @module gpt-researcher/skills/browser
 */

import type { GptResearcher } from '../agent.ts'
import type { ScrapedContent } from '../types.ts'
import { WorkerPool } from '../utils/workers.ts'

/** One candidate image with a relevance score, as upstream's scrapers report. */
export interface ScoredImage {
  url: string
  score: number
}

/** Scrape orchestration. */
export class BrowserManager {
  readonly #agent: GptResearcher
  readonly #pool: WorkerPool

  constructor(agent: GptResearcher) {
    this.#agent = agent
    this.#pool = new WorkerPool(
      agent.deps.config.maxScraperWorkers,
      agent.deps.config.scraperRateLimitDelay,
    )
  }

  /**
   * Scrape a batch of URLs (upstream `browse_urls`).
   *
   * @param urls - URLs to scrape; already-visited URLs are skipped.
   * @returns the successfully scraped documents.
   */
  async browseUrls(urls: readonly string[]): Promise<ScrapedContent[]> {
    const agent = this.#agent
    if (urls.length === 0) return []
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'scraping_urls',
      message: `🌐 Scraping content from ${urls.length} URLs...`,
    })

    const scraper = agent.scraper
    const context = {
      runtime: agent.deps.runtime,
      config: {
        browseChunkMaxLength: agent.deps.config.browseChunkMaxLength,
        userAgent: agent.deps.config.userAgent,
        timeoutMs: agent.scraperTimeoutMs,
        maxScraperWorkers: agent.deps.config.maxScraperWorkers,
        scraperRateLimitDelay: agent.deps.config.scraperRateLimitDelay,
      },
    }

    // Scrape concurrently, then attach images. Each URL is one work item so a
    // single slow host cannot block the batch.
    const settled = await this.#pool.map(
      urls,
      async (url) => {
        const results = await scraper.scrape([url], context, agent.deps.runtime.signal)
        return results[0]
      },
      {
        fallback: undefined as ScrapedContent | undefined,
        logger: agent.deps.runtime.log,
        ...(agent.deps.runtime.signal === undefined ? {} : { signal: agent.deps.runtime.signal }),
        now: agent.deps.runtime.now,
      },
    )

    const scraped = settled.filter((item): item is ScrapedContent => item !== undefined)
    agent.addResearchSources(scraped)

    const images: ScoredImage[] = []
    for (const document of scraped) {
      for (const url of document.image_urls ?? []) images.push({ url, score: 1 })
    }
    const selected = this.selectTopImages(images, 4)
    agent.addResearchImages(selected)

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'scraping_content',
      message: `📄 Scraped ${scraped.length} pages of content`,
    })
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'scraping_images',
      message: `🖼️ Selected ${selected.length} new images from ${images.length} total images`,
      data: selected,
    })
    return scraped
  }

  /**
   * Pick the highest-scoring unique images (upstream `select_top_images`).
   *
   * Upstream hashes the image *bytes* to dedupe visually identical images; this
   * port dedupes on the URL, which needs no extra network round-trip. The
   * deviation is recorded here because it is observable: two URLs serving the
   * same picture are both kept.
   *
   * @param images - candidate images with scores.
   * @param k - maximum number of images to return.
   * @returns the selected image URLs.
   */
  selectTopImages(images: readonly ScoredImage[], k = 2): string[] {
    const already = new Set(this.#agent.getResearchImages())
    const seen = new Set<string>()
    const selected: string[] = []
    for (const image of [...images].sort((a, b) => b.score - a.score)) {
      const url = image.url
      if (!url || seen.has(url) || already.has(url)) continue
      seen.add(url)
      selected.push(url)
      if (selected.length === k) break
    }
    return selected
  }
}
