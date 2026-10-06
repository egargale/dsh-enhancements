/**
 * Unit tests for configuration resolution.
 *
 * The review found the documented configuration path dead: the plugin submitted
 * its *defaulted* config as explicit overrides, which outrank both
 * `CONFIG_PATH` and the environment, so `RETRIEVER=tavily`/`MAX_ITERATIONS=8`
 * were silently ignored. It also found `REASONING_EFFORT` read straight from the
 * environment (ignoring file and override values) and no coverage at all for
 * `convertEnvValue`.
 *
 * Precedence this file pins:
 * `upstream DEFAULT_CONFIG → plugin host defaults → config file → environment → explicit overrides`.
 *
 * @module test/unit/config
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  Config,
  ConfigError,
  DEFAULT_CONFIG,
  convertEnvValue,
  parseProviderPair,
  parseReasoningEffort,
  parseRetrievers,
  resolveTone,
  canonicalToneName,
  resolveReportType,
} from '../../src/config.ts'
import { configDefaultsFromPlugin, configOverridesFromPlugin } from '../../src/tools/shared.ts'
import { normalisePluginConfig } from '../../src/dsh/plugin-config.ts'

const workDir = mkdtempSync(join(tmpdir(), 'gptr-config-'))
after(() => rmSync(workDir, { recursive: true, force: true }))

/** Write a JSON config file and return its path. */
function configFile(contents: Record<string, unknown>): string {
  const path = join(workDir, `config-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(contents), 'utf8')
  return path
}

describe('environment coercion', () => {
  it('coerces booleans, numbers, lists, dicts and null-able strings', () => {
    assert.equal(convertEnvValue('CURATE_SOURCES', 'true', false), true)
    assert.equal(convertEnvValue('CURATE_SOURCES', '1', false), true)
    assert.equal(convertEnvValue('CURATE_SOURCES', 'yes', false), true)
    assert.equal(convertEnvValue('CURATE_SOURCES', 'on', false), true)
    assert.equal(convertEnvValue('CURATE_SOURCES', 'nope', false), false)
    assert.equal(convertEnvValue('MAX_ITERATIONS', '8', 3), 8)
    assert.equal(convertEnvValue('TEMPERATURE', '0.25', 0.4), 0.25)
    assert.deepEqual(convertEnvValue('MCP_SERVERS', '[{"name":"x"}]', []), [{ name: 'x' }])
    assert.deepEqual(convertEnvValue('LLM_KWARGS', '{"a":1}', {}), { a: 1 })
    assert.equal(convertEnvValue('AGENT_ROLE', 'none', null), null)
    assert.equal(convertEnvValue('AGENT_ROLE', '', null), null)
    assert.equal(convertEnvValue('AGENT_ROLE', 'analyst', null), 'analyst')
  })

  it('rejects unparseable JSON for list/dict keys', () => {
    assert.throws(() => convertEnvValue('MCP_SERVERS', 'not json', []), ConfigError)
  })
})

describe('parsers', () => {
  it('splits and validates retriever lists', () => {
    assert.deepEqual(parseRetrievers('tavily, duckduckgo'), ['tavily', 'duckduckgo'])
    assert.deepEqual(parseRetrievers('tavily,,duckduckgo'), ['tavily', 'duckduckgo'])
    assert.throws(() => parseRetrievers(' , '), ConfigError)
  })

  it('validates provider:model pairs', () => {
    assert.deepEqual(parseProviderPair('openai:gpt-4o-mini', new Set(['openai']), 'SMART_LLM'), {
      provider: 'openai',
      model: 'gpt-4o-mini',
    })
    assert.throws(() => parseProviderPair('gpt-4o-mini', new Set(['openai']), 'SMART_LLM'), ConfigError)
    assert.throws(
      () => parseProviderPair('nope:model', new Set(['openai']), 'SMART_LLM'),
      /Unsupported nope/,
    )
  })

  it('accepts the documented reasoning efforts and rejects the rest', () => {
    assert.equal(parseReasoningEffort(undefined), 'medium')
    assert.equal(parseReasoningEffort('high'), 'high')
    assert.throws(() => parseReasoningEffort('turbo'), ConfigError)
  })

  it('normalises tones and report types, including the deep alias', () => {
    assert.equal(canonicalToneName('analytical'), 'Analytical')
    assert.match(resolveTone('analytical'), /^Analytical/)
    assert.match(resolveTone(undefined), /^Objective/)
    assert.equal(resolveReportType('deep_research'), 'deep')
    assert.equal(resolveReportType(undefined), 'research_report')
    assert.throws(() => resolveReportType('nope'), ConfigError)
  })
})

describe('precedence', () => {
  const hostDefaults = configDefaultsFromPlugin(normalisePluginConfig(undefined))

  it('falls back to the plugin stack defaults when nothing is configured', () => {
    const config = new Config({ defaults: hostDefaults })
    assert.deepEqual(config.retrievers, ['dsh_web'])
    assert.equal(config.scraper, 'bs')
    assert.equal(config.embedding, 'local:hash')
    assert.equal(config.totalWords, 1200)
  })

  it('lets the environment override the plugin defaults', () => {
    const env: Record<string, string> = {
      RETRIEVER: 'tavily',
      SCRAPER: 'firecrawl',
      MAX_ITERATIONS: '8',
      TOTAL_WORDS: '3000',
    }
    const config = new Config({ defaults: hostDefaults, env: (name) => env[name] })
    assert.deepEqual(config.retrievers, ['tavily'])
    assert.equal(config.scraper, 'firecrawl')
    assert.equal(config.maxIterations, 8)
    assert.equal(config.totalWords, 3000)
  })

  it('lets explicit plugin fields and tool arguments override the environment', () => {
    const env: Record<string, string> = { MAX_ITERATIONS: '8', TOTAL_WORDS: '3000' }
    const config = new Config({
      defaults: hostDefaults,
      overrides: configOverridesFromPlugin({ maxIterations: 2, timeoutMs: 90_000 }),
      env: (name) => env[name],
    })
    assert.equal(config.maxIterations, 2, 'explicit plugin config must win over the environment')
    assert.equal(config.totalWords, 3000, 'unset plugin fields must let the environment through')
    assert.equal(config.timeoutMs, 90_000, 'the documented timeoutMs must reach the engine')
  })

  it('applies the documented file → env order for the same key', () => {
    const path = configFile({ MAX_ITERATIONS: 5, TOTAL_WORDS: 2000 })
    const env: Record<string, string> = { MAX_ITERATIONS: '8' }
    const config = new Config({
      configPath: path,
      defaults: hostDefaults,
      env: (name) => env[name],
    })
    assert.equal(config.maxIterations, 8, 'env beats the file')
    assert.equal(config.totalWords, 2000, 'the file beats the host defaults')
    assert.deepEqual(config.retrievers, ['dsh_web'], 'untouched keys keep the host default')
  })

  it('honours REASONING_EFFORT from a file or an override, not just the environment', () => {
    const path = configFile({ REASONING_EFFORT: 'high' })
    assert.equal(new Config({ configPath: path, env: () => undefined }).reasoningEffort, 'high')
    assert.equal(new Config({ overrides: { REASONING_EFFORT: 'low' } }).reasoningEffort, 'low')
    assert.equal(new Config({ env: () => undefined }).reasoningEffort, 'medium')
  })

  it('keeps upstream defaults for keys the plugin does not manage', () => {
    const config = new Config({ defaults: hostDefaults })
    assert.equal(config.maxSubtopics, DEFAULT_CONFIG.MAX_SUBTOPICS)
    assert.equal(config.reportSource, 'web')
  })

  it('resolves the timeout with override > env > host default, ignoring junk', () => {
    // Host default is the documented 120 000 ms.
    assert.equal(new Config({ defaults: hostDefaults }).timeoutMs, 120_000)
    // Environment wins over the host default.
    assert.equal(
      new Config({ defaults: hostDefaults, env: (name) => ({ TIMEOUT_MS: '45000' })[name] }).timeoutMs,
      45_000,
    )
    // Explicit override wins over the environment.
    assert.equal(
      new Config({
        defaults: hostDefaults,
        overrides: { TIMEOUT_MS: 90_000 },
        env: (name) => ({ TIMEOUT_MS: '45000' })[name],
      }).timeoutMs,
      90_000,
    )
    // A non-finite or zero value is never trusted (it would abort every fetch).
    assert.equal(
      new Config({ defaults: hostDefaults, env: (name) => ({ TIMEOUT_MS: 'abc' })[name] }).timeoutMs,
      120_000,
    )
    assert.equal(
      new Config({ defaults: hostDefaults, env: (name) => ({ TIMEOUT_MS: '0' })[name] }).timeoutMs,
      120_000,
    )
  })
})

describe('Config.withVerbose', () => {
  it('returns a copy with verbosity applied and everything else preserved', () => {
    const config = new Config({ defaults: configDefaultsFromPlugin(normalisePluginConfig(undefined)) })
    const verbose = config.withVerbose(true)
    assert.equal(verbose.verbose, true)
    assert.equal(config.verbose, false, 'the original must not be mutated')
    assert.deepEqual(verbose.retrievers, config.retrievers)
  })
})
