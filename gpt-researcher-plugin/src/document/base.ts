/**
 * Document loader contract and registry.
 *
 * Upstream, `report_source` selects where context comes from: `local` reads a
 * directory of files, `hybrid` merges local + web, `azure` reads a blob
 * container, `langchain_documents`/`langchain_vectorstore` accept in-memory
 * documents. A loader's only job is to turn a source into documents the rest of
 * the pipeline already understands ({@link ScrapedContent}), so every later
 * stage is source-agnostic.
 *
 * @module gpt-researcher/document/base
 */

import type { Runtime } from '../runtime.ts'
import type { ScrapedContent } from '../types.ts'

/** What one loader is asked to read. */
export interface DocumentLoadRequest {
  /** Directory for `local`, URLs for `online`, container for `azure`. */
  source?: string | readonly string[]
  /** In-memory documents supplied by the caller (`langchain_documents`). */
  documents?: readonly ScrapedContent[]
  /** File extensions to accept; defaults to a per-loader list. */
  extensions?: readonly string[]
  /** Abort signal for the run. */
  signal?: AbortSignal
}

/** One loader implementation. */
export interface DocumentLoaderDefinition {
  name: string
  keys: string[]
  keyless: boolean
  description: string
  load(
    ctx: { runtime: Runtime },
    request: DocumentLoadRequest,
  ): Promise<ScrapedContent[]>
}

/** The registry of document loaders. */
export class DocumentLoaderRegistry {
  private readonly definitions = new Map<string, DocumentLoaderDefinition>()

  constructor(definitions: readonly DocumentLoaderDefinition[] = []) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: DocumentLoaderDefinition): void {
    this.definitions.set(definition.name, definition)
  }

  get(name: string): DocumentLoaderDefinition | undefined {
    return this.definitions.get(name)
  }

  all(): DocumentLoaderDefinition[] {
    return [...this.definitions.values()]
  }

  names(): string[] {
    return this.all().map((definition) => definition.name)
  }
}

/**
 * Extensions upstream's local loader accepts
 * (`document/document.py`, `LangChainDocumentLoader.LOADER_MAPPING`).
 */
export const LOCAL_DOCUMENT_EXTENSIONS = [
  '.txt',
  '.csv',
  '.json',
  '.md',
  '.pdf',
  '.doc',
  '.docx',
  '.pptx',
  '.xlsx',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
] as const
