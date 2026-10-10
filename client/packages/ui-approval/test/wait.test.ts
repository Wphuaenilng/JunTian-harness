import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeWait, syncArrivals, APPROVAL_HINT_AFTER_MS } from '../src/wait.ts'

/**
 * Plan M1 asks for 「挂起 30s 显式提醒」. Until this module existed, the only way to see the
 * 30-second branch was to reach a real gate and deliberately not answer it — i.e. to pay for a
 * run and leave it hanging — so every live approval (answered at ~9 s) exercised only the hint
 * branch. These boundaries are the cheap substitute, and they are exact.
 */

test('quiet before the hint threshold, hint between, alarm at 30 s', () => {
  assert.deepEqual(describeWait(0, 30_000), { hintSeconds: null, stallSeconds: null })
  assert.deepEqual(describeWait(APPROVAL_HINT_AFTER_MS, 30_000), { hintSeconds: null, stallSeconds: null },
    'exactly 8 s is still quiet: the hint is strictly after it')
  assert.deepEqual(describeWait(APPROVAL_HINT_AFTER_MS + 1, 30_000), { hintSeconds: 8, stallSeconds: null })
  assert.deepEqual(describeWait(29_999, 30_000), { hintSeconds: 29, stallSeconds: null })
  assert.deepEqual(describeWait(30_000, 30_000), { hintSeconds: null, stallSeconds: 30 },
    '30 s is inclusive — the alarm must not need a 31st second')
})

test('the alarm replaces the hint, it never stacks both', () => {
  for (const ms of [30_000, 45_000, 120_000]) {
    const w = describeWait(ms, 30_000)
    assert.equal(w.hintSeconds, null, `${ms} should be silent on the hint row`)
    assert.notEqual(w.stallSeconds, null, `${ms} must be alarming`)
  }
})

test('threshold is a parameter, not a magic constant baked in', () => {
  assert.equal(describeWait(6_000, 5_000).stallSeconds, 6, 'a 5 s stall setting fires at 6 s')
  assert.equal(describeWait(6_000, 30_000).stallSeconds, null)
})

test('syncArrivals clocks new gates, keeps running ones, and prunes answered ones', () => {
  const map = new Map<string, number>()
  syncArrivals(map, ['a', 'b'], 1_000)
  assert.deepEqual([...map.entries()], [['a', 1_000], ['b', 1_000]])

  syncArrivals(map, ['a', 'b'], 5_000)
  assert.equal(map.get('a'), 1_000, 'an already-pending gate must keep its original clock')

  syncArrivals(map, ['b'], 6_000)
  assert.equal(map.has('a'), false, 'an answered gate leaves the map')

  syncArrivals(map, ['a', 'b'], 7_000)
  assert.equal(map.get('a'), 7_000, 'a reappearing id starts fresh, not "already stalled"')
  assert.equal(map.get('b'), 1_000, 'b never left the pending set, so its original clock stands')
})
