/**
 * Tolerant JSON extraction — the port of upstream's `json_repair` usage.
 *
 * Upstream calls `json_repair.loads(response)` on raw LLM output (search-query
 * lists, agent selection, subtopics, curated sources). Models routinely wrap
 * JSON in prose or fences, emit trailing commas, single quotes, Python literals
 * (`True`/`None`), or unquoted keys. This module recovers those cases instead of
 * failing a whole research run on one stray comma.
 *
 * **Everything here is string-state aware.** An earlier revision applied the
 * repair regexes blindly, which rewrote *content* (`"The value is True"` became
 * `"The value is true"` — a silent edit to curated source text) and could
 * discard its own repairs (a `, Benefit:` inside a string was rewritten into a
 * key, breaking the JSON). The scanner below only transforms characters that are
 * outside a string literal, and every stage is re-validated with `JSON.parse`
 * before it is kept.
 *
 * @module gpt-researcher/utils/json
 */

/** The JSON-ish scalar literals models emit from Python habits. */
const PYTHON_LITERALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bTrue\b/g, 'true'],
  [/\bFalse\b/g, 'false'],
  [/\bNone\b/g, 'null'],
]

/**
 * Split text into alternating outside/inside-string segments.
 *
 * Handles double- and single-quoted strings and backslash escapes. The returned
 * `inside` flag says whether the segment is string *content* (which must be left
 * untouched by the repair passes).
 *
 * @param text - the text to segment.
 * @returns the segments in order.
 */
export function segmentStrings(text: string): Array<{ text: string; inside: boolean }> {
  const segments: Array<{ text: string; inside: boolean }> = []
  let buffer = ''
  let quote: '"' | "'" | undefined
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (quote === undefined) {
      if (char === '"' || char === "'") {
        if (buffer.length > 0) {
          segments.push({ text: buffer, inside: false })
          buffer = ''
        }
        quote = char
        buffer = char
      } else {
        buffer += char
      }
    } else {
      buffer += char
      if (char === '\\' && index + 1 < text.length) {
        buffer += text[index + 1] as string
        index += 2
        continue
      }
      if (char === quote) {
        segments.push({ text: buffer, inside: true })
        buffer = ''
        quote = undefined
      }
    }
    index += 1
  }
  if (buffer.length > 0) segments.push({ text: buffer, inside: quote === undefined ? false : true })
  return segments
}

/**
 * Apply a transform to the non-string parts of a document only.
 *
 * @param text - the document.
 * @param transform - applied to each outside-string segment.
 * @returns the document with content untouched.
 */
export function mapOutsideStrings(text: string, transform: (segment: string) => string): string {
  return segmentStrings(text)
    .map((segment) => (segment.inside ? segment.text : transform(segment.text)))
    .join('')
}

/**
 * Strip a ```json … ``` fence (or any bare fence) around a payload.
 *
 * @param text - raw model output.
 * @returns the inner payload when fenced, otherwise the trimmed input.
 */
export function stripCodeFence(text: string): string {
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text)
  if (fenced && fenced[1] !== undefined) return fenced[1].trim()
  return text.trim()
}

/**
 * Find the first balanced `{…}` or `[…]` span, ignoring braces inside strings.
 *
 * @param text - text that may contain a JSON value.
 * @returns the balanced span, or undefined when none exists.
 */
export function findBalancedSpan(text: string): string | undefined {
  const start = firstIndexOfAny(text, ['{', '['])
  if (start < 0) return undefined
  const open = text[start] as '{' | '['
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      // A single quote inside an already-quoted run is treated as a delimiter
      // only when it looks like one; JSON proper only has double quotes, and
      // prose apostrophes are the common false positive.
      if (char === "'" && !looksLikeSingleQuotedValue(text, index)) continue
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

function looksLikeSingleQuotedValue(text: string, index: number): boolean {
  // `'` opens a value when the previous non-space character is a structural one
  // (`:`, `,`, `[`, `{`) and a closing `'` appears later.
  let before = index - 1
  while (before >= 0 && /\s/.test(text[before] as string)) before -= 1
  const previous = before >= 0 ? (text[before] as string) : ''
  if (![':', ',', '[', '{'].includes(previous)) return false
  return text.indexOf("'", index + 1) > index
}

function firstIndexOfAny(text: string, chars: readonly string[]): number {
  let best = -1
  for (const char of chars) {
    const at = text.indexOf(char)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  return best
}

/** Try `JSON.parse`; undefined when it throws. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Rewrite single-quoted strings and bare keys into JSON, touching only regions
 * outside existing strings.
 *
 * @param text - candidate JSON text.
 * @returns the rewritten text.
 */
function quoteStringsAndKeys(text: string): string {
  const segments = segmentStrings(text)
  const out: string[] = []
  for (const segment of segments) {
    if (segment.inside) {
      // Convert a single-quoted run into a double-quoted one, escaping inner
      // double quotes and unescaping single ones.
      if (segment.text.startsWith("'")) {
        const body = segment.text.slice(1, -1)
        out.push(`"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`)
      } else {
        out.push(segment.text)
      }
      continue
    }
    // Outside a string: quote a bare key that a `:` follows, and convert the
    // Python scalars, which are never valid JSON.
    let replaced = segment.text.replace(
      /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g,
      '$1"$2"$3',
    )
    for (const [pattern, value] of PYTHON_LITERALS) replaced = replaced.replace(pattern, value)
    out.push(replaced)
  }
  return out.join('')
}

/** Remove trailing commas before a closing brace/bracket, outside strings. */
function dropTrailingCommas(text: string): string {
  return mapOutsideStrings(text, (segment) => segment.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * Apply lightweight repairs that turn common model output into valid JSON.
 *
 * Stages are applied in order and each one is kept only when it produces
 * parseable JSON, so a repair can never make an already-valid document worse.
 *
 * Handled: Python literals (`True`/`False`/`None`), single-quoted strings,
 * trailing commas, unquoted object keys, and surrounding prose.
 *
 * @param text - candidate JSON text.
 * @returns repaired JSON text.
 */
export function repairJsonText(text: string): string {
  let candidate = stripCodeFence(text)
  const span = findBalancedSpan(candidate)
  if (span) candidate = span

  const stages: Array<(value: string) => string> = [
    dropTrailingCommas,
    quoteStringsAndKeys,
    (value) => dropTrailingCommas(quoteStringsAndKeys(value)),
  ]
  let current = candidate
  for (const stage of stages) {
    const next = stage(current)
    if (next === current) continue
    if (tryParse(next) !== undefined) return next
    // Keep the stage result only when it is at least as parseable as the input;
    // otherwise the input may still parse and must not be discarded.
    current = tryParse(current) === undefined ? next : current
  }
  return current
}

/**
 * Parse model output into a JSON value, repairing it when necessary.
 *
 * @param text - raw model output, or `undefined`/empty when the call failed.
 * @returns the parsed value, or undefined when nothing parseable was found.
 */
export function parseJsonLoose<T = unknown>(text: string | undefined | null): T | undefined {
  if (!text || text.trim().length === 0) return undefined
  const attempts = [stripCodeFence(text), findBalancedSpan(text), repairJsonText(text)]
  for (const attempt of attempts) {
    if (!attempt) continue
    const parsed = tryParse(attempt)
    if (parsed !== undefined) return parsed as T
  }
  return undefined
}

/**
 * Whether a bare string looks like JSON, a code fence, or a prose sentence
 * rather than a list item — the guard that stops `parseStringList` from
 * returning an entire JSON document (or a paragraph) as a "search query".
 *
 * @param line - the candidate line.
 * @returns true when the line must not be treated as a list item.
 */
export function isNotAListItem(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  if (/^[[{]\s*"/.test(trimmed)) return true
  if (/^[[{]\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(trimmed)) return true
  if (trimmed.startsWith('```')) return true
  // A sentence: several words plus terminal punctuation is prose, not a query.
  if (/[.!?]\s*$/.test(trimmed) && trimmed.split(/\s+/).length > 6) return true
  if (trimmed.length > 400) return true
  return false
}

/**
 * Parse model output that should contain a list of strings — the shape
 * upstream expects from `generate_search_queries_prompt` and
 * `generate_subtopics_prompt`.
 *
 * Accepts a bare array, a single-key wrapper (`queries`, `query`, `question`,
 * `task`, `subtopics`, …), a newline-separated list, or a bulleted answer.
 * Anything that is not list-like is rejected rather than returned verbatim.
 *
 * @param text - raw model output.
 * @param preferredKeys - object keys to check first, in order.
 * @returns cleaned, de-duplicated, non-empty strings.
 */
export function parseStringList(
  text: string | undefined | null,
  preferredKeys: readonly string[] = [
    'queries',
    'subtopics',
    'sub_queries',
    'items',
    'results',
    'query',
    'question',
    'task',
    'title',
  ],
): string[] {
  if (!text || text.trim().length === 0) return []
  const parsed = parseJsonLoose<unknown>(text)
  const fromParsed = collectStrings(parsed, preferredKeys)
  if (fromParsed.length > 0) return fromParsed

  // Fall back to line/bullet parsing: strip list markers and quotes, and reject
  // documents/prose that are not list items.
  return dedupeStrings(
    stripCodeFence(text)
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .map((line) => line.replace(/^["'`]|["'`,]$/g, '').trim())
      .filter((line) => !isNotAListItem(line)),
  )
}

function collectStrings(value: unknown, preferredKeys: readonly string[]): string[] {
  // A direct string value: `{"query": "…"}` and `{"task": "…"}` must yield the
  // string, not nothing — that was the difference between recovering a planned
  // query and falling through to the (now rejected) line parser.
  if (typeof value === 'string') return dedupeStrings([value.trim()])
  if (Array.isArray(value)) {
    const direct = value.filter((item): item is string => typeof item === 'string')
    if (direct.length > 0) return dedupeStrings(direct.map((item) => item.trim()))
    const nested: string[] = []
    for (const item of value) nested.push(...collectStrings(item, preferredKeys))
    return dedupeStrings(nested)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of preferredKeys) {
      if (key in record) {
        const collected = collectStrings(record[key], preferredKeys)
        if (collected.length > 0) return collected
      }
    }
  }
  return []
}

/**
 * Parse the `{server, agent_role_prompt}` object upstream's `choose_agent`
 * expects, with upstream's default agent as the fallback.
 *
 * @param text - raw model output.
 * @returns the chosen agent name and role prompt.
 */
export function parseAgentChoice(text: string | undefined | null): {
  server: string
  agentRolePrompt: string
  fallback: boolean
} {
  const parsed = parseJsonLoose<Record<string, unknown>>(text)
  const server = parsed?.server
  const role = parsed?.agent_role_prompt
  if (typeof server === 'string' && server.length > 0 && typeof role === 'string' && role.length > 0) {
    return { server, agentRolePrompt: role, fallback: false }
  }
  return {
    server: 'Default Agent',
    agentRolePrompt:
      'You are an AI critical thinker research assistant. Your sole purpose is to write well written, ' +
      'critically acclaimed, objective and structured reports on given text.',
    fallback: true,
  }
}

/** Remove duplicate strings, preserving first-seen order. */
export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}
