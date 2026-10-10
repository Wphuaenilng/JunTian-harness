import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionModel } from '../src/session-model.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent => ({ seq, ts: 0, type: type as SessionEvent['type'], data })

/**
 * Captured from a live sidecar run with no provider key (session 202610097f98bb012102,
 * GET /sessions/:id/events) — so the shapes here are the wire's, not imagined ones.
 */
const liveCapture: SessionEvent[] = [
  ev(1, 'user', { text: 'hello probe' }),
  ev(2, 'status', { status: 'running' }),
  ev(3, 'goal_state', { goalId: '', goal: '', status: 'active', iteration: 0, maxIterations: 0, wallClockElapsedMs: 0, successCriteria: [] }),
  ev(4, 'error', { error: 'No usable API key for provider "deepseek" — the request was not sent.' }),
  ev(5, 'done', { status: 'failed' }),
]

test('replays a real capture into the expected timeline', () => {
  const s = new SessionModel()
  s.loadEvents(liveCapture)
  const st = s.current
  assert.deepEqual(st.blocks.map((b) => b.kind), ['user', 'error'])
  assert.equal(st.blocks[0]?.kind === 'user' && st.blocks[0].text, 'hello probe')
  assert.equal(st.running, false)
  assert.equal(st.terminalStatus, 'failed')
  // goal_state is a state-category snapshot, not a chat block.
  assert.equal(st.snapshots.goal_state?.['status'], 'active')
  assert.equal(st.approvals.length, 0)
})

test('streaming deltas fold into one open block, not one per delta', () => {
  const s = new SessionModel()
  s.loadEvents([ev(1, 'text_delta', { text: '你好 ' }), ev(2, 'text_delta', { text: '世界' })])
  const blocks = s.current.blocks
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.kind === 'text' && blocks[0].text, '你好 世界')
  assert.equal(blocks[0]?.kind === 'text' && blocks[0].open, true)
})

test('a user event closes the open assistant tail so ordering survives', () => {
  const s = new SessionModel()
  s.loadEvents([
    ev(1, 'text_delta', { text: 'first' }),
    ev(2, 'user', { text: 'second turn' }),
    ev(3, 'text_delta', { text: 'third' }),
  ])
  assert.deepEqual(s.current.blocks.map((b) => b.kind), ['text', 'user', 'text'])
  assert.equal(s.current.blocks[0]?.kind === 'text' && s.current.blocks[0].open, false)
  assert.equal(s.current.blocks.at(-1)?.kind === 'text' && s.current.blocks.at(-1)?.kind === 'text' && s.current.blocks.at(-1).open, true)
})

test('tool_use and tool_result pair into one block by call id', () => {
  const s = new SessionModel()
  s.loadEvents([
    ev(1, 'tool_use', { id: 'tu_1', name: 'edit_file', input: { path: 'a.ts' } }),
    ev(2, 'tool_result', { toolUseId: 'tu_1', content: 'ok', isError: false }),
  ])
  const b = s.current.blocks[0]
  assert.equal(b?.kind, 'tool')
  assert.equal(b?.kind === 'tool' && b.name, 'edit_file')
  assert.equal(b?.kind === 'tool' && b.result, 'ok')
  assert.equal(b?.kind === 'tool' && b.open, false)
  assert.equal(s.current.blocks.length, 1)
})

test('approval_snapshot is authoritative even when empty', () => {
  const s = new SessionModel()
  s.loadEvents([ev(1, 'approval_required', { requestId: 'r1', toolName: 'bash', input: { command: 'rm -rf /tmp/x' } })])
  assert.equal(s.current.approvals.length, 1)
  s.loadEvents([ev(2, 'approval_snapshot', { approvals: [], lastSeq: 2 })])
  assert.equal(s.current.approvals.length, 0, 'empty snapshot must clear stale pending approvals')

  s.loadEvents([ev(3, 'approval_snapshot', { approvals: [{ requestId: 'r2', toolName: 'write_file', input: {} }], lastSeq: 3 })])
  assert.deepEqual(s.current.approvals.map((a) => a.requestId), ['r2'])
  s.loadEvents([ev(4, 'approval_resolved', { requestId: 'r2' })])
  assert.equal(s.current.approvals.length, 0)
})

test('sealing a generation stops old partials from absorbing new deltas', () => {
  const s = new SessionModel()
  s.loadEvents([ev(1, 'text_delta', { text: 'half a sentence' })])
  s.sealGeneration()
  s.loadEvents([ev(2, 'text_delta', { text: ' continues' })])
  assert.deepEqual(s.current.blocks.map((b) => b.kind), ['text', 'text'])
  assert.equal(s.current.blocks[1]?.kind === 'text' && s.current.blocks[1].text, ' continues')
})

test('lastSeq tracks the timeline cursor and ignores seq=0 synthetic events', () => {
  const s = new SessionModel()
  s.loadEvents([ev(0, 'replay_window', { floorSeq: 1 }), ev(7, 'done', { status: 'completed' }), ev(0, 'job_snapshot', { jobs: [] })])
  assert.equal(s.current.lastSeq, 7, 'synthetic seq=0 snapshots must not move the reconnect cursor')
})

test('prependEvents back-fills an older page and keeps the timeline contiguous', () => {
  const s = new SessionModel()
  // Start from a truncated window (what a big session looks like after ring eviction).
  s.loadEvents([ev(50, 'user', { text: 'later' }), ev(51, 'text_delta', { text: 'answer' })])
  assert.deepEqual(s.current.blocks.map((b) => b.kind), ['user', 'text'])

  const added = s.prependEvents([ev(1, 'user', { text: 'the original prompt' }), ev(2, 'tool_use', { id: 't1', name: 'read_file', input: {} })])
  assert.equal(added, 2)
  assert.deepEqual(s.current.blocks.map((b) => b.kind), ['user', 'tool', 'user', 'text'])
  assert.equal(s.current.blocks[0]?.kind === 'user' && s.current.blocks[0].text, 'the original prompt')
  assert.equal(s.current.lastSeq, 51, 'cursor must not move backwards when older pages arrive')
})

test('re-prepending the same page is a no-op', () => {
  const s = new SessionModel()
  s.loadEvents([ev(5, 'user', { text: 'b' })])
  assert.equal(s.prependEvents([ev(1, 'user', { text: 'a' })]), 1)
  assert.equal(s.prependEvents([ev(1, 'user', { text: 'a' })]), 0)
  assert.deepEqual(s.current.blocks.map((b) => b.kind), ['user', 'user'])
})

test('shouldOfferEarlier comes only from the server replay_window bookkeeping', async () => {
  const { shouldOfferEarlier } = await import('../src/session-model.ts')
  assert.equal(shouldOfferEarlier(undefined), false, 'no window reported = nothing to load')
  assert.equal(shouldOfferEarlier({ floorSeq: 1, diskFirstSeq: 1 }), false, 'full window already held')
  assert.equal(shouldOfferEarlier({ floorSeq: 40, diskFirstSeq: 7 }), true, 'disk has a head the ring dropped')
  assert.equal(shouldOfferEarlier({ floorSeq: 0, diskFirstSeq: 0 }), false)
})

test('oldestSeq tracks the low end so before= has a cursor to ask with', () => {
  const s = new SessionModel()
  assert.equal(s.current.oldestSeq, 0)
  s.loadEvents([ev(0, 'replay_window', { floorSeq: 1 }), ev(30, 'user', { text: 'x' }), ev(31, 'done', {})])
  assert.equal(s.current.oldestSeq, 30, 'seq=0 synthetics must not become the cursor')
  s.prependEvents([ev(4, 'user', { text: 'older' })])
  assert.equal(s.current.oldestSeq, 4)
})

test('unknown event types are tolerated and recorded, never thrown', () => {
  const s = new SessionModel()
  s.loadEvents([ev(1, 'event_from_a_future_runtime', { hello: 'world' })])
  assert.equal(s.current.blocks.length, 0)
  assert.equal(s.current.snapshots.event_from_a_future_runtime?.['hello'], 'world')
})

/**
 * §4.3 #1 的「回放事件**原子替换**会话窗口」。两条分支都要钉住：冷启动（游标还在 0）整窗替换，
 * 续读（游标已推进）绝不清空——后者是断线重连时保住已渲染内容的唯一保证。
 */
const streamed = (seq: number, type: string, data: Record<string, unknown>) =>
  ({ event: ev(seq, type, data), category: 'lifecycle', generation: 1, phase: 'replay' }) as const

test('cold open replaces the window instead of appending onto what it replaces', () => {
  const s = new SessionModel()
  s.apply(streamed(0, 'job_snapshot', { jobs: [{ id: 'j1' }] }))
  assert.notEqual(s.current.snapshots.job_snapshot, undefined, 'fixture: a seq=0 snapshot landed first')

  s.apply(streamed(0, 'replay_window', { floorSeq: 1, diskFirstSeq: 1, diskLastSeq: 9 }))
  assert.equal(s.current.snapshots.job_snapshot, undefined, 'the cold-open window must replace the previous state, not merge into it')
  assert.equal(s.current.blocks.length, 0)
  assert.deepEqual(s.current.snapshots.replay_window, { floorSeq: 1, diskFirstSeq: 1, diskLastSeq: 9 })
})

test('a resume (cursor already advanced) must NOT wipe what the previous generation showed', () => {
  const s = new SessionModel()
  s.apply(streamed(1, 'user', { text: 'kept' }))
  s.apply(streamed(2, 'text_delta', { text: 'streamed' }))
  const before = s.current

  s.apply(streamed(0, 'replay_window', { floorSeq: 1, diskFirstSeq: 1, diskLastSeq: 9 }))
  assert.equal(s.current.blocks.length, before.blocks.length, 'resume wiped the timeline')
  assert.equal(s.current.lastSeq, 2, 'the cursor must survive the resume marker')
  assert.notEqual(s.current.snapshots.replay_window, undefined, 'the window itself is still recorded')
})

test('a truncated head reaches the predicate through the fold, not through a guess', async () => {
  const { shouldOfferEarlier } = await import('../src/session-model.ts')
  const s = new SessionModel()
  assert.equal(shouldOfferEarlier(s.current.snapshots.replay_window), false, 'nothing reported yet')

  s.apply(streamed(0, 'replay_window', { floorSeq: 42, diskFirstSeq: 7, diskLastSeq: 90 }))
  assert.equal(shouldOfferEarlier(s.current.snapshots.replay_window), true, 'disk has a head the memory ring dropped')
  assert.equal(s.current.blocks.length, 0, 'this branch must not touch the timeline')
})
