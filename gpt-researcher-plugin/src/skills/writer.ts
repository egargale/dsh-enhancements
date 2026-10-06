/**
 * Report generator skill — the port of
 * `gpt_researcher/skills/writer.py`.
 *
 * Every public method answers "produce prose from research state": the body,
 * the introduction, the conclusion, the subtopic list, and the draft section
 * titles used to keep a long report from repeating itself.
 *
 * @module gpt-researcher/skills/writer
 */

import type { GptResearcher } from '../agent.ts'
import {
  generateDraftSectionTitles,
  generateReport,
  writeConclusion,
  writeReportIntroduction,
} from '../actions/report-generation.ts'
import { callLlm, isAbortError } from '../llm/call.ts'
import { asContextText } from '../utils/text.ts'
import { parseSubtopics, renderSubtopicsPrompt } from '../utils/subtopics.ts'
import type { ReportType } from '../types.ts'

/** Options for {@link ReportGenerator.writeReport}. */
export interface WriteReportOptions {
  existingHeaders?: Array<Record<string, unknown>>
  relevantWrittenContents?: string[]
  /** Overrides the researcher's accumulated context. */
  extContext?: unknown
  /** A caller-supplied prompt that replaces the report prompt. */
  customPrompt?: string
}

/** Report prose generation. */
export class ReportGenerator {
  readonly #agent: GptResearcher

  constructor(agent: GptResearcher) {
    this.#agent = agent
  }

  /** The role prompt used as the system message (upstream `agent_role_prompt`). */
  get agentRolePrompt(): string {
    return this.#agent.deps.config.agentRole ?? this.#agent.role
  }

  /**
   * Write the report (upstream `write_report`).
   *
   * Upstream streams the selected images before writing and appends an
   * "AVAILABLE IMAGES" block to the prompt; this port keeps the progress event
   * and the image list, and adds one diagnostic (not present upstream) when the
   * context is empty, so a report generated without sources is visible in the
   * session log rather than silently invented.
   *
   * @param options - headers/contents from earlier subtopics, context override.
   * @returns the report markdown.
   */
  async writeReport(options: WriteReportOptions = {}): Promise<string> {
    const agent = this.#agent
    const researchImages = agent.getResearchImages()
    if (researchImages.length > 0) {
      agent.deps.runtime.progress({
        type: 'images',
        step: 'selected_images',
        message: JSON.stringify(researchImages),
        data: researchImages,
      })
    }

    const context = options.extContext ?? agent.context
    if (asContextText(context).trim().length === 0) {
      // // DEVIATION (improvement over upstream): upstream asks the model to
      // // write a report from an empty context, which produces an invented,
      // // uncited report that is then stored and published as a success. This
      // // port abstains explicitly instead, so the caller can tell the
      // // difference between "no sources" and "a report we trust".
      agent.deps.runtime.log.warn(
        'no research context was gathered; returning an explicit abstention instead of inventing a report',
      )
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'no_source_material',
        message: `🧐 I could not gather any source material for '${agent.query}'.`,
      })
      return (
        `I could not gather any source material for "${agent.query}". ` +
        'No sources were retrieved (searches may have returned nothing or been blocked), ' +
        'so I am not able to produce a reliable, sourced report.'
      )
    }

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'writing_report',
      message: `✍️ Writing report for '${agent.query}'...`,
    })

    const report = await generateReport(agent.deps, {
      query: agent.query,
      context,
      agentRolePrompt: this.agentRolePrompt,
      reportType: agent.reportType as ReportType,
      tone: agent.tone,
      reportSource: agent.reportSource,
      ...(agent.reportType === 'subtopic_report'
        ? {
            mainTopic: agent.parentQuery,
            existingHeaders: (options.existingHeaders ?? []).map((header) =>
              JSON.stringify(header),
            ),
            relevantWrittenContents: options.relevantWrittenContents ?? [],
          }
        : {}),
      ...(options.customPrompt ? { customPrompt: options.customPrompt } : {}),
    })

    agent.deps.runtime.progress({
      type: 'logs',
      step: 'report_written',
      message: `📝 Report written for '${agent.query}'`,
    })
    return report
  }

  /**
   * Write the conclusion (upstream `write_report_conclusion`).
   *
   * @param reportContent - the report body to conclude.
   * @returns the conclusion markdown.
   */
  async writeReportConclusion(reportContent: string): Promise<string> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'writing_conclusion',
      message: `✍️ Writing conclusion for '${agent.query}'...`,
    })
    const conclusion = await writeConclusion(agent.deps, {
      query: agent.query,
      context: reportContent,
      agentRolePrompt: this.agentRolePrompt,
    })
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'conclusion_written',
      message: `📝 Conclusion written for '${agent.query}'`,
    })
    return conclusion
  }

  /**
   * Write the introduction (upstream `write_introduction`).
   *
   * @returns the introduction markdown.
   */
  async writeIntroduction(): Promise<string> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'writing_introduction',
      message: `✍️ Writing introduction for '${agent.query}'...`,
    })
    const introduction = await writeReportIntroduction(agent.deps, {
      query: agent.query,
      context: agent.context,
      agentRolePrompt: this.agentRolePrompt,
    })
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'introduction_written',
      message: `📝 Introduction written for '${agent.query}'`,
    })
    return introduction
  }

  /**
   * Build the subtopic list (upstream `get_subtopics` →
   * `construct_subtopics`). On any failure the caller-supplied subtopics (or an
   * empty list) are returned, exactly as upstream does.
   *
   * @returns the subtopic task names.
   */
  async getSubtopics(): Promise<string[]> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'generating_subtopics',
      message: `🌳 Generating subtopics for '${agent.query}'...`,
    })

    const prompt = renderSubtopicsPrompt(agent.deps.prompts, {
      task: agent.query,
      data: asContextText(agent.context),
      existingSubtopics: agent.subtopics,
      maxSubtopics: agent.deps.config.maxSubtopics,
    })

    try {
      const response = await callLlm(agent.deps, {
        tier: 'smart',
        messages: [{ role: 'user', content: prompt }],
        temperature: agent.deps.config.temperature,
        maxTokens: agent.deps.config.smartTokenLimit,
        step: 'report_writing',
      })
      const subtopics = parseSubtopics(response.text, agent.deps.config.maxSubtopics)
      agent.deps.runtime.progress({
        type: 'logs',
        step: 'subtopics_generated',
        message: `📊 Subtopics generated for '${agent.query}'`,
        data: subtopics,
      })
      return subtopics
    } catch (error) {
      if (isAbortError(error) || agent.deps.runtime.signal?.aborted) throw error
      agent.deps.runtime.log.error(
        `subtopic construction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return [...agent.subtopics]
    }
  }

  /**
   * Draft section titles for one subtopic (upstream
   * `get_draft_section_titles`).
   *
   * @param currentSubtopic - the subtopic being written.
   * @returns the draft titles, newline-separated upstream and split here.
   */
  async getDraftSectionTitles(currentSubtopic: string): Promise<string[]> {
    const agent = this.#agent
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'generating_draft_sections',
      message: `📑 Generating draft section titles for '${agent.query}'...`,
    })
    const titles = await generateDraftSectionTitles(agent.deps, {
      query: agent.query,
      currentSubtopic,
      context: agent.context,
      role: this.agentRolePrompt,
    })
    agent.deps.runtime.progress({
      type: 'logs',
      step: 'draft_sections_generated',
      message: `🗂️ Draft section titles generated for '${agent.query}'`,
      data: titles,
    })
    return titles
  }
}
