import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionModel } from '../src/session-model.ts'
import type { SessionEvent, StreamedEvent } from '../src/protocol-types.ts'

/**
 * Plan §7's mitigation for "no formal API docs, future breaking changes" ends with three
 * words that were never tested: **未知事件忽略**. The kernel can add an event type, or send a
 * field with a shape we have not seen, in any minor release; the client's job is to degrade to
 * "still readable" rather than to a blank timeline.
 *
 * This file is that claim, measured. It also pins the *shape* of the degradation, because
 * "ignore" has two meanings and only one of them is honest: drop silently, or keep the raw
 * payload where a human can still see it. We do the second (the ContextPanel dumps any
 * snapshot without a dedicated renderer), and a test is what keeps the two from drifting.
 */
const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: 0, type: type as SessionEvent['type'], data })
const streamed = (event: SessionEvent): StreamedEvent => ({ event } as unknown as StreamedEvent)

test('an unknown event type advances the cursor and is kept as a raw snapshot, never a crash', () => {
  const s = new SessionModel()
  s.apply(streamed(ev(1, 'text_delta', { text: 'before ' })))
  // A type that does not exist yet in this mirror — what a kernel minor release ships.
  s.apply(streamed(ev(2, 'quantum_update', { weird: [1, 2, { deep: true }] })))
  s.apply(streamed(ev(3, 'text_delta', { text: 'after' })))

  const st = s.current
  assert.equal(st.lastSeq, 3, 'an unknown seq=normal event must still move the cursor, or a reconnect re-reads it forever')
  assert.equal(st.blocks.filter((b) => b.kind === 'text').length, 1)
  const text = st.blocks.find((b) => b.kind === 'text')
  assert.equal(text?.kind === 'text' ? text.text : '', 'before after', 'the timeline keeps folding around the unknown event')
  assert.deepEqual(st.snapshots['quantum_update'], { weird: [1, 2, { deep: true }] }, 'the payload survives for the raw-snapshot surface')
  assert.equal(st.running, s.current.running, 'and it is not treated as a terminal signal')
})

test('malformed payloads on KNOWN types degrade instead of throwing', () => {
  const s = new SessionModel()
  // Every one of these is a shape the mirror allows but the kernel need not honour.
  for (const bad of [
    ev(1, 'text_delta', {}),
    ev(2, 'text_delta', { text: null }),
    ev(3, 'tool_use', { name: 42 }),
    ev(4, 'tool_result', { result: { nested: 'not a string' }, uiContent: 7 }),
    ev(5, 'error', {}),
    ev(6, 'approval_required', {}),
    ev(7, 'replay_window', null as unknown as Record<string, unknown>),
    ev(8, 'status', { status: 99 }),
  ]) {
    assert.doesNotThrow(() => s.apply(streamed(bad)), `${bad.type} with ${JSON.stringify(bad.data)} must not throw`)
  }
  // A malformed approval must not fabricate a gate the user could click.
  assert.equal(s.current.approvals.length, 0, 'an approval_required with no usable fields renders no gate')
  assert.ok(s.current.lastSeq >= 8, 'the cursor still walked the whole malformed batch')
})

/**
 * Measured behaviour, not a requirement: the plan's §4.3 #2 says nothing about a *forward*
 * jump (server starts above our cursor — only possible if the persisted log lost rows).
 * Today the client appends what it gets and shows no gap marker. Pinning this means the next
 * person does not "discover" it as a surprise, and it documents why a naive
 * `seq !== lastSeq+1` warning would mis-fire: replay compaction delivers a whole delta run as
 * one event whose seq is the run's LAST (`src/server/replay-compaction.ts` mergeRun), so
 * legitimate reconnects jump by design.
 */
test('a forward seq jump appends rather than throws, and a compacted run jumps legitimately', () => {
  const s = new SessionModel()
  s.apply(streamed(ev(1, 'text_delta', { text: 'a' })))
  // True jump: nothing on the server accounts for 2..19.
  s.apply(streamed(ev(20, 'text_delta', { text: 'b' })))
  const t1 = s.current.blocks.find((b) => b.kind === 'text')
  assert.equal(t1?.kind === 'text' ? t1.text : '', 'ab', 'content is kept; the jump itself is not visualised (no marker yet)')
  assert.equal(s.current.lastSeq, 20, 'the cursor accepts the new high-water mark')

  // Compacted jump: the same +19 gap is LEGAL when streamStartSeq says where the run began.
  const s2 = new SessionModel()
  s2.apply(streamed(ev(1, 'text_delta', { text: 'a' })))
  s2.apply(streamed(ev(20, 'text_delta', { text: 'bcdefghijklmnopqrst', streamStartSeq: 2 })))
  assert.equal(s2.current.lastSeq, 20)
  const t2 = s2.current.blocks.find((b) => b.kind === 'text')
  assert.equal(t2?.kind === 'text' ? t2.text : '', 'abcdefghijklmnopqrst')
})
