import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionModel } from '../src/session-model.ts'
import type { ApprovalRequest, SessionEvent } from '../src/protocol-types.ts'

/**
 * The `/interventions` 兜底轮询 (plan §7's second half of the OpenCode #16367 countermeasure)
 * introduces an ordering problem the event stream never had: a poll can be answered from a
 * server snapshot taken *before* the user's click landed, which would hand back the gate the
 * panel just dismissed and leave it sitting there for a whole poll interval. These tests pin
 * the guard that makes the poll safe to run.
 */

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: seq, type: type as SessionEvent['type'], data })
const gate = (requestId: string): ApprovalRequest => ({ requestId, toolName: 'edit_file', input: { file_path: 'a.ts' } })

function feed(m: SessionModel, seq: number, type: string, data: Record<string, unknown>): void {
  m.apply({ event: ev(seq, type, data), category: 'lifecycle', generation: 1, phase: 'live' })
}

test('a snapshot taken before the answer landed does not resurrect the gate', () => {
  const m = new SessionModel()
  feed(m, 1, 'approval_required', { approval: gate('req-1') })
  assert.equal(m.current.approvals.length, 1)

  feed(m, 2, 'approval_resolved', { requestId: 'req-1', approved: true })
  assert.equal(m.current.approvals.length, 0)

  // The in-flight poll response, built from the pre-answer server state.
  m.applySnapshot({ approvals: [gate('req-1')], lastSeq: 2 })
  assert.equal(m.current.approvals.length, 0, 'a resolved gate must not come back')
})

test('a late approval_required frame for a resolved id is ignored, but a new gate still lands', () => {
  const m = new SessionModel()
  feed(m, 1, 'approval_required', { approval: gate('req-1') })
  feed(m, 2, 'approval_resolved', { requestId: 'req-1' })

  feed(m, 3, 'approval_required', { approval: gate('req-1') })
  assert.equal(m.current.approvals.length, 0, 'the replay must not re-arm the dismissed gate')

  feed(m, 4, 'approval_required', { approval: gate('req-2') })
  assert.deepEqual(m.current.approvals.map((a) => a.requestId), ['req-2'], 'unseen gates are not swallowed')
})

test('the guard only suppresses ids this view has resolved', () => {
  const m = new SessionModel()
  // Cold-start authority arrives before any resolution: it must apply as-is.
  m.applySnapshot({ approvals: [gate('req-a'), gate('req-b')], lastSeq: 0 })
  assert.deepEqual(m.current.approvals.map((a) => a.requestId), ['req-a', 'req-b'])

  feed(m, 5, 'approval_resolved', { requestId: 'req-a' })
  m.applySnapshot({ approvals: [gate('req-b')], lastSeq: 5 })
  assert.deepEqual(m.current.approvals.map((a) => a.requestId), ['req-b'])

  // An empty list is a clear signal, not a no-op.
  m.applySnapshot({ approvals: [], lastSeq: 6 })
  assert.equal(m.current.approvals.length, 0)

  // And a genuinely new gate after all that is still shown.
  feed(m, 7, 'approval_required', { approval: gate('req-c') })
  assert.deepEqual(m.current.approvals.map((a) => a.requestId), ['req-c'])
})
