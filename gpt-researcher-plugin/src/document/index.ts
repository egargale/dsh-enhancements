/**
 * Document loaders and registry factory.
 *
 * Upstream, `report_source` decides where context comes from: `local` walks
 * `DOC_PATH` (`document/document.py`), `online` downloads a URL list
 * (`document/online_document.py`), `azure` pulls a blob container
 * (`document/azure_document_loader.py`), and `langchain_documents` accepts
 * caller-supplied documents (`document/langchain_document.py`). Every loader
 * returns the same `{url, raw_content}` shape the scrapers produce, so the rest
 * of the pipeline never learns where a document came from.
 *
 * @module gpt-researcher/document
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { withTimeout, type Runtime } from '../runtime.ts'
import { fetchWithPolicy } from '../utils/url-policy.ts'
import type { ScrapedContent } from '../types.ts'
import { extractHtml } from '../scraper/html.ts'
import {
  DocumentLoaderRegistry,
  LOCAL_DOCUMENT_EXTENSIONS,
  type DocumentLoaderDefinition,
  type DocumentLoadRequest,
} from './base.ts'

/** Raised when a loader cannot read its source, or is not configured. */
export class DocumentLoadError extends Error {
  override readonly name = 'DocumentLoadError'

  /**
   * @param message - human-readable reason, naming the source when known.
   * @param options - standard `Error` options (e.g. `cause`).
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/**
 * The extensions the `local` loader reads directly: the text-like subset of
 * {@link LOCAL_DOCUMENT_EXTENSIONS}. Binary formats are listed in
 * {@link UNSUPPORTED_DOCUMENT_REASONS} and always reported, never skipped
 * silently.
 */
export const TEXT_DOCUMENT_EXTENSIONS: readonly string[] = [
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
]

/** Extensions parsed as HTML/XML rather than emitted as raw markup. */
const MARKUP_DOCUMENT_EXTENSIONS = new Set(['.html', '.htm', '.xml'])

/**
 * Binary formats upstream handles with `langchain_community` loaders
 * (`PyMuPDFLoader`, `UnstructuredWordDocumentLoader`, …). None of those
 * extractors are bundled here, so each extension maps to the reason it is
 * reported instead.
 */
export const UNSUPPORTED_DOCUMENT_REASONS: Record<string, string> = {
  '.pdf': "PDF text extraction needs a PDF parser (upstream uses PyMuPDF), which is not bundled here. Convert the file to .txt/.md, or load it through the 'online' loader with an extraction provider.",
  '.doc': "legacy Word documents need an Unstructured extractor, which is not bundled here. Convert the file to .txt/.md first.",
  '.docx': "Word documents need an Unstructured extractor, which is not bundled here. Convert the file to .txt/.md first.",
  '.pptx': "PowerPoint decks need an Unstructured extractor, which is not bundled here. Export the slides to .txt/.md first.",
  '.xls': "Excel workbooks need an Unstructured extractor, which is not bundled here. Export the sheet to .csv first.",
  '.xlsx': "Excel workbooks need an Unstructured extractor, which is not bundled here. Export the sheet to .csv first.",
}

/** Timeout for one online document download; upstream uses a 6-second aiohttp timeout. */
const ONLINE_DOCUMENT_TIMEOUT_MS = 30_000

/** User agent for online downloads; upstream `OnlineDocumentLoader` sends `Mozilla/5.0`. */
const ONLINE_DOCUMENT_USER_AGENT = 'Mozilla/5.0'

/** Accept header used for online document downloads. */
const ONLINE_DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5'

/**
 * Abort the load when the caller's signal fires, so a cancelled run does not
 * keep reading the disk or the network.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DocumentLoadError('document loading aborted', { cause: signal.reason })
  }
}

/** Read a message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Normalise an extension list to the lowercased, dot-prefixed set used for lookups. */
function normaliseExtensions(extensions: readonly string[]): Set<string> {
  return new Set(
    extensions.map((extension) => {
      const lower = extension.toLowerCase()
      return lower.startsWith('.') ? lower : `.${lower}`
    }),
  )
}

/** The lowercased extension of a URL path, query string ignored. */
function extensionOfUrl(url: string): string {
  try {
    return extname(new URL(url).pathname).toLowerCase()
  } catch {
    return extname(url.split(/[?#]/, 1)[0] ?? url).toLowerCase()
  }
}

/** Recursively collect the regular files under a directory, sorted by name. */
async function collectFiles(
  runtime: Runtime,
  directory: string,
  signal: AbortSignal | undefined,
  out: string[],
): Promise<void> {
  throwIfAborted(signal)
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    throwIfAborted(signal)
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(runtime, path, signal, out)
      continue
    }
    if (entry.isFile()) {
      out.push(path)
      continue
    }
    if (entry.isSymbolicLink()) {
      const info = await stat(path).catch(() => undefined)
      if (info?.isFile() === true) {
        out.push(path)
        continue
      }
    }
    runtime.log.warn(`Skipping ${path}: not a regular file`)
  }
}

/** Resolve the local loader's source into a sorted list of regular files. */
async function resolveLocalFiles(
  runtime: Runtime,
  source: string | readonly string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const inputs = typeof source === 'string' ? [source] : [...(source ?? [])]
  if (inputs.length === 0) {
    throw new DocumentLoadError(
      'The local document loader needs a directory (DOC_PATH). ' +
        'Set DOC_PATH, or pass `source` on the load request.',
    )
  }
  const files: string[] = []
  for (const input of inputs) {
    throwIfAborted(signal)
    const info = await stat(input).catch(() => undefined)
    if (info === undefined) {
      runtime.log.warn(`Local document source not found, skipping: ${input}`)
      continue
    }
    if (info.isDirectory()) await collectFiles(runtime, input, signal, files)
    else if (info.isFile()) files.push(input)
    else runtime.log.warn(`Skipping ${input}: not a regular file or directory`)
  }
  return files
}

/** The `local` loader: walk a directory and read each supported file. */
const localLoader: DocumentLoaderDefinition = {
  name: 'local',
  keys: [],
  keyless: true,
  description:
    'Walk a directory (DOC_PATH) and read .txt/.md/.csv/.json/.html/.yaml files; binary formats are reported as unsupported.',
  async load(ctx: { runtime: Runtime }, request: DocumentLoadRequest): Promise<ScrapedContent[]> {
    const files = await resolveLocalFiles(ctx.runtime, request.source, request.signal)
    const accepted = normaliseExtensions(request.extensions ?? TEXT_DOCUMENT_EXTENSIONS)
    const documents: ScrapedContent[] = []

    for (const file of files) {
      throwIfAborted(request.signal)
      const extension = extname(file).toLowerCase()
      const unsupported = UNSUPPORTED_DOCUMENT_REASONS[extension]
      if (unsupported !== undefined) {
        ctx.runtime.log.warn(`Skipping unsupported document ${file} (${extension}): ${unsupported}`)
        continue
      }
      if (!accepted.has(extension)) {
        ctx.runtime.log.warn(
          `Skipping ${file}: unsupported extension '${extension || '(none)'}'. ` +
            `Supported: ${[...accepted].sort().join(', ')}`,
        )
        continue
      }
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (error) {
        ctx.runtime.log.warn(`Failed to read ${file}: ${errorMessage(error)}`)
        continue
      }
      const content = MARKUP_DOCUMENT_EXTENSIONS.has(extension)
        ? extractHtml(raw, { url: file }).text
        : raw
      // // DEVIATION: upstream reads markup with `BSHTMLLoader`, i.e. it strips
      // // tags before the text reaches the context. Markup files therefore go
      // // through the shared HTML extractor instead of contributing raw tags.
      if (content.trim().length === 0) {
        ctx.runtime.log.warn(`Skipping empty document ${file}`)
        continue
      }
      documents.push({ url: file, title: basename(file), raw_content: content })
    }

    if (documents.length === 0) {
      throw new DocumentLoadError(
        `Failed to load any documents from ${request.source === undefined ? '(no source)' : String(request.source)}. ` +
          `Supported extensions: ${[...accepted].sort().join(', ')}.`,
      )
    }
    return documents
  },
}

/** True when a downloaded body should go through the HTML extractor. */
function isHtmlDocument(contentType: string, extension: string, body: string): boolean {
  if (contentType.includes('html')) return true
  if (MARKUP_DOCUMENT_EXTENSIONS.has(extension)) {
    return contentType === '' || contentType.includes('html') || contentType.includes('xml')
  }
  const head = body.slice(0, 200).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

/** True when a content type is text-like enough to pass through unchanged. */
function isTextContentType(contentType: string): boolean {
  if (contentType === '') return true
  return (
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml')
  )
}

/** Fetch and extract one online document; returns `undefined` when unsupported. */
async function fetchOnlineDocument(
  runtime: Runtime,
  url: string,
  signal: AbortSignal | undefined,
): Promise<ScrapedContent | undefined> {
  const timeout = withTimeout(signal, ONLINE_DOCUMENT_TIMEOUT_MS)
  try {
    // `document_urls` is caller/model-controlled, and this path fetches it
    // directly: apply the same policy as the page scrapers, per redirect hop.
    const { response } = await fetchWithPolicy(
      runtime.http,
      url,
      {
        headers: {
          'User-Agent': ONLINE_DOCUMENT_USER_AGENT,
          Accept: ONLINE_DOCUMENT_ACCEPT,
        },
        signal: timeout.signal,
      },
      { allowPrivateHosts: runtime.allowPrivateHosts ?? false, maxRedirects: 5 },
    )
    if (!response.ok) throw new DocumentLoadError(`HTTP ${response.status} for ${url}`)
    const contentType = (response.header('content-type') ?? '').toLowerCase()
    const body = await response.text()
    const extension = extensionOfUrl(url)

    // // DEVIATION: upstream downloads PDFs/Office files and runs the matching
    // // langchain loader. Those extractors are not bundled, so the format is
    // // reported through UNSUPPORTED_DOCUMENT_REASONS instead of being skipped.
    const unsupported =
      UNSUPPORTED_DOCUMENT_REASONS[extension] ??
      (/application\/pdf/i.test(contentType) ? UNSUPPORTED_DOCUMENT_REASONS['.pdf'] : undefined)
    if (unsupported !== undefined) {
      runtime.log.warn(`Skipping ${url}: ${unsupported}`)
      return undefined
    }

    if (isHtmlDocument(contentType, extension, body)) {
      const extraction = extractHtml(body, { url })
      if (extraction.text.trim().length === 0) {
        runtime.log.warn(`Skipping ${url}: no extractable text`)
        return undefined
      }
      return {
        url,
        raw_content: extraction.text,
        title: extraction.title,
        image_urls: extraction.imageUrls,
        source_type: 'online',
      }
    }

    if (!isTextContentType(contentType)) {
      runtime.log.warn(
        `Skipping ${url}: content type '${contentType || '(none)'}' is not text and has no bundled extractor.`,
      )
      return undefined
    }

    if (body.trim().length === 0) {
      runtime.log.warn(`Skipping ${url}: empty response body`)
      return undefined
    }
    return { url, raw_content: body, title: '', source_type: 'online' }
  } finally {
    timeout.dispose()
  }
}

/** The `online` loader: fetch each URL and extract its text. */
const onlineLoader: DocumentLoaderDefinition = {
  name: 'online',
  keys: [],
  keyless: true,
  description:
    'Download a URL list through runtime.http and extract text (HTML reuses the local HTML extractor).',
  async load(ctx: { runtime: Runtime }, request: DocumentLoadRequest): Promise<ScrapedContent[]> {
    const urls = typeof request.source === 'string' ? [request.source] : [...(request.source ?? [])]
    if (urls.length === 0) {
      throw new DocumentLoadError(
        'The online document loader needs one or more URLs (report_source=online).',
      )
    }
    const documents: ScrapedContent[] = []
    for (const url of urls) {
      throwIfAborted(request.signal)
      try {
        const document = await fetchOnlineDocument(ctx.runtime, url, request.signal)
        if (document !== undefined) documents.push(document)
      } catch (error) {
        // One failing URL must not abort the batch (upstream logs and continues).
        ctx.runtime.log.warn(`Failed to load ${url}: ${errorMessage(error)}`)
      }
    }
    if (documents.length === 0) {
      throw new DocumentLoadError(`Failed to load any documents from ${urls.length} URL(s).`)
    }
    return documents
  },
}

/**
 * The `azure` loader: the upstream interface over `AZURE_CONNECTION_STRING` and
 * `AZURE_CONTAINER_NAME`.
 *
 * // DEVIATION: upstream uses `azure-storage-blob` to download every blob to a
 * // temp directory and then hands the paths to `DocumentLoader`. The Azure SDK
 * // is not a dependency of this port, so configuration is validated (and a
 * // missing setting fails loudly) but no download is attempted. Export the
 * // container locally and use the `local` loader instead.
 */
const azureLoader: DocumentLoaderDefinition = {
  name: 'azure',
  keys: ['AZURE_CONNECTION_STRING', 'AZURE_CONTAINER_NAME'],
  keyless: false,
  description:
    'Azure Blob container source (AZURE_CONNECTION_STRING, AZURE_CONTAINER_NAME). Not bundled: fails with instructions.',
  async load(ctx: { runtime: Runtime }, request: DocumentLoadRequest): Promise<ScrapedContent[]> {
    const connectionString = ctx.runtime.env('AZURE_CONNECTION_STRING')
    const container =
      ctx.runtime.env('AZURE_CONTAINER_NAME') ??
      (typeof request.source === 'string' ? request.source : undefined)
    if (!connectionString || !container) {
      throw new DocumentLoadError(
        'Azure document loading is not configured: set AZURE_CONNECTION_STRING and ' +
          'AZURE_CONTAINER_NAME (or pass `source` as the container name). ' +
          "Alternatively set REPORT_SOURCE=local and point DOC_PATH at an exported copy of the container.",
      )
    }
    throw new DocumentLoadError(
      `Azure blob loading is not bundled in this port (container '${container}'): the azure-storage-blob ` +
        'SDK is not a dependency here. Export the container to a local directory and use the ' +
        "'local' loader, or load the files through the 'online' loader.",
    )
  },
}

/** The `documents` loader: pass caller-supplied documents straight through. */
const documentsLoader: DocumentLoaderDefinition = {
  name: 'documents',
  keys: [],
  keyless: true,
  description:
    'Pass through documents supplied by the caller (upstream report_source=langchain_documents).',
  async load(_ctx: { runtime: Runtime }, request: DocumentLoadRequest): Promise<ScrapedContent[]> {
    if (request.documents === undefined) {
      throw new DocumentLoadError(
        'The documents loader needs `request.documents` (upstream report_source=langchain_documents).',
      )
    }
    return request.documents.map((document) => ({
      url: document.url,
      raw_content: document.raw_content,
      title: document.title ?? '',
      image_urls: [...(document.image_urls ?? [])],
      source_type: document.source_type ?? 'documents',
    }))
  },
}

/** The upstream-compatible default loaders, in registry order. */
function defaultLoaders(): DocumentLoaderDefinition[] {
  return [localLoader, onlineLoader, azureLoader, documentsLoader]
}

/**
 * Build the document loader registry: the upstream-compatible defaults plus any
 * extra definitions a deployment (or a test) wants to add or override.
 *
 * @param extra - additional definitions; a name collision replaces the default.
 * @returns a registry holding every definition.
 */
export function createDocumentLoaderRegistry(
  extra: readonly DocumentLoaderDefinition[] = [],
): DocumentLoaderRegistry {
  return new DocumentLoaderRegistry([...defaultLoaders(), ...extra])
}

/**
 * Re-exported so consumers (the agent composition root, tests) can name the
 * loader contract without importing `document/base.ts` directly.
 */
export type { DocumentLoaderDefinition, DocumentLoadRequest } from './base.ts'
