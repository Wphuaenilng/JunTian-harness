import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGUI_EVENT_TYPES,
  createAguiState,
  finalizeAgui,
  translateToAgui,
  validateAguiStream,
  type AguiEvent,
} from '../src/ag-ui.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent =>
  ({ seq, ts: 1000 + seq, type: type as SessionEvent['type'], data })

/** Run a sidecar sequence through the translator, returning the AG-UI frames. */
function run(events: SessionEvent[]): AguiEvent[] {
  let state = createAguiState()
  const out: AguiEvent[] = []
  for (const e of events) {
    const t = translateToAgui(e, state)
    out.push(...t.events)
    state = t.state
  }
  out.push(...finalizeAgui(state, 9999))
  return out
}

test('every emitted type is in the documented AG-UI vocabulary', () => {
  const frames = run([
    ev(1, 'user', { text: 'hi' }),
    ev(2, 'text_delta', { text: 'hel' }),
    ev(3, 'text_delta', { text: 'lo' }),
    ev(4, 'tool_use', { id: 't1', name: 'read_file', input: { path: 'a' } }),
    ev(5, 'tool_result', { toolUseId: 't1', content: 'ok' }),
    ev(6, 'turn_complete', {}),
    ev(7, 'done', { status: 'completed' }),
  ])
  for (const f of frames) {
    assert.ok((AGUI_EVENT_TYPES as readonly string[]).includes(f.type), `not an AG-UI type: ${f.type}`)
  }
  assert.deepEqual(validateAguiStream(frames), [])
})

test('deltas fold into one message with exactly one START and one END', () => {
  const frames = run([ev(1, 'text_delta', { text: 'a' }), ev(2, 'text_delta', { text: 'b' }), ev(3, 'text_delta', { text: 'c' }), ev(4, 'done', {})])
  const starts = frames.filter((f) => f.type === 'TEXT_MESSAGE_START')
  const ends = frames.filter((f) => f.type === 'TEXT_MESSAGE_END')
  const contents = frames.filter((f) => f.type === 'TEXT_MESSAGE_CONTENT')
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.equal(contents.length, 3)
  assert.deepEqual(validateAguiStream(frames), [])
})

test('an answer interrupted by a tool call still closes its message', () => {
  const frames = run([
    ev(1, 'text_delta', { text: 'let me look' }),
    ev(2, 'tool_use', { id: 't1', name: 'bash', input: {} }),
    ev(3, 'tool_result', { toolUseId: 't1', content: 'x' }),
    ev(4, 'done', {}),
  ])
  assert.deepEqual(validateAguiStream(frames), [])
  const order = frames.map((f) => f.type)
  assert.ok(order.indexOf('TEXT_MESSAGE_END') < order.indexOf('TOOL_CALL_START'), 'message must close before the tool opens')
})

test('thinking arrives via the CUSTOM escape hatch, never an invented spec name', () => {
  // AG-UI 1.0 has no reasoning event; mapping it to a fake TEXT_MESSAGE would
  // silently present chain-of-thought as answer text.
  const frames = run([ev(1, 'thinking_delta', { text: 'pondering' }), ev(2, 'done', {})])
  const custom = frames.filter((f) => f.type === 'CUSTOM')
  assert.ok(custom.length >= 1)
  assert.equal(custom[0]?.name, 'tianshu.thinking_delta')
  assert.equal(frames.some((f) => f.type === 'TEXT_MESSAGE_CONTENT'), false)
})

test('errors and aborted runs surface as RUN_ERROR', () => {
  const frames = run([ev(1, 'error', { error: 'boom', kind: 'network' }), ev(2, 'done', { status: 'failed' })])
  const errs = frames.filter((f) => f.type === 'RUN_ERROR')
  assert.equal(errs.length, 2)
  assert.equal(errs[0]?.message, 'boom')
  assert.equal(errs[0]?.code, 'network')
})

test('state-category events ride STATE_DELTA with a JSON-patch shaped body', () => {
  const frames = run([ev(1, 'todo_state', { items: [] }), ev(2, 'done', {})])
  const delta = frames.find((f) => f.type === 'STATE_DELTA')
  assert.ok(delta)
  const patch = delta.delta as Array<{ op: string; path: string }>
  assert.equal(patch[0]?.op, 'replace')
  assert.equal(patch[0]?.path, '/todo_state')
})

test('the validator actually catches a broken stream (it is not vacuously green)', () => {
  const broken: AguiEvent[] = [
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'ghost', delta: 'x', timestamp: 1 },
    { type: 'NOT_A_REAL_TYPE', timestamp: 2 },
  ]
  const problems = validateAguiStream(broken)
  assert.ok(problems.some((p) => p.includes('unopened messageId')))
  assert.ok(problems.some((p) => p.includes('unknown AG-UI event type')))
  assert.ok(problems.some((p) => p.includes('never opened a run')))
})

test('a tool_result for an id never opened still balances START/END (live-replay case)', () => {
  // Observed on a real replay: compaction dropped the tool_use but kept its result.
  const frames = run([
    ev(1, 'tool_result', { toolUseId: 'orphan_1', content: 'x' }),
    ev(2, 'done', { status: 'completed' }),
  ])
  assert.equal(frames.filter((f) => f.type === 'TOOL_CALL_START').length, 1)
  assert.equal(frames.filter((f) => f.type === 'TOOL_CALL_END').length, 1)
  assert.deepEqual(validateAguiStream(frames), [])
})

test('two tool calls in a row leave nothing dangling', () => {
  const frames = run([
    ev(1, 'tool_use', { id: 'a', name: 'read_file', input: {} }),
    ev(2, 'tool_use', { id: 'b', name: 'read_file', input: {} }),
    ev(3, 'tool_result', { toolUseId: 'b', content: 'ok' }),
    ev(4, 'done', {}),
  ])
  assert.deepEqual(validateAguiStream(frames), [], 'the first call must be closed when the second arrives')
})

test('an unclosed message is reported rather than shipped silently', () => {
  let state = createAguiState()
  const { events, state: s2 } = translateToAgui(ev(1, 'text_delta', { text: 'no end' }), state)
  state = s2
  assert.deepEqual(validateAguiStream(events), ['stream ended with messageId msg_assistant_1 never closed'])
  // finalize is what the stream handler calls on disconnect; it must close it.
  const closed = [...events, ...finalizeAgui(state, 2)]
  assert.deepEqual(validateAguiStream(closed), [])
})
