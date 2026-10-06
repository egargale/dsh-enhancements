/**
 * Unit test for the shipped mount patches.
 *
 * The review found the end-to-end smoke test entirely outside `npm test`, with
 * nothing validating its patch offline: a renamed plugin-config key (or a key
 * that never existed) was only discovered by a live `dsh` run. This test parses
 * the patch files and checks every `config:` key against the loader schema.
 *
 * @module test/unit/mount-patches
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { PluginConfigSchema } from '../../src/dsh/plugin-config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..', '..')

/** Every key the loader schema knows, taken from its own defaults. */
const knownKeys = new Set(Object.keys(PluginConfigSchema({})))

/**
 * Extract the `config:` block keys from a cordis patch file.
 *
 * Deliberately a small line scanner rather than a YAML dependency: the files are
 * authored in one documented shape, and this test only needs the keys.
 *
 * @param text - the patch file's contents.
 * @returns the config keys, in file order.
 */
function configKeysOf(text: string): string[] {
  const keys: string[] = []
  let inConfig = false
  let configIndent = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim().startsWith('#')) continue
    const match = /^(\s*)config:\s*$/.exec(line)
    if (match) {
      inConfig = true
      configIndent = (match[1] ?? '').length
      continue
    }
    if (!inConfig) continue
    if (line.trim().length === 0) continue
    const indent = (line.match(/^\s*/)?.[0] ?? '').length
    if (indent <= configIndent) {
      inConfig = false
      continue
    }
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line)
    if (key?.[1]) keys.push(key[1])
  }
  return keys
}

describe('mount patches', () => {
  for (const relative of ['cordis.yml', 'test/dsh/smoke-headless.patch.yml']) {
    it(`${relative} uses only real plugin-config keys`, () => {
      const text = readFileSync(join(pluginRoot, relative), 'utf8')
      const keys = configKeysOf(text)
      assert.ok(keys.length > 0, `expected a config block in ${relative}`)
      const unknown = keys.filter((key) => !knownKeys.has(key))
      assert.deepEqual(unknown, [], `unknown plugin-config keys in ${relative}: ${unknown.join(', ')}`)
    })

    it(`${relative} validates against the loader schema`, () => {
      const text = readFileSync(join(pluginRoot, relative), 'utf8')
      const config: Record<string, unknown> = {}
      for (const key of configKeysOf(text)) {
        // Values here only need to type-check; the schema's defaults cover the
        // semantics, which the config tests exercise.
        const numeric = [
          'totalWords',
          'maxSearchResultsPerQuery',
          'maxIterations',
          'deepResearchBreadth',
          'deepResearchDepth',
          'deepResearchConcurrency',
          'maxTokens',
          'timeoutMs',
        ].includes(key)
        const boolean = ['curateSources', 'writeArtifacts', 'allowPrivateHosts'].includes(key)
        config[key] = numeric ? 1 : boolean ? true : 'value'
      }
      // Throws on a wrong type; unknown keys are ignored by schemastery, which is
      // why the key-set check above is the load-bearing one.
      assert.doesNotThrow(() => PluginConfigSchema(config))
    })
  }

  it('the smoke patch materialises both placeholders', () => {
    const text = readFileSync(join(pluginRoot, 'test/dsh/smoke-headless.patch.yml'), 'utf8')
    assert.match(text, /__ENTRY__/, 'the smoke patch expects an entry placeholder')
    assert.match(text, /__OUTPUT_DIR__/, 'the smoke patch expects an output placeholder')
  })

  it('the shipped cordis.yml stays machine-neutral', () => {
    const text = readFileSync(join(pluginRoot, 'cordis.yml'), 'utf8')
    assert.match(text, /name: '__ENTRY__'/, 'the mount example must not hardcode one machine path')
    assert.ok(!/name: '\/home\//.test(text), 'no absolute home path in the mount example')
  })
})
