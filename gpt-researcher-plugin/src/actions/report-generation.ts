/**
 * Report generation — the port of
 * `gpt_researcher/actions/report_generation.py`.
 *
 * Every report type funnels through {@link generateReport}, which picks the
 * prompt by report type exactly as upstream's `get_prompt_by_report_type` does,
 * then calls the smart model at temperature 0.35 (0.25 for the intro/conclusion
 * helpers). Upstream's fallback of retrying with the role prompt inlined as a
 * user message is preserved: some providers reject a system role.
 *
 * @module gpt-researcher/actions/report-generation
 */

import type { EngineDeps } from '../deps.ts'
import { callLlm, isAbortError, throwIfAborted } from '../llm/call.ts'
import type { ReportSource, ReportType } from '../types.ts'

/** Shared report options, mirroring upstream's `generate_report` kwargs. */
export interface ReportOptions {
  query: string
  context: unknown
  agentRolePrompt: string
  reportType: ReportType
  tone: string
  reportSource: ReportSource
  /** Only for `subtopic_report`. */
  mainTopic?: string
  existingHeaders?: string[]
  relevantWrittenContents?: string[]
  /** Overrides the assembled prompt entirely (upstream `custom_prompt`). */
  customPrompt?: string
  signal?: AbortSignal
}

/**
 * Generate the report body (upstream `generate_report`).
 *
 * @param deps - engine dependencies.
 * @param options - report inputs.
 * @returns the report markdown, or an empty string when both attempts fail.
 */
export async function generateReport(
  deps: EngineDeps,
  options: ReportOptions,
): Promise<string> {
  const cfg = deps.config
  const reportFormat = cfg.reportFormat
  const totalWords = cfg.totalWords
  const language = cfg.language

  let content: string
  if (options.reportType === 'subtopic_report') {
    content = deps.prompts.generate_subtopic_report_prompt({
      current_subtopic: options.query,
      existing_headers: options.existingHeaders ?? [],
      relevant_written_contents: options.relevantWrittenContents ?? [],
      main_topic: options.mainTopic ?? '',
      context: options.context,
      report_format: reportFormat,
      tone: options.tone,
      total_words: totalWords,
      language,
    })
  } else if (options.customPrompt) {
    content = `${options.customPrompt}\n\nContext: ${asText(options.context)}`
  } else {
    const shared = {
      report_format: reportFormat,
      tone: options.tone,
      total_words: totalWords,
      language,
      report_source: options.reportSource,
    }
    switch (options.reportType) {
      case 'resource_report':
        content = deps.prompts.generate_resource_report_prompt(
          options.query,
          options.context,
          shared,
        )
        break
      case 'outline_report':
        content = deps.prompts.generate_outline_report_prompt(
          options.query,
          options.context,
          shared,
        )
        break
      case 'custom_report':
        content = deps.prompts.generate_custom_report_prompt(
          options.query,
          options.context,
          shared,
        )
        break
      case 'deep':
        content = deps.prompts.generate_deep_research_prompt(
          options.query,
          options.context,
          shared,
        )
        break
      default:
        content = deps.prompts.generate_report_prompt(
          options.query,
          options.context,
          options.reportSource,
          shared,
        )
    }
  }

  try {
    return (
      await callLlm(deps, {
        tier: 'smart',
        messages: [
          { role: 'system', content: options.agentRolePrompt },
          { role: 'user', content },
        ],
        temperature: 0.35,
        maxTokens: cfg.smartTokenLimit,
        step: 'report_writing',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    ).text
  } catch (error) {
    // Cancellation is not a "the provider rejected the system role" case: it
    // must stop the run, not trigger a second doomed call.
    if (isAbortError(error) || options.signal?.aborted || deps.runtime.signal?.aborted) {
      throw error
    }
    deps.runtime.log.warn(
      `report generation with a system role failed (${
        error instanceof Error ? error.message : String(error)
      }); retrying with the role inlined`,
    )
    try {
      return (
        await callLlm(deps, {
          tier: 'smart',
          messages: [{ role: 'user', content: `${options.agentRolePrompt}\n\n${content}` }],
          temperature: 0.35,
          maxTokens: cfg.smartTokenLimit,
          step: 'report_writing',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      ).text
    } catch (secondError) {
      if (isAbortError(secondError) || options.signal?.aborted || deps.runtime.signal?.aborted) {
        throw secondError
      }
      deps.runtime.log.error(
        `report generation failed: ${
          secondError instanceof Error ? secondError.message : String(secondError)
        }`,
      )
      throw secondError
    }
  }
}

/**
 * Write the report introduction (upstream `write_report_introduction`).
 *
 * @param deps - engine dependencies.
 * @param options - query, research summary, role prompt.
 * @returns the introduction markdown (empty string on failure, as upstream).
 */
export async function writeReportIntroduction(
  deps: EngineDeps,
  options: {
    query: string
    context: unknown
    agentRolePrompt: string
    signal?: AbortSignal
  },
): Promise<string> {
  try {
    return (
      await callLlm(deps, {
        tier: 'smart',
        messages: [
          { role: 'system', content: options.agentRolePrompt },
          {
            role: 'user',
            content: deps.prompts.generate_report_introduction({
              question: options.query,
              research_summary: asText(options.context),
              language: deps.config.language,
            }),
          },
        ],
        temperature: 0.25,
        maxTokens: deps.config.smartTokenLimit,
        step: 'report_writing',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    ).text
  } catch (error) {
    if (isAbortError(error)) throw error
    deps.runtime.log.error(
      `introduction generation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return ''
  }
}

/**
 * Write the report conclusion (upstream `write_conclusion`).
 *
 * @param deps - engine dependencies.
 * @param options - query, report body, role prompt.
 * @returns the conclusion markdown (empty string on failure).
 */
export async function writeConclusion(
  deps: EngineDeps,
  options: {
    query: string
    context: string
    agentRolePrompt: string
    signal?: AbortSignal
  },
): Promise<string> {
  try {
    return (
      await callLlm(deps, {
        tier: 'smart',
        messages: [
          { role: 'system', content: options.agentRolePrompt },
          {
            role: 'user',
            content: deps.prompts.generate_report_conclusion({
              query: options.query,
              report_content: options.context,
              language: deps.config.language,
            }),
          },
        ],
        temperature: 0.25,
        maxTokens: deps.config.smartTokenLimit,
        step: 'report_writing',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    ).text
  } catch (error) {
    if (isAbortError(error)) throw error
    deps.runtime.log.error(
      `conclusion generation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return ''
  }
}

/**
 * Generate draft section titles for a subtopic (upstream
 * `generate_draft_section_titles`).
 *
 * @param deps - engine dependencies.
 * @param options - the subtopic, the parent query, context, role prompt.
 * @returns the titles, split on newlines as upstream does.
 */
export async function generateDraftSectionTitles(
  deps: EngineDeps,
  options: {
    query: string
    currentSubtopic: string
    context: unknown
    role: string
    signal?: AbortSignal
  },
): Promise<string[]> {
  try {
    const text = (
      await callLlm(deps, {
        tier: 'smart',
        messages: [
          { role: 'system', content: options.role },
          {
            role: 'user',
            content: deps.prompts.generate_draft_titles_prompt(
              options.currentSubtopic,
              options.query,
              options.context,
            ),
          },
        ],
        temperature: 0.25,
        maxTokens: deps.config.smartTokenLimit,
        step: 'report_writing',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    ).text
    return text.split('\n')
  } catch (error) {
    if (isAbortError(error)) throw error
    deps.runtime.log.error(
      `draft title generation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

/**
 * Summarise one URL's content (upstream `summarize_url`).
 *
 * @param deps - engine dependencies.
 * @param options - URL, content, role prompt.
 * @returns the summary (empty string on failure).
 */
export async function summarizeUrl(
  deps: EngineDeps,
  options: { url: string; content: string; role: string; signal?: AbortSignal },
): Promise<string> {
  try {
    return (
      await callLlm(deps, {
        tier: 'smart',
        messages: [
          { role: 'system', content: options.role },
          {
            role: 'user',
            content: `Summarize the following content from ${options.url}:\n\n${options.content}`,
          },
        ],
        temperature: 0.25,
        maxTokens: deps.config.smartTokenLimit,
        step: 'summarizing',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    ).text
  } catch (error) {
    if (isAbortError(error)) throw error
    deps.runtime.log.error(
      `URL summarisation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return ''
  }
}

/** Render a context value as text, mirroring how upstream f-strings render it. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map((item) => asText(item)).join('\n')
  return JSON.stringify(value)
}
