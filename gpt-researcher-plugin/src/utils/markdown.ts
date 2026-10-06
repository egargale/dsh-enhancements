/**
 * Markdown post-processing: a port of
 * `gpt_researcher/actions/markdown_processing.py`.
 *
 * Upstream converts markdown to HTML with the `markdown` package and then
 * regex-parses the result. This port parses the markdown directly (no HTML
 * round-trip), which produces the same header tree, section list, table of
 * contents, and reference block without a dependency.
 *
 * @module gpt-researcher/utils/markdown
 */

/** One node of the header tree returned by {@link extractHeaders}. */
export interface HeaderNode {
  level: number
  text: string
  children?: HeaderNode[]
}

/** One written section, as {@link extractSections} returns it. */
export interface MarkdownSection {
  section_title: string
  written_content: string
}

/**
 * Build the header tree (upstream `extract_headers`), nesting deeper headers
 * under the nearest shallower one.
 *
 * @param markdownText - markdown report text.
 * @returns the top-level headers, each with nested `children`.
 */
export function extractHeaders(markdownText: string): HeaderNode[] {
  const headers: HeaderNode[] = []
  const stack: HeaderNode[] = []
  for (const line of markdownText.split('\n')) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const level = (match[1] as string).length
    const text = (match[2] as string).trim()
    if (text.length === 0) continue
    while (stack.length > 0 && (stack[stack.length - 1] as HeaderNode).level >= level) {
      stack.pop()
    }
    const header: HeaderNode = { level, text }
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children = parent.children ?? []
      parent.children.push(header)
    } else {
      headers.push(header)
    }
    stack.push(header)
  }
  return headers
}

/**
 * Split a report into its written sections (upstream `extract_sections`).
 *
 * @param markdownText - report text; may mix headings and prose.
 * @returns one entry per heading that has content, heading text stripped.
 */
export function extractSections(markdownText: string): MarkdownSection[] {
  const lines = markdownText.split('\n')
  const sections: MarkdownSection[] = []
  let currentTitle: string | undefined
  let buffer: string[] = []

  const flush = (): void => {
    if (currentTitle !== undefined) {
      const content = stripMarkdown(buffer.join('\n')).trim()
      if (content.length > 0) {
        sections.push({ section_title: currentTitle, written_content: content })
      }
    }
    buffer = []
  }

  for (const line of lines) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (match) {
      flush()
      currentTitle = (match[1] as string).trim()
      continue
    }
    if (currentTitle !== undefined) buffer.push(line)
  }
  flush()
  return sections
}

/**
 * Generate a table of contents (upstream `table_of_contents`), using
 * four-space indentation per nesting level.
 *
 * @param markdownText - report text.
 * @returns the `## Table of Contents` block, or the input when unparseable.
 */
export function tableOfContents(markdownText: string): string {
  const render = (headers: readonly HeaderNode[], depth = 0): string => {
    let toc = ''
    for (const header of headers) {
      toc += `${' '.repeat(depth * 4)}- ${header.text}\n`
      if (header.children) toc += render(header.children, depth + 1)
    }
    return toc
  }
  try {
    return `## Table of Contents\n\n${render(extractHeaders(markdownText))}`
  } catch {
    return markdownText
  }
}

/**
 * Append the visited-URL reference list (upstream `add_references`).
 *
 * @param reportMarkdown - the report body.
 * @param visitedUrls - URLs visited during research; order is preserved.
 * @returns the report with a `## References` section appended.
 */
export function addReferences(
  reportMarkdown: string,
  visitedUrls: Iterable<string>,
): string {
  const urls = [...visitedUrls]
  let references = '\n\n\n## References\n\n'
  for (const url of urls) references += `- [${url}](${url})\n`
  return reportMarkdown + references
}

/** Strip markdown/HTML markup down to plain text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim()
}

/**
 * Choose one section of a report by heading text, for upstream's
 * `relevant_written_contents` bookkeeping.
 *
 * @param markdownText - report text.
 * @param title - heading text to match, case-insensitive.
 * @returns the section, or undefined.
 */
export function findSection(
  markdownText: string,
  title: string,
): MarkdownSection | undefined {
  const wanted = title.trim().toLowerCase()
  return extractSections(markdownText).find(
    (section) => section.section_title.trim().toLowerCase() === wanted,
  )
}
