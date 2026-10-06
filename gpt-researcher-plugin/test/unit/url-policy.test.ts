/**
 * Unit tests for the fetch policy (SSRF guard).
 *
 * The review found the plugin willing to fetch anything on the model-controlled
 * path — `source_urls`, harvested links, document URLs — including cloud
 * metadata, loopback services and private networks, and to follow redirects to
 * those destinations without re-checking. These tests pin the guard.
 *
 * @module test/unit/url-policy
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  UrlPolicyError,
  assertFetchableUrl,
  fetchWithPolicy,
  isPrivateHost,
  sanitizeDomainFilter,
} from '../../src/utils/url-policy.ts'
import { fakeHttp } from '../helpers/harness.ts'

describe('isPrivateHost', () => {
  it('blocks loopback, private, link-local, CGNAT and reserved ranges', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(isPrivateHost(host), true, `${host} must be private`)
    }
  })

  it('blocks IPv6 loopback, ULA, link-local and IPv4-mapped addresses', () => {
    for (const host of ['[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[ff02::1]', '[::ffff:127.0.0.1]']) {
      assert.equal(isPrivateHost(host), true, `${host} must be private`)
    }
    assert.equal(isPrivateHost('[2606:4700:4700::1111]'), false)
  })

  it('blocks internal names and localhost variants', () => {
    for (const host of [
      'localhost',
      'localhost.',
      'app.localhost',
      'service.internal',
      'printer.local',
      'host.home.arpa',
      'metadata.google.internal',
    ]) {
      assert.equal(isPrivateHost(host), true, `${host} must be internal`)
    }
  })

  it('allows public addresses and names', () => {
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
      assert.equal(isPrivateHost(host), false, `${host} must be public`)
    }
  })
})

describe('assertFetchableUrl', () => {
  it('refuses non-http(s) schemes', () => {
    for (const url of ['data:text/plain,INJECTED', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/']) {
      assert.throws(() => assertFetchableUrl(url), UrlPolicyError, url)
    }
  })

  it('refuses internal destinations by default', () => {
    assert.throws(() => assertFetchableUrl('http://169.254.169.254/latest/meta-data/'), /internal address/)
    assert.throws(() => assertFetchableUrl('http://127.0.0.1:3080/'), /internal address/)
    assert.throws(() => assertFetchableUrl('http://10.0.0.1/'), /internal address/)
    assert.throws(() => assertFetchableUrl('http://wiki.internal/'), /internal address/)
  })

  it('resists obfuscated IPv4 spellings through URL normalisation', () => {
    for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/']) {
      assert.throws(() => assertFetchableUrl(url), UrlPolicyError, url)
    }
  })

  it('allows a public URL, and internal ones when explicitly opted in', () => {
    assert.ok(assertFetchableUrl('https://example.com/page'))
    assert.ok(assertFetchableUrl('http://10.0.0.1/wiki', { allowPrivateHosts: true }))
  })

  it('rejects an unparseable URL with a bounded message', () => {
    const long = `not a url ${'x'.repeat(500)}`
    assert.throws(
      () => assertFetchableUrl(long),
      (error: unknown) => error instanceof UrlPolicyError && (error.message.length < 300),
    )
  })
})

describe('fetchWithPolicy', () => {
  it('follows a redirect to a public host', async () => {
    const http = fakeHttp(
      [
        ['https://start.test/', { status: 302, body: '', headers: { location: 'https://end.test/page' } }],
        ['https://end.test/page', { status: 200, body: 'arrived' }],
      ],
      { status: 404, body: '' },
    )
    const { response, finalUrl } = await fetchWithPolicy(http, 'https://start.test/')
    assert.equal(finalUrl, 'https://end.test/page')
    assert.equal(await response.text(), 'arrived')
    // Every hop must be requested manually so it can be validated.
    assert.equal(http.requests.length, 2)
  })

  it('refuses a redirect that points at an internal address', async () => {
    const http = fakeHttp([
      [
        'https://start.test/',
        { status: 302, body: '', headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
      ],
    ])
    await assert.rejects(() => fetchWithPolicy(http, 'https://start.test/'), /internal address/)
    assert.equal(http.requests.length, 1, 'the internal hop must never be requested')
  })

  it('refuses a redirect to a non-http scheme', async () => {
    const http = fakeHttp([
      ['https://start.test/', { status: 302, body: '', headers: { location: 'file:///etc/passwd' } }],
    ])
    await assert.rejects(() => fetchWithPolicy(http, 'https://start.test/'), /only http: and https:/)
  })

  it('stops after the redirect budget', async () => {
    const http = fakeHttp([
      ['https://loop.test/', { status: 302, body: '', headers: { location: 'https://loop.test/again' } }],
      ['https://loop.test/again', { status: 302, body: '', headers: { location: 'https://loop.test/' } }],
    ])
    await assert.rejects(() => fetchWithPolicy(http, 'https://loop.test/', {}, { maxRedirects: 3 }), /redirects/)
  })
})

describe('sanitizeDomainFilter', () => {
  it('keeps hostname-shaped values and normalises them', () => {
    assert.equal(sanitizeDomainFilter('example.com'), 'example.com')
    assert.equal(sanitizeDomainFilter('  EXAMPLE.com '), 'example.com')
    assert.equal(sanitizeDomainFilter('https://ok.test/path'), 'ok.test')
  })

  it('drops values that could rewrite the search query', () => {
    for (const value of ['x) OR site:internal', 'site:a b', 'a..b', '', 'a/b', 'x"y']) {
      assert.equal(sanitizeDomainFilter(value), undefined, value)
    }
  })
})
