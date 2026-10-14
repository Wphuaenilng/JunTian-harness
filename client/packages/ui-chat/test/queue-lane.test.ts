import test from 'node:test'
import assert from 'node:assert/strict'
import { laneIsWaiting } from '../src/queue-lane.ts'

/**
 * The retract affordance in `ContextPanel` shows on a waiting lane and on nothing else, and the
 * word "waiting" is a fact about the kernel's event stream, not about a status enum the client
 * happens to like: every `queue_status` echo names the lane it took out of the queue — `steered`
 * when it is folded into the running turn, `retracted` after a successful retract, `merged` per
 * entry at the next prompt. A pending row whose own lane has such a status attached can only be
 * stale, and retracting it is a 409 the route answers `no longer queued`.
 */
test('队列 lane 没有任何 queue_status 时算还在等', () => {
  assert.equal(laneIsWaiting({ laneId: 'l-1', text: 'x' }, undefined), true)
})

test('queue_status 点名同一条 lane 就不再等：三种状态一样', () => {
  for (const status of ['steered', 'retracted', 'merged']) {
    assert.equal(laneIsWaiting({ laneId: 'l-1' }, { laneId: 'l-1', status }), false, `status=${status}`)
  }
})

test('queue_status 说的是别条 lane 时不影响本条', () => {
  // 折成 last-wins 单槽后，面板上的 pending 与 status 未必是同一条 lane——只有同名的那次才算。
  assert.equal(laneIsWaiting({ laneId: 'l-2' }, { laneId: 'l-1', status: 'merged' }), true)
})

test('没有 laneId 就没有可撤回的对象', () => {
  for (const pending of [undefined, {}, { laneId: '' }, { text: '没带 laneId' }]) {
    assert.equal(laneIsWaiting(pending, undefined), false, JSON.stringify(pending))
  }
})

test('status 侧缺 laneId 时不牵连 pending（缺字段只当没说这条 lane）', () => {
  assert.equal(laneIsWaiting({ laneId: 'l-1' }, { status: 'merged' }), true)
  assert.equal(laneIsWaiting({ laneId: 'l-1' }, { laneId: 7, status: 'merged' }), true)
})
