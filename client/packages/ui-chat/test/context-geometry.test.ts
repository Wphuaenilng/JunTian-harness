import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetSegments, contextPercentOf, ringFor, sharePercent, usedTokens, RING_CIRCUMFERENCE } from '../src/context-geometry.ts'
import type { ContextBudgetSnapshot } from '@tianshu/client-core'

/**
 * A snapshot shaped like the live one that exposed the bug below: a small used amount inside a large
 * window, with the reservations carrying most of the budget. `budgetSegments` used to decompose
 * `outputReserve` / `safetyMargin` as if they were usage, so the legend rows summed to 16% while the
 * ring read 9% — the two halves of one gauge disagreeing about the same session.
 */
const realSnapshot: ContextBudgetSnapshot = {
  requestId: 'r-1', revision: 7, sampledAt: 1, model: 'm', source: 'measured', state: 'ready',
  windowTokens: 500_000, inputBudget: 460_000,
  inputTokens: 40_000, toolTokens: 5_000, reasoningTokens: 28, imageTokens: 0,
  outputReserve: 30_000, safetyMargin: 45_000,
}

/**
 * The numbers here are the approved drawing's own: `.ck-ring` draws r=19 with
 * stroke-dasharray="119.38" and, at 42% used, stroke-dashoffset="69.24". If the helpers reproduce
 * those two literals, the port is faithful; that is the point of asserting on the drawing's values
 * rather than on numbers derived from the same formula in the test.
 */
test('the ring reproduces the drawing’s own dash literals at 42%', () => {
  assert.equal(RING_CIRCUMFERENCE, 119.38)
  const g = ringFor(210_000, 500_000)
  assert.equal(g.percent, 42)
  assert.equal(g.dashArray, 119.38)
  assert.equal(g.dashOffset, 69.24)
})

test('the fraction clamps instead of overrunning the circle', () => {
  assert.equal(ringFor(900_000, 500_000).percent, 100)
  assert.equal(ringFor(900_000, 500_000).dashOffset, 0)
  assert.equal(ringFor(1_000, -5).percent, 0)
  assert.equal(ringFor(1_000, 0).fraction, 0)
})

test('segments are shares of what is used, so they sum to the whole bar', () => {
  const segs = budgetSegments({ windowTokens: 500_000, inputTokens: 90_000, toolTokens: 60_000, reasoningTokens: 45_000 })
  assert.deepEqual(segs.map((s) => s.key), ['input', 'tool', 'reasoning'])
  assert.equal(segs.reduce((n, s) => n + s.share, 0).toFixed(6), '1.000000')
  assert.equal(Math.round(segs[1]!.share * 100), 31)
})

test('a field the runtime never reported is dropped, not shown as zero', () => {
  // 字段"没报"就是缺这个键：runtime 走 JSON，永远不会出现 `key: undefined`，
  // 而 exactOptionalPropertyTypes 也不允许显式 undefined（那会被读成"报了但值为空"）。
  const segs = budgetSegments({ inputTokens: 100, toolTokens: 0, imageTokens: 100 })
  assert.deepEqual(segs.map((s) => s.key), ['input', 'image'])
})

test('all-zero or all-missing yields no segments at all — the UI then says so instead of painting a fake bar', () => {
  assert.deepEqual(budgetSegments({ inputTokens: 0, toolTokens: 0 }), [])
  assert.deepEqual(budgetSegments({}), [])
})

test('the legend reads share-of-window (the drawing: 18/15/9 over a 42% ring) while the bar reads share-of-used', () => {
  const segs = budgetSegments({ windowTokens: 500_000, inputTokens: 90_000, toolTokens: 75_000, reasoningTokens: 45_000 })
  assert.deepEqual(segs.map((s) => Math.round(s.windowShare * 100)), [18, 15, 9])
  assert.equal(Math.round(segs.reduce((n, s) => n + s.share, 0) * 100), 100)
})

test('used tokens counts only the four things that occupy the window', () => {
  assert.equal(usedTokens(realSnapshot), realSnapshot.inputTokens + realSnapshot.toolTokens + realSnapshot.reasoningTokens)
  assert.equal(usedTokens({}), 0)
})

test('the legend rows sum to the ring: budget reservations are not context usage', () => {
  const segs = budgetSegments(realSnapshot)
  assert.deepEqual(segs.map((s) => s.key), ['input', 'tool', 'reasoning'])
  const ring = ringFor(usedTokens(realSnapshot), realSnapshot.windowTokens)
  assert.equal(ring.percent, 9)
  assert.equal(segs.reduce((n, s) => n + s.windowShare, 0).toFixed(10), ring.fraction.toFixed(10))
})

test('a non-zero slice of a big window reads as <1% instead of 0%', () => {
  const reasoning = budgetSegments(realSnapshot).find((s) => s.key === 'reasoning')!
  assert.equal(sharePercent(reasoning.windowShare), '<1%')
  assert.equal(sharePercent(0), '0%')
  assert.equal(sharePercent(0.099), '10%')
})

test('the collapsed rail’s tooltip and the ring cannot disagree: one algebra, two surfaces', () => {
  assert.equal(
    contextPercentOf({ ...realSnapshot }),
    ringFor(usedTokens(realSnapshot), realSnapshot.windowTokens).percent,
  )
})

test('no budget snapshot yet reads as "no number", never as 0%', () => {
  assert.equal(contextPercentOf(undefined), null)
  assert.equal(contextPercentOf({ inputTokens: 40_000 }), null)
  assert.equal(contextPercentOf({ windowTokens: 0, inputTokens: 1 }), null)
})
