import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStalled, shouldArmStall } from '../src/stall-watch.ts'

const WATCH = { seqAtSend: 42, afterMs: 20_000 }

/**
 * The case this exists for, measured live rather than imagined: a keyless
 * `POST /prompt` answers 200 `{status:'running'}` and then the timeline never moves —
 * the kernel's own watchdog logs `[loop-stall] activities=none`. Without this rule the
 * UI shows a healthy run forever.
 */
test('a send whose timeline never moved is stalled', () => {
  assert.equal(isStalled(WATCH, 42, 20_001), true, 'no event at all after the window')
  assert.equal(isStalled(WATCH, 41, 25_000), true, 'a regression in seq is still not an answer')
})

test('any movement clears it, including our own echo', () => {
  assert.equal(isStalled(WATCH, 43, 20_001), false, 'the user block alone counts as progress')
  assert.equal(isStalled(WATCH, 999, 60_000), false)
})

test('it never fires early, however quiet the run is', () => {
  // A long-thinking model that simply has not emitted yet is not a stall; the whole point
  // of the window is that a false alarm here is worse than a late one.
  assert.equal(isStalled(WATCH, 42, 0), false)
  assert.equal(isStalled(WATCH, 42, 19_999), false)
  assert.equal(isStalled(WATCH, 42, WATCH.afterMs), true, 'exactly at the window')
})

test('only a directly accepted run arms the watch', () => {
  assert.equal(shouldArmStall('ok'), true)
  // A queued send is parked by design — warning about it would cry wolf on valid input.
  assert.equal(shouldArmStall('busy'), false)
  assert.equal(shouldArmStall('conflict'), false)
  assert.equal(shouldArmStall('error'), false)
})
