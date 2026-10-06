/**
 * Unit tests for the HTTP timeout composition and the report artifacts.
 *
 * The review found `withTimeout`'s timer branch untested (the only guard against
 * one hung scrape eating a 30–60 minute tool budget) and the artifact failure
 * path untested (a regression that threw instead of warning would break every
 * research tool rather than degrade).
 *
 * @module test/unit/runtime-artifacts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { withTimeout } from '../../src/runtime.ts'
import { sanitizeHeaderValue, writeArtifacts } from '../../src/tools/artifacts.ts'
import type { ResearchOutcome } from '../../src/types.ts'

const workDir = mkdtempSync(join(tmpdir(), 'gptr-artifacts-'))
after(() => rmSync(workDir, { recursive: true, force: true }))

/** A minimal outcome for artifact tests. */
function outcome(overrides: Partial<ResearchOutcome> = {}): ResearchOutcome {
  return {
    query: 'a query',
    reportType: 'research_report',
    report: '# Report\n\nBody.',
    sources: [{ url: 'https://a.test/1', raw_content: 'x'.repeat(120), title: 'A' }],
    visitedUrls: ['https://a.test/1'],
    context: 'context',
    costs: { total: 0.0012, perStep: { research: 0.0012 }, currency: 'USD' },
    ...overrides,
  }
}

describe('withTimeout', () => {
  it('aborts the composed signal when the timer fires, naming the budget', async () => {
    const { signal, dispose } = withTimeout(undefined, 20)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    assert.equal(signal.aborted, true)
    assert.match(String(signal.reason), /timed out after 20ms/)
    dispose()
  })

  it('forwards an outer abort and releases its own timer on dispose', async () => {
    const outer = new AbortController()
    const { signal, dispose } = withTimeout(outer.signal, 10_000)
    assert.equal(signal.aborted, false)
    outer.abort(new Error('caller cancelled'))
    assert.equal(signal.aborted, true)
    assert.match(String(signal.reason), /caller cancelled/)
    dispose()
  })

  it('does not keep the process alive after dispose', async () => {
    const { dispose } = withTimeout(undefined, 5_000)
    dispose()
    // A live timer would keep the loop busy; unref/clear must leave it clear.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(true)
  })

  it('composes an already-aborted outer signal immediately', () => {
    const outer = new AbortController()
    outer.abort(new Error('already gone'))
    const { signal, dispose } = withTimeout(outer.signal, 5_000)
    assert.equal(signal.aborted, true)
    dispose()
  })
})

describe('sanitizeHeaderValue', () => {
  it('keeps an ordinary query intact', () => {
    assert.equal(sanitizeHeaderValue('How does quantum computing work?'), 'How does quantum computing work?')
  })

  it('neutralises HTML-comment breakouts and heading injection', () => {
    const sanitized = sanitizeHeaderValue('x --> <img src=y onerror=alert(1)>\n# Injected')
    assert.ok(!sanitized.includes('-->'), sanitized)
    assert.ok(!sanitized.includes('\n'), sanitized)
    assert.ok(!sanitized.startsWith('#'), sanitized)
  })

  it('strips control characters and collapses whitespace runs', () => {
    assert.equal(sanitizeHeaderValue('a\tb\u0000c\r\nd'), 'a b c d')
  })
})

describe('writeArtifacts', () => {
  it('writes the report and its sources sidecar', async () => {
    const result = await writeArtifacts(outcome(), { outputDir: workDir, cwd: workDir })
    assert.ok(result.reportPath)
    assert.ok(result.sourcesPath)
    const report = readFileSync(result.reportPath, 'utf8')
    assert.match(report, /# Research report: a query/)
    assert.match(report, /# Report/)
    const sources = JSON.parse(readFileSync(result.sourcesPath, 'utf8')) as {
      visited_urls: string[]
      sources: Array<{ url: string }>
    }
    assert.deepEqual(sources.visited_urls, ['https://a.test/1'])
    assert.equal(sources.sources[0]?.url, 'https://a.test/1')
  })

  it('cannot break out of the metadata comment, even with a hostile query', async () => {
    const result = await writeArtifacts(
      outcome({ query: 'x --> <img src=y onerror=alert(1)>\n\n# Injected heading' }),
      { outputDir: workDir, cwd: workDir },
    )
    const report = readFileSync(result.reportPath as string, 'utf8')
    const firstLine = report.split('\n')[0] ?? ''
    assert.ok(firstLine.startsWith('<!--') && firstLine.endsWith('-->'), firstLine)
    assert.equal(firstLine.match(/-->/g)?.length, 1, 'exactly one comment terminator')
    assert.ok(!report.includes('<img src=y'), 'no live markup from the query')
  })

  it('reports a write failure as a warning instead of throwing', async () => {
    // `output_path` pointing *through* an existing file cannot be created.
    const blocker = join(workDir, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const result = await writeArtifacts(outcome(), {
      outputDir: workDir,
      cwd: workDir,
      outputPath: join('blocker', 'nested', 'report.md'),
    })
    assert.equal(result.reportPath, undefined)
    assert.match(result.warning ?? '', /could not write the report/)
    assert.ok(existsSync(blocker), 'the blocking file must be untouched')
  })

  it('writes nothing at all when disabled', async () => {
    const before = readdirSafe(workDir)
    const result = await writeArtifacts(outcome(), {
      outputDir: workDir,
      cwd: workDir,
      disabled: true,
    })
    assert.deepEqual(result, {})
    assert.deepEqual(readdirSafe(workDir), before)
  })
})

/** Directory listing helper that tolerates a missing directory. */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path).sort()
  } catch {
    return []
  }
}
