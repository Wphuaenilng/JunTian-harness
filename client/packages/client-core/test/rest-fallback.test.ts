import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openSessionStream, type StreamedEvent } from '../src/session-stream.ts'
import { SidecarClient } from '../src/sidecar-client.ts'
import { SessionModel } from '../src/session-model.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

/**
 * 计划 §4.3 #2 的后半——「REST 兜底快照与 SSE 增量在 Session 对象层去重合并」——此前**整条没接**：
 * `api.events(id, since)`（对应内核 `GET /sessions/:id/events?since=N`，`session-routes.ts:1250`
 * 那句 B3 replay tail）在客户端里是零调用点，断线期间界面只能冻在最后一个事件上。
 *
 * 这几条用脚本化传输把那条路径钉住：socket **一直连不上**（比真实故障更狠），于是唯一能让时间线
 * 前进的就是兜底那一发。断言落在三件事上：事件送到了模型、渲染文本没有第二遍、以及**游标被推进**
 * （推进之后 SSE 每一发重连问的都是新游标，通道恢复时同一批 seq 不会被投第二次）。
 */

const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: seq, type: type as SessionEvent['type'], data })

// 断线期间产生在服务器侧的那一段。每个 delta 自带空格，重复一次就会显形。
const TAIL = [ev(2, 'text_delta', { text: 'He' }), ev(3, 'text_delta', { text: 'llo' }),
  ev(4, 'text_delta', { text: ' wo' }), ev(5, 'text_delta', { text: 'rld' }), ev(6, 'text_delta', { text: '!' })]

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition never met within budget')
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** A socket that never even completes the request. Returns the restore seam. */
function deadSocket(seen: number[]): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(Number(new URL(String(input)).searchParams.get('since')))
    throw new Error('fake socket: connection refused')
  }) as typeof fetch
  return () => { globalThis.fetch = real }
}

test('the REST tail carries the timeline while the socket is dead, and moves the resume cursor', async () => {
  const since: number[] = []
  const pulled: number[] = []
  const delivered: StreamedEvent[] = []
  const model = new SessionModel()
  const restore = deadSocket(since)

  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 1, maxBackoffMs: 2, rand: () => 1,
    sleepMs: async () => { await new Promise((r) => setTimeout(r, 1)) },
    onEvent: (e) => { delivered.push(e); model.apply(e) },
    pullRest: async (cursor) => { pulled.push(cursor); return cursor === 0 ? TAIL : [] },
  })
  try {
    await until(() => pulled.length >= 2 && since.filter((s) => s === 6).length >= 2)
  } finally {
    close()
    restore()
  }

  // 1. 阈值之前不拉：前三次失败（attempt 0/1/2 之前）都只退避，第一次拉取发生在攒够失败之后。
  assert.deepEqual(since.slice(0, 3), [0, 0, 0], `退避阶梯是 ${JSON.stringify(since.slice(0, 3))}，前三发都该问 since=0`)
  // 2. 兜底把断线期间的事件送上了模型，且只送一次。
  assert.deepEqual(delivered.filter((d) => d.event.seq > 0).map((d) => d.event.seq), [2, 3, 4, 5, 6])
  const texts = model.current.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text)
  assert.equal(texts.join(''), 'Hello world!')
  // 3. 游标被推进：第一次从 0 拉，第二次就从 6 拉——而通道恢复后每一发重连问的都是 6，
  //     所以服务器不会再把这批 seq 投第二遍。
  assert.deepEqual(pulled.slice(0, 2), [0, 6], `兜底的起点是 ${JSON.stringify(pulled.slice(0, 2))}`)
  assert.ok(since.slice(3).every((s) => s === 6), `SSE 后来问的游标是 ${JSON.stringify(since.slice(3))}，应全是 6`)
})

test('a tail that overlaps what the cursor already holds is folded, not appended twice', async () => {
  const since: number[] = []
  const delivered: StreamedEvent[] = []
  const model = new SessionModel()
  const restore = deadSocket(since)

  // 每次都回同一批（服务器按 since 过滤之外，客户端还要能咽下重复——真实回放就会重叠）。
  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 1, maxBackoffMs: 2, rand: () => 1,
    sleepMs: async () => { await new Promise((r) => setTimeout(r, 1)) },
    onEvent: (e) => { delivered.push(e); model.apply(e) },
    pullRest: async () => TAIL,
  })
  try {
    await until(() => delivered.filter((d) => d.event.seq > 0).length >= 5 && since.filter((s) => s === 6).length >= 2)
  } finally {
    close()
    restore()
  }

  assert.deepEqual(delivered.filter((d) => d.event.seq > 0).map((d) => d.event.seq), [2, 3, 4, 5, 6],
    '重叠的那批必须按 seq 丢掉：投第二次就会把 " wo" 折成两遍')
  const texts = model.current.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text)
  assert.equal(texts.join(''), 'Hello world!')
})

test('a failing REST fallback does not kill the retry loop — the socket is the primary path', async () => {
  const since: number[] = []
  const restore = deadSocket(since)
  let pulls = 0

  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 1, maxBackoffMs: 2, rand: () => 1,
    sleepMs: async () => { await new Promise((r) => setTimeout(r, 1)) },
    pullRest: async () => { pulls += 1; throw new Error('GET /events → 500') },
  })
  try {
    await until(() => pulls >= 2 && since.length >= 5)
  } finally {
    close()
    restore()
  }
  assert.ok(pulls >= 2, `兜底只拉了 ${pulls} 次——一次失败把循环弄死了`)
})

test('with no pullRest configured the loop behaves exactly as before (the fallback is opt-in)', async () => {
  const since: number[] = []
  const restore = deadSocket(since)

  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 1, maxBackoffMs: 2, rand: () => 1,
    sleepMs: async () => { await new Promise((r) => setTimeout(r, 1)) },
  })
  try {
    await until(() => since.length >= 5)
  } finally {
    close()
    restore()
  }
  assert.deepEqual(since.slice(0, 5), [0, 0, 0, 0, 0], '没配兜底时游标不该被任何东西推进')
})

/**
 * The two event windows are one route with two cursors, and until now the **query string itself**
 * was only guarded by the zero-cost acceptance run: dropping `before=` from `historyPage` left
 * every unit test green (measured — it is how this file's sibling sweep found the hole). The
 * paging loop cannot tell a missing cursor from an empty page, so the shape is asserted here.
 */
test('hot asks with since=, cold asks with before= + limit, and the session id is escaped', async () => {
  const asked: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input))
    asked.push(`${u.pathname}?${u.search.slice(1)}`)
    return {
      ok: true, status: 200, json: async () => ({ events: [], lastSeq: 0, firstSeq: 0, diskLastSeq: 0 }),
    } as unknown as Response
  }) as typeof fetch
  try {
    const api = new SidecarClient({ baseUrl: 'http://127.0.0.1:0', token: 't' })
    await api.events('s/1', 7)
    await api.historyPage('s/1', 41, 5)
  } finally {
    globalThis.fetch = real
  }
  assert.deepEqual(asked, ['/sessions/s%2F1/events?since=7', '/sessions/s%2F1/events?before=41&limit=5'],
    '两条窗口各自的游标参数名不能互换，且冷通道必须把 limit 也带上')
})
