/**
 * Prompt templates: a faithful port of `gpt_researcher/prompts.py`.
 *
 * The prompt text *is* the product here, so every literal is transcribed
 * character-for-character from upstream: emoji, markdown fences, JSON examples
 * (Python's `{{`/`}}` f-string escapes become single braces again), the
 * indentation inside triple-quoted strings, and trailing whitespace all
 * survive. Each template literal below mirrors the Python source line for line,
 * which is what makes a side-by-side diff possible.
 *
 * Three deliberate adaptations:
 *
 * 1. Keyword arguments became a trailing `options` object (TypeScript has no
 *    keyword arguments). The report options (`report_format`, `tone`,
 *    `total_words`, `language`) default to the values the upstream *engine*
 *    always passed — `cfg.report_format`, `cfg.total_words`, `cfg.language` —
 *    rather than to the Python signature literals (`"apa"`, `1000`/`2000`/`800`,
 *    `"english"`), because every upstream call site passed the config values.
 *    With the default {@link Config} this renders `APA` / `1200` / `english`,
 *    i.e. exactly what upstream produces on a default run. Likewise
 *    {@link PromptFamily.generate_resource_report_prompt} and
 *    {@link PromptFamily.generate_deep_research_prompt} take upstream's
 *    positional `report_source` inside the options object, defaulting to
 *    `cfg.reportSource`.
 * 2. `context` and other opaque values are typed `unknown` and rendered by
 *    {@link asText}: strings pass through unchanged (the engine hands over a
 *    string everywhere except the search-query `context`, which is a list of
 *    search results), anything else is JSON-stringified. Python would instead
 *    print a list/dict `repr` (`['a', 'b']`) or `None`; that difference can
 *    only show for a non-string `context`. Interpolations whose value upstream
 *    always builds as a list of strings (`existing_headers`,
 *    `relevant_written_contents`, the MCP tool names) use
 *    {@link pyStringList} instead, so those render exactly like Python.
 * 3. Upstream marks most of these as `@staticmethod`, but in JavaScript static
 *    members are not reachable through an instance and every call site here is
 *    `new PromptFamily(cfg)` followed by `family.generate_…()`. The generators
 *    are therefore instance methods. `curate_sources` and
 *    `auto_agent_instructions` keep the static spelling the port contract asks
 *    for *and* an instance counterpart that delegates to it, because the
 *    engine's curator and agent creator call them through an instance.
 *
 * @module gpt-researcher/prompts
 */

import type { Config } from './config.ts'
import { TONES } from './types.ts'
import type { DocumentChunk } from './types.ts'

/** Upstream `ReportType.DetailedReport.value`. */
const DETAILED_REPORT = 'detailed_report'
/** Upstream `ReportType.SubtopicReport.value`. */
const SUBTOPIC_REPORT = 'subtopic_report'
/** Upstream `ReportSource.Web.value`. */
const REPORT_SOURCE_WEB = 'web'

/**
 * Render a value the way this port interpolates it: strings pass through
 * unchanged — the engine passes a string for nearly every interpolated value —
 * and anything else is JSON-stringified.
 *
 * DEVIATION: Python's f-strings render non-strings with `str()`/`repr()`, so a
 * list becomes `['a', 'b']` and `None` becomes `None`; `asText` produces
 * `["a","b"]` and `null` instead. Only a non-string `context` (the search-query
 * planner's `SearchResult[]`) reaches this branch in practice.
 *
 * @param value - value to interpolate into a prompt.
 * @returns the interpolated text.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  const encoded = JSON.stringify(value)
  return encoded === undefined ? '' : encoded
}

/**
 * Serialise a value the way upstream's `json.dumps(value, indent=2)` does for
 * the MCP tool description list.
 *
 * DEVIATION: Python escapes non-ASCII characters by default; `JSON.stringify`
 * leaves them as-is.
 *
 * @param value - value to serialise.
 * @returns pretty-printed JSON.
 */
function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null'
}

/**
 * Python truthiness for the values upstream branches on (`if context`,
 * `if tone`): `None`, `False`, `0`, `''`, `[]` and `{}` are falsy.
 *
 * @param value - value to test.
 * @returns whether Python would treat the value as true.
 */
function pyTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return value !== 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

/**
 * Render a value the way a Python f-string renders a `str`/`None` metadata
 * value: a missing key or `None` becomes the literal text `None`.
 *
 * @param value - metadata value to render.
 * @returns the rendered text.
 */
function pyText(value: unknown): string {
  if (value === undefined || value === null) return 'None'
  return typeof value === 'string' ? value : String(value)
}

/**
 * Render a `string[]` the way Python's f-string renders a list of strings
 * (upstream interpolates `existing_headers`, `relevant_written_contents` and
 * the MCP tool-name list directly): `['a', 'b']`.
 *
 * @param values - the strings to render as a Python list.
 * @returns the Python list representation.
 */
function pyStringList(values: readonly string[]): string {
  return `[${values.map((value) => `'${value}'`).join(', ')}]`
}

/** `dict.get(key, fallback)`: the fallback applies only when the key is absent. */
function metadataOr(
  metadata: Record<string, unknown>,
  key: string,
  fallback: unknown,
): unknown {
  return Object.hasOwn(metadata, key) ? metadata[key] : fallback
}

/** Zero-pad a date component, as Python's `strftime('%d')` does. */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** English month names, in `strftime('%B')` order. */
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/**
 * Upstream `datetime.now(timezone.utc).strftime('%B %d, %Y')`, e.g.
 * `October 06, 2025`.
 *
 * @param now - clock to read; defaults to the current time.
 * @returns the UTC date stamp used by the prompt templates.
 */
function utcDateStamp(now: Date = new Date()): string {
  const month = MONTH_NAMES[now.getUTCMonth()] ?? ''
  return `${month} ${pad2(now.getUTCDate())}, ${now.getUTCFullYear()}`
}

/**
 * Upstream `date.today()` (a local date), rendered the way a Python f-string
 * renders it: `2025-10-06`.
 *
 * @param now - clock to read; defaults to the current time.
 * @returns the local ISO date.
 */
function localDateIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** Options for {@link PromptFamily.generate_search_queries_prompt}. */
export interface SearchQueriesPromptOptions {
  /** Upstream `max_iterations`; the number of queries to ask for. */
  max_iterations?: number
  /** Real-time context handed to the query writer; a string in this port. */
  context?: unknown
}

/** Report options shared by every report-prompt generator (upstream kwargs). */
export interface ReportPromptOptions {
  /** Upstream `report_format`; defaults to `cfg.reportFormat`. */
  report_format?: string
  /** Upstream `tone`; the descriptive tone value, or omitted for no tone line. */
  tone?: string
  /** Upstream `total_words`; defaults to `cfg.totalWords`. */
  total_words?: number
  /** Upstream `language`; defaults to `cfg.language`. */
  language?: string
  /**
   * The report source (`web` selects the URL-reference rules). Only the
   * generators whose port signature has no positional `report_source`
   * (`generate_resource_report_prompt`, `generate_deep_research_prompt`) read
   * it; they default to `cfg.reportSource`, i.e. `web` on a default config.
   */
  report_source?: string
}

/** Options for {@link PromptFamily.generate_subtopic_report_prompt}. */
export interface SubtopicReportPromptOptions extends ReportPromptOptions {
  /** The subtopic this sub-report covers. */
  current_subtopic: string
  /** Headers already used by sibling sub-reports. */
  existing_headers: string[]
  /** Contents already written by sibling sub-reports. */
  relevant_written_contents: string[]
  /** The main topic the sub-report belongs to. */
  main_topic: string
  /** Research context for this sub-report. */
  context: unknown
  /** Upstream `max_subsections` (default `5`). */
  max_subsections?: number
}

/** Options for {@link PromptFamily.generate_report_introduction}. */
export interface ReportIntroductionPromptOptions {
  /** The research question the introduction belongs to. */
  question: string
  /** Upstream `research_summary` (default `""`). */
  research_summary?: string
  /** Upstream `language` (default `cfg.language`). */
  language?: string
  /** Upstream `report_format` (default `cfg.reportFormat`). */
  report_format?: string
}

/** Options for {@link PromptFamily.generate_report_conclusion}. */
export interface ReportConclusionPromptOptions {
  /** The research task or question. */
  query: string
  /** Upstream `report_content`; the report to conclude. */
  report_content?: string
  /** Upstream `language` (default `cfg.language`). */
  language?: string
  /** Upstream `report_format` (default `cfg.reportFormat`). */
  report_format?: string
}

/** One report section handed to {@link PromptFamily.generate_image_analysis_prompt}. */
export interface ImageAnalysisSection {
  header: string
  content: string
}

/**
 * A prompt generator as returned by {@link get_prompt_by_report_type}: upstream
 * returns a bare callable via `getattr`, so the arguments are untyped here and
 * the caller picks the matching arity (`generate_report_prompt` style, or the
 * single-options `generate_subtopic_report_prompt` style).
 */
export type PromptGenerator = (...args: unknown[]) => string

/**
 * Resolve the report options the way upstream's call sites did.
 *
 * @param cfg - the family's configuration.
 * @param options - caller-supplied overrides.
 * @returns the fully resolved options.
 */
function resolveReportOptions(
  cfg: Config,
  options: ReportPromptOptions,
): { report_format: string; tone: string | undefined; total_words: number; language: string } {
  return {
    report_format: options.report_format ?? cfg.reportFormat ?? 'APA',
    tone: options.tone,
    total_words: options.total_words ?? cfg.totalWords ?? 1200,
    language: options.language ?? cfg.language ?? 'english',
  }
}

/**
 * General purpose class for prompt formatting — the port of upstream
 * `PromptFamily`.
 *
 * This may be subclassed for a model-specific family (see
 * {@link GranitePromptFamily}); derived classes must retain the same set of
 * method names but may override individual methods.
 */
export class PromptFamily {
  /** The configuration the family was constructed with (upstream `self.cfg`). */
  readonly cfg: Config

  /**
   * Initialize with a config instance. This may be used by derived classes to
   * select the correct prompting based on configured models and/or providers.
   *
   * @param config - the resolved plugin configuration.
   */
  constructor(config: Config) {
    this.cfg = config
  }

  // MCP-specific prompts

  /**
   * Generate prompt for LLM-based MCP tool selection.
   *
   * @param query - the research query.
   * @param tools_info - available tools with their metadata.
   * @param max_tools - maximum number of tools to select (default `3`).
   * @returns the tool selection prompt.
   */
  generate_mcp_tool_selection_prompt(
    query: string,
    tools_info: unknown,
    max_tools: number = 3,
  ): string {
    return `You are a research assistant helping to select the most relevant tools for a research query.

RESEARCH QUERY: "${query}"

AVAILABLE TOOLS:
${asJson(tools_info)}

TASK: Analyze the tools and select EXACTLY ${max_tools} tools that are most relevant for researching the given query.

SELECTION CRITERIA:
- Choose tools that can provide information, data, or insights related to the query
- Prioritize tools that can search, retrieve, or access relevant content
- Consider tools that complement each other (e.g., different data sources)
- Exclude tools that are clearly unrelated to the research topic

Return a JSON object with this exact format:
{
  "selected_tools": [
    {
      "index": 0,
      "name": "tool_name",
      "relevance_score": 9,
      "reason": "Detailed explanation of why this tool is relevant"
    }
  ],
  "selection_reasoning": "Overall explanation of the selection strategy"
}

Select exactly ${max_tools} tools, ranked by relevance to the research query.
`
  }

  /**
   * Generate prompt for MCP research execution with selected tools.
   *
   * Upstream accepts strings or objects with a `.name` attribute; the names are
   * interpolated as a Python list would be (`['a', 'b']`) because upstream
   * interpolates the list itself.
   *
   * @param query - the research query.
   * @param selected_tools - the selected MCP tools (names, or objects with a `name`).
   * @returns the research execution prompt.
   */
  generate_mcp_research_prompt(query: string, selected_tools: readonly unknown[]): string {
    const tool_names = selected_tools.map((tool) =>
      tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string'
        ? ((tool as { name: string }).name)
        : String(tool),
    )
    const renderedToolNames = pyStringList(tool_names)

    return `You are a research assistant with access to specialized tools. Your task is to research the following query and provide comprehensive, accurate information.

RESEARCH QUERY: "${query}"

INSTRUCTIONS:
1. Use the available tools to gather relevant information about the query
2. Call multiple tools if needed to get comprehensive coverage
3. If a tool call fails or returns empty results, try alternative approaches
4. Synthesize information from multiple sources when possible
5. Focus on factual, relevant information that directly addresses the query

AVAILABLE TOOLS: ${renderedToolNames}

Please conduct thorough research and provide your findings. Use the tools strategically to gather the most relevant and comprehensive information.`
  }

  // Image generation prompts

  /**
   * Generate prompt for analyzing which report sections need images.
   *
   * @param query - the research query.
   * @param sections - report sections with `header` and `content`.
   * @param max_images - maximum number of images to suggest (default `3`).
   * @returns the analysis prompt.
   */
  generate_image_analysis_prompt(
    query: string,
    sections: readonly ImageAnalysisSection[],
    max_images: number = 3,
  ): string {
    const sections_text = sections
      .map(
        (section, i) =>
          `### Section ${i + 1}: ${section.header}\n${String(section.content).slice(0, 500)}...`,
      )
      .join('\n\n')

    return `Analyze the following research report sections and identify which ${max_images} sections would benefit MOST from a visual illustration or diagram.

RESEARCH TOPIC: ${query}

REPORT SECTIONS:
${sections_text}

For each recommended section, provide:
1. The section number (1-indexed)
2. A specific, detailed image prompt that would create an informative illustration
3. A brief explanation of why this section benefits from visualization

IMPORTANT GUIDELINES:
- Choose sections where visual representation would genuinely aid understanding
- Focus on concepts, processes, comparisons, data flows, or statistics that are inherently visual
- Avoid sections that are purely textual analysis, introductions, or conclusions
- The image prompt should be specific enough to generate a relevant, professional illustration
- Images should be informative and educational, not decorative
- Consider diagrams, flowcharts, comparison charts, or conceptual illustrations

Respond in JSON format:
{
    "suggestions": [
        {
            "section_number": 1,
            "section_header": "Section Title",
            "image_prompt": "Detailed prompt for generating an informative illustration...",
            "image_type": "diagram|flowchart|comparison|concept|data_visualization",
            "reason": "Why this section benefits from visualization"
        }
    ]
}

Return ONLY the JSON, no additional text.`
  }

  /**
   * Enhance an image prompt with context for better generation.
   *
   * @param base_prompt - the base image generation prompt.
   * @param section_content - content from the report section.
   * @param research_topic - the main research topic.
   * @returns the enhanced image prompt.
   */
  generate_image_prompt_enhancement(
    base_prompt: string,
    section_content: string,
    research_topic: string,
  ): string {
    return `Create a professional, informative illustration for a research report.

RESEARCH TOPIC: ${research_topic}

IMAGE DESCRIPTION: ${base_prompt}

CONTEXT FROM REPORT:
${String(section_content).slice(0, 800)}

STYLE REQUIREMENTS:
- Professional and clean design suitable for academic/business reports
- Clear, easy-to-understand visual elements
- Modern, minimalist aesthetic
- Use a professional color palette (blues, teals, grays)
- Avoid excessive text in the image
- High contrast for readability
- If showing data or comparisons, use clear labels and legends
- Suitable for both digital viewing and printing`
  }

  /**
   * Generates the search queries prompt for the given question.
   *
   * @param query - the question to generate the search queries prompt for
   *   (upstream `question`).
   * @param parent_query - the main question (only relevant for detailed reports).
   * @param report_type - the report type.
   * @param options - `max_iterations` (default `3`) and the real-time `context`.
   * @returns the search queries prompt for the given question.
   */
  generate_search_queries_prompt(
    query: string,
    parent_query: string,
    report_type: string,
    options: SearchQueriesPromptOptions = {},
  ): string {
    const max_iterations = options.max_iterations ?? 3
    const context = options.context ?? []

    const task =
      report_type === DETAILED_REPORT || report_type === SUBTOPIC_REPORT
        ? `${parent_query} - ${query}`
        : query

    const context_prompt = pyTruthy(context)
      ? `
You are a seasoned research assistant tasked with generating search queries to find relevant information for the following task: "${task}".
Context: ${asText(context)}

Use this context to inform and refine your search queries. The context provides real-time web information that can help you generate more specific and relevant queries. Consider any current events, recent developments, or specific details mentioned in the context that could enhance the search queries.
`
      : ''

    const dynamic_example = Array.from(
      { length: Math.max(0, Math.trunc(max_iterations)) },
      (_, i) => `"query ${i + 1}"`,
    ).join(', ')

    return `Write ${max_iterations} search queries to research the following task: "${task}"

Each query must be a plain natural language phrase. Do not use search operator syntax
such as site:, filetype:, inurl:, intitle:, OR, AND, or NOT — these operators are
not universally supported and will return empty results on many search backends.

Assume the current date is ${utcDateStamp()} if required.

${context_prompt}
You must respond with a list of strings in the following format: [${dynamic_example}].
The response should contain ONLY the list.
`
  }

  /**
   * Generates the report prompt for the given question and research summary.
   *
   * @param query - the question to generate the report prompt for.
   * @param context - the research summary (a string in this port).
   * @param report_source - the report source; `web` adds the URL reference rules.
   * @param options - report format, tone, total words and language.
   * @returns the report prompt for the given question and research summary.
   */
  generate_report_prompt(
    query: string,
    context: unknown,
    report_source: string,
    options: ReportPromptOptions = {},
  ): string {
    const { report_format, tone, total_words, language } = resolveReportOptions(this.cfg, options)

    let reference_prompt = ''
    if (report_source === REPORT_SOURCE_WEB) {
      reference_prompt = `
You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.
Every url should be hyperlinked: [url website](url)
Additionally, you MUST include hyperlinks to the relevant URLs wherever they are referenced in the report:

eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)
`
    } else {
      reference_prompt = `
You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
`
    }

    const tone_prompt = tone ? `Write the report in a ${tone} tone.` : ''

    return `
Information: "${asText(context)}"
---
Using the above information, answer the following query or task: "${query}" in a detailed report --
The report should focus on the answer to the query, should be well structured, informative,
in-depth, and comprehensive, with facts and numbers if available and at least ${total_words} words.
You should strive to write the report as long as you can using all relevant and necessary information provided.

Please follow all of the following guidelines in your report:
- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.
- You MUST write the report with markdown syntax and ${report_format} format.
- Structure your report with clear markdown headers: use # for the main title, ## for major sections, and ### for subsections.
- Use markdown tables when presenting structured data or comparisons to enhance readability.
- You MUST prioritize the relevance, reliability, and significance of the sources you use. Choose trusted sources over less reliable ones.
- You must also prioritize new articles over older articles if the source can be trusted.
- You MUST NOT include a table of contents, but DO include proper markdown headers (# ## ###) to structure your report clearly.
- Use in-text citation references in ${report_format} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- Don't forget to add a reference list at the end of the report in ${report_format} format and full url links without hyperlinks.
- ${reference_prompt}
- ${tone_prompt}
You MUST write the report in the following language: ${language}.
Please do your best, this is very important to my career.
Assume that the current date is ${localDateIso()}.
`
  }

  /**
   * Evaluate and curate scraped content for a research task.
   *
   * Upstream declares this as a `@staticmethod` and the port contract keeps it
   * static, but Python also lets a staticmethod be called through an instance
   * while JavaScript does not — and the engine's curator calls
   * `family.curate_sources(...)`. Both spellings are provided; they share one
   * implementation.
   *
   * @param query - the research task the sources must serve.
   * @param sources - the sources list to evaluate.
   * @param max_results - maximum number of sources to keep (default `10`).
   * @returns the source curation prompt.
   */
  curate_sources(query: string, sources: unknown, max_results: number = 10): string {
    return PromptFamily.curate_sources(query, sources, max_results)
  }

  /**
   * Evaluate and curate scraped content for a research task.
   *
   * @param query - the research task the sources must serve.
   * @param sources - the sources list to evaluate.
   * @param max_results - maximum number of sources to keep (default `10`).
   * @returns the source curation prompt.
   */
  static curate_sources(query: string, sources: unknown, max_results: number = 10): string {
    return `Your goal is to evaluate and curate the provided scraped content for the research task: "${query}"
    while prioritizing the inclusion of relevant and high-quality information, especially sources containing statistics, numbers, or concrete data.

The final curated list will be used as context for creating a research report, so prioritize:
- Retaining as much original information as possible, with extra emphasis on sources featuring quantitative data or unique insights
- Including a wide range of perspectives and insights
- Filtering out only clearly irrelevant or unusable content

EVALUATION GUIDELINES:
1. Assess each source based on:
   - Relevance: Include sources directly or partially connected to the research query. Err on the side of inclusion.
   - Credibility: Favor authoritative sources but retain others unless clearly untrustworthy.
   - Currency: Prefer recent information unless older data is essential or valuable.
   - Objectivity: Retain sources with bias if they provide a unique or complementary perspective.
   - Quantitative Value: Give higher priority to sources with statistics, numbers, or other concrete data.
2. Source Selection:
   - Include as many relevant sources as possible, up to ${max_results}, focusing on broad coverage and diversity.
   - Prioritize sources with statistics, numerical data, or verifiable facts.
   - Overlapping content is acceptable if it adds depth, especially when data is involved.
   - Exclude sources only if they are entirely irrelevant, severely outdated, or unusable due to poor content quality.
3. Content Retention:
   - DO NOT rewrite, summarize, or condense any source content.
   - Retain all usable information, cleaning up only clear garbage or formatting issues.
   - Keep marginally relevant or incomplete sources if they contain valuable data or insights.

SOURCES LIST TO EVALUATE:
${asText(sources)}

You MUST return your response in the EXACT sources JSON list format as the original sources.
The response MUST not contain any markdown format or additional text (like \`\`\`json), just the JSON list!
`
  }

  /**
   * Generates the resource report prompt for the given question and research summary.
   *
   * The trailing whitespace after `reference_prompt` is significant: upstream's
   * closing `"""` sits at 8- or 12-space indent, so those spaces are part of the
   * rendered prompt.
   *
   * @param query - the question to generate the resource report prompt for.
   * @param context - the research summary.
   * @param options - report format, tone, total words and language; upstream's
   *   positional `report_source` lives in `options.report_source` here.
   * @returns the resource report prompt for the given question and research summary.
   */
  generate_resource_report_prompt(
    query: string,
    context: unknown,
    options: ReportPromptOptions = {},
  ): string {
    const { total_words, language } = resolveReportOptions(this.cfg, options)
    const report_source = options.report_source ?? this.cfg.reportSource ?? REPORT_SOURCE_WEB

    let reference_prompt = ''
    if (report_source === REPORT_SOURCE_WEB) {
      // Explicit escapes: the upstream string ends with a newline plus the
      // 12-space indentation of its closing `"""`.
      reference_prompt =
        '\n            You MUST include all relevant source urls.\n            Every url should be hyperlinked: [url website](url)\n            '
    } else {
      // Ends with a newline plus the 8-space indentation of its closing `"""`.
      reference_prompt =
        '\n            You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."\n        '
    }

    return (
      `"""${asText(context)}"""\n\nBased on the above information, generate a bibliography recommendation report for the following` +
      ` question or topic: "${query}". The report should provide a detailed analysis of each recommended resource,` +
      ' explaining how each source can contribute to finding answers to the research question.\n' +
      'Focus on the relevance, reliability, and significance of each source.\n' +
      'Ensure that the report is well-structured, informative, in-depth, and follows Markdown syntax.\n' +
      'Use markdown tables and other formatting features when appropriate to organize and present information clearly.\n' +
      'Include relevant facts, figures, and numbers whenever available.\n' +
      `The report should have a minimum length of ${total_words} words.\n` +
      `You MUST write the report in the following language: ${language}.\n` +
      'You MUST include all relevant source urls.' +
      'Every url should be hyperlinked: [url website](url)' +
      `${reference_prompt}`
    )
  }

  /**
   * Generates the custom report prompt: the caller's own instructions prefixed
   * with the context; the report options are accepted (and ignored) exactly as
   * upstream does.
   *
   * @param query_prompt - the caller's instructions for the report.
   * @param context - the research summary.
   * @param options - report format, tone, total words, language and report
   *   source (all unused by upstream).
   * @returns the custom report prompt.
   */
  generate_custom_report_prompt(
    query_prompt: string,
    context: unknown,
    options: ReportPromptOptions = {},
  ): string {
    void options
    return `"${asText(context)}"\n\n${query_prompt}`
  }

  /**
   * Generates the outline report prompt for the given question and research summary.
   *
   * @param query - the question to generate the outline report prompt for.
   * @param context - the research summary.
   * @param options - report format, tone, total words, language and report
   *   source (the report source is unused by upstream).
   * @returns the outline report prompt for the given question and research summary.
   */
  generate_outline_report_prompt(
    query: string,
    context: unknown,
    options: ReportPromptOptions = {},
  ): string {
    const { total_words } = resolveReportOptions(this.cfg, options)

    return (
      `"""${asText(context)}""" Using the above information, generate an outline for a research report in Markdown syntax` +
      ` for the following question or topic: "${query}". The outline should provide a well-structured framework` +
      ' for the research report, including the main sections, subsections, and key points to be covered.' +
      ` The research report should be detailed, informative, in-depth, and a minimum of ${total_words} words.` +
      ' Use appropriate Markdown syntax to format the outline and ensure readability.' +
      ' Consider using markdown tables and other formatting features where they would enhance the presentation of information.'
    )
  }

  /**
   * Generates the deep research report prompt, specialized for handling
   * hierarchical research results.
   *
   * @param query - the research question.
   * @param context - the research context containing learnings with citations.
   * @param options - report format, tone, total words and language; upstream's
   *   positional `report_source` lives in `options.report_source` here.
   * @returns the deep research report prompt.
   */
  generate_deep_research_prompt(
    query: string,
    context: unknown,
    options: ReportPromptOptions = {},
  ): string {
    const { report_format, tone, total_words, language } = resolveReportOptions(this.cfg, options)
    const report_source = options.report_source ?? this.cfg.reportSource ?? REPORT_SOURCE_WEB

    let reference_prompt = ''
    if (report_source === REPORT_SOURCE_WEB) {
      reference_prompt = `
You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.
Every url should be hyperlinked: [url website](url)
Additionally, you MUST include hyperlinks to the relevant URLs wherever they are referenced in the report:

eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)
`
    } else {
      reference_prompt = `
You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
`
    }

    const tone_prompt = tone ? `Write the report in a ${tone} tone.` : ''

    return `
Using the following hierarchically researched information and citations:

"${asText(context)}"

Write a comprehensive research report answering the query: "${query}"

The report should:
1. Synthesize information from multiple levels of research depth
2. Integrate findings from various research branches
3. Present a coherent narrative that builds from foundational to advanced insights
4. Maintain proper citation of sources throughout
5. Be well-structured with clear sections and subsections
6. Have a minimum length of ${total_words} words
7. Follow ${report_format} format with markdown syntax
8. Use markdown tables, lists and other formatting features when presenting comparative data, statistics, or structured information

Additional requirements:
- Prioritize insights that emerged from deeper levels of research
- Highlight connections between different research branches
- Include relevant statistics, data, and concrete examples
- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.
- You MUST prioritize the relevance, reliability, and significance of the sources you use. Choose trusted sources over less reliable ones.
- You must also prioritize new articles over older articles if the source can be trusted.
- Use in-text citation references in ${report_format} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- ${tone_prompt}
- Write in ${language}

${reference_prompt}

Please write a thorough, well-researched report that synthesizes all the gathered information into a cohesive whole.
Assume the current date is ${utcDateStamp()}.
`
  }

  /**
   * The autonomous-agent framing instructions (upstream `auto_agent_instructions`).
   *
   * Note the upstream source leaves `"agent_role_prompt` unquoted in the first
   * example; that typo is preserved verbatim.
   *
   * Upstream declares this as a `@staticmethod`; like `curate_sources`, both
   * the static and the instance spelling are provided because the engine's
   * agent creator calls `family.auto_agent_instructions()`.
   *
   * @returns the agent instructions, examples included.
   */
  auto_agent_instructions(): string {
    return PromptFamily.auto_agent_instructions()
  }

  /**
   * The autonomous-agent framing instructions (upstream `auto_agent_instructions`).
   *
   * Note the upstream source leaves `"agent_role_prompt` unquoted in the first
   * example; that typo is preserved verbatim.
   *
   * @returns the agent instructions, examples included.
   */
  static auto_agent_instructions(): string {
    return `
This task involves researching a given topic, regardless of its complexity or the availability of a definitive answer. The research is conducted by a specific server, defined by its type and role, with each server requiring distinct instructions.
Agent
The server is determined by the field of the topic and the specific name of the server that could be utilized to research the topic provided. Agents are categorized by their area of expertise, and each server type is associated with a corresponding emoji.

examples:
task: "should I invest in apple stocks?"
response:
{
    "server": "💰 Finance Agent",
    "agent_role_prompt: "You are a seasoned finance analyst AI assistant. Your primary goal is to compose comprehensive, astute, impartial, and methodically arranged financial reports based on provided data and trends."
}
task: "could reselling sneakers become profitable?"
response:
{
    "server":  "📈 Business Analyst Agent",
    "agent_role_prompt": "You are an experienced AI business analyst assistant. Your main objective is to produce comprehensive, insightful, impartial, and systematically structured business reports based on provided business data, market trends, and strategic analysis."
}
task: "what are the most interesting sites in Tel Aviv?"
response:
{
    "server":  "🌍 Travel Agent",
    "agent_role_prompt": "You are a world-travelled AI tour guide assistant. Your main purpose is to draft engaging, insightful, unbiased, and well-structured travel reports on given locations, including history, attractions, and cultural insights."
}
`
  }

  /**
   * Generates the summary prompt for the given question and text.
   *
   * @param query - the question to generate the summary prompt for.
   * @param data - the text to generate the summary prompt for.
   * @returns the summary prompt for the given question and text.
   */
  generate_summary_prompt(query: string, data: unknown): string {
    return (
      `${asText(data)}\n Using the above text, summarize it based on the following task or query: "${query}".\n If the ` +
      'query cannot be answered using the text, YOU MUST summarize the text in short.\n Include all factual ' +
      'information such as numbers, stats, quotes, etc if available. '
    )
  }

  /**
   * Generates the quick summary prompt for the given question and context.
   *
   * @param query - the query to generate the summary for.
   * @param context - the search results to summarize.
   * @returns the quick summary prompt.
   */
  generate_quick_summary_prompt(query: string, context: unknown): string {
    return `
Synthesize a comprehensive answer to the following query based ONLY on the provided search results.
Query: "${query}"

Search Results:
${asText(context)}

Instructions:
1. Provide a single, continuous narrative summary.
2. Cite your sources using numbers [1], [2], etc., corresponding to the search results.
3. If the results are insufficient to answer the query, state that clearly.
4. Focus on accuracy and relevance.
`
  }

  /**
   * Compress the list of documents into a context string.
   *
   * Upstream renders `Source:` / `Title:` / `Content:` per document, joined by
   * newlines.
   *
   * @param docs - the documents to compress.
   * @param top_n - keep only the first `top_n` documents; default keeps all.
   * @returns the compressed context string.
   */
  pretty_print_docs(docs: readonly DocumentChunk[], top_n?: number): string {
    return docs
      .filter((_, i) => top_n === undefined || i < top_n)
      .map(
        (doc) =>
          `Source: ${pyText(doc.metadata.source)}\n` +
          `Title: ${pyText(doc.metadata.title)}\n` +
          `Content: ${doc.page_content}\n`,
      )
      .join('\n')
  }

  /**
   * Joins local documents with context scraped from the internet.
   *
   * @param docs_context - context from local documents.
   * @param web_context - context from web sources.
   * @returns the joined context.
   */
  join_local_web_documents(
    docs_context: string | string[],
    web_context: string | string[],
  ): string {
    return `Context from local documents: ${asText(docs_context)}\n\nContext from web sources: ${asText(web_context)}`
  }

  ////////////////////////////////////////////////////////////////////////////////
  // DETAILED REPORT PROMPTS

  /**
   * The subtopic-planning template.
   *
   * Upstream returns the raw template with its `{task}`, `{data}`,
   * `{subtopics}`, `{max_subtopics}` and `{format_instructions}` placeholders
   * intact, because LangChain's `PromptTemplate` fills them in; this port does
   * the same.
   *
   * @returns the subtopics template.
   */
  generate_subtopics_prompt(): string {
    return `
Provided the main topic:

{task}

and research data:

{data}

- Construct a list of subtopics which indicate the headers of a report document to be generated on the task.
- These are a possible list of subtopics : {subtopics}.
- There should NOT be any duplicate subtopics.
- Limit the number of subtopics to a maximum of {max_subtopics}
- Finally order the subtopics by their tasks, in a relevant and meaningful order which is presentable in a detailed report

"IMPORTANT!":
- Every subtopic MUST be relevant to the main topic and provided research data ONLY!

{format_instructions}
`
  }

  /**
   * Generates the prompt for one sub-report of a detailed report.
   *
   * @param options - the subtopic, sibling headers/contents, main topic, context
   *   and report options (`max_subsections` defaults to `5`, `tone` to
   *   `Tone.Objective`).
   * @returns the subtopic report prompt.
   */
  generate_subtopic_report_prompt(options: SubtopicReportPromptOptions): string {
    const { report_format, total_words, language } = resolveReportOptions(this.cfg, options)
    const max_subsections = options.max_subsections ?? 5
    // Upstream's signature default is `tone: Tone = Tone.Objective`.
    const tone = options.tone ? options.tone : TONES.Objective

    return `
Context:
"${asText(options.context)}"

Main Topic and Subtopic:
Using the latest information available, construct a detailed report on the subtopic: ${options.current_subtopic} under the main topic: ${options.main_topic}.
You must limit the number of subsections to a maximum of ${max_subsections}.

Content Focus:
- The report should focus on answering the question, be well-structured, informative, in-depth, and include facts and numbers if available.
- Use markdown syntax and follow the ${report_format.toUpperCase()} format.
- When presenting data, comparisons, or structured information, use markdown tables to enhance readability.

IMPORTANT:Content and Sections Uniqueness:
- This part of the instructions is crucial to ensure the content is unique and does not overlap with existing reports.
- Carefully review the existing headers and existing written contents provided below before writing any new subsections.
- Prevent any content that is already covered in the existing written contents.
- Do not use any of the existing headers as the new subsection headers.
- Do not repeat any information already covered in the existing written contents or closely related variations to avoid duplicates.
- If you have nested subsections, ensure they are unique and not covered in the existing written contents.
- Ensure that your content is entirely new and does not overlap with any information already covered in the previous subtopic reports.

"Existing Subtopic Reports":
- Existing subtopic reports and their section headers:

    ${pyStringList(options.existing_headers)}

- Existing written contents from previous subtopic reports:

    ${pyStringList(options.relevant_written_contents)}

"Structure and Formatting":
- As this sub-report will be part of a larger report, include only the main body divided into suitable subtopics without any introduction or conclusion section.

- You MUST include markdown hyperlinks to relevant source URLs wherever referenced in the report, for example:

    ### Section Header

    This is a sample text ([in-text citation](url)).

- Use H2 for the main subtopic header (##) and H3 for subsections (###).
- Use smaller Markdown headers (e.g., H2 or H3) for content structure, avoiding the largest header (H1) as it will be used for the larger report's heading.
- Organize your content into distinct sections that complement but do not overlap with existing reports.
- When adding similar or identical subsections to your report, you should clearly indicate the differences between and the new content and the existing written content from previous subtopic reports. For example:

    ### New header (similar to existing header)

    While the previous section discussed [topic A], this section will explore [topic B]."

"Date":
Assume the current date is ${utcDateStamp()} if required.

"IMPORTANT!":
- You MUST write the report in the following language: ${language}.
- The focus MUST be on the main topic! You MUST Leave out any information un-related to it!
- Must NOT have any introduction, conclusion, summary or reference section.
- You MUST use in-text citation references in ${report_format.toUpperCase()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- You MUST mention the difference between the existing content and the new content in the report if you are adding the similar or same subsections wherever necessary.
- The report should have a minimum length of ${total_words} words.
- Use an ${tone} tone throughout the report.

Do NOT add a conclusion section.
`
  }

  /**
   * Generates draft section-title headers for one subtopic.
   *
   * Upstream's fourth parameter (`max_subsections`) is unused in the template
   * and is therefore not accepted here.
   *
   * @param current_subtopic - the subtopic the headers are for.
   * @param query - the main topic of the report (upstream `main_topic`).
   * @param context - the research context.
   * @returns the draft titles prompt.
   */
  generate_draft_titles_prompt(
    current_subtopic: string,
    query: string,
    context: unknown,
  ): string {
    return `
"Context":
"${asText(context)}"

"Main Topic and Subtopic":
Using the latest information available, construct a draft section title headers for a detailed report on the subtopic: ${current_subtopic} under the main topic: ${query}.

"Task":
1. Create a list of draft section title headers for the subtopic report.
2. Each header should be concise and relevant to the subtopic.
3. The header should't be too high level, but detailed enough to cover the main aspects of the subtopic.
4. Use markdown syntax for the headers, using H3 (###) as H1 and H2 will be used for the larger report's heading.
5. Ensure the headers cover main aspects of the subtopic.

"Structure and Formatting":
Provide the draft headers in a list format using markdown syntax, for example:

### Header 1
### Header 2
### Header 3

"IMPORTANT!":
- The focus MUST be on the main topic! You MUST Leave out any information un-related to it!
- Must NOT have any introduction, conclusion, summary or reference section.
- Focus solely on creating headers, not content.
`
  }

  /**
   * Generates the introduction prompt for a report.
   *
   * @param options - the question, the research summary, language and report format.
   * @returns the report introduction prompt.
   */
  generate_report_introduction(options: ReportIntroductionPromptOptions): string {
    const research_summary = options.research_summary ?? ''
    const language = options.language ?? this.cfg.language ?? 'english'
    const report_format = options.report_format ?? this.cfg.reportFormat ?? 'APA'

    return `${research_summary}\n
Using the above latest information, Prepare a detailed report introduction on the topic -- ${options.question}.
- The introduction should be succinct, well-structured, informative with markdown syntax.
- As this introduction will be part of a larger report, do NOT include any other sections, which are generally present in a report.
- The introduction should be preceded by an H1 heading with a suitable topic for the entire report.
- You must use in-text citation references in ${report_format.toUpperCase()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
Assume that the current date is ${utcDateStamp()} if required.
- The output must be in ${language} language.
`
  }

  /**
   * Generates a concise conclusion summarizing the main findings and
   * implications of a research report.
   *
   * @param options - the research task, the report content, language and report format.
   * @returns the report conclusion prompt.
   */
  generate_report_conclusion(options: ReportConclusionPromptOptions): string {
    const query = options.query
    const report_content = options.report_content ?? ''
    const language = options.language ?? this.cfg.language ?? 'english'
    const report_format = options.report_format ?? this.cfg.reportFormat ?? 'APA'

    // The trailing 4 spaces are upstream's closing `"""` indentation.
    const prompt =
      `
    Based on the research report below and research task, please write a concise conclusion that summarizes the main findings and their implications:

    Research task: ${query}

    Research Report: ${report_content}

    Your conclusion should:
    1. Recap the main points of the research
    2. Highlight the most important findings
    3. Discuss any implications or next steps
    4. Be approximately 2-3 paragraphs long

    If there is no "## Conclusion" section title written at the end of the report, please add it to the top of your conclusion.
    You must use in-text citation references in ${report_format.toUpperCase()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).

    IMPORTANT: The entire conclusion MUST be written in ${language} language.

    Write the conclusion:
` + '    '

    return prompt
  }
}

/** A constructor for a {@link PromptFamily} subclass. */
type PromptFamilyCtor = new (config: Config) => PromptFamily

/** Upstream `Granite3PromptFamily._DOCUMENTS_PREFIX`. */
const GRANITE3_DOCUMENTS_PREFIX = '<|start_of_role|>documents<|end_of_role|>\n'
/** Upstream `Granite3PromptFamily._DOCUMENTS_SUFFIX`. */
const GRANITE3_DOCUMENTS_SUFFIX = '\n<|end_of_text|>'

/** Upstream `Granite33PromptFamily._DOCUMENT_TEMPLATE`, with `{{field}}` markers. */
const GRANITE33_DOCUMENT_TEMPLATE =
  '<|start_of_role|>document {"document_id": "{{document_id}}"}<|end_of_role|>\n{{document_content}}<|end_of_text|>\n'

/**
 * Render the granite 3.3 per-document template (upstream
 * `_DOCUMENT_TEMPLATE.format(...)`).
 *
 * @param document_id - the document id, usually its source.
 * @param document_content - the document body.
 * @returns the formatted document block.
 */
function granite33Document(document_id: string, document_content: string): string {
  return GRANITE33_DOCUMENT_TEMPLATE.replaceAll('{{document_id}}', () => document_id).replaceAll(
    '{{document_content}}',
    () => document_content,
  )
}

/**
 * Prompts for IBM's granite models; delegates to the version-specific family
 * based on the configured smart model (upstream `GranitePromptFamily`).
 */
export class GranitePromptFamily extends PromptFamily {
  /**
   * Get the right granite prompt family based on the version number.
   *
   * @returns the family class to delegate to.
   */
  private _get_granite_class(): PromptFamilyCtor {
    const smart_llm = String(this.cfg.smartLlm ?? '')
    if (smart_llm.includes('3.3')) return Granite33PromptFamily
    if (smart_llm.includes('3')) return Granite3PromptFamily
    // If not a known version, return the default
    return PromptFamily
  }

  /**
   * Compress the list of documents using the granite-version-specific format.
   *
   * @param docs - the documents to compress.
   * @param top_n - keep only the first `top_n` documents; default keeps all.
   * @returns the compressed context string.
   */
  override pretty_print_docs(docs: readonly DocumentChunk[], top_n?: number): string {
    return new (this._get_granite_class())(this.cfg).pretty_print_docs(docs, top_n)
  }

  /**
   * Joins local and web documents using the granite-version-specific format.
   *
   * @param docs_context - context from local documents.
   * @param web_context - context from web sources.
   * @returns the joined context.
   */
  override join_local_web_documents(
    docs_context: string | string[],
    web_context: string | string[],
  ): string {
    return new (this._get_granite_class())(this.cfg).join_local_web_documents(
      docs_context,
      web_context,
    )
  }
}

/**
 * Prompts for IBM's granite 3.X models (before 3.3); upstream
 * `Granite3PromptFamily`.
 */
export class Granite3PromptFamily extends PromptFamily {
  /** Upstream `Granite3PromptFamily._DOCUMENTS_PREFIX`. */
  static readonly _DOCUMENTS_PREFIX = GRANITE3_DOCUMENTS_PREFIX
  /** Upstream `Granite3PromptFamily._DOCUMENTS_SUFFIX`. */
  static readonly _DOCUMENTS_SUFFIX = GRANITE3_DOCUMENTS_SUFFIX

  /**
   * Compress the list of documents into granite's `documents` role block.
   *
   * @param docs - the documents to compress.
   * @param top_n - keep only the first `top_n` documents; default keeps all.
   * @returns the compressed context string.
   */
  override pretty_print_docs(docs: readonly DocumentChunk[], top_n?: number): string {
    if (docs.length === 0) return ''

    const all_documents = docs
      .filter((_, i) => top_n === undefined || i < top_n)
      .map(
        (doc, i) =>
          `Document ${pyText(metadataOr(doc.metadata, 'source', i))}\n` +
          `Title: ${pyText(doc.metadata.title)}\n` +
          doc.page_content,
      )
      .join('\n\n')

    return [GRANITE3_DOCUMENTS_PREFIX, all_documents, GRANITE3_DOCUMENTS_SUFFIX].join('')
  }

  /**
   * Joins local web documents using Granite's preferred format.
   *
   * @param docs_context - context from local documents.
   * @param web_context - context from web sources.
   * @returns the joined context in granite's `documents` role block.
   */
  override join_local_web_documents(
    docs_context: string | string[],
    web_context: string | string[],
  ): string {
    let local: string | string[] = docs_context
    let web: string | string[] = web_context
    if (typeof local === 'string' && local.startsWith(GRANITE3_DOCUMENTS_PREFIX)) {
      local = local.slice(GRANITE3_DOCUMENTS_PREFIX.length)
    }
    if (typeof web === 'string' && web.endsWith(GRANITE3_DOCUMENTS_SUFFIX)) {
      web = web.slice(0, -GRANITE3_DOCUMENTS_SUFFIX.length)
    }
    const all_documents = `${asText(local)}\n\n${asText(web)}`
    return [GRANITE3_DOCUMENTS_PREFIX, all_documents, GRANITE3_DOCUMENTS_SUFFIX].join('')
  }
}

/**
 * Prompts for IBM's granite 3.3 models; upstream `Granite33PromptFamily`.
 */
export class Granite33PromptFamily extends PromptFamily {
  /**
   * The document content, prefixed with a `Title:` line when the document has
   * a title (upstream `_get_content`).
   *
   * @param doc - the document.
   * @returns the trimmed document content.
   */
  private static _get_content(doc: DocumentChunk): string {
    let doc_content = doc.page_content
    const title = doc.metadata.title
    if (title) {
      doc_content = `Title: ${pyText(title)}\n${doc_content}`
    }
    return doc_content.trim()
  }

  /**
   * Compress the list of documents into granite 3.3 document blocks.
   *
   * @param docs - the documents to compress.
   * @param top_n - keep only the first `top_n` documents; default keeps all.
   * @returns the compressed context string.
   */
  override pretty_print_docs(docs: readonly DocumentChunk[], top_n?: number): string {
    return docs
      .filter((_, i) => top_n === undefined || i < top_n)
      .map((doc, i) =>
        granite33Document(
          pyText(metadataOr(doc.metadata, 'source', i)),
          Granite33PromptFamily._get_content(doc),
        ),
      )
      .join('\n')
  }

  /**
   * Joins local web documents using Granite's preferred format.
   *
   * @param docs_context - context from local documents.
   * @param web_context - context from web sources.
   * @returns the joined context.
   */
  override join_local_web_documents(
    docs_context: string | string[],
    web_context: string | string[],
  ): string {
    return `${asText(docs_context)}\n\n${asText(web_context)}`
  }
}

// Factory //////////////////////////////////////////////////////////////////////

/**
 * Map of report type to the prompt-generator method that renders it.
 *
 * Verbatim upstream: `detailed_report` is deliberately absent, so a detailed
 * report falls back to the research-report prompt (see
 * {@link get_prompt_by_report_type}). Note that `custom_report` and `deep` are
 * the odd ones out: their generators take different arguments.
 */
export const report_type_mapping: Record<string, string> = {
  research_report: 'generate_report_prompt',
  resource_report: 'generate_resource_report_prompt',
  outline_report: 'generate_outline_report_prompt',
  custom_report: 'generate_custom_report_prompt',
  subtopic_report: 'generate_subtopic_report_prompt',
  deep: 'generate_deep_research_prompt',
}

/**
 * Look up the prompt generator bound to a report type.
 *
 * DEVIATION: upstream calls `warnings.warn(...)` before falling back when the
 * report type is unknown (including `detailed_report`, which upstream's mapping
 * omits); this port has no warning channel, so unknown types fall back silently
 * to the research-report prompt.
 *
 * @param report_type - the report type name.
 * @param prompt_family - the family whose method should be bound.
 * @returns the bound prompt generator (a `generate_report_prompt`-style
 *   callable, or the single-options `generate_subtopic_report_prompt` for
 *   `subtopic_report`).
 */
export function get_prompt_by_report_type(
  report_type: string,
  prompt_family: PromptFamily,
): PromptGenerator {
  // Upstream: getattr(prompt_family, report_type_mapping.get(report_type, ""), None)
  const methods = prompt_family as unknown as Record<string, PromptGenerator>
  const method_name = report_type_mapping[report_type] ?? ''
  const prompt_by_type = method_name ? methods[method_name] : undefined
  if (typeof prompt_by_type === 'function') {
    return prompt_by_type.bind(prompt_family)
  }

  const default_report_type = 'research_report'
  const fallback_name = report_type_mapping[default_report_type] ?? 'generate_report_prompt'
  const fallback = methods[fallback_name]
  if (typeof fallback !== 'function') {
    // Unreachable for a well-formed PromptFamily; present for the type checker.
    throw new TypeError(`PromptFamily is missing ${fallback_name}`)
  }
  return fallback.bind(prompt_family)
}

/**
 * Map of prompt family name to its class, matching upstream's
 * `prompt_family_mapping` (which keys off `utils.enum.PromptFamily` values).
 */
const prompt_family_mapping: Record<string, PromptFamilyCtor> = {
  default: PromptFamily,
  granite: GranitePromptFamily,
  granite3: Granite3PromptFamily,
  'granite3.1': Granite3PromptFamily,
  'granite3.2': Granite3PromptFamily,
  'granite3.3': Granite33PromptFamily,
}

/**
 * Get a prompt family by name.
 *
 * DEVIATION: upstream calls `warnings.warn(...)` and then `PromptFamily()` (no
 * config, so `cfg` would be missing) for an unknown name; this port falls back
 * silently to the default family *with* the supplied config.
 *
 * @param name - the family name (`default`, `granite`, `granite3`,
 *   `granite3.1`, `granite3.2`, `granite3.3`).
 * @param config - the resolved plugin configuration.
 * @returns the requested family, or the default family for an unknown name.
 */
export function get_prompt_family(name: string, config: Config): PromptFamily {
  const family = prompt_family_mapping[name]
  if (family) return new family(config)
  return new PromptFamily(config)
}
