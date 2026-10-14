import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createViewStore, setDraft } from '../src/index.ts'

/**
 * 计划 §4.3 #3 三档节拍里，**立即**那一档过去只在注释里，没人钉。这几条补的就是它：视图状态走
 * zustand 的同步通知（点一下就必须有反应），而合帧那一档由 `frame-scheduler.test.ts` 管。
 *
 * 两条断言方向相反，缺一半都不算钉住：
 * ① 订阅者必须**在下一句代码之前**已经被叫到（否则"立即"是假的）；
 * ② 连续两次 setState 必须触发**两次**通知（否则视图状态也在被批处理，那些要求即时反馈的
 *    交互就会看到中间态丢失——而这是本模块与渲染器分工的边界）。
 */

test('the immediate tier is actually immediate — the listener has already run before the next statement', () => {
  const store = createViewStore()
  const seen: boolean[] = []
  store.subscribe((s) => { seen.push(s.includeArchived) })

  store.setState((s) => ({ includeArchived: !s.includeArchived }))

  assert.deepEqual(seen, [true], '同步通知：这一句执行时订阅者必须已经被叫过（异步的"立即"是谎话）')
})

test('two writes are two notifications — view state is not coalesced by anything here', () => {
  const store = createViewStore()
  let calls = 0
  store.subscribe(() => { calls += 1 })

  store.setState((s) => ({ rightTab: s.rightTab === 'git' ? 'files' : 'git' }))
  assert.equal(calls, 1)
  store.setState((s) => ({ rightTab: s.rightTab === 'git' ? 'files' : 'git' }))
  assert.equal(calls, 2, '合帧只属于 createFrameScheduler；视图状态走立即档，两次写就是两次通知')
})

test('subscribe does NOT replay the current state — that half belongs to useSyncExternalStore', () => {
  const store = createViewStore({ includeArchived: true })
  const seen: boolean[] = []
  store.subscribe((s) => { seen.push(s.includeArchived) })

  // 真实分工，钉住它是为了别有人"顺手加个初始回放"：vanilla 的订阅只在**变化**时通知，
  // 挂载时读当前态是 `useSyncExternalStore` 的 getSnapshot 那一侧的事。在这里回放一次，
  // 每个面板挂载就会多渲染一次，而且 React 那边仍会再读一遍——变成两处事实源。
  assert.deepEqual(seen, [], '本模块不得自作主张回放；回放归渲染器的 getSnapshot')

  store.setState((s) => ({ includeArchived: !s.includeArchived }))
  assert.deepEqual(seen, [false], '变化之后才通知')
})

test('setDraft keeps per-session drafts apart (the composer must not leak one session text into another)', () => {
  const store = createViewStore()
  setDraft(store, 'session-a', '给 a 的话')
  setDraft(store, 'session-b', '给 b 的话')

  assert.equal(store.getState().drafts['session-a'], '给 a 的话')
  assert.equal(store.getState().drafts['session-b'], '给 b 的话')
})
