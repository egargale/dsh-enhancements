/**
 * Pure HTML → readable text extractor: the BeautifulSoup equivalent.
 *
 * Upstream `scraper/utils.py` cleans a `BeautifulSoup` tree
 * (`clean_soup`) and then flattens it (`get_text_from_soup`), while
 * `scraper/beautiful_soup/beautiful_soup.py` additionally extracts the title and
 * the relevant images (`get_relevant_images`). This module reproduces all four
 * behaviours as a **pure function** — no I/O, no DOM, no dependencies — so the
 * whole extraction pipeline is deterministic and testable offline.
 *
 * The extractor is deliberately a small tokenizer rather than a real HTML
 * parser: it is fed whatever the HTTP seam returned, including malformed
 * markup, and must never throw.
 *
 * @module gpt-researcher/scraper/html
 */

/** The result of extracting a page. */
export interface HtmlExtraction {
  /** `<title>`, falling back to `og:title` and then the first `<h1>`. */
  title: string
  /** `<meta name="description">` / `og:description`, decoded; `''` when absent. */
  description: string
  /** Readable text: block-separated lines, entities decoded, whitespace collapsed. */
  text: string
  /** Absolute, de-duplicated, relevance-sorted image URLs (at most 10). */
  imageUrls: string[]
}

/** Options for {@link extractHtml}. */
export interface HtmlExtractionOptions {
  /**
   * Absolute URL of the page. Used to resolve relative `src`/`href` values and
   * to select a per-site handler (see {@link handlerForHost}). Purely
   * computational — the value is never fetched.
   */
  url?: string
}

/**
 * Upstream `get_relevant_images` scores an image 4 when one of these class
 * tokens is present (`scraper/utils.py`).
 */
const IMAGE_CLASS_HINTS = new Set([
  'header',
  'featured',
  'hero',
  'thumbnail',
  'main',
  'content',
])

/**
 * Tags upstream `clean_soup` decomposes, plus the container tags the port adds
 * (`noscript`, `iframe`, `template`, `canvas`, `head`) so no scriptable or
 * chrome text can leak into the context.
 */
const DROP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'canvas',
  'applet',
  'object',
  'embed',
  'head',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'menu',
  'dialog',
  'video',
  'audio',
])

/**
 * Class tokens whose elements are chrome rather than content. The first four
 * mirror upstream's `disallowed_class_set`; the rest are the same idea applied
 * to the class names modern sites use.
 */
const DISALLOWED_CLASS_TOKENS = new Set([
  'nav',
  'menu',
  'sidebar',
  'footer',
  'navbar',
  'site-header',
  'site-footer',
  'advertisement',
  'ad-container',
  'cookie-banner',
  'newsletter',
  'subscribe',
  'social-share',
  'breadcrumb',
  'breadcrumbs',
  'pagination',
  'related-posts',
  'popup',
  'modal',
])

/** HTML void elements: they never open a scope and never need a close tag. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/**
 * Block-level tags that cannot meaningfully live inside chrome without ending
 * it. {@link stripChrome} uses them as implied end tags: when one of them opens
 * while a chrome element is being dropped, that element is treated as closed at
 * that point instead of swallowing the rest of the document.
 */
const CONTENT_BOUNDARY_TAGS = new Set([
  'article',
  'blockquote',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'ul',
])

/** Tags that separate text into lines when rendered. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

/**
 * One token of HTML is a comment, a declaration, a tag, or a run of text; quoted
 * attribute values are honoured so a `>` inside an attribute cannot end a tag.
 * {@link tokensOf} produces them in a single forward pass — the regular
 * expression this used to be let its body repetition absorb later `<`
 * characters, so each unterminated `<tag` rescanned to end of input and a
 * malformed page took quadratic time.
 */

/** Named character references decoded by {@link decodeHtmlEntities}. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '\u2014',
  ndash: '\u2013',
  minus: '\u2212',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  deg: '\u00b0',
  plusmn: '\u00b1',
  times: '\u00d7',
  divide: '\u00f7',
  frac12: '\u00bd',
  frac14: '\u00bc',
  frac34: '\u00be',
  sup2: '\u00b2',
  sup3: '\u00b3',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  middot: '\u00b7',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  harr: '\u2194',
  crarr: '\u21b5',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  curren: '\u00a4',
  brvbar: '\u00a6',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  ordf: '\u00aa',
  ordm: '\u00ba',
  not: '\u00ac',
  infin: '\u221e',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  asymp: '\u2248',
  equiv: '\u2261',
  sum: '\u2211',
  prod: '\u220f',
  radic: '\u221a',
  int: '\u222b',
  part: '\u2202',
  nabla: '\u2207',
  isin: '\u2208',
  notin: '\u2209',
  empty: '\u2205',
  forall: '\u2200',
  exist: '\u2203',
  ang: '\u2220',
  perp: '\u22a5',
  sdot: '\u22c5',
  oplus: '\u2295',
  otimes: '\u2297',
}

/**
 * Decode HTML character references: numeric (`&#38;`, `&#x26;`) and the named
 * subset in {@link NAMED_ENTITIES}. Unknown references are left untouched, and
 * the common legacy spellings without a trailing semicolon (`&amp`) are also
 * decoded.
 *
 * @param input - text possibly containing character references.
 * @returns the decoded text.
 */
export function decodeHtmlEntities(input: string): string {
  if (input.length === 0 || !input.includes('&')) return input
  const decoded = input.replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
        if (code >= 0xd800 && code <= 0xdfff) return match
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return NAMED_ENTITIES[body] ?? match
    },
  )
  return decoded.replace(/&(amp|lt|gt|quot|nbsp)(?![a-zA-Z0-9;])/g, (match, name: string) => {
    return NAMED_ENTITIES[name] ?? match
  })
}

/**
 * Collapse a text blob into readable lines: control and zero-width characters
 * removed, runs of horizontal whitespace collapsed, every line trimmed, blank
 * lines dropped.
 *
 * @param input - raw extracted text.
 * @returns newline-separated non-empty lines, without a trailing newline.
 */
export function collapseWhitespace(input: string): string {
  const cleaned = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
  const lines: string[] = []
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/[^\S\n]+/g, ' ').trim()
    if (line.length > 0) lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Extract the `<title>` of a document, falling back to `og:title` and then the
 * first `<h1>`.
 *
 * @param html - raw HTML.
 * @returns the decoded, single-line title, or `''`.
 */
export function extractTitle(html: string): string {
  const title = elementInner(html, 'title')
  if (title !== undefined) {
    const text = collapseInline(decodeHtmlEntities(stripTags(title)))
    if (text.length > 0) return text
  }
  const ogTitle = metaContent(html, 'og:title')
  if (ogTitle.length > 0) return ogTitle
  const h1 = elementInner(html, 'h1')
  if (h1 !== undefined) return collapseInline(decodeHtmlEntities(stripTags(h1)))
  return ''
}

/**
 * Extract the page description from `<meta name="description">`, falling back
 * to `og:description`.
 *
 * @param html - raw HTML.
 * @returns the decoded, single-line description, or `''`.
 */
export function extractMetaDescription(html: string): string {
  const description = metaContent(html, 'description')
  if (description.length > 0) return description
  return metaContent(html, 'og:description')
}

/**
 * Per-host extraction handlers, keyed by host suffix.
 *
 * Upstream `scraper/scraper.py` special-cases hosts and file extensions when it
 * chooses a scraper class (`arxiv.org` → `ArxivScraper`, `*.pdf` →
 * `PyMuPDFScraper`) but has no selector table of its own. This table is the
 * port's equivalent for the `bs` scraper: each entry narrows the page to the
 * region that actually holds the article, exactly as a site-specific soup
 * selector would, and returns an HTML fragment that is then run through the
 * shared pipeline. Returning the input unchanged is always valid.
 *
 * `arxiv.org` is present because upstream routes that host to a dedicated
 * scraper; the remaining hosts are the common article sites where the generic
 * extractor would otherwise keep list-page chrome.
 */
export const SITE_TEXT_HANDLERS: Record<string, (html: string) => string> = {
  'arxiv.org': (html) =>
    elementInner(html, 'blockquote', (tag) => /class\s*=\s*["'][^"']*abstract/i.test(tag)) ??
    elementInner(html, 'div', (tag) => /id\s*=\s*["']abs["']/i.test(tag)) ??
    html,
  'github.com': (html) =>
    elementInner(html, 'article', (tag) => /markdown-body/i.test(tag)) ?? html,
  'medium.com': (html) => elementInner(html, 'article') ?? html,
  'wikipedia.org': (html) =>
    elementInner(html, 'div', (tag) => /id\s*=\s*["']mw-content-text["']/i.test(tag)) ?? html,
  'stackoverflow.com': (html) =>
    elementInner(html, 'div', (tag) => /id\s*=\s*["'](?:mainbar|question)["']/i.test(tag)) ?? html,
  'developer.mozilla.org': (html) =>
    elementInner(html, 'article', (tag) => /main-page-content/i.test(tag)) ?? html,
}

/**
 * Find the per-site handler for a URL or bare hostname.
 *
 * Hosts match exactly or as a dot-suffixed subdomain (`blog.medium.com` matches
 * the `medium.com` entry).
 *
 * @param hostOrUrl - absolute URL or hostname.
 * @returns the handler, or `undefined` when the site is not special-cased.
 */
export function handlerForHost(hostOrUrl: string): ((html: string) => string) | undefined {
  const host = hostnameOf(hostOrUrl)
  if (host === undefined || host.length === 0) return undefined
  const direct = SITE_TEXT_HANDLERS[host]
  if (direct !== undefined) return direct
  for (const key of Object.keys(SITE_TEXT_HANDLERS)) {
    if (host.endsWith(`.${key}`)) return SITE_TEXT_HANDLERS[key]
  }
  return undefined
}

/**
 * Extract readable text, metadata, and image URLs from an HTML document.
 *
 * Pipeline: drop chrome elements (script/style/nav/header/footer/…), optionally
 * narrow to a per-site region, prefer `<main>`/`<article>`, render block-aware
 * text, decode entities, and collapse whitespace. `<main>`/`<article>` are only
 * preferred when they contain text. Never throws: empty, malformed, or
 * content-free input yields empty fields.
 *
 * @param html - raw HTML from the HTTP or web seam.
 * @param options - optional page URL (for relative image URLs and per-site handlers).
 * @returns the extracted title, description, text, and image URLs.
 */
export function extractHtml(
  html: string,
  options: HtmlExtractionOptions = {},
): HtmlExtraction {
  const source = typeof html === 'string' ? html : ''
  if (source.trim().length === 0) {
    return { title: '', description: '', text: '', imageUrls: [] }
  }

  const pageUrl = options.url
  const cleaned = stripChrome(source)
  const handler = pageUrl === undefined ? undefined : handlerForHost(pageUrl)
  const scoped = handler === undefined ? cleaned : handler(cleaned)
  const text = collapseWhitespace(renderText(selectContentRegion(scoped)))

  return {
    title: extractTitle(source),
    description: extractMetaDescription(source),
    // A page with no letters or digits anywhere holds no usable content; treat
    // it as garbage rather than emitting punctuation noise into the context.
    text: /[\p{L}\p{N}]/u.test(text) ? text : '',
    imageUrls: collectImageUrls(cleaned, resolveBaseUrl(source, pageUrl)),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `<` — the first character of every markup token. */
const CHAR_LT = 0x3c

/** `>` — the character that ends a tag, declaration, or text run boundary. */
const CHAR_GT = 0x3e

/** `!` — the character that starts a comment, CDATA section, or declaration. */
const CHAR_BANG = 0x21

/** `/` — the character that marks a closing tag. */
const CHAR_SLASH = 0x2f

/** `"` — one of the two attribute-value quote characters. */
const CHAR_DOUBLE_QUOTE = 0x22

/** `'` — one of the two attribute-value quote characters. */
const CHAR_SINGLE_QUOTE = 0x27

/** True for an ASCII letter, the required first character of a tag name. */
function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/** True for a letter, digit, `:`, or `-`: the rest of a tag name. */
function isNameChar(code: number): boolean {
  return (
    isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x2d
  )
}

/**
 * Tokenize a document in one forward pass, never backtracking.
 *
 * The regular expression this replaces
 * (`/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g`) let its body
 * repetition absorb later `<` characters, so every unterminated `<tag` scanned
 * to end of input and then the engine restarted at the next `<`: a 10 KB page of
 * `'<a'` took over a second, and a 100 KB one took 141 s. The token stream is
 * unchanged — text runs, comments, declarations, CDATA sections, and tags whose
 * quoted attribute values may contain `>`.
 *
 * Tag bodies are sized with a right-to-left table over the document ("where
 * does the body that starts here end?"), so an unterminated body costs one
 * shared pass instead of one scan per `<`. The table is built lazily, on the
 * first body that has to be measured, because well-formed documents never need
 * it.
 */
function tokensOf(html: string): string[] {
  const length = html.length
  const tokens: string[] = []
  const lastGt = html.lastIndexOf('>')
  const lastCommentEnd = html.lastIndexOf('-->')
  const lastCdataEnd = html.lastIndexOf(']]>')

  /**
   * `table[index]` is the offset of the `>` that ends the tag body starting at
   * `index`, or `-1` when that body can never be completed. Built once, only
   * when some tag body has to be sized.
   */
  let bodyTable: Int32Array | undefined

  /** Build (once) and return the tag-body terminator table. */
  const terminatorTable = (): Int32Array => {
    if (bodyTable !== undefined) return bodyTable
    const table = new Int32Array(length + 1)
    table[length] = -1
    let nextDouble = length
    let nextSingle = length
    for (let index = length - 1; index >= 0; index -= 1) {
      const code = html.charCodeAt(index)
      if (code === CHAR_GT) {
        table[index] = index
      } else if (code === CHAR_DOUBLE_QUOTE) {
        // A quoted value ends at the next `"`; with none, the body is unclosed.
        table[index] = nextDouble === length ? -1 : (table[nextDouble + 1] ?? -1)
        nextDouble = index
      } else if (code === CHAR_SINGLE_QUOTE) {
        table[index] = nextSingle === length ? -1 : (table[nextSingle + 1] ?? -1)
        nextSingle = index
      } else {
        table[index] = table[index + 1] ?? -1
      }
    }
    bodyTable = table
    return table
  }

  /**
   * The exclusive end of the comment, declaration, or tag that starts at
   * `start`, or `-1` when the markup there is incomplete (in which case the
   * caller drops the `<` and resumes one character later).
   */
  const scanMarkup = (start: number): number => {
    if (html.charCodeAt(start) !== CHAR_LT) return -1
    if (html.charCodeAt(start + 1) === CHAR_BANG) {
      if (lastCommentEnd >= start + 4 && html.startsWith('<!--', start)) {
        const end = html.indexOf('-->', start + 4)
        if (end >= 0) return end + 3
      }
      if (lastCdataEnd >= start + 9 && html.startsWith('<![CDATA[', start)) {
        const end = html.indexOf(']]>', start + 9)
        if (end >= 0) return end + 3
      }
      if (lastGt < start + 2) return -1
      return html.indexOf('>', start + 2) + 1
    }
    let cursor = start + 1
    if (html.charCodeAt(cursor) === CHAR_SLASH) cursor += 1
    if (!isNameStart(html.charCodeAt(cursor))) return -1
    cursor += 1
    while (cursor < length && isNameChar(html.charCodeAt(cursor))) cursor += 1
    const stop = terminatorTable()[cursor] ?? -1
    return stop < 0 ? -1 : stop + 1
  }

  let index = 0
  while (index < length) {
    const start = html.indexOf('<', index)
    if (start < 0) {
      tokens.push(html.slice(index))
      break
    }
    if (start > index) tokens.push(html.slice(index, start))
    const end = scanMarkup(start)
    if (end < 0) {
      index = start + 1
      continue
    }
    tokens.push(html.slice(start, end))
    index = end
  }
  return tokens
}

/**
 * One element on a {@link pushOpen} stack. `drop` marks chrome whose content is
 * being discarded; the element-matching passes leave it unset.
 */
interface OpenElement {
  /** Lowercased tag name. */
  tag: string
  /** Whether the element's content is being dropped. */
  drop?: boolean
  /** Index of the opening tag token, used to look up implied end tags. */
  tokenIndex?: number
}

/**
 * The stack position of the nearest open element named `tag`, or `-1`.
 *
 * `openAt` maps a tag name to the stack positions of its open elements in
 * increasing order, so the nearest one is always the last. Scanning the stack
 * instead would make `'<x>'.repeat(n) + '</y>'.repeat(n)` — every close tag
 * matching nothing — quadratic.
 */
function topOpenIndex(openAt: Map<string, number[]>, tag: string): number {
  const positions = openAt.get(tag)
  if (positions === undefined || positions.length === 0) return -1
  return positions[positions.length - 1] ?? -1
}

/** Push a freshly opened element, indexing it by tag name. */
function pushOpen(
  stack: OpenElement[],
  openAt: Map<string, number[]>,
  tag: string,
  entry: OpenElement,
): void {
  const positions = openAt.get(tag)
  if (positions === undefined) openAt.set(tag, [stack.length])
  else positions.push(stack.length)
  stack.push(entry)
}

/**
 * Pop down to (and including) `openIndex`, keeping the tag index in sync.
 *
 * @returns how many of the popped elements were chrome.
 */
function popOpen(
  stack: OpenElement[],
  openAt: Map<string, number[]>,
  openIndex: number,
): number {
  let dropped = 0
  for (let scan = stack.length - 1; scan >= openIndex; scan -= 1) {
    const entry = stack[scan]
    if (entry === undefined) continue
    openAt.get(entry.tag)?.pop()
    if (entry.drop === true) dropped += 1
  }
  stack.length = openIndex
  return dropped
}

/**
 * Mark every opening-tag token that a later closing tag actually closes, using
 * the same pairing {@link stripChrome} applies (nearest open tag with the same
 * name wins, and unmatched closing tags are ignored).
 *
 * @param tokens - a token stream from {@link tokensOf}.
 * @returns a flag per token index: `true` when that opening tag is closed.
 */
function markMatchedOpenTags(tokens: readonly string[]): boolean[] {
  const matched: boolean[] = new Array<boolean>(tokens.length).fill(false)
  const stack: Array<{ tag: string; drop?: boolean; tokenIndex: number }> = []
  const openAt = new Map<string, number[]>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (!token.startsWith('<')) continue
    const tag = tagNameOf(token)
    if (tag === undefined || VOID_TAGS.has(tag)) continue
    if (/^<\s*\//.test(token)) {
      const openIndex = topOpenIndex(openAt, tag)
      if (openIndex < 0) continue
      const entry = stack[openIndex]
      if (entry !== undefined) matched[entry.tokenIndex] = true
      popOpen(stack, openAt, openIndex)
      continue
    }
    pushOpen(stack, openAt, tag, { tag, tokenIndex: index })
  }
  return matched
}

/** The lowercased tag name of a tag token, or `undefined` for other tokens. */
function tagNameOf(token: string): string | undefined {
  const match = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(token)
  return match?.[1]?.toLowerCase()
}

/** Read an attribute value from a single tag token. */
function attrOf(token: string, name: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'i',
  )
  const match = pattern.exec(token)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3] ?? ''
}

/** True when a tag token carries an explicitly hidden marker. */
function isHiddenTag(token: string): boolean {
  if (/(?:^|\s)hidden(?:\s|=|>|$)/i.test(token)) return true
  if (/aria-hidden\s*=\s*["']?\s*true/i.test(token)) return true
  const style = attrOf(token, 'style')
  if (style !== undefined && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) {
    return true
  }
  return false
}

/** True when a tag token carries a chrome class (see {@link DISALLOWED_CLASS_TOKENS}). */
function hasDisallowedClass(token: string): boolean {
  const classAttr = attrOf(token, 'class')
  if (classAttr === undefined || classAttr.length === 0) return false
  return classAttr
    .toLowerCase()
    .split(/\s+/)
    .some((tokenName) => tokenName.length > 0 && DISALLOWED_CLASS_TOKENS.has(tokenName))
}

/**
 * Remove comments, declarations, and every element that is chrome rather than
 * content — upstream `clean_soup` plus the container tags this port adds.
 *
 * A chrome element that is never closed (a common shape in real pages) would
 * otherwise swallow every following sibling, so {@link CONTENT_BOUNDARY_TAGS}
 * act as implied end tags: when one opens while an *unclosed* chrome element is
 * being dropped, the chrome is closed there and the rest of the document is
 * kept. Well-formed chrome is unaffected, because a chrome element with a
 * matching close tag is never treated as unclosed.
 */
function stripChrome(html: string): string {
  const tokens = tokensOf(html)
  const out: string[] = []
  const stack: Array<{ tag: string; drop: boolean; tokenIndex: number }> = []
  const openAt = new Map<string, number[]>()
  // Which opening tags a later close tag actually closes, computed only when an
  // implied end tag needs to know (healthy pages never ask).
  let matched: boolean[] | undefined
  let dropDepth = 0

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token.startsWith('<!--') || /^<![^>]*>$/.test(token)) continue
    if (!token.startsWith('<')) {
      if (dropDepth === 0) out.push(token)
      continue
    }

    const tag = tagNameOf(token)
    if (tag === undefined) continue
    const closing = /^<\s*\//.test(token)

    if (closing) {
      const openIndex = topOpenIndex(openAt, tag)
      if (openIndex < 0) continue
      dropDepth -= popOpen(stack, openAt, openIndex)
      if (dropDepth === 0) out.push(token)
      continue
    }

    // Implied end tags: close a run of chrome whose elements never close, so a
    // stray `<nav>`/`<form>`/`class="menu"` cannot discard the article body.
    if (dropDepth > 0 && CONTENT_BOUNDARY_TAGS.has(tag)) {
      let runStart = stack.length
      while (runStart > 0 && stack[runStart - 1]?.drop === true) runStart -= 1
      if (runStart < stack.length) {
        matched ??= markMatchedOpenTags(tokens)
        for (let scan = runStart; scan < stack.length; scan += 1) {
          const entry = stack[scan]
          if (entry !== undefined && matched[entry.tokenIndex] !== true) {
            dropDepth -= popOpen(stack, openAt, runStart)
            break
          }
        }
      }
    }

    const drop =
      dropDepth > 0 ||
      DROP_TAGS.has(tag) ||
      hasDisallowedClass(token) ||
      isHiddenTag(token)
    if (!drop) out.push(token)
    if (!VOID_TAGS.has(tag)) {
      pushOpen(stack, openAt, tag, { tag, drop, tokenIndex: index })
      if (drop) dropDepth += 1
    }
  }

  return out.join('')
}

/** Render already-cleaned HTML as text, separating block elements with newlines. */
function renderText(html: string): string {
  const out: string[] = []
  for (const token of tokensOf(html)) {
    if (token.startsWith('<!--') || /^<![^>]*>$/.test(token)) continue
    if (token.startsWith('<')) {
      const tag = tagNameOf(token)
      if (tag === undefined) continue
      if (tag === 'br' || tag === 'hr') out.push('\n')
      else if (BLOCK_TAGS.has(tag)) out.push('\n')
      continue
    }
    out.push(decodeHtmlEntities(token))
  }
  return out.join('')
}

/**
 * Prefer the `<main>`/`<article>` subtree when it holds text, mirroring how a
 * reader-mode extractor focuses the page body.
 *
 * The test is on the *rendered* text, not the raw inner HTML: markup always
 * contains letters (`<img`, `class`), so an image-only `<main id="app">` used
 * to win and then be discarded as too short, taking the real article body — a
 * following sibling — down with it.
 */
function selectContentRegion(html: string): string {
  for (const tag of ['main', 'article']) {
    const inner = elementInner(html, tag)
    if (inner === undefined) continue
    if (/[\p{L}\p{N}]/u.test(collapseWhitespace(renderText(inner)))) return inner
  }
  return html
}

/** The text of a `<meta>` tag matching a `name` or `property` key. */
function metaContent(html: string, key: string): string {
  for (const token of tokensOf(html)) {
    if (tagNameOf(token) !== 'meta') continue
    const name = attrOf(token, 'name') ?? attrOf(token, 'property')
    if (name === undefined || name.toLowerCase() !== key.toLowerCase()) continue
    const content = attrOf(token, 'content')
    if (content === undefined) continue
    return collapseInline(decodeHtmlEntities(content))
  }
  return ''
}

/** Strip tags from a fragment, keeping its text. */
function stripTags(html: string): string {
  const out: string[] = []
  let index = 0
  while (index < html.length) {
    const start = html.indexOf('<', index)
    if (start < 0) break
    const end = html.indexOf('>', start + 1)
    if (end < 0) break
    out.push(html.slice(index, start), ' ')
    index = end + 1
  }
  out.push(html.slice(index))
  return out.join('')
}

/** Collapse every run of whitespace into single spaces, then trim. */
function collapseInline(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/**
 * Return the inner HTML of the first matching element.
 *
 * Both patterns end in `>`, so no match can extend past the document's last
 * `>`: restricting the search to that prefix keeps every match's index and text
 * identical while denying the engine the runaway `[^>]*` backtracking that made
 * an unterminated `<main`/`<title` quadratic (39 KB took ~20 s).
 *
 * @param html - source HTML.
 * @param tag - tag name to look for.
 * @param accept - optional predicate over the opening tag token.
 * @returns the inner HTML, or `undefined` when no element matches.
 */
function elementInner(
  html: string,
  tag: string,
  accept?: (openingTag: string) => boolean,
): string | undefined {
  const lastGt = html.lastIndexOf('>')
  const searchSpace = lastGt < 0 ? '' : html.slice(0, lastGt + 1)
  const openPattern = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = openPattern.exec(searchSpace)) !== null) {
    if (accept !== undefined && !accept(match[0])) continue
    const innerStart = match.index + match[0].length
    const scanPattern = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi')
    scanPattern.lastIndex = innerStart
    let depth = 1
    let inner: RegExpExecArray | null
    while ((inner = scanPattern.exec(searchSpace)) !== null) {
      if (inner[0].startsWith('</')) {
        depth -= 1
        if (depth === 0) return html.slice(innerStart, inner.index)
      } else {
        depth += 1
      }
    }
    return html.slice(innerStart)
  }
  return undefined
}

/** Resolve the document's `<base href>` against the page URL, when present. */
function resolveBaseUrl(html: string, pageUrl: string | undefined): string | undefined {
  for (const token of tokensOf(html)) {
    if (tagNameOf(token) !== 'base') continue
    const href = attrOf(token, 'href')
    if (href !== undefined) return resolveUrl(href, pageUrl) ?? pageUrl
  }
  return pageUrl
}

/** Resolve a possibly relative URL; only absolute `http(s)` results survive. */
function resolveUrl(value: string, base: string | undefined): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (/^(?:data|javascript|mailto|about|blob):/i.test(trimmed)) return undefined
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (base === undefined) return undefined
  try {
    const resolved = new URL(trimmed, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : undefined
  } catch {
    return undefined
  }
}

/** The hostname of a URL or bare hostname, without port or credentials. */
function hostnameOf(hostOrUrl: string): string | undefined {
  const value = hostOrUrl.trim()
  if (value.length === 0) return undefined
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    try {
      return new URL(value).hostname.toLowerCase()
    } catch {
      return undefined
    }
  }
  const withoutPath = value.split(/[/?#]/, 1)[0] ?? ''
  const withoutUser = withoutPath.includes('@')
    ? (withoutPath.split('@').pop() ?? '')
    : withoutPath
  const host = withoutUser.split(':', 1)[0] ?? ''
  return host.length > 0 ? host.toLowerCase() : undefined
}

/** Parse `width`/`height` attributes, tolerating a `px` suffix. */
function parseDimension(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const digits = value.trim().replace(/px$/i, '')
  if (digits.length === 0) return undefined
  const parsed = Number.parseFloat(digits)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Collect image URLs, mirroring upstream `get_relevant_images`: relative URLs
 * are resolved against the page, only `http(s)` survives, images with small
 * explicit dimensions are dropped, class-scored images rank first, at most ten
 * are returned.
 */
function collectImageUrls(html: string, base: string | undefined): string[] {
  const scored: Array<{ url: string; score: number; order: number }> = []
  let order = 0

  for (const token of tokensOf(html)) {
    if (tagNameOf(token) !== 'img') continue
    const raw =
      attrOf(token, 'src') ?? attrOf(token, 'data-src') ?? attrOf(token, 'data-original')
    if (raw === undefined) continue
    const url = resolveUrl(raw, base)
    if (url === undefined) continue

    const classes = (attrOf(token, 'class') ?? '').toLowerCase().split(/\s+/)
    let score = 0
    if (classes.some((name) => name.length > 0 && IMAGE_CLASS_HINTS.has(name))) {
      score = 4
    } else {
      const width = parseDimension(attrOf(token, 'width'))
      const height = parseDimension(attrOf(token, 'height'))
      if (width !== undefined && height !== undefined) {
        if (width >= 2000 && height >= 1000) score = 3
        else if (width >= 1600 || height >= 800) score = 2
        else if (width >= 800 || height >= 500) score = 1
        else if (width >= 500 || height >= 300) score = 0
        else continue
      }
    }
    scored.push({ url, score, order: order++ })
  }

  const seen = new Set<string>()
  return scored
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .filter((image) => {
      if (seen.has(image.url)) return false
      seen.add(image.url)
      return true
    })
    .slice(0, 10)
    .map((image) => image.url)
}
