import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeWait, syncArrivals, APPROVAL_HINT_AFTER_MS, APPROVAL_STALL_AFTER_MS } from '../src/wait.ts'

/**
 * Plan M1 asks for 「挂起 30s 显式提醒」. Until this module existed, the only way to see the
 * 30-second branch was to reach a real gate and deliberately not answer it — i.e. to pay for a
 * run and leave it hanging — so every live approval (answered at ~9 s) exercised only the hint
 * branch. These boundaries are the cheap substitute, and they are exact.
 */

test('the 30 s number has exactly one home, and that home is still the plan number', () => {
  // 以前每条断言都把 30_000 当参数传进去测，于是"面板默认值"这个计划真正核的数**没有主人**：
  // 有人把默认改成 60_000，这个文件照绿。现在数字住在常数里，面板默认读它，这里钉它等于计划的 30 秒。
  assert.equal(APPROVAL_STALL_AFTER_MS, 30_000, '计划 M1 写的是 30 秒——要改这个数字得同时改计划，不是改这一行')
  const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.tsx'), 'utf8')
  assert.match(panel, /stallAfterMs = APPROVAL_STALL_AFTER_MS/, '面板默认必须引用常数，而不是自己再写一个数')
  assert.doesNotMatch(panel, /stallAfterMs = \d/, '默认阈值里又出现字面秒数 = 第二个家，两处会各自漂移')
})

test('quiet before the hint threshold, hint between, alarm at 30 s', () => {
  assert.deepEqual(describeWait(0, APPROVAL_STALL_AFTER_MS), { hintSeconds: null, stallSeconds: null })
  assert.deepEqual(describeWait(APPROVAL_HINT_AFTER_MS, APPROVAL_STALL_AFTER_MS), { hintSeconds: null, stallSeconds: null },
    'exactly 8 s is still quiet: the hint is strictly after it')
  assert.deepEqual(describeWait(APPROVAL_HINT_AFTER_MS + 1, APPROVAL_STALL_AFTER_MS), { hintSeconds: 8, stallSeconds: null })
  assert.deepEqual(describeWait(29_999, APPROVAL_STALL_AFTER_MS), { hintSeconds: 29, stallSeconds: null })
  assert.deepEqual(describeWait(30_000, APPROVAL_STALL_AFTER_MS), { hintSeconds: null, stallSeconds: 30 },
    '30 s is inclusive — the alarm must not need a 31st second')
})

test('the alarm replaces the hint, it never stacks both', () => {
  for (const ms of [30_000, 45_000, 120_000]) {
    const w = describeWait(ms, APPROVAL_STALL_AFTER_MS)
    assert.equal(w.hintSeconds, null, `${ms} should be silent on the hint row`)
    assert.notEqual(w.stallSeconds, null, `${ms} must be alarming`)
  }
})

test('threshold is a parameter, not a magic constant baked in', () => {
  assert.equal(describeWait(6_000, 5_000).stallSeconds, 6, 'a 5 s stall setting fires at 6 s')
  assert.equal(describeWait(6_000, APPROVAL_STALL_AFTER_MS).stallSeconds, null)
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
