/**
 * The default retriever registry.
 *
 * Registration order mirrors the `get_retriever` switch in upstream
 * `gpt_researcher/actions/retriever.py`, followed by the two additions this
 * port makes (`brave`, `dsh_web`). Names are the exact strings used in
 * `RETRIEVER=a,b`, so an upstream `config.json` or environment keeps working.
 *
 * @module gpt-researcher/retrievers
 */

import { RetrieverRegistry, type RetrieverDefinition } from './base.ts'

import { googleRetriever } from './google.ts'
import { searxRetriever } from './searx.ts'
import { searchApiRetriever } from './searchapi.ts'
import { serpApiRetriever } from './serpapi.ts'
import { serperRetriever } from './serper.ts'
import { duckduckgoRetriever } from './duckduckgo.ts'
import { bingRetriever } from './bing.ts'
import { bochaRetriever } from './bocha.ts'
import { arxivRetriever } from './arxiv.ts'
import { tavilyRetriever } from './tavily.ts'
import { exaRetriever } from './exa.ts'
import { semanticScholarRetriever } from './semantic_scholar.ts'
import { pubmedCentralRetriever } from './pubmed_central.ts'
import { customRetriever } from './custom.ts'
import { xquikRetriever } from './xquik.ts'
import { getXapiRetriever } from './getxapi.ts'
import { braveRetriever } from './brave.ts'
import { dshWebRetriever } from './dsh_web.ts'

// DEVIATION: upstream also has an `mcp` retriever
// (`gpt_researcher/retrievers/mcp/retriever.py`, a 323-line MCP client). It is
// deliberately not ported: a DSH session already exposes its own MCP tool
// catalog, so re-implementing an MCP client inside this plugin would duplicate
// the host's transport, auth, and server lifecycle. `resolve(['mcp'], ...)`
// therefore reports `mcp` as an invalid retriever and lists the valid names.

/** Every retriever this port ships, in registry order. */
export const DEFAULT_RETRIEVERS: readonly RetrieverDefinition[] = [
  googleRetriever,
  searxRetriever,
  searchApiRetriever,
  serpApiRetriever,
  serperRetriever,
  duckduckgoRetriever,
  bingRetriever,
  bochaRetriever,
  arxivRetriever,
  tavilyRetriever,
  exaRetriever,
  semanticScholarRetriever,
  pubmedCentralRetriever,
  customRetriever,
  xquikRetriever,
  getXapiRetriever,
  braveRetriever,
  dshWebRetriever,
]

/**
 * Build the default registry.
 *
 * @param extra - additional (or replacement) definitions, registered last so a
 *   deployment can override a built-in retriever by name.
 * @returns the populated registry.
 */
export function createRetrieverRegistry(
  extra: readonly RetrieverDefinition[] = [],
): RetrieverRegistry {
  return new RetrieverRegistry([...DEFAULT_RETRIEVERS, ...extra])
}

export * from './base.ts'
export * from './google.ts'
export * from './searx.ts'
export * from './searchapi.ts'
export * from './serpapi.ts'
export * from './serper.ts'
export * from './duckduckgo.ts'
export * from './bing.ts'
export * from './bocha.ts'
export * from './arxiv.ts'
export * from './tavily.ts'
export * from './exa.ts'
export * from './semantic_scholar.ts'
export * from './pubmed_central.ts'
export * from './custom.ts'
export * from './xquik.ts'
export * from './getxapi.ts'
export * from './brave.ts'
export * from './dsh_web.ts'
