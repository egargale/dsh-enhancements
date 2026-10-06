/**
 * Fetch policy: which URLs the plugin is willing to retrieve.
 *
 * The plugin fetches URLs that are ultimately **model-controlled** — the
 * `source_urls` tool argument and every link harvested from a search result or a
 * scraped page. Without a policy that is a server-side request forgery
 * primitive: `http://169.254.169.254/latest/meta-data/…` reads cloud instance
 * credentials, `http://127.0.0.1:<port>` reaches loopback services (including
 * the local DeepSeek Harness GUI), and RFC1918/`*.internal` names reach the
 * private network — with the response body flowing into the model context, the
 * tool result and the written report. `data:` URLs additionally let an attacker
 * inject arbitrary "page" content.
 *
 * The policy is deliberately *not* installed on the shared HTTP seam: the
 * embedding providers legitimately default to `http://localhost:1234` and
 * `http://localhost:11434`. It is applied at the retrieval boundary instead
 * (page scrapers and document loaders), and redirects are re-validated hop by
 * hop because following a public URL that 302s to an internal one would defeat a
 * pre-flight check.
 *
 * @module gpt-researcher/utils/url-policy
 */

import type { HttpFetch, HttpResponse } from '../runtime.ts'

/** Error raised when a URL is refused by the fetch policy. */
export class UrlPolicyError extends Error {
  override readonly name = 'UrlPolicyError'
}

/** Policy inputs. */
export interface FetchPolicy {
  /**
   * Permit loopback/private/link-local destinations. Off by default; a
   * deployment that researches an internal wiki can opt in explicitly.
   */
  allowPrivateHosts?: boolean
  /** Maximum redirect hops to follow (validating each one). */
  maxRedirects?: number
}

/** Hostname suffixes that always denote internal infrastructure. */
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan'] as const

/** Exact hostnames that always denote internal infrastructure. */
const INTERNAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/**
 * Whether a hostname is loopback/private/link-local/ULA, or names internal
 * infrastructure.
 *
 * Decimal, octal and hexadecimal IPv4 spellings are handled automatically
 * because the WHATWG URL parser normalises them to dotted decimal before this
 * runs (`http://2130706433/` → `127.0.0.1`).
 *
 * @param hostname - a lower-cased hostname, with or without IPv6 brackets.
 * @returns true when the host must not be fetched unless explicitly allowed.
 */
export function isPrivateHost(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (name.length === 0) return true
  if (INTERNAL_HOSTNAMES.has(name)) return true
  if (INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true

  const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
  if (bare.includes(':')) return isPrivateIpv6(bare)
  return isPrivateIpv4(bare)
}

/** IPv4 range check (loopback, private, link-local, CGNAT, unspecified, broadcast). */
function isPrivateIpv4(candidate: string): boolean {
  const parts = candidate.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a = 0, b = 0] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

/** IPv6 range check, including IPv4-mapped addresses. */
function isPrivateIpv6(candidate: string): boolean {
  const groups = expandIpv6(candidate)
  if (groups === undefined) return false
  const [first = 0, second = 0] = groups
  // ::/128 unspecified, ::1/128 loopback
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xff00) === 0xff00) return true
  // ::ffff:a.b.c.d and ::a.b.c.d (IPv4-mapped/-compatible)
  const mappedPrefix = groups.slice(0, 5).every((group) => group === 0)
  if (mappedPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const ipv4 = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`
    if (isPrivateIpv4(ipv4)) return true
  }
  if (second === 0 && first === 0) return true
  return false
}

/** Expand an IPv6 literal to eight 16-bit groups, or undefined when invalid. */
function expandIpv6(candidate: string): number[] | undefined {
  const [head, tail] = candidate.split('::')
  const parse = (part: string | undefined): number[] | undefined => {
    if (part === undefined || part.length === 0) return []
    const groups = part.split(':')
    const values: number[] = []
    for (const group of groups) {
      if (group.length === 0) return undefined
      if (group.includes('.')) {
        const octets = group.split('.').map((value) => Number(value))
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value > 255)) {
          return undefined
        }
        const [a = 0, b = 0, c = 0, d = 0] = octets
        values.push((a << 8) | b, (c << 8) | d)
        continue
      }
      const value = Number.parseInt(group, 16)
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) return undefined
      values.push(value)
    }
    return values
  }
  const headValues = parse(head)
  const tailValues = parse(tail)
  if (headValues === undefined || tailValues === undefined) return undefined
  if (tail === undefined) return headValues.length === 8 ? headValues : undefined
  const fill = 8 - headValues.length - tailValues.length
  if (fill < 1) return undefined
  return [...headValues, ...new Array<number>(fill).fill(0), ...tailValues]
}

/**
 * Validate one URL against the fetch policy.
 *
 * @param url - the URL about to be fetched.
 * @param policy - the policy; `allowPrivateHosts` opts internal destinations in.
 * @returns the parsed URL.
 * @throws {UrlPolicyError} when the URL is unusable or refused.
 */
export function assertFetchableUrl(url: string, policy: FetchPolicy = {}): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UrlPolicyError(`refusing to fetch an unparseable URL: ${describe(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlPolicyError(
      `refusing to fetch a ${parsed.protocol || 'relative'} URL (only http: and https: are allowed): ${describe(url)}`,
    )
  }
  if (!parsed.hostname) {
    throw new UrlPolicyError(`refusing to fetch a URL without a host: ${describe(url)}`)
  }
  if (!policy.allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    throw new UrlPolicyError(
      `refusing to fetch the internal address ${parsed.hostname}: ${describe(url)}. ` +
        'Set allowPrivateHosts (plugin config) to research private hosts deliberately.',
    )
  }
  return parsed
}

/**
 * Validate a search-domain filter before it is interpolated into a provider's
 * query syntax.
 *
 * `queryDomains` reaches `site:${domain}` operators, so an unvalidated value
 * such as `x) OR site:internal` rewrites the search itself. Only hostname-shaped
 * values survive.
 *
 * @param domain - one caller-supplied domain filter.
 * @returns the normalised hostname, or undefined when it is not one.
 */
export function sanitizeDomainFilter(domain: string): string | undefined {
  const value = domain.trim().toLowerCase()
  // A pasted URL contributes only its hostname; a bare value must itself be
  // hostname-shaped (so `a/b` is rejected rather than silently truncated to `a`).
  const trimmed = /^https?:\/\//.test(value) ? value.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : value
  if (trimmed.length === 0 || trimmed.length > 253) return undefined
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(trimmed)) return undefined
  if (trimmed.includes('..')) return undefined
  return trimmed
}

/**
 * Fetch a URL, validating every redirect hop.
 *
 * `redirect: 'follow'` hands the destination decision to the transport, so a
 * permitted public URL that answers `302 Location: http://169.254.169.254/…`
 * would bypass a pre-flight check entirely. This follows redirects manually,
 * re-validating each `Location`.
 *
 * @param http - the HTTP seam.
 * @param url - the URL to fetch.
 * @param init - request options forwarded to the seam.
 * @param policy - the fetch policy.
 * @returns the final response and the URL it came from.
 */
export async function fetchWithPolicy(
  http: HttpFetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
  policy: FetchPolicy = {},
): Promise<{ response: HttpResponse; finalUrl: string }> {
  const maxRedirects = policy.maxRedirects ?? 5
  let current = assertFetchableUrl(url, policy).toString()
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await http(current, { ...init, redirect: 'manual' })
    const isRedirect = response.status >= 300 && response.status < 400
    if (!isRedirect) return { response, finalUrl: current }
    const location = response.header('location')
    if (!location) return { response, finalUrl: current }
    const next = new URL(location, current).toString()
    assertFetchableUrl(next, policy)
    current = next
  }
  throw new UrlPolicyError(`refusing to follow more than ${maxRedirects} redirects from ${describe(url)}`)
}

/** Truncate a URL for an error message so a long query string cannot flood a log. */
function describe(url: string): string {
  const text = typeof url === 'string' ? url : String(url)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
