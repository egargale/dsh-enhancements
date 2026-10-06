/**
 * Offline unit tests for the multi-agent module tree.
 *
 * Every prompt assertion here was produced by evaluating the Python originals
 * (`multi_agents/agents/*.py`) with `ast` + `eval`, so a whitespace change in
 * the ported template literals fails the suite.
 *
 * @module test/unit/multi-agents
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config } from '../../src/config.ts'
import type { EngineDeps } from '../../src/deps.ts'
import {
  EditorAgent,
  HumanAgent,
  PublisherAgent,
  ReviewerAgent,
  ReviserAgent,
  WriterAgent,
  pythonRepr,
  pythonStr,
  type EditorAgents,
} from '../../src/multi-agents/agents.ts'
import type {
  DraftState,
  ResearchState,
  SubtopicDraft,
  Task,
} from '../../src/multi-agents/state.ts'
import { get_prompt_family } from '../../src/prompts.ts'
import { makeRuntime, silentLogger } from '../../src/runtime.ts'
import type { ChatClient, ChatRequest, ChatResult } from '../../src/types.ts'
import { CostTracker } from '../../src/utils/costs.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One scripted completion, matched against the joined message text. */
interface Route {
  tag: string
  match: (promptText: string) => boolean
  reply: (request: ChatRequest, call: number) => string
}

/** A `ChatClient` that answers by prompt content and records every request. */
class ScriptedChatClient implements ChatClient {
  readonly requests: Array<{ tag: string; request: ChatRequest }> = []
  readonly #routes: Route[]
  #calls = 0

  constructor(routes: Route[]) {
    this.#routes = routes
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const promptText = request.messages.map((message) => message.content).join('\n')
    const route = this.#routes.find((candidate) => candidate.match(promptText))
    if (route === undefined) {
      throw new Error(`unscripted prompt: ${promptText.slice(0, 120)}`)
    }
    this.#calls += 1
    this.requests.push({ tag: route.tag, request })
    return { text: route.reply(request, this.#calls) }
  }

  /** The tags of every call, in call order. */
  tags(): string[] {
    return this.requests.map((entry) => entry.tag)
  }

  /** The user-message content of every call with a tag. */
  userPrompts(tag: string): string[] {
    return this.requests
      .filter((entry) => entry.tag === tag)
      .map(
        (entry) =>
          entry.request.messages.find((message) => message.role === 'user')?.content ?? '',
      )
  }
}

/** Build deps whose every seam is offline. */
function makeDeps(client: ChatClient): EngineDeps {
  const config = new Config({
    env: () => undefined,
    overrides: {
      RETRIEVER: 'tavily',
      EMBEDDING: 'custom:test',
      MEMORY_BACKEND: 'none',
      VERBOSE: false,
    },
  })
  return {
    runtime: makeRuntime({
      llm: client,
      env: () => undefined,
      log: silentLogger,
      progress: () => {},
    }),
    config,
    prompts: get_prompt_family('default', config),
    costs: new CostTracker(),
  }
}

/** The upstream `task.json` values, with `query`/`guidelines` shortened. */
const TASK: Task = {
  query: 'Is AI in a hype cycle?',
  model: 'gpt-4o',
  max_sections: 3,
  include_human_feedback: false,
  follow_guidelines: true,
  guidelines: ['G1', 'G2'],
  verbose: false,
  source: 'web',
}

/** `datetime.now().strftime('%d/%m/%Y')`, as the prompts render it. */
function today(): string {
  const now = new Date()
  const day = String(now.getDate()).padStart(2, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${now.getFullYear()}`
}

// ---------------------------------------------------------------------------
// EditorAgent.planResearch
// ---------------------------------------------------------------------------

test('EditorAgent.planResearch returns the model plan', async () => {
  const client = new ScriptedChatClient([
    {
      tag: 'plan',
      match: () => true,
      reply: () =>
        '{"title": "AI Report", "date": "01/02/2026", "sections": ["One", "Two"]}',
    },
  ])
  const editor = new EditorAgent(makeDeps(client))

  const plan = await editor.planResearch({ task: TASK, initial_research: 'summary' })

  assert.deepEqual(plan, { title: 'AI Report', date: '01/02/2026', sections: ['One', 'Two'] })
  assert.deepEqual(client.tags(), ['plan'])
})

test('EditorAgent.planResearch falls back to upstream default field values', async () => {
  const client = new ScriptedChatClient([
    { tag: 'plan', match: () => true, reply: () => 'I could not produce a plan.' },
  ])
  const editor = new EditorAgent(makeDeps(client))

  const plan = await editor.planResearch({ task: TASK, initial_research: 'summary' })

  // Upstream's `plan.get("title"/"date"/"sections")` yields None for every field
  // when the repaired payload carries no such key — i.e. these three keys, all
  // undefined.
  assert.deepEqual(plan, { title: undefined, date: undefined, sections: undefined })
})

test('EditorAgent.planResearch prompt is upstream verbatim', async () => {
  const client = new ScriptedChatClient([
    { tag: 'plan', match: () => true, reply: () => '{}' },
  ])
  const editor = new EditorAgent(makeDeps(client))
  await editor.planResearch({ task: TASK, initial_research: 'INITIAL SUMMARY TEXT' })

  const prompt = client.requests[0]?.request
  assert.ok(prompt)
  const indent = ' '.repeat(19)
  const expectedUser = [
    `Today's date is ${today()}`,
    `${indent}Research summary report: 'INITIAL SUMMARY TEXT'`,
    indent,
    indent,
    'Your task is to generate an outline of sections headers for the research project',
    `${indent}based on the research summary report above.`,
    `${indent}You must generate a maximum of 3 section headers.`,
    `${indent}You must focus ONLY on related research topics for subheaders and do NOT include introduction, conclusion and references.`,
    `${indent}You must return nothing but a JSON with the fields 'title' (str) and `,
    `${indent}'sections' (maximum 3 section headers) with the following structure:`,
    `${indent}'{title: string research title, date: today's date, `,
    `${indent}sections: ['section header 1', 'section header 2', 'section header 3' ...]}'.`,
  ].join('\n')

  assert.equal(
    prompt.messages[0]?.content,
    'You are a research editor. Your goal is to oversee the research project ' +
      'from inception to completion. Your main task is to plan the article section ' +
      'layout based on an initial research summary.\n ',
  )
  assert.equal(prompt.messages[1]?.content, expectedUser)
})

// ---------------------------------------------------------------------------
// Reviewer / reviser conditional loop
// ---------------------------------------------------------------------------

/** The draft `ResearchAgent.runDepthResearch` would produce for a section. */
const STUB_DRAFT: SubtopicDraft = { 'Section One': 'initial draft body' }

/** An `EditorAgent` whose section researcher is stubbed (reviewer/reviser are real). */
class TestEditor extends EditorAgent {
  readonly #research: EditorAgents['research']

  constructor(deps: EngineDeps, research: EditorAgents['research']) {
    super(deps)
    this.#research = research
  }

  override initializeAgents(): EditorAgents {
    return {
      research: this.#research,
      reviewer: new ReviewerAgent(this.deps),
      reviser: new ReviserAgent(this.deps),
    }
  }
}

/** A stand-in researcher that always returns the given draft. */
function stubResearch(draft: SubtopicDraft): EditorAgents['research'] {
  return {
    runDepthResearch: async () => ({ draft }),
  } as unknown as EditorAgents['research']
}

test('the review loop accepts when the reviewer returns None', async () => {
  const client = new ScriptedChatClient([
    {
      tag: 'reviewer',
      match: (text) => text.includes('expert research article reviewer'),
      reply: () => 'The draft meets all the guidelines, so I return None.',
    },
    {
      tag: 'reviser',
      match: (text) => text.includes('revise drafts based on reviewer notes'),
      reply: () => '{"draft": "should never be used", "revision_notes": "n/a"}',
    },
  ])
  const editor = new TestEditor(makeDeps(client), stubResearch(STUB_DRAFT))

  const draft = await editor.runSection('Section One', 'Title', TASK)

  assert.deepEqual(draft, STUB_DRAFT)
  assert.deepEqual(client.tags(), ['reviewer'])
})

test('the review loop revises once then accepts, threading the notes back', async () => {
  const client = new ScriptedChatClient([
    {
      tag: 'reviewer',
      match: (text) => text.includes('expert research article reviewer'),
      reply: (_request, call) => (call === 1 ? 'Add more quantitative detail.' : 'None'),
    },
    {
      tag: 'reviser',
      match: (text) => text.includes('revise drafts based on reviewer notes'),
      reply: () =>
        '{"draft": "revised draft body", "revision_notes": "added the missing numbers"}',
    },
  ])
  const editor = new TestEditor(makeDeps(client), stubResearch(STUB_DRAFT))

  const draft = await editor.runSection('Section One', 'Title', TASK)

  assert.equal(draft, 'revised draft body')
  assert.deepEqual(client.tags(), ['reviewer', 'reviser', 'reviewer'])
  // The reviser's notes become the next review prompt's `revision_notes`.
  assert.ok(client.userPrompts('reviewer')[0]?.includes('Guidelines: G1- G2'))
  assert.ok(!client.userPrompts('reviewer')[0]?.includes('The reviser has already revised'))
  assert.ok(client.userPrompts('reviewer')[1]?.includes('added the missing numbers'))
  assert.ok(client.userPrompts('reviewer')[1]?.includes('The reviser has already revised'))
})

test('the review loop stops at the revision cap', async () => {
  let revisions = 0
  const client = new ScriptedChatClient([
    {
      tag: 'reviewer',
      match: (text) => text.includes('expert research article reviewer'),
      reply: () => 'Still needs work.',
    },
    {
      tag: 'reviser',
      match: (text) => text.includes('revise drafts based on reviewer notes'),
      reply: () => {
        revisions += 1
        return JSON.stringify({
          draft: `revision ${revisions}`,
          revision_notes: `notes ${revisions}`,
        })
      },
    },
  ])
  const editor = new TestEditor(makeDeps(client), stubResearch(STUB_DRAFT))

  const draft = await editor.runSection('Section One', 'Title', TASK)

  // `task.max_revisions` defaults to 3, the AG2 sibling's counter.
  assert.equal(draft, 'revision 3')
  assert.equal(client.tags().filter((tag) => tag === 'reviewer').length, 3)
  assert.equal(client.tags().filter((tag) => tag === 'reviser').length, 3)
})

test('an explicit max_revisions bounds the loop', async () => {
  const client = new ScriptedChatClient([
    {
      tag: 'reviewer',
      match: (text) => text.includes('expert research article reviewer'),
      reply: () => 'Never good enough.',
    },
    {
      tag: 'reviser',
      match: (text) => text.includes('revise drafts based on reviewer notes'),
      reply: () => '{"draft": "another revision", "revision_notes": "more"}',
    },
  ])
  const editor = new TestEditor(makeDeps(client), stubResearch(STUB_DRAFT))

  await editor.runSection('Section One', 'Title', { ...TASK, max_revisions: 1 })

  assert.deepEqual(client.tags(), ['reviewer', 'reviser'])
})

// ---------------------------------------------------------------------------
// Verbatim prompts
// ---------------------------------------------------------------------------

/** Upstream `reviser.py::sample_revision_notes`, copied independently. */
const EXPECTED_REVISION_NOTES = `
{
  "draft": { 
    draft title: The revised draft that you are submitting for review 
  },
  "revision_notes": Your message to the reviewer about the changes you made to the draft based on their feedback
}
`

test('pythonStr/pythonRepr render values the way Python does', () => {
  assert.equal(pythonStr('plain'), 'plain')
  assert.equal(pythonStr(undefined), 'None')
  assert.equal(pythonStr(null), 'None')
  assert.equal(pythonStr(true), 'True')
  assert.equal(pythonStr(3), '3')
  assert.equal(pythonStr(['G1', 'G2']), "['G1', 'G2']")
  assert.equal(pythonStr({ title: 'T', date: 'Date' }), "{'title': 'T', 'date': 'Date'}")
  assert.equal(pythonStr([{ 'Topic A': 'Draft body A' }, 'Draft body B']), "[{'Topic A': 'Draft body A'}, 'Draft body B']")
  assert.equal(pythonRepr("it's"), "'it\\'s'")
})

test('ReviserAgent.reviseDraft sends upstream verbatim text', async () => {
  const client = new ScriptedChatClient([
    {
      tag: 'reviser',
      match: () => true,
      reply: () => '{"draft": "x", "revision_notes": "y"}',
    },
  ])
  const reviser = new ReviserAgent(makeDeps(client))
  const draftState: DraftState = {
    task: TASK,
    topic: 'Topic A',
    draft: { 'Topic A': 'Draft body A' },
    review: 'Please add more numbers.',
    revision_notes: null,
  }

  await reviser.reviseDraft(draftState)

  const expectedUser = `Draft:
{'Topic A': 'Draft body A'}" + "Reviewer's notes:
Please add more numbers.


You have been tasked by your reviewer with revising the following draft, which was written by a non-expert.
If you decide to follow the reviewer's notes, please write a new draft and make sure to address all of the points they raised.
Please keep all other aspects of the draft the same.
You MUST return nothing but a JSON in the following format:
${EXPECTED_REVISION_NOTES}
`
  assert.equal(client.userPrompts('reviser')[0], expectedUser)
  assert.equal(
    client.requests[0]?.request.messages[0]?.content,
    'You are an expert writer. Your goal is to revise drafts based on reviewer notes.',
  )
})

test('ReviewerAgent.reviewDraft sends upstream verbatim text', async () => {
  const client = new ScriptedChatClient([
    { tag: 'reviewer', match: () => true, reply: () => 'None' },
  ])
  const reviewer = new ReviewerAgent(makeDeps(client))
  const draftState: DraftState = {
    task: TASK,
    topic: 'Topic A',
    draft: { 'Topic A': 'Draft body A' },
    review: null,
    revision_notes: 'OLD NOTES',
  }

  const review = await reviewer.reviewDraft(draftState)

  const expectedUser = `You have been tasked with reviewing the draft which was written by a non-expert based on specific guidelines.
Please accept the draft if it is good enough to publish, or send it for revision, along with your notes to guide the revision.
If not all of the guideline criteria are met, you should send appropriate revision notes.
If the draft meets all the guidelines, please return None.
The reviser has already revised the draft based on your previous review notes with the following feedback:
OLD NOTES

Please provide additional feedback ONLY if critical since the reviser has already made changes based on your previous feedback.
If you think the article is sufficient or that non critical revisions are required, please aim to return None.


Guidelines: G1- G2
Draft: {'Topic A': 'Draft body A'}

`
  assert.equal(review, null)
  assert.equal(client.userPrompts('reviewer')[0], expectedUser)
  assert.equal(
    client.requests[0]?.request.messages[0]?.content,
    'You are an expert research article reviewer. Your goal is to review research drafts and ' +
      'provide feedback to the reviser only based on specific guidelines. ',
  )
})

test('WriterAgent.writeSections renders upstream verbatim text', async () => {
  const client = new ScriptedChatClient([
    {
      tag: 'writer',
      match: () => true,
      reply: () =>
        '{"table_of_contents": "- A", "introduction": "intro", "conclusion": "conclusion", "sources": ["- S"]}',
    },
  ])
  const writer = new WriterAgent(makeDeps(client))
  const researchState = {
    task: TASK,
    title: 'THE TITLE',
    research_data: [{ 'Topic A': 'Draft body A' }, 'Draft body B'],
  } as unknown as ResearchState

  await writer.writeSections(researchState)

  const prompt = client.userPrompts('writer')[0] ?? ''
  assert.ok(prompt.startsWith(`Today's date is ${today()}\n.Query or Topic: THE TITLE\n`))
  assert.ok(prompt.includes("Research data: [{'Topic A': 'Draft body A'}, 'Draft body B']\n"))
  assert.ok(
    prompt.includes("markdown hyperlinks -For example: 'This is a sample text. ([url website](url))'\n\n"),
  )
  assert.ok(prompt.includes("You must follow the guidelines provided: ['G1', 'G2']\n"))
  assert.ok(prompt.endsWith('}\n\n\n'))
  assert.ok(prompt.includes('You MUST return nothing but a JSON in the following format (without json markdown):\n\n{\n'))
})

// ---------------------------------------------------------------------------
// PublisherAgent
// ---------------------------------------------------------------------------

test('PublisherAgent.run assembles the upstream layout', async () => {
  const client = new ScriptedChatClient([])
  const publisher = new PublisherAgent(makeDeps(client))

  const { report } = await publisher.run({
    task: TASK,
    title: 'AI Report',
    date: '01/02/2026',
    headers: {
      title: 'AI Report',
      date: 'Date',
      introduction: 'Introduction',
      table_of_contents: 'Table of Contents',
      conclusion: 'Conclusion',
      references: 'References',
    },
    introduction: 'Intro text',
    table_of_contents: '- One\n- Two',
    conclusion: 'Conclusion text',
    sources: ['- Source A', '- Source B'],
    research_data: [{ One: 'Body one' }, 'Body two'],
  })

  assert.ok(report.startsWith('# AI Report\n#### Date: 01/02/2026\n\n'))
  assert.ok(report.includes('## Introduction\nIntro text\n\n'))
  assert.ok(report.includes('## Table of Contents\n- One\n- Two\n\n'))
  assert.ok(report.includes('Body one\n\nBody two\n\n'))
  assert.ok(report.includes('## Conclusion\nConclusion text\n\n'))
  assert.ok(report.includes('## References\n- Source A\n- Source B\n'))
})

test('PublisherAgent emits each requested publish format', async () => {
  const client = new ScriptedChatClient([])
  const published: Array<{ format: string; layout: string }> = []
  const publisher = new PublisherAgent(makeDeps(client), {
    onPublish: (format, layout) => {
      published.push({ format, layout })
    },
  })

  const { report } = await publisher.run({
    task: { ...TASK, publish_formats: { pdf: true, markdown: true } },
    title: 'T',
    sources: [],
    research_data: [],
  })

  assert.deepEqual(
    published.map((entry) => entry.format),
    ['pdf', 'markdown'],
  )
  assert.equal(published[0]?.layout, report)
})

// ---------------------------------------------------------------------------
// HumanAgent
// ---------------------------------------------------------------------------

test('HumanAgent returns null without a human-feedback callback', async () => {
  const client = new ScriptedChatClient([])
  const human = new HumanAgent(makeDeps(client))

  const result = await human.reviewPlan({
    task: { ...TASK, include_human_feedback: true },
    sections: ['A', 'B'],
  })

  assert.deepEqual(result, { human_feedback: null })
})

test('HumanAgent treats a reply containing "no" as acceptance', async () => {
  const client = new ScriptedChatClient([])
  const questions: string[] = []
  const human = new HumanAgent(makeDeps(client), {
    onHumanFeedback: async (question) => {
      questions.push(question)
      return 'no'
    },
  })

  const result = await human.reviewPlan({
    task: { ...TASK, include_human_feedback: true },
    sections: ['A', 'B'],
  })

  assert.deepEqual(result, { human_feedback: null })
  assert.deepEqual(questions, [
    "Any feedback on this plan of topics to research? ['A', 'B']? If not, please reply with 'no'.",
  ])
})

test('HumanAgent passes real feedback through', async () => {
  const client = new ScriptedChatClient([])
  const human = new HumanAgent(makeDeps(client), {
    onHumanFeedback: async () => 'Please add a section about pricing',
  })

  const result = await human.reviewPlan({
    task: { ...TASK, include_human_feedback: true },
    sections: ['A'],
  })

  assert.deepEqual(result, { human_feedback: 'Please add a section about pricing' })
})
