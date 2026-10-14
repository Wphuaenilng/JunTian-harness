import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionModel } from '../src/session-model.ts'
import type { StreamedEvent } from '../src/session-stream.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

/**
 * 计划 §4.3 #3 写「增量事件 fold 成**不可变**块数组」。读代码是对的（每次都是 `slice/concat/map`
 * 换新数组、新对象），但"不可变"这件事**一条测试都没钉**——而它是渲染契约的地基：
 * `useSyncExternalStore` 靠**引用变化**决定要不要重渲染，一旦有人把折叠改成原地 `push`，
 * 数组引用不变，界面就静停在上一次渲染上——不报错、不红，只是不再更新，是最难查的那类故障。
 *
 * 所以这几条全部钉两件事：**新状态必须换新引用**，而**已经交出去的旧快照必须逐字段不动**
 * （旧数组不会被撑长、旧块不会被改文本、旧 `open` 不会被翻成 false）。
 */

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: seq, type: type as SessionEvent['type'], data })

const send = (m: SessionModel, seq: number, type: string, data: Record<string, unknown>, generation = 1): void => {
  const streamed: StreamedEvent = { event: ev(seq, type, data), category: 'text', generation, phase: 'live' }
  m.apply(streamed)
}

const textOf = (b: unknown): string => (b as { text: string }).text
const openOf = (b: unknown): boolean => (b as { open: boolean }).open

test('every delta produces a NEW array, while the snapshot handed out earlier is untouched', () => {
  const m = new SessionModel()
  send(m, 1, 'user', { text: 'say hello' })
  send(m, 2, 'text_delta', { text: 'He' })

  const before = m.current.blocks
  const tailBefore = before[1]
  assert.equal(before.length, 2)
  assert.equal(textOf(tailBefore), 'He')

  send(m, 3, 'text_delta', { text: 'llo' })
  const after = m.current.blocks

  assert.notEqual(after, before, '折叠必须换新数组引用——原地改会让 useSyncExternalStore 根本不重渲染')
  assert.equal(before.length, 2, '旧快照被撑长了：那就是原地 push')
  assert.equal(textOf(tailBefore), 'He', '旧块对象被原地改了文本')
  assert.equal(textOf(after[1]), 'Hello', '新快照才带着拼接结果')
})

test('closing the previous open block copies the block instead of flipping its flag in place', () => {
  const m = new SessionModel()
  send(m, 2, 'thinking_delta', { text: '想一下' })
  const thinkingBefore = m.current.blocks[0]
  assert.equal(openOf(thinkingBefore), true)

  send(m, 3, 'text_delta', { text: '答案' })

  assert.equal(openOf(thinkingBefore), true, '已交出去的块不许被就地改成 closed')
  assert.equal(openOf(m.current.blocks[0]), false, '新快照里那一块才是关闭态')
  assert.equal(m.current.blocks[1]?.kind, 'text')
})

test('sealGeneration re-derives a new array and leaves the old snapshots alone', () => {
  const m = new SessionModel()
  send(m, 2, 'text_delta', { text: '半句' })
  const before = m.current.blocks
  const tailBefore = before[0]

  m.sealGeneration()

  assert.notEqual(m.current.blocks, before)
  assert.equal(openOf(tailBefore), true, '封存不许就地翻旧块的 open')
  assert.equal(openOf(m.current.blocks[0]), false, '封存要在副本上翻')
})

test('back-filling an older page prepends into a new array; the published one is not reshuffled', () => {
  const m = new SessionModel()
  send(m, 5, 'user', { text: '后半' })
  const before = m.current.blocks

  const added = m.prependEvents([ev(4, 'user', { text: '前半' })])

  assert.equal(added, 1)
  assert.notEqual(m.current.blocks, before, '合并结果必须是新数组')
  assert.equal(before.length, 1, '旧快照被就地插入了')
  assert.equal(textOf(before[0]), '后半')
  assert.deepEqual(m.current.blocks.map((b) => textOf(b)), ['前半', '后半'])
})

test('unchanged blocks keep their object identity, while the touched one is replaced', () => {
  const m = new SessionModel()
  send(m, 2, 'user', { text: '问题' })
  const userBefore = m.current.blocks[0]
  send(m, 3, 'tool_use', { callId: 'c1', name: 'read_file', args: { path: 'x' } })
  const toolBefore = m.current.blocks[1]

  send(m, 4, 'tool_result', { callId: 'c1', result: 'done', uiContent: '' })

  // 两半都要：只断"换新对象"会漏掉"整表重造"（那样每个 memo 都失效）；只断"引用不变"会漏掉原地改。
  assert.equal(m.current.blocks.length, 2, '工具回执应并入同一张工具卡，而不是再开一张')
  assert.equal(m.current.blocks[0], userBefore, '没被动过的块必须保持同一引用（结构性共享，否则 memo 全废）')
  assert.notEqual(m.current.blocks[1], toolBefore, '被更新的那一块必须是新对象（同一引用意味着界面看不到更新）')
})
