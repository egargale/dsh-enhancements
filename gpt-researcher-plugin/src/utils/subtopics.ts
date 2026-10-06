/**
 * Subtopic construction — the port of upstream `utils/llm.py#construct_subtopics`
 * + `utils/validators.py`.
 *
 * Upstream asks the smart model for a `Subtopics` pydantic object
 * (`{subtopics: [{task}]}`) through a `PydanticOutputParser`, filling the
 * template returned by `generate_subtopics_prompt()` with `task`, `data`,
 * `subtopics`, `max_subtopics`, and the parser's `format_instructions`.
 *
 * There is no pydantic here, so the format instructions are reproduced as an
 * equivalent JSON-schema instruction block and parsing is tolerant across the
 * shapes models actually emit (`subtopics`, `subTopics`, a bare array, or
 * newline-separated titles).
 *
 * @module gpt-researcher/utils/subtopics
 */

import type { PromptFamily } from '../prompts.ts'
import { dedupeStrings, parseJsonLoose, parseStringList } from './json.ts'

/**
 * The `format_instructions` upstream's `PydanticOutputParser` supplies for the
 * `Subtopics` model.
 */
export const SUBTOPICS_FORMAT_INSTRUCTIONS = [
  'The output should be formatted as a JSON instance that conforms to the JSON schema below.',
  '',
  'As an example, for the schema {"properties": {"foo": {"title": "Foo", "description": "a list of strings", "type": "array", "items": {"type": "string"}}}, "required": ["foo"]}',
  'the object {"foo": ["bar", "baz"]} is a well-formatted instance of the schema. The object {"properties": {"foo": ["bar", "baz"]}} is not well-formatted.',
  '',
  'Here is the output schema:',
  '```',
  JSON.stringify(
    {
      properties: {
        subtopics: {
          default: [],
          items: { $ref: '#/$defs/Subtopic' },
          title: 'Subtopics',
          type: 'array',
        },
      },
      $defs: {
        Subtopic: {
          description: 'Model representing a single research subtopic.',
          properties: {
            task: {
              description: 'Task name',
              minLength: 1,
              title: 'Task',
              type: 'string',
            },
          },
          required: ['task'],
          title: 'Subtopic',
          type: 'object',
        },
      },
      title: 'Subtopics',
      type: 'object',
    },
    null,
    0,
  ),
  '```',
].join('\n')

/**
 * Fill the subtopics prompt template (upstream's LangChain `PromptTemplate`
 * partial-variable binding).
 *
 * The substitution is deliberately literal: only the five placeholders upstream
 * declares are replaced, and `{subtopics}` renders the Python-list form
 * (`['a', 'b']`) that upstream produces, so the model sees the same text.
 *
 * @param prompts - the prompt family carrying `generate_subtopics_prompt()`.
 * @param values - the template variables.
 * @returns the rendered prompt.
 */
export function renderSubtopicsPrompt(
  prompts: PromptFamily,
  values: {
    task: string
    data: string
    existingSubtopics?: readonly string[]
    maxSubtopics: number
  },
): string {
  const template = prompts.generate_subtopics_prompt()
  return template
    .replace(/\{task\}/g, values.task)
    .replace(/\{data\}/g, values.data)
    .replace(/\{subtopics\}/g, pythonList(values.existingSubtopics ?? []))
    .replace(/\{max_subtopics\}/g, String(values.maxSubtopics))
    .replace(/\{format_instructions\}/g, SUBTOPICS_FORMAT_INSTRUCTIONS)
}

/**
 * Parse a subtopics response into task names.
 *
 * @param text - raw model output.
 * @param maxSubtopics - upstream `MAX_SUBTOPICS` bound.
 * @returns the subtopic task names, in model order, de-duplicated.
 */
export function parseSubtopics(text: string | undefined | null, maxSubtopics: number): string[] {
  const parsed = parseJsonLoose<unknown>(text)
  const fromObject = collectTasks(parsed)
  const tasks =
    fromObject.length > 0 ? fromObject : parseStringList(text, ['subtopics', 'subTopics', 'tasks'])
  return dedupeStrings(tasks).slice(0, Math.max(0, maxSubtopics))
}

/** Pull `task`-like strings out of any of the shapes a model may return. */
function collectTasks(value: unknown): string[] {
  if (Array.isArray(value)) {
    const tasks: string[] = []
    for (const item of value) {
      if (typeof item === 'string') tasks.push(item)
      else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        const task = record.task ?? record.subtopic ?? record.title ?? record.name
        if (typeof task === 'string') tasks.push(task)
      }
    }
    return tasks
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['subtopics', 'subTopics', 'tasks', 'items']) {
      if (key in record) {
        const nested = collectTasks(record[key])
        if (nested.length > 0) return nested
      }
    }
  }
  return []
}

/** Render a list the way Python's f-string interpolation of a list does. */
export function pythonList(items: readonly string[]): string {
  return `[${items.map((item) => `'${item.replace(/'/g, "\\'")}'`).join(', ')}]`
}
