import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
// Single source of truth: the skill's quick-mode renderer. Run
// `npm run sync-assets` after updating visual-explainer/visual-explainer/quick/.
import { validateQuickSpec, renderQuickSpec } from './assets/render.mjs'

/**
 * Registers `visual_explainer_render_quick`: the deterministic quick-mode
 * renderer of the visual-explainer skill as a native tool.
 *
 * The skill uses this tool automatically when it is present and falls back to
 * `node <skill-dir>/quick/render.mjs` when it is absent (degrade gracefully).
 */
export function registerVisualExplainerTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'visual_explainer_render_quick',
    description:
      'Validate a visual-explainer quick spec and render it into a complete, self-contained ' +
      'HTML page. Use for /generate-web-diagram --quick, /diff-review --quick, ' +
      '/plan-review --quick, and /project-recap --quick when the user passed --quick. ' +
      'On validation failure, fall back to the full HTML workflow.',
    parameters: {
      spec: {
        type: 'object',
        required: true,
        description:
          'Quick-mode spec: { title, subtitle?, summary?, sections: [{ title, subtitle?, summary?, tone?, ' +
          'cards?, table?, risks?, files?, steps?, flow?, callouts?, evidence? }] }. ' +
          'See the visual-explainer skill quick/schema.json for the authoritative contract.',
      },
      filename: {
        type: 'string',
        required: true,
        description: 'Output filename. Basename only, must end in .html.',
      },
      outputDir: {
        type: 'string',
        description: 'Output directory relative to the session working directory. Defaults to ./diagrams.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'number' },
          title: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'bytes', 'title'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `Wrote ${value.path} (${value.bytes} bytes) — ${value.title}. Open the file in a browser; DSH does not render HTML inline.` },
      ],
    },
    async execute(args, exec) {
      // 1. Validate — identical rules to quick/render.mjs.
      const errors = validateQuickSpec(args.spec)
      if (errors.length > 0) {
        throw new Error(`Quick spec validation failed:\n- ${errors.join('\n- ')}`)
      }

      // 2. Filename safety: basename only, no traversal, .html suffix.
      const name = basename(args.filename)
      if (name !== args.filename || !name.endsWith('.html')) {
        throw new Error('filename must be a basename ending in .html')
      }

      // 3. Render the complete self-contained HTML document.
      const html = await renderQuickSpec(args.spec)

      // 4. Write to the output directory (default ./diagrams).
      const outDir = args.outputDir ?? './diagrams'
      const outPath = isAbsolute(outDir) ? join(outDir, name) : join(resolve(outDir), name)
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, html, 'utf8')

      return { path: outPath, bytes: Buffer.byteLength(html, 'utf8'), title: args.spec.title, warnings: [] }
    },
  }))
}

