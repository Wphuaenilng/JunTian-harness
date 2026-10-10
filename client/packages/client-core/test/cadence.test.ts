import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionModel } from '../src/session-model.ts'
import { classifyStreamEvent } from '../src/stream-accept.ts'
import type { SessionEvent, StreamedEvent } from '../src/protocol-types.ts'

/**
 * Plan §4.3 #3 promises three notification cadences (immediate / microtask / rAF).
 * Two exist here and both are now measured; the third has no consumer, and this file is
 * where that stops being a rumour:
 *
 *   - immediate: the timeline. Measured on the real model: **N deltas → N+1 notifications**
 *     (the extra one is the first event, which mutates twice — open the block, move the
 *     cursor). Every later delta costs exactly one. One notification per accepted event is
 *     deliberate: a half-rendered message is worse than one extra repaint.
 *   - rAF: the status-bar counters (`createFrameScheduler`, used in apps/web) — derived
 *     aggregates, so they coalesce instead of repainting per delta.
 *   - microtask: nothing schedules on a microtask, because React 18 already coalesces store
 *     notifications that land inside one task. Counting notifications is what distinguishes
 *     "we chose not to" from "we forgot". If a consumer ever appears outside the React
 *     cascade (a canvas, a worker), that tier has to be added back deliberately.
 */
const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: 0, type: type as SessionEvent['type'], data })
const streamed = (event: SessionEvent): StreamedEvent => ({ event } as unknown as StreamedEvent)

function feedDeltas(count: number): { notifies: number; blocks: number; text: string; lastSeq: number } {
  const s = new SessionModel()
  let notifies = 0
  s.subscribe(() => { notifies += 1 })
  for (let i = 1; i <= count; i++) s.apply(streamed(ev(i, 'text_delta', { text: `d${i} ` })))
  const st = s.current
  const texts = st.blocks.filter((b) => b.kind === 'text')
  assert.equal(texts.length, 1, 'a burst must fold into ONE open tail block, not one block per delta')
  const first = texts[0]
  return { notifies, blocks: st.blocks.length, text: first?.kind === 'text' ? first.text : '', lastSeq: st.lastSeq }
}

test('the immediate tier costs one notification per event, plus one to open the block', () => {
  const twelve = feedDeltas(12)
  assert.equal(twelve.notifies, 13, 'N+1: measured, and the +1 is the first event, not a per-event overhead')
  assert.equal(twelve.lastSeq, 12)
  assert.equal(twelve.text, 'd1 d2 d3 d4 d5 d6 d7 d8 d9 d10 d11 d12 ')

  // The marginal rate is the claim that matters: a second event must add exactly one
  // notification. Comparing two burst sizes is what makes this test fail if the model ever
  // starts mutating twice per delta (which is the shape a "firehose" regression takes).
  const thirteen = feedDeltas(13)
  assert.equal(thirteen.notifies - twelve.notifies, 1, 'one extra delta = one extra notification')
})

test('dedupe lives in the accept layer, and the model deliberately trusts its input', () => {
  assert.equal(classifyStreamEvent(1, 1), 'dup', 'a re-read seq is a duplicate')
  assert.equal(classifyStreamEvent(2, 1), 'next')
  assert.equal(classifyStreamEvent(0, 5), 'meta', 'seq=0 passes through without moving the cursor')

  // Measured, not assumed: the model has no seq guard of its own, so a duplicate handed
  // straight to it *does* append. That is the design — the socket drops dups upstream
  // (§4.3 #2), and a second copy of the rule inside the model would only mask a broken
  // transport. The cursor still refuses to move backwards, which is what protects `since=`.
  const s = new SessionModel()
  s.apply(streamed(ev(1, 'text_delta', { text: 'x' })))
  s.apply(streamed(ev(1, 'text_delta', { text: ' duplicate' })))

  const text = s.current.blocks.find((b) => b.kind === 'text')
  assert.equal(text?.kind === 'text' ? text.text : '', 'x duplicate')
  assert.equal(s.current.lastSeq, 1, 'a duplicate cannot drag the cursor backwards')
})
