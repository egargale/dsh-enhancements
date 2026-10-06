/**
 * Unit tests for the prompt templates (`src/prompts.ts`), the port of
 * `gpt_researcher/prompts.py`.
 *
 * The suite has three jobs: cover the generated text the engine depends on,
 * cover the factory functions and document formatters, and — in the fidelity
 * blocks — assert literal strings copied character-for-character out of the
 * Python source, which is the guarantee this module exists for.
 *
 * Every test builds a hermetic {@link Config} (no config file, no environment)
 * so the rendered prompts are deterministic.
 *
 * @module gpt-researcher/test/unit/prompts
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config } from '../../src/config.ts'
import {
  Granite33PromptFamily,
  Granite3PromptFamily,
  GranitePromptFamily,
  PromptFamily,
  get_prompt_by_report_type,
  get_prompt_family,
  report_type_mapping,
} from '../../src/prompts.ts'
import { TONES } from '../../src/types.ts'
import type { DocumentChunk } from '../../src/types.ts'

/**
 * Build a hermetic config: defaults only, ignoring the ambient environment.
 *
 * @param overrides - uppercase config overrides applied on top of the defaults.
 * @returns the resolved configuration.
 */
function makeConfig(overrides: Record<string, string | number | boolean> = {}): Config {
  return new Config({ env: () => undefined, overrides })
}

/** A prompt family backed by the default hermetic config. */
function makePrompts(overrides: Record<string, string | number | boolean> = {}): PromptFamily {
  return new PromptFamily(makeConfig(overrides))
}

const QUESTION = 'What is quantum computing?'
const CONTEXT = 'Context line one.\nContext line two.'

test('generate_search_queries_prompt renders query, parent query, iterations and literal sentences', () => {
  const prompts = makePrompts()
  const rendered = prompts.generate_search_queries_prompt(
    QUESTION,
    'parent question',
    'detailed_report',
    { max_iterations: 4, context: 'fresh news about chips' },
  )

  assert.ok(rendered.includes(`"parent question - ${QUESTION}"`))
  assert.ok(rendered.includes('Write 4 search queries to research the following task:'))
  assert.ok(rendered.includes('"query 1", "query 2", "query 3", "query 4"'))
  assert.ok(
    rendered.includes(
      'Each query must be a plain natural language phrase. Do not use search operator syntax',
    ),
  )
  assert.ok(
    rendered.includes(
      'such as site:, filetype:, inurl:, intitle:, OR, AND, or NOT — these operators are\nnot universally supported and will return empty results on many search backends.',
    ),
  )
  assert.ok(rendered.includes('Assume the current date is '))
  assert.ok(rendered.includes('Context: fresh news about chips'))
  assert.ok(rendered.includes('The response should contain ONLY the list.'))
})

test('generate_search_queries_prompt omits the context block when there is no context', () => {
  const prompts = makePrompts()

  const without = prompts.generate_search_queries_prompt(QUESTION, '', 'research_report')
  const empty = prompts.generate_search_queries_prompt(QUESTION, '', 'research_report', {
    context: [],
  })
  const withContext = prompts.generate_search_queries_prompt(QUESTION, '', 'research_report', {
    context: 'something',
  })

  assert.ok(!without.includes('You are a seasoned research assistant'))
  assert.equal(without, empty)
  assert.ok(withContext.includes('You are a seasoned research assistant'))
  assert.notEqual(withContext, without)
})

test('generate_search_queries_prompt only prefixes the parent query for sub-reports', () => {
  const prompts = makePrompts()

  const research = prompts.generate_search_queries_prompt(QUESTION, 'parent', 'research_report')
  const subtopic = prompts.generate_search_queries_prompt(QUESTION, 'parent', 'subtopic_report')

  assert.ok(research.includes(`task: "${QUESTION}"`))
  assert.ok(subtopic.includes(`task: "parent - ${QUESTION}"`))
})

test('generate_report_prompt contains query, tone, words, language and format', () => {
  const prompts = makePrompts()
  const tone = TONES.Formal
  const rendered = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web', {
    report_format: 'MLA',
    tone,
    total_words: 900,
    language: 'french',
  })

  assert.ok(rendered.includes(`Information: "${CONTEXT}"`))
  assert.ok(rendered.includes(`answer the following query or task: "${QUESTION}"`))
  assert.ok(rendered.includes(`Write the report in a ${tone} tone.`))
  assert.ok(rendered.includes('at least 900 words'))
  assert.ok(rendered.includes('You MUST write the report in the following language: french.'))
  assert.ok(rendered.includes('markdown syntax and MLA format'))
  assert.ok(rendered.includes('citation references in MLA format'))
})

test('generate_report_prompt changes with each option and defaults to the config values', () => {
  const prompts = makePrompts()
  const defaults = { report_format: 'APA', total_words: 1200, language: 'english' }
  const base = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web', defaults)

  for (const [key, value] of [
    ['report_format', 'IEEE'],
    ['tone', TONES.Critical],
    ['total_words', 4321],
    ['language', 'german'],
  ] as const) {
    const changed = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web', {
      ...defaults,
      [key]: value,
    })
    assert.notEqual(changed, base, `${key} did not change the prompt`)
    assert.ok(changed.includes(String(value)))
  }

  // Omitting every option reproduces a default-config run (upstream passed
  // cfg.report_format / cfg.total_words / cfg.language at every call site).
  const omitted = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web')
  assert.equal(omitted, base)
  assert.ok(omitted.includes('at least 1200 words'))
  assert.ok(omitted.includes('following language: english.'))
  assert.ok(omitted.includes('markdown syntax and APA format'))

  // A report-specific config is what an omitted option falls back to.
  const frenchPrompts = makePrompts({ REPORT_FORMAT: 'Harvard', TOTAL_WORDS: 250, LANGUAGE: 'spanish' })
  const frenchDefaults = frenchPrompts.generate_report_prompt(QUESTION, CONTEXT, 'web')
  assert.ok(frenchDefaults.includes('at least 250 words'))
  assert.ok(frenchDefaults.includes('following language: spanish.'))
  assert.ok(frenchDefaults.includes('markdown syntax and Harvard format'))

  // No tone means no tone line at all.
  const noTone = omitted
  assert.ok(!noTone.includes('Write the report in a'))
})

test('generate_report_prompt switches reference rules by report source', () => {
  const prompts = makePrompts()

  const web = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web')
  const local = prompts.generate_report_prompt(QUESTION, CONTEXT, 'local')

  assert.ok(
    web.includes(
      'You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.',
    ),
  )
  assert.ok(
    local.includes(
      'You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."',
    ),
  )
  assert.notEqual(web, local)
})

test('generate_subtopic_report_prompt includes the topic, headers and previous contents', () => {
  const prompts = makePrompts()
  const rendered = prompts.generate_subtopic_report_prompt({
    current_subtopic: 'Subtopic One',
    existing_headers: ['## Existing One', '## Existing Two'],
    relevant_written_contents: ['Some previously written content.'],
    main_topic: 'Main Topic',
    context: CONTEXT,
    report_format: 'apa',
    tone: TONES.Formal,
    total_words: 777,
    language: 'english',
  })

  assert.ok(rendered.includes(`"${CONTEXT}"`))
  assert.ok(
    rendered.includes(
      'construct a detailed report on the subtopic: Subtopic One under the main topic: Main Topic.',
    ),
  )
  assert.ok(rendered.includes("    ['## Existing One', '## Existing Two']"))
  assert.ok(rendered.includes("    ['Some previously written content.']"))
  assert.ok(rendered.includes('You must limit the number of subsections to a maximum of 5.'))
  assert.ok(rendered.includes('follow the APA format'))
  assert.ok(rendered.includes(`Use an ${TONES.Formal} tone throughout the report.`))
  assert.ok(rendered.includes('minimum length of 777 words'))
  assert.ok(rendered.includes('following language: english.'))
  assert.ok(rendered.includes('Do NOT add a conclusion section.'))
})

test('generate_subtopics_prompt returns the unfilled template', () => {
  const rendered = makePrompts().generate_subtopics_prompt()

  assert.ok(rendered.length > 0)
  assert.ok(rendered.includes('Provided the main topic:'))
  assert.ok(rendered.includes('{task}'))
  assert.ok(rendered.includes('{data}'))
  assert.ok(rendered.includes('{subtopics}'))
  assert.ok(rendered.includes('{max_subtopics}'))
  assert.ok(rendered.includes('{format_instructions}'))
  assert.ok(
    rendered.includes(
      '- Every subtopic MUST be relevant to the main topic and provided research data ONLY!',
    ),
  )
  assert.ok(rendered.startsWith('\n'))
  assert.ok(rendered.endsWith('\n'))
})

test('auto_agent_instructions returns the agent framing with its examples', () => {
  const rendered = makePrompts().auto_agent_instructions()

  assert.ok(rendered.length > 0)
  assert.ok(
    rendered.includes(
      'This task involves researching a given topic, regardless of its complexity or the availability of a definitive answer.',
    ),
  )
  assert.ok(rendered.includes('"server": "💰 Finance Agent"'))
  assert.ok(rendered.includes('"server":  "📈 Business Analyst Agent"'))
  assert.ok(rendered.includes('"server":  "🌍 Travel Agent"'))

  // The engine calls it through an instance; the upstream static spelling works too.
  assert.equal(rendered, PromptFamily.auto_agent_instructions())
})

test('generate_draft_titles_prompt, introduction and conclusion render their inputs', () => {
  const prompts = makePrompts()

  const titles = prompts.generate_draft_titles_prompt('Subtopic One', 'Main Topic', CONTEXT)
  assert.ok(titles.includes(`"${CONTEXT}"`))
  assert.ok(
    titles.includes(
      'construct a draft section title headers for a detailed report on the subtopic: Subtopic One under the main topic: Main Topic.',
    ),
  )
  assert.ok(titles.includes('### Header 1'))

  const introduction = prompts.generate_report_introduction({
    question: QUESTION,
    research_summary: 'Summary text',
    language: 'english',
    report_format: 'apa',
  })
  assert.ok(introduction.startsWith('Summary text\n\n'))
  assert.ok(introduction.includes(`Prepare a detailed report introduction on the topic -- ${QUESTION}.`))
  assert.ok(introduction.includes('citation references in APA format'))
  assert.ok(introduction.includes('The output must be in english language.'))

  const conclusion = prompts.generate_report_conclusion({
    query: QUESTION,
    report_content: 'The report body.',
    language: 'english',
    report_format: 'apa',
  })
  assert.ok(conclusion.includes(`    Research task: ${QUESTION}`))
  assert.ok(conclusion.includes('    Research Report: The report body.'))
  assert.ok(conclusion.includes('citation references in APA format'))
  assert.ok(conclusion.includes('MUST be written in english language.'))
})

test('get_prompt_by_report_type binds the generator matching the report type', () => {
  const prompts = makePrompts()
  const shared = {
    report_format: 'apa',
    tone: TONES.Objective,
    total_words: 1000,
    language: 'english',
  }

  const resource = get_prompt_by_report_type('resource_report', prompts)
  assert.ok(
    resource(QUESTION, CONTEXT, shared).includes(
      'generate a bibliography recommendation report for the following question or topic',
    ),
  )

  const outline = get_prompt_by_report_type('outline_report', prompts)
  assert.ok(
    outline(QUESTION, CONTEXT, shared).includes(
      'generate an outline for a research report in Markdown syntax',
    ),
  )

  const custom = get_prompt_by_report_type('custom_report', prompts)
  const customPrompt = custom('Return a haiku.', CONTEXT, shared)
  assert.ok(customPrompt.includes('"' + CONTEXT + '"'))
  assert.ok(customPrompt.includes('Return a haiku.'))

  const deep = get_prompt_by_report_type('deep', prompts)
  assert.ok(
    deep(QUESTION, CONTEXT, shared).includes(
      'Using the following hierarchically researched information and citations:',
    ),
  )

  const subtopic = get_prompt_by_report_type('subtopic_report', prompts)
  assert.ok(
    subtopic({
      current_subtopic: 'Subtopic One',
      existing_headers: ['## One'],
      relevant_written_contents: ['Written.'],
      main_topic: 'Main Topic',
      context: CONTEXT,
    }).includes('subtopic: Subtopic One under the main topic: Main Topic.'),
  )

  const research = get_prompt_by_report_type('research_report', prompts)
  assert.ok(research(QUESTION, CONTEXT, 'web', shared).includes('in a detailed report --'))
})

test('get_prompt_by_report_type falls back silently to the research report', () => {
  const prompts = makePrompts()
  const shared = { report_format: 'apa', total_words: 1000, language: 'english' }

  const expected = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web', shared)

  // An unknown type and `detailed_report` (absent from upstream's mapping)
  // both fall back to `generate_report_prompt`.
  for (const reportType of ['bogus_report', 'detailed_report', '']) {
    const generator = get_prompt_by_report_type(reportType, prompts)
    assert.equal(generator(QUESTION, CONTEXT, 'web', shared), expected)
  }
})

test('report_type_mapping matches upstream, detailed_report included as absent', () => {
  assert.deepEqual(report_type_mapping, {
    research_report: 'generate_report_prompt',
    resource_report: 'generate_resource_report_prompt',
    outline_report: 'generate_outline_report_prompt',
    custom_report: 'generate_custom_report_prompt',
    subtopic_report: 'generate_subtopic_report_prompt',
    deep: 'generate_deep_research_prompt',
  })
  assert.equal('detailed_report' in report_type_mapping, false)
})

test('pretty_print_docs honours top_n, defaulting to every document', () => {
  const prompts = makePrompts()
  const docs: DocumentChunk[] = [
    { page_content: 'Alpha body', metadata: { source: 'https://a', title: 'A' } },
    { page_content: 'Beta body', metadata: {} },
    { page_content: 'Gamma body', metadata: { source: 'https://c', title: 'C' } },
  ]

  assert.equal(prompts.pretty_print_docs([]), '')
  assert.equal(
    prompts.pretty_print_docs(docs),
    'Source: https://a\nTitle: A\nContent: Alpha body\n' +
      '\n' +
      'Source: None\nTitle: None\nContent: Beta body\n' +
      '\n' +
      'Source: https://c\nTitle: C\nContent: Gamma body\n',
  )
  assert.equal(
    prompts.pretty_print_docs(docs, 1),
    'Source: https://a\nTitle: A\nContent: Alpha body\n',
  )
  assert.equal(prompts.pretty_print_docs(docs, 0), '')
  assert.ok(!prompts.pretty_print_docs(docs, 2).includes('Gamma body'))
})

test('join_local_web_documents joins both contexts', () => {
  const prompts = makePrompts()

  assert.equal(
    prompts.join_local_web_documents('local ctx', 'web ctx'),
    'Context from local documents: local ctx\n\nContext from web sources: web ctx',
  )
})

test('granite prompt families override the document formatters', () => {
  const docs: DocumentChunk[] = [
    { page_content: 'Alpha body', metadata: { source: 'https://a', title: 'A' } },
    { page_content: 'Beta body', metadata: {} },
  ]

  const granite3 = new Granite3PromptFamily(makeConfig())
  const granite3Output = granite3.pretty_print_docs(docs)
  assert.ok(granite3Output.startsWith('<|start_of_role|>documents<|end_of_role|>\n'))
  assert.ok(granite3Output.endsWith('\n<|end_of_text|>'))
  assert.ok(granite3Output.includes('Document https://a\nTitle: A\nAlpha body'))
  assert.ok(granite3Output.includes('Document 1\nTitle: None\nBeta body'))
  assert.ok(!granite3.pretty_print_docs(docs, 1).includes('Beta body'))
  assert.equal(granite3.pretty_print_docs([]), '')
  assert.equal(
    granite3.join_local_web_documents('local ctx', 'web ctx'),
    '<|start_of_role|>documents<|end_of_role|>\nlocal ctx\n\nweb ctx\n<|end_of_text|>',
  )

  const granite33 = new Granite33PromptFamily(makeConfig())
  const granite33Output = granite33.pretty_print_docs(docs)
  assert.ok(
    granite33Output.includes(
      '<|start_of_role|>document {"document_id": "https://a"}<|end_of_role|>\nTitle: A\nAlpha body<|end_of_text|>\n',
    ),
  )
  assert.ok(
    granite33Output.includes(
      '<|start_of_role|>document {"document_id": "1"}<|end_of_role|>\nBeta body<|end_of_text|>\n',
    ),
  )
  assert.equal(granite33.join_local_web_documents('local ctx', 'web ctx'), 'local ctx\n\nweb ctx')

  // `GranitePromptFamily` dispatches on the configured smart model.
  const dispatch = (smartLlm: string): string =>
    new GranitePromptFamily(makeConfig({ SMART_LLM: smartLlm })).pretty_print_docs(docs)
  assert.ok(dispatch('openai:granite-3.3-8b').startsWith('<|start_of_role|>document {"document_id"'))
  assert.ok(dispatch('openai:granite-3-8b').startsWith('<|start_of_role|>documents<|end_of_role|>'))
  assert.ok(dispatch('openai:gpt-4.1').startsWith('Source: https://a\n'))
})

test('get_prompt_family maps every upstream name, unknown names to the default', () => {
  const config = makeConfig()

  assert.equal(get_prompt_family('default', config).constructor, PromptFamily)
  assert.equal(get_prompt_family('granite', config).constructor, GranitePromptFamily)
  assert.equal(get_prompt_family('granite3', config).constructor, Granite3PromptFamily)
  assert.equal(get_prompt_family('granite3.1', config).constructor, Granite3PromptFamily)
  assert.equal(get_prompt_family('granite3.2', config).constructor, Granite3PromptFamily)
  assert.equal(get_prompt_family('granite3.3', config).constructor, Granite33PromptFamily)
  assert.equal(get_prompt_family('not-a-family', config).constructor, PromptFamily)
})

test('remaining templates render their inputs', () => {
  const prompts = makePrompts()

  const searchPrompt = prompts.generate_summary_prompt(QUESTION, 'The text to summarize.')
  assert.ok(searchPrompt.startsWith('The text to summarize.\n Using the above text'))
  assert.ok(searchPrompt.includes(`task or query: "${QUESTION}".`))
  assert.ok(searchPrompt.endsWith('etc if available. '))

  const quick = prompts.generate_quick_summary_prompt(QUESTION, CONTEXT)
  assert.ok(quick.includes(`Query: "${QUESTION}"`))
  assert.ok(quick.includes(`Search Results:\n${CONTEXT}`))
  assert.ok(quick.includes('Cite your sources using numbers [1], [2], etc.'))

  const curateInstance = prompts.curate_sources(QUESTION, 'SOURCES', 5)
  assert.equal(curateInstance, PromptFamily.curate_sources(QUESTION, 'SOURCES', 5))
  assert.ok(curateInstance.includes(`research task: "${QUESTION}"`))
  assert.ok(curateInstance.includes('up to 5, focusing on broad coverage and diversity.'))
  assert.ok(curateInstance.includes('SOURCES LIST TO EVALUATE:\nSOURCES'))

  const toolSelection = prompts.generate_mcp_tool_selection_prompt(
    QUESTION,
    [{ name: 'search' }],
    2,
  )
  assert.ok(toolSelection.includes(`RESEARCH QUERY: "${QUESTION}"`))
  assert.ok(toolSelection.includes('select EXACTLY 2 tools'))
  assert.ok(toolSelection.includes('Select exactly 2 tools, ranked by relevance'))
  assert.ok(toolSelection.includes('"name": "search"'))
  assert.ok(toolSelection.includes('"selection_reasoning": "Overall explanation of the selection strategy"'))

  const mcpResearch = prompts.generate_mcp_research_prompt(QUESTION, ['search', 'fetch'])
  assert.ok(mcpResearch.includes(`RESEARCH QUERY: "${QUESTION}"`))
  assert.ok(mcpResearch.includes("AVAILABLE TOOLS: ['search', 'fetch']"))
  assert.ok(mcpResearch.endsWith('comprehensive information.'))

  const analysis = prompts.generate_image_analysis_prompt(
    QUESTION,
    [{ header: 'Header', content: 'x'.repeat(600) }],
    3,
  )
  assert.ok(analysis.includes(`RESEARCH TOPIC: ${QUESTION}`))
  assert.ok(analysis.includes('### Section 1: Header'))
  assert.ok(analysis.includes(`${'x'.repeat(500)}...`))
  assert.ok(!analysis.includes('x'.repeat(501)))
  assert.ok(analysis.endsWith('Return ONLY the JSON, no additional text.'))

  const enhancement = prompts.generate_image_prompt_enhancement(
    'A base prompt',
    'y'.repeat(900),
    'Main Topic',
  )
  assert.ok(enhancement.includes(`RESEARCH TOPIC: Main Topic`))
  assert.ok(enhancement.includes('IMAGE DESCRIPTION: A base prompt'))
  assert.ok(enhancement.includes('y'.repeat(800)))
  assert.ok(!enhancement.includes('y'.repeat(801)))
  assert.ok(enhancement.endsWith('- Suitable for both digital viewing and printing'))
})

test('non-string context is JSON-stringified, not Python repr (documented deviation)', () => {
  const prompts = makePrompts()
  const rendered = prompts.generate_search_queries_prompt(QUESTION, '', 'research_report', {
    max_iterations: 2,
    context: [{ title: 'T' }],
  })

  assert.ok(rendered.includes('Context: [{"title":"T"}]'))
})

// --- Fidelity: literals copied character-for-character from the Python source ---

test('report and deep-research templates carry upstream literals verbatim', () => {
  const prompts = makePrompts()
  const report = prompts.generate_report_prompt(QUESTION, CONTEXT, 'web')
  const deep = prompts.generate_deep_research_prompt(QUESTION, CONTEXT)

  for (const literal of [
    '- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.',
    '- You MUST NOT include a table of contents, but DO include proper markdown headers (# ## ###) to structure your report clearly.',
    "- Don't forget to add a reference list at the end of the report in APA format and full url links without hyperlinks.",
    'Please do your best, this is very important to my career.',
    'eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)',
  ]) {
    assert.ok(report.includes(literal), `report prompt is missing: ${literal}`)
  }

  for (const literal of [
    '2. Integrate findings from various research branches',
    '- Prioritize insights that emerged from deeper levels of research',
    'Please write a thorough, well-researched report that synthesizes all the gathered information into a cohesive whole.',
    '- Write in english',
  ]) {
    assert.ok(deep.includes(literal), `deep research prompt is missing: ${literal}`)
  }
})

test('subtopic and detailed-report templates carry upstream literals verbatim', () => {
  const prompts = makePrompts()
  const subtopics = prompts.generate_subtopics_prompt()
  const subtopic = prompts.generate_subtopic_report_prompt({
    current_subtopic: 'Subtopic One',
    existing_headers: [],
    relevant_written_contents: [],
    main_topic: 'Main Topic',
    context: CONTEXT,
  })
  const titles = prompts.generate_draft_titles_prompt('Subtopic One', 'Main Topic', CONTEXT)

  for (const literal of [
    'IMPORTANT:Content and Sections Uniqueness:',
    '- Ensure that your content is entirely new and does not overlap with any information already covered in the previous subtopic reports.',
    '- Use H2 for the main subtopic header (##) and H3 for subsections (###).',
    '    While the previous section discussed [topic A], this section will explore [topic B]."',
  ]) {
    assert.ok(subtopic.includes(literal), `subtopic prompt is missing: ${literal}`)
  }

  assert.ok(subtopics.includes('- Finally order the subtopics by their tasks, in a relevant and meaningful order which is presentable in a detailed report'))
  assert.ok(titles.includes("3. The header should't be too high level, but detailed enough to cover the main aspects of the subtopic."))
})

test('curation, MCP, agent and image templates carry upstream literals verbatim', () => {
  const prompts = makePrompts()

  const curate = prompts.curate_sources(QUESTION, 'SOURCES')
  assert.ok(
    curate.includes(
      'The response MUST not contain any markdown format or additional text (like ```json), just the JSON list!',
    ),
  )
  assert.ok(
    curate.includes('- Currency: Prefer recent information unless older data is essential or valuable.'),
  )

  const agent = prompts.auto_agent_instructions()
  assert.ok(
    agent.includes(
      '"agent_role_prompt: "You are a seasoned finance analyst AI assistant. Your primary goal is to compose comprehensive, astute, impartial, and methodically arranged financial reports based on provided data and trends."',
    ),
  )

  const selection = prompts.generate_mcp_tool_selection_prompt(QUESTION, [], 3)
  assert.ok(
    selection.includes(
      'TASK: Analyze the tools and select EXACTLY 3 tools that are most relevant for researching the given query.',
    ),
  )

  const analysis = prompts.generate_image_analysis_prompt(QUESTION, [], 3)
  assert.ok(
    analysis.includes('"image_type": "diagram|flowchart|comparison|concept|data_visualization",'),
  )
  assert.ok(
    analysis.includes(
      '- Avoid sections that are purely textual analysis, introductions, or conclusions',
    ),
  )
  assert.ok(
    prompts
      .generate_image_prompt_enhancement('base', 'content', 'topic')
      .includes('- Professional and clean design suitable for academic/business reports'),
  )
})
