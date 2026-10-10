/**
 * AG-UI adapter (plan §3 option B, M3 deliverable).
 *
 * The internal pipeline is already organised into the five AG-UI categories, so this
 * is a vocabulary projection, not a redesign: sidecar events leave as AG-UI event
 * names, and anything AG-UI has no word for goes through the `CUSTOM`/`RAW` escape
 * hatches the spec provides rather than being invented into a standard name.
 *
 * Vocabulary per analysis-reports/2026-10-09-agent-client-protocols.md:72-77.
 *
 * What is NOT claimed: conformance was checked against the documented event names and
 * the structural invariants below, not against a running CopilotKit client — no
 * third-party AG-UI SDK was installed in this workspace. The plan's v2.0 definition of
 * done ("AG-UI 端点被 CopilotKit 示例消费成功") therefore stays open until someone
 * points a real client at /ag-ui.
 */
import type { SessionEvent } from './protocol-types.ts'
import { categorize } from './event-category.ts'

export const AGUI_EVENT_TYPES = [
  'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR', 'STEP_STARTED', 'STEP_FINISHED',
  'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
  'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
  'STATE_SNAPSHOT', 'STATE_DELTA', 'MESSAGES_SNAPSHOT',
  'RAW', 'CUSTOM',
] as const

export type AguiEventType = (typeof AGUI_EVENT_TYPES)[number]

export interface AguiEvent {
  type: AguiEventType
  timestamp: number
  [k: string]: unknown
}

/** Sidecar events that open a run rather than describing a step inside it. */
const RUN_START_EVENTS = new Set(['phase'])
const TEXT_KEYS = ['text', 'delta', 'textDelta'] as const

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const pick = (d: Record<string, unknown>, keys: readonly string[]): string => {
  for (const k of keys) {
    const v = d[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

export interface AguiTranslatorState {
  /** messageId of the currently open text message, if any. */
  openMessageId: string | null
  openToolCallId: string | null
  runStarted: boolean
  messageSeq: number
}

export function createAguiState(): AguiTranslatorState {
  return { openMessageId: null, openToolCallId: null, runStarted: false, messageSeq: 0 }
}

export interface AguiTranslation {
  events: AguiEvent[]
  state: AguiTranslatorState
}

/**
 * One sidecar event in, zero or more AG-UI events out. Pairing is enforced here: a
 * CONTENT frame is never emitted without its START, and an open message is closed
 * before any other kind of frame goes out — an unterminated message is the single
 * most likely way a downstream renderer breaks.
 */
export function translateToAgui(ev: SessionEvent, state: AguiTranslatorState): AguiTranslation {
  const out: AguiEvent[] = []
  const d = (ev.data ?? {}) as Record<string, unknown>
  const s: AguiTranslatorState = { ...state }
  const category = categorize(ev.type)

  const closeMessage = (): void => {
    if (s.openMessageId) {
      out.push({ type: 'TEXT_MESSAGE_END', messageId: s.openMessageId, timestamp: ev.ts })
      s.openMessageId = null
    }
  }
  const closeTool = (): void => {
    if (s.openToolCallId) {
      out.push({ type: 'TOOL_CALL_END', toolCallId: s.openToolCallId, timestamp: ev.ts })
      s.openToolCallId = null
    }
  }
  const ensureRun = (): void => {
    if (!s.runStarted) {
      out.push({ type: 'RUN_STARTED', timestamp: ev.ts })
      s.runStarted = true
    }
  }

  switch (ev.type) {
    case 'user': {
      closeMessage(); closeTool(); ensureRun()
      // AG-UI has no "the human said this" event; a user turn is a text message.
      const messageId = `msg_user_${ev.seq}`
      out.push({ type: 'TEXT_MESSAGE_START', messageId, role: 'user', timestamp: ev.ts })
      out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: str(d.text), timestamp: ev.ts })
      out.push({ type: 'TEXT_MESSAGE_END', messageId, timestamp: ev.ts })
      break
    }
    case 'text_delta': {
      ensureRun()
      closeTool()
      if (!s.openMessageId) {
        s.messageSeq += 1
        s.openMessageId = `msg_assistant_${s.messageSeq}`
        out.push({ type: 'TEXT_MESSAGE_START', messageId: s.openMessageId, role: 'assistant', timestamp: ev.ts })
      }
      out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: s.openMessageId, delta: pick(d, TEXT_KEYS), timestamp: ev.ts })
      break
    }
    case 'thinking_delta': {
      // Reasoning is not in the AG-UI 1.0 vocabulary → CUSTOM escape hatch, with the
      // enclosing message closed first so a reader never mixes it with answer text.
      closeMessage(); closeTool(); ensureRun()
      out.push({ type: 'CUSTOM', name: 'tianshu.thinking_delta', value: { delta: pick(d, TEXT_KEYS), seq: ev.seq }, timestamp: ev.ts })
      break
    }
    case 'tool_use': {
      closeMessage()
      // A second call before the first was answered: close the first, or it dangles.
      closeTool()
      ensureRun()
      const toolCallId = str(d.id ?? d.toolUseId) || `call_${ev.seq}`
      out.push({ type: 'TOOL_CALL_START', toolCallId, toolCallName: str(d.name ?? d.toolName) || 'tool', timestamp: ev.ts })
      const args = JSON.stringify(d.input ?? d.args ?? {})
      out.push({ type: 'TOOL_CALL_ARGS', toolCallId, delta: args, timestamp: ev.ts })
      s.openToolCallId = toolCallId
      break
    }
    case 'tool_result': {
      closeMessage()
      // A reconnect replay can legitimately start on a bare result (the tool_use
      // predates `?since=`), and that still has to open a run — a consumer that saw
      // RUN_FINISHED without RUN_STARTED would treat the stream as malformed.
      ensureRun()
      const toolCallId = str(d.toolUseId ?? d.id) || s.openToolCallId || `call_${ev.seq}`
      // A result for some *other* call means the open one is done as far as the
      // runtime is concerned — close it, or it dangles forever.
      if (s.openToolCallId && s.openToolCallId !== toolCallId) closeTool()
      if (s.openToolCallId !== toolCallId) {
        // A result can arrive without a matching tool_use in this replay window
        // (ring compaction, or the call predates `?since=`). Synthesise the START and
        // **record it as open**, otherwise the END below has nothing to close.
        out.push({ type: 'TOOL_CALL_START', toolCallId, toolCallName: str(d.name) || 'tool', timestamp: ev.ts })
        s.openToolCallId = toolCallId
      }
      out.push({ type: 'TOOL_CALL_RESULT', toolCallId, content: pick(d, ['content', 'result', 'output']), role: 'tool', timestamp: ev.ts })
      closeTool()
      break
    }
    case 'turn_complete': {
      closeMessage(); closeTool()
      out.push({ type: 'STEP_FINISHED', stepName: `turn_${ev.seq}`, timestamp: ev.ts })
      break
    }
    case 'done': {
      closeMessage(); closeTool()
      const status = str(d.status)
      if (status === 'failed') {
        out.push({ type: 'RUN_ERROR', message: 'run failed', code: status, timestamp: ev.ts })
      } else {
        out.push({ type: 'RUN_FINISHED', timestamp: ev.ts, ...(status ? { result: { status } } : {}) })
      }
      s.runStarted = false
      break
    }
    case 'error': {
      closeMessage(); closeTool()
      out.push({ type: 'RUN_ERROR', message: pick(d, ['error', 'message']) || 'error', ...(typeof d.kind === 'string' ? { code: d.kind } : {}), timestamp: ev.ts })
      break
    }
    case 'phase': {
      closeMessage(); closeTool()
      if (RUN_START_EVENTS.has(ev.type)) ensureRun()
      const phase = pick(d, ['phase', 'name'])
      if (phase) out.push({ type: 'STEP_STARTED', stepName: phase, timestamp: ev.ts })
      break
    }
    default: {
      // State and custom categories: STATE_SNAPSHOT/STATE_DELTA carry the private
      // payload under a documented key instead of inventing spec names for them.
      closeMessage(); closeTool()
      if (category === 'state') {
        out.push({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: `/${ev.type}`, value: d }], timestamp: ev.ts })
      } else if (category === 'tool') {
        out.push({ type: 'CUSTOM', name: `tianshu.${ev.type}`, value: d, timestamp: ev.ts })
      } else {
        out.push({ type: ev.type === 'replay_window' ? 'STATE_SNAPSHOT' : 'CUSTOM', ...(ev.type === 'replay_window' ? { snapshot: d } : { name: `tianshu.${ev.type}`, value: d }), timestamp: ev.ts })
      }
    }
  }

  return { events: out, state: s }
}

/**
 * Structural checks that AG-UI consumers rely on. These are the failure modes that
 * actually break a downstream renderer, and they are cheap enough to assert on every
 * translated stream (both in tests and against a real replayed session).
 */
export function validateAguiStream(events: readonly AguiEvent[]): string[] {
  const problems: string[] = []
  const openMessages = new Set<string>()
  const openTools = new Set<string>()
  let sawRunStart = false
  let runOpen = false

  for (const [i, e] of events.entries()) {
    if (!(AGUI_EVENT_TYPES as readonly string[]).includes(e.type)) {
      problems.push(`#${i}: unknown AG-UI event type ${JSON.stringify(e.type)}`)
      continue
    }
    switch (e.type) {
      case 'RUN_STARTED':
        if (runOpen) problems.push(`#${i}: RUN_STARTED while a run is open`)
        sawRunStart = true
        runOpen = true
        break
      case 'RUN_FINISHED':
      case 'RUN_ERROR':
        if (!runOpen) problems.push(`#${i}: ${e.type} without RUN_STARTED`)
        runOpen = false
        break
      case 'TEXT_MESSAGE_START': {
        const id = String(e.messageId ?? '')
        if (!id) problems.push(`#${i}: TEXT_MESSAGE_START without messageId`)
        if (openMessages.has(id)) problems.push(`#${i}: duplicate open messageId ${id}`)
        openMessages.add(id)
        break
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const id = String(e.messageId ?? '')
        if (!openMessages.has(id)) problems.push(`#${i}: CONTENT for unopened messageId ${id}`)
        if (typeof e.delta !== 'string') problems.push(`#${i}: CONTENT without string delta`)
        break
      }
      case 'TEXT_MESSAGE_END': {
        const id = String(e.messageId ?? '')
        if (!openMessages.has(id)) problems.push(`#${i}: END for unopened messageId ${id}`)
        openMessages.delete(id)
        break
      }
      case 'TOOL_CALL_START': {
        const id = String(e.toolCallId ?? '')
        if (!id) problems.push(`#${i}: TOOL_CALL_START without toolCallId`)
        if (openTools.has(id)) problems.push(`#${i}: duplicate open toolCallId ${id}`)
        if (typeof e.toolCallName !== 'string') problems.push(`#${i}: TOOL_CALL_START without toolCallName`)
        openTools.add(id)
        break
      }
      case 'TOOL_CALL_ARGS':
      case 'TOOL_CALL_RESULT': {
        const id = String(e.toolCallId ?? '')
        if (!openTools.has(id)) problems.push(`#${i}: ${e.type} for unopened toolCallId ${id}`)
        break
      }
      case 'TOOL_CALL_END': {
        const id = String(e.toolCallId ?? '')
        if (!openTools.has(id)) problems.push(`#${i}: TOOL_CALL_END for unopened toolCallId ${id}`)
        openTools.delete(id)
        break
      }
      case 'CUSTOM':
        if (typeof e.name !== 'string') problems.push(`#${i}: CUSTOM without name`)
        break
      default:
        break
    }
  }

  for (const id of openMessages) problems.push(`stream ended with messageId ${id} never closed`)
  for (const id of openTools) problems.push(`stream ended with toolCallId ${id} never closed`)
  if (!sawRunStart) problems.push('stream never opened a run')
  return problems
}
/** Close whatever is still open — call at end of stream or on disconnect. */
/** Close whatever is still open — call at end of stream or on disconnect. */
export function finalizeAgui(state: AguiTranslatorState, ts: number): AguiEvent[] {
  const out: AguiEvent[] = []
  if (state.openToolCallId) out.push({ type: 'TOOL_CALL_END', toolCallId: state.openToolCallId, timestamp: ts })
  if (state.openMessageId) out.push({ type: 'TEXT_MESSAGE_END', messageId: state.openMessageId, timestamp: ts })
  return out
}
