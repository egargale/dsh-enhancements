import type { Context } from '@deepseek-ai/cordis'
import { registerVisualExplainerTools } from './render-tool.js'

export const name = 'visual-explainer-plugin'
export const inject = ['tools']

export function apply(ctx: Context): void {
  registerVisualExplainerTools(ctx)
  // NOTE: the Web Client chat node (src/client/index.tsx) is a separate client
  // entry; see README.md "Mounting the client node" for composing it into the
  // Web bundle.
}

