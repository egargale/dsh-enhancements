/**
 * Offline unit tests for the document loader module tree (`src/document`).
 *
 * The `local` loader is exercised against a real temporary directory (that is
 * its whole job); every network loader runs against a fake `Runtime.http`.
 *
 * @module gpt-researcher/test/unit/document
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { HttpFetch, HttpResponse, Runtime } from '../../src/runtime.ts'
import type { ScrapedContent } from '../../src/types.ts'
import {
  DocumentLoadError,
  TEXT_DOCUMENT_EXTENSIONS,
  UNSUPPORTED_DOCUMENT_REASONS,
  createDocumentLoaderRegistry,
} from '../../src/document/index.ts'
import type { DocumentLoaderDefinition } from '../../src/document/base.ts'

/** A paragraph long enough to be visible in every assertion. */
const LONG_PARAGRAPH =
  'Local documents describe how retrieval augmented generation assembles context from private files.'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake `HttpResponse`. */
function fakeResponse(
  body: string,
  options: { status?: number; contentType?: string } = {},
): HttpResponse {
  const status = options.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    header: (name: string) =>
      name.toLowerCase() === 'content-type'
        ? (options.contentType ?? 'text/html; charset=utf-8')
        : null,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  }
}

/** The fakes one test needs. */
interface Harness {
  runtime: Runtime
  /** The context object loaders receive (upstream's loader takes only a runtime). */
  ctx: { runtime: Runtime }
  warnings: string[]
}

/** Build a `Runtime` around fake seams. */
function makeHarness(options: {
  http?: HttpFetch
  env?: Record<string, string>
  signal?: AbortSignal
} = {}): Harness {
  const warnings: string[] = []
  const runtime: Runtime = {
    llm: { complete: async () => ({ text: '' }) },
    http:
      options.http ??
      (async (url) => {
        throw new Error(`unexpected HTTP request to ${url}`)
      }),
    env: (name: string) => options.env?.[name],
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message)
      },
      error: () => {},
    },
    progress: () => {},
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  return { runtime, ctx: { runtime }, warnings }
}

/** Look up a default loader, failing the test when it is missing. */
function loaderFor(name: string): DocumentLoaderDefinition {
  const definition = createDocumentLoaderRegistry().get(name)
  assert.ok(definition, `loader '${name}' should exist`)
  return definition
}

/** Create a temporary directory that the test cleans up afterwards. */
async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gptr-documents-'))
  t.after(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

// ---------------------------------------------------------------------------
// local loader
// ---------------------------------------------------------------------------

test('local reads supported files, ignores directories, and reports binaries', async (t) => {
  const directory = await makeTempDir(t)
  await writeFile(join(directory, 'notes.txt'), 'Plain notes about retrieval.')
  await writeFile(join(directory, 'data.csv'), 'a,b\n1,2\n')
  await writeFile(join(directory, 'config.yaml'), 'key: value\n')
  await writeFile(
    join(directory, 'page.html'),
    '<html><head><title>Page</title><script>bad()</script></head>' +
      '<body><p>Extracted page body text.</p></body></html>',
  )
  await writeFile(join(directory, 'report.pdf'), '%PDF-1.4 not really a pdf')
  await mkdir(join(directory, 'nested'))
  await writeFile(join(directory, 'nested', 'deep.md'), '# Deep notes\n\nNested content.')

  const harness = makeHarness()
  const documents = await loaderFor('local').load(harness.ctx, { source: directory })

  assert.deepEqual(
    documents.map((document) => document.url),
    [
      join(directory, 'config.yaml'),
      join(directory, 'data.csv'),
      join(directory, 'nested', 'deep.md'),
      join(directory, 'notes.txt'),
      join(directory, 'page.html'),
    ],
  )
  for (const document of documents) {
    assert.ok(document.raw_content.length > 0)
    assert.equal(document.title, document.url.split('/').pop())
  }

  const byName = new Map(documents.map((document) => [document.url, document]))
  assert.equal(byName.get(join(directory, 'notes.txt'))?.raw_content, 'Plain notes about retrieval.')
  assert.equal(byName.get(join(directory, 'data.csv'))?.raw_content, 'a,b\n1,2\n')
  assert.equal(byName.get(join(directory, 'config.yaml'))?.raw_content, 'key: value\n')
  assert.equal(
    byName.get(join(directory, 'nested', 'deep.md'))?.raw_content,
    '# Deep notes\n\nNested content.',
  )
  // HTML goes through the shared extractor, so markup and scripts are gone.
  assert.equal(byName.get(join(directory, 'page.html'))?.raw_content, 'Extracted page body text.')

  // Directories are walked, never returned as documents.
  assert.ok(!documents.some((document) => document.url === join(directory, 'nested')))
  // The binary format is reported with its reason, not silently skipped.
  assert.ok(harness.warnings.some((warning) => warning.includes('report.pdf')))
  assert.ok(harness.warnings.some((warning) => warning.includes('PDF')))
})

test('local accepts a list of explicit file paths', async (t) => {
  const directory = await makeTempDir(t)
  const file = join(directory, 'one.txt')
  await writeFile(file, 'One document.')
  const harness = makeHarness()
  const documents = await loaderFor('local').load(harness.ctx, { source: [file] })
  assert.equal(documents.length, 1)
  assert.equal(documents[0]?.url, file)
})

test('local honours an extensions override and reports other extensions', async (t) => {
  const directory = await makeTempDir(t)
  await writeFile(join(directory, 'notes.txt'), 'Text notes.')
  await writeFile(join(directory, 'data.csv'), 'a,b\n')
  const harness = makeHarness()
  const documents = await loaderFor('local').load(harness.ctx, {
    source: directory,
    extensions: ['.txt'],
  })
  assert.deepEqual(
    documents.map((document) => document.url),
    [join(directory, 'notes.txt')],
  )
  assert.ok(harness.warnings.some((warning) => warning.includes('unsupported extension')))
})

test('local fails clearly when nothing could be loaded', async (t) => {
  const directory = await makeTempDir(t)
  await writeFile(join(directory, 'report.pdf'), '%PDF-1.4')
  await writeFile(join(directory, 'binary.bin'), '\u0000\u0001')
  const harness = makeHarness()
  await assert.rejects(
    loaderFor('local').load(harness.ctx, { source: directory }),
    /Failed to load any documents/,
  )
  assert.ok(harness.warnings.some((warning) => warning.includes('report.pdf')))
})

test('local needs a source and skips missing paths with a warning', async (t) => {
  const directory = await makeTempDir(t)
  await writeFile(join(directory, 'notes.txt'), 'Text notes.')
  const harness = makeHarness()
  await assert.rejects(loaderFor('local').load(harness.ctx, {}), /needs a directory/)

  const documents = await loaderFor('local').load(harness.ctx, {
    source: [join(directory, 'missing.txt'), join(directory, 'notes.txt')],
  })
  assert.equal(documents.length, 1)
  assert.ok(harness.warnings.some((warning) => warning.includes('missing.txt')))
})

test('local stops when the request signal is aborted', async (t) => {
  const directory = await makeTempDir(t)
  await writeFile(join(directory, 'notes.txt'), 'Text notes.')
  const harness = makeHarness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    loaderFor('local').load(harness.ctx, { source: directory, signal: controller.signal }),
    /aborted/,
  )
})

// ---------------------------------------------------------------------------
// online loader
// ---------------------------------------------------------------------------

test('online extracts HTML and passes text formats through', async () => {
  const html = `<html><head><title>Online page</title><script>bad()</script></head><body><p>${LONG_PARAGRAPH}</p></body></html>`
  const http: HttpFetch = async (url) => {
    if (url.endsWith('.json')) return fakeResponse('{"a":1}', { contentType: 'application/json' })
    if (url.endsWith('.txt')) return fakeResponse('plain body', { contentType: 'text/plain' })
    return fakeResponse(html)
  }
  const harness = makeHarness({ http })
  const documents = await loaderFor('online').load(harness.ctx, {
    source: [
      'https://example.com/a',
      'https://example.com/data.json',
      'https://example.com/notes.txt',
    ],
  })

  assert.deepEqual(
    documents.map((document) => document.url),
    ['https://example.com/a', 'https://example.com/data.json', 'https://example.com/notes.txt'],
  )
  const page = documents[0]
  assert.equal(page?.title, 'Online page')
  assert.equal(page?.raw_content, LONG_PARAGRAPH)
  assert.ok(!page?.raw_content.includes('bad()'))
  assert.equal(page?.source_type, 'online')
  assert.equal(documents[1]?.raw_content, '{"a":1}')
  assert.equal(documents[2]?.raw_content, 'plain body')
})

test('online reports an unsupported binary URL instead of skipping it silently', async () => {
  const harness = makeHarness({
    http: async () => fakeResponse('%PDF-1.4', { contentType: 'application/pdf' }),
  })
  await assert.rejects(
    loaderFor('online').load(harness.ctx, { source: ['https://example.com/paper.pdf'] }),
    /Failed to load any documents/,
  )
  assert.ok(harness.warnings.some((warning) => warning.includes('paper.pdf')))
  assert.ok(UNSUPPORTED_DOCUMENT_REASONS['.pdf']?.includes('PDF'))
})

test('online logs and continues when one URL fails', async () => {
  const html = `<html><body><p>${LONG_PARAGRAPH}</p></body></html>`
  const harness = makeHarness({
    http: async (url) => {
      if (url.includes('boom')) throw new Error('network down')
      return fakeResponse(html)
    },
  })
  const documents = await loaderFor('online').load(harness.ctx, {
    source: ['https://example.com/boom', 'https://example.com/ok'],
  })
  assert.deepEqual(
    documents.map((document) => document.url),
    ['https://example.com/ok'],
  )
  assert.ok(harness.warnings.some((warning) => warning.includes('network down')))
})

test('online needs one or more URLs', async () => {
  const harness = makeHarness()
  await assert.rejects(loaderFor('online').load(harness.ctx, {}), /one or more URLs/)
})

// ---------------------------------------------------------------------------
// documents loader
// ---------------------------------------------------------------------------

test('documents passes caller-supplied documents straight through', async () => {
  const supplied: ScrapedContent[] = [
    {
      url: 'doc://one',
      raw_content: 'First body.',
      title: 'First',
      image_urls: ['https://img.example.com/1.png'],
    },
    { url: 'doc://two', raw_content: 'Second body.', source_type: 'langchain' },
  ]
  const harness = makeHarness()
  const documents = await loaderFor('documents').load(harness.ctx, { documents: supplied })

  assert.deepEqual(documents, [
    {
      url: 'doc://one',
      raw_content: 'First body.',
      title: 'First',
      image_urls: ['https://img.example.com/1.png'],
      source_type: 'documents',
    },
    {
      url: 'doc://two',
      raw_content: 'Second body.',
      title: '',
      image_urls: [],
      source_type: 'langchain',
    },
  ])
  // Copies, so a later mutation of the result cannot touch the caller's objects.
  assert.notEqual(documents[0], supplied[0])
  assert.notEqual(documents[0]?.image_urls, supplied[0]?.image_urls)
})

test('documents explains itself when no documents were supplied', async () => {
  const harness = makeHarness()
  await assert.rejects(loaderFor('documents').load(harness.ctx, {}), /request\.documents/)
})

// ---------------------------------------------------------------------------
// azure loader
// ---------------------------------------------------------------------------

test('azure fails clearly when it is not configured', async () => {
  const harness = makeHarness()
  await assert.rejects(
    loaderFor('azure').load(harness.ctx, {}),
    (error: unknown) => {
      assert.ok(error instanceof DocumentLoadError)
      assert.match((error as Error).message, /AZURE_CONNECTION_STRING/)
      assert.match((error as Error).message, /AZURE_CONTAINER_NAME/)
      return true
    },
  )
})

test('azure does not silently succeed when configured but unbundled', async () => {
  const harness = makeHarness({
    env: {
      AZURE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=test',
      AZURE_CONTAINER_NAME: 'research-docs',
    },
  })
  await assert.rejects(
    loaderFor('azure').load(harness.ctx, {}),
    /not bundled.*research-docs/s,
  )
})

test('azure accepts the container name from the request source', async () => {
  const harness = makeHarness({ env: { AZURE_CONNECTION_STRING: 'AccountName=test' } })
  await assert.rejects(
    loaderFor('azure').load(harness.ctx, { source: 'from-source' }),
    /not bundled.*from-source/s,
  )
})

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('the default document loader registry exposes the upstream sources', () => {
  const registry = createDocumentLoaderRegistry()
  assert.deepEqual(registry.names().sort(), ['azure', 'documents', 'local', 'online'])
  assert.equal(registry.get('local')?.keyless, true)
  assert.equal(registry.get('azure')?.keyless, false)
  assert.deepEqual(registry.get('azure')?.keys, [
    'AZURE_CONNECTION_STRING',
    'AZURE_CONTAINER_NAME',
  ])
})

test('extra loaders are registered and can replace a default', () => {
  const custom: DocumentLoaderDefinition = {
    name: 'custom',
    keys: [],
    keyless: true,
    description: 'test loader',
    async load() {
      return []
    },
  }
  const registry = createDocumentLoaderRegistry([custom])
  assert.equal(registry.get('custom'), custom)
  assert.ok(registry.names().includes('custom'))
})

test('the documented text extensions are exactly the readable subset', () => {
  assert.deepEqual([...TEXT_DOCUMENT_EXTENSIONS], [
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
  ])
  for (const binary of ['.pdf', '.doc', '.docx', '.pptx', '.xls', '.xlsx']) {
    assert.ok(UNSUPPORTED_DOCUMENT_REASONS[binary], `expected a reason for ${binary}`)
    assert.ok(!TEXT_DOCUMENT_EXTENSIONS.includes(binary))
  }
})
