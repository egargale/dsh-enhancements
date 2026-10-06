/**
 * Report artifacts: where a research result is written on disk.
 *
 * Upstream's CLI writes `outputs/<timestamp>_<slug>.md` plus a sources JSON;
 * the backend streams the markdown to the client. In DSH the report comes back
 * as the tool result *and* is written to the workspace, so the session has a
 * durable deliverable that can be opened, diffed, or attached.
 *
 * @module gpt-researcher/tools/artifacts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { ResearchOutcome } from '../types.ts'
import { slugify } from '../utils/text.ts'

/** Where and how to write a report. */
export interface ArtifactOptions {
  /** Directory for reports, relative to the working directory when not absolute. */
  outputDir: string
  /** Working directory used to resolve a relative {@link outputDir}. */
  cwd: string
  /** Explicit file path; overrides `outputDir`. */
  outputPath?: string
  /** Also write `<report>.sources.json`. */
  writeSources?: boolean
  /** Disable writing entirely (the tool result still carries the report). */
  disabled?: boolean
}

/** What was written. */
export interface ArtifactResult {
  reportPath?: string
  sourcesPath?: string
  /** True when writing was skipped or failed; the reason is in `warning`. */
  warning?: string
}

/**
 * Write a report (and optionally its sources) to disk.
 *
 * A write failure is never fatal for a research run: the report is already in
 * the tool result, so this reports the failure as a warning instead of throwing.
 *
 * @param outcome - the finished research outcome.
 * @param options - artifact policy.
 * @returns the written paths, or a warning explaining why nothing was written.
 */
export async function writeArtifacts(
  outcome: ResearchOutcome,
  options: ArtifactOptions,
): Promise<ArtifactResult> {
  if (options.disabled) return {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = options.outputPath
    ? resolve(options.cwd, options.outputPath)
    : join(
        isAbsolute(options.outputDir) ? options.outputDir : resolve(options.cwd, options.outputDir),
        `${stamp}_${slugify(outcome.query)}.md`,
      )
  try {
    await mkdir(dirname(base), { recursive: true })
    const header = renderHeader(outcome)
    await writeFile(base, `${header}${outcome.report}\n`, 'utf8')
    let sourcesPath: string | undefined
    if (options.writeSources !== false) {
      sourcesPath = base.replace(/\.md$/, '') + '.sources.json'
      await writeFile(
        sourcesPath,
        JSON.stringify(
          {
            query: outcome.query,
            report_type: outcome.reportType,
            visited_urls: outcome.visitedUrls,
            costs: outcome.costs,
            sources: outcome.sources.map((source) => ({
              url: source.url,
              title: source.title ?? '',
              characters: source.raw_content.length,
            })),
          },
          null,
          2,
        ),
        'utf8',
      )
    }
    return { reportPath: base, ...(sourcesPath === undefined ? {} : { sourcesPath }) }
  } catch (error) {
    return {
      warning: `could not write the report to ${base}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/**
 * Strip characters that would let a query escape the header it is rendered into.
 *
 * The query is caller/model-supplied and lands in an HTML comment and an H1, so
 * `-->` would terminate the comment early (emitting live markup into a file a
 * client may render) and newlines/`#` would forge headings. Everything else is
 * preserved so the header still identifies the run.
 *
 * @param value - the raw header value.
 * @returns a single-line, comment-safe rendering.
 */
export function sanitizeHeaderValue(value: string): string {
  return value
    // Angle brackets first: a client that renders the markdown would execute
    // raw `<img onerror=…>` from the query, and escaping them also removes any
    // literal `-->` that could end the metadata comment early.
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/--+/g, '-')
    .replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^#+/, '')
    .trim()
}

/** The front-matter block prepended to a written report. */
function renderHeader(outcome: ResearchOutcome): string {
  const query = sanitizeHeaderValue(outcome.query)
  return [
    `<!-- gpt-researcher: query=${JSON.stringify(query)} type=${outcome.reportType} -->`,
    `# Research report: ${query}`,
    '',
    `- Report type: \`${outcome.reportType}\``,
    `- Sources scraped: ${outcome.sources.length}`,
    `- URLs visited: ${outcome.visitedUrls.length}`,
    `- Estimated cost: $${outcome.costs.total.toFixed(6)}`,
    '',
    '---',
    '',
  ].join('\n')
}
