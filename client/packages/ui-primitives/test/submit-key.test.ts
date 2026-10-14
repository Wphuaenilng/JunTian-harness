import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submitsOnEnter, type SubmitKey } from '../src/submit-key.ts'

const k = (over: Partial<SubmitKey> = {}): SubmitKey => ({ key: 'Enter', shiftKey: false, isComposing: false, ...over })

test('a plain Enter on its own is the send keystroke', () => {
  assert.equal(submitsOnEnter(k()), true)
})

test('Shift+Enter is a newline, not a send', () => {
  assert.equal(submitsOnEnter(k({ shiftKey: true })), false)
})

test('the Enter that commits an IME candidate does not send — the defect this function exists for', () => {
  assert.equal(submitsOnEnter(k({ isComposing: true })), false)
})

test('any other key is not a send, composing or not', () => {
  assert.equal(submitsOnEnter(k({ key: 'a' })), false)
  assert.equal(submitsOnEnter(k({ key: 'Backspace' })), false)
  assert.equal(submitsOnEnter(k({ key: 'Escape', isComposing: true })), false)
  assert.equal(submitsOnEnter(k({ key: 'enter' })), false)  // `key` is exact, not case-insensitive
})

/**
 * The flag is a **required** field on purpose. React's synthetic keyboard event does not carry
 * `isComposing` (measured 2026-10-13: a composing Enter at a real React textarea gives
 * `nativeEvent.isComposing === true` and `e.isComposing === undefined`), so a call site that hands
 * over the React event must fail to compile here instead of quietly sending. This test is the
 * executable version of that claim: the only shape that satisfies the type is one built from the
 * native event.
 */
test('the composition flag has to be handed over — it is not something the predicate guesses', () => {
  const fromNative = (e: { key: string, shiftKey: boolean, nativeEvent: { isComposing: boolean } }): SubmitKey =>
    ({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })
  assert.deepEqual(fromNative({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } }), k({ isComposing: true }))
  assert.equal(submitsOnEnter(fromNative({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } })), false)
  assert.equal(submitsOnEnter(fromNative({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false } })), true)
  // `Object.keys` on the required shape: an omitted flag is not a legal input at all.
  assert.deepEqual(Object.keys(k()).sort(), ['isComposing', 'key', 'shiftKey'])
})

/**
 * Control that keeps this file honest: the rule the composer had before 2026-10-13. If the suite
 * only asserted cases both rules agree on, it would be green whether or not the guard exists — so
 * the composition case is pinned *by divergence*, not by repetition.
 */
test('the pre-fix inline rule would have sent on a composing Enter, so these tests can tell them apart', () => {
  const legacy = (e: SubmitKey) => e.key === 'Enter' && !e.shiftKey
  const composing = k({ isComposing: true })
  assert.equal(legacy(composing), true, 'the old shape is the defect; if this stops being true the foil is no longer a foil')
  assert.equal(submitsOnEnter(composing), false)
  // Everywhere else the two agree — the guard costs nothing beyond the one case it fixes.
  for (const e of [k(), k({ shiftKey: true }), k({ key: 'a' }), k({ key: 'Escape' })]) {
    assert.equal(submitsOnEnter(e), legacy(e), `divergence on a case that is not the IME commit: ${e.key}/${e.shiftKey}`)
  }
})
