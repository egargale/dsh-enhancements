import { createElement } from 'react'
import type {
  ClientContext,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Web Client chat node: one business row per diagram delivered by the
 * `visual_explainer_render_quick` tool. Matches the durable `tool/result`
 * session event (no custom event family needed on the server side).
 *
 * Reference-quality scaffold — verify the exact `tool/result` payload shape
 * against your checkout (packages/core/tools) before relying on field names.
 */

interface VeDiagramChatData {
  readonly title: string
  readonly path: string
  readonly bytes: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    've-diagram': VeDiagramChatData
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationStepDataMap {
    've-diagram': VeDiagramChatData
  }
}

interface VeDiagramState extends VeDiagramChatData {
  readonly turn: number
  readonly step: number
}

const TOOL_NAME = 'visual_explainer_render_quick'

/** Extract our tool result from any session event; returns null when irrelevant. */
function toolResult(event: {
  type: string
  data?: {
    name?: string
    callId?: string
    value?: { title?: string; path?: string; bytes?: number }
    turn?: number
    step?: number
  }
}): { id: string; state: VeDiagramState } | null {
  if (event.type !== 'tool/result') return null
  const data = event.data
  if (!data || data.name !== TOOL_NAME) return null
  const value = data.value
  if (!value || typeof value.title !== 'string' || typeof value.path !== 'string') return null
  return {
    id: String(data.callId ?? value.path),
    state: {
      title: value.title,
      path: value.path,
      bytes: typeof value.bytes === 'number' ? value.bytes : 0,
      turn: data.turn ?? 0,
      step: data.step ?? 0,
    },
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function viewData(state: VeDiagramState): VeDiagramChatData {
  return { title: state.title, path: state.path, bytes: state.bytes }
}

const veDiagramDefinition: ConversationNodeDefinition<VeDiagramState> = {
  kind: 've-diagram',
  target: 'chat',
  match: (event) => {
    const hit = toolResult(event)
    if (hit === null) return null
    return { id: hit.id, role: 'start' }
  },
  start: (_context, match) => {
    const hit = toolResult(match.event)
    if (hit === null) throw new Error('ve-diagram requires a visual_explainer_render_quick tool/result')
    return hit.state
  },
  update: (context) => context.state,
  publication: 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'step' || context.state === undefined) return null
    return {
      kind: 'step',
      turn: context.state.turn,
      step: context.state.step,
      key: 've-diagram',
      value: viewData(context.state),
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 've-diagram',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: viewData(context.state),
    }
  },
}

function VeDiagramNodeView({ node }: ChatNodeViewProps<'ve-diagram'>) {
  const kb = node.data.bytes >= 1024 ? (node.data.bytes / 1024).toFixed(1) + ' KB' : node.data.bytes + ' B'
  return createElement(
    'div',
    { style: { border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' } },
    createElement('strong', null, node.data.title),
    createElement('div', { style: { fontFamily: 'monospace', fontSize: 12 } }, node.data.path + ' (' + kb + ')'),
    createElement(
      'div',
      { style: { fontSize: 12, opacity: 0.7 } },
      'Open the file in a browser — DSH does not render HTML inline. (Inline preview needs a static-file route; see README.)'
    )
  )
}

export const inject = ['conversationEvents', 'slots']

export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(veDiagramDefinition)
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register({ name: 'conversation.chat.node', key: 've-diagram' }, VeDiagramNodeView)
  )
}

