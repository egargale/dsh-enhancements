/**
 * Scraper contract and registry.
 *
 * Upstream `scraper/scraper.py` picks one scraper class from the configured
 * names (`bs`, `firecrawl`, `tavily_extract`, …) and calls `scrape(urls)`.
 * The default `bs` scraper uses BeautifulSoup plus a per-site handler table;
 * this port mirrors the handler table with a deterministic HTML-to-text
 * extractor ({@link file://./html.ts}).
 *
 * @module gpt-researcher/scraper/base
 */

import type { Runtime } from '../runtime.ts'
import type { ScrapedContent } from '../types.ts'

/** Everything a scraper may use. */
export interface ScraperContext {
  runtime: Runtime
  config: ScraperConfig
}

/** The configuration surface scrapers read. */
export interface ScraperConfig {
  /** `BROWSE_CHUNK_MAX_LENGTH`: cap on extracted text per document. */
  browseChunkMaxLength: number
  userAgent: string
  timeoutMs: number
  /** `MAX_SCRAPER_WORKERS`: concurrency bound. */
  maxScraperWorkers: number
  /** `SCRAPER_RATE_LIMIT_DELAY`: minimum seconds between requests. */
  scraperRateLimitDelay: number
}

/** One scraper implementation. */
export interface ScraperDefinition {
  /** Registry name, as used in `SCRAPER=`. */
  name: string
  /** Environment variables required before the scraper can run. */
  keys: string[]
  keyless: boolean
  description: string
  /**
   * Fetch and extract the given URLs.
   *
   * Implementations must not throw for a single failing URL: upstream logs and
   * continues, so a partial result is the contract.
   *
   * @param urls - absolute URLs to scrape.
   * @param ctx - injected runtime and config.
   * @param signal - run cancellation.
   * @returns one entry per successfully scraped URL, in completion order.
   */
  scrape(
    urls: readonly string[],
    ctx: ScraperContext,
    signal?: AbortSignal,
  ): Promise<ScrapedContent[]>
}

/** The registry of available scrapers. */
export class ScraperRegistry {
  private readonly definitions = new Map<string, ScraperDefinition>()

  constructor(definitions: readonly ScraperDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: ScraperDefinition): void {
    this.definitions.set(definition.name, definition)
  }

  get(name: string): ScraperDefinition | undefined {
    return this.definitions.get(name)
  }

  all(): ScraperDefinition[] {
    return [...this.definitions.values()]
  }

  names(): string[] {
    return this.all().map((definition) => definition.name)
  }

  /** Resolve one scraper name, failing loudly with the valid options. */
  resolve(name: string, runtime: Runtime): ScraperDefinition {
    const definition = this.get(name)
    if (!definition) {
      throw new Error(
        `Invalid scraper '${name}'. Valid options are: ${this.names().join(', ')}.`,
      )
    }
    if (!definition.keyless) {
      const missing = definition.keys.filter((key) => !runtime.env(key))
      if (missing.length > 0) {
        throw new Error(
          `Scraper '${name}' requires ${missing.join(', ')}. ` +
            `Set the environment variable(s), or use a keyless scraper (${this.all()
              .filter((definition) => definition.keyless)
              .map((definition) => definition.name)
              .join(', ')}).`,
        )
      }
    }
    return definition
  }
}
