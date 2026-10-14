import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openServerEvents, type ServerEvent } from '../src/server-events.ts'

/**
 * The global `/events` channel had **zero** tests: the only product consumer is
 * `apps/web/src/App.tsx`, and no suite ever named `openServerEvents`. Its framing was
 * also a second copy of `readSse`'s loop (now shared in `src/sse-frames.ts`), so the
 * byte-boundary cases in `sse-frames.test.ts` proved nothing about this call site.
 *
 * Frame shapes are the kernel's own: `src/server/server-events-route.ts:59-60` writes
 * `event: hello` with `{kind:'hello', ts, heartbeatMs}` then `event: health` with
 * `{kind:'health', ts, data: <HealthBody>}`; `:59` has no `seq`, which is exactly why
 * this file must NOT reuse `readSse`'s event guard.
 */
const enc = new TextEncoder()

type Pushable = { stream: ReadableStream<Uint8Array>; push: (bytes: Uint8Array) => void; close: () => void }

function pushable(): Pushable {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
  return {
    stream,
    push: (b) => ctrl.enqueue(b),
    close: () => { try { ctrl.close() } catch { /* already closed */ } },
  }
}

type Seen = { url: string; headers: Record<string, string>; body: ReadableStream<Uint8Array> }

/** Stub fetch with a per-call script; every call returns a still-open stream we can push into. */
function stubFetch(): { calls: Seen[]; streams: Pushable[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Seen[] = []
  const streams: Pushable[] = []
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const p = pushable()
    streams.push(p)
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: p.stream,
    })
    return { ok: true, status: 200, body: p.stream } as unknown as Response
  }) as typeof fetch
  return { calls, streams, restore: () => { globalThis.fetch = original } }
}

const helloFrame = (heartbeatMs = 5_000): string => `event: hello\ndata: ${JSON.stringify({ kind: 'hello', ts: 1, heartbeatMs })}\n\n`
const healthFrame = (over: Record<string, unknown> = {}): string =>
  `event: health\ndata: ${JSON.stringify({ kind: 'health', ts: 2, data: { sessionCount: 3, runningCount: 1, ...over } })}\n\n`

/** Real timers, bounded. A condition that never becomes true must fail loudly, not hang. */
async function until(cond: () => boolean, ms = 1_000, what = 'condition'): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - t0 > ms) throw new Error(`等不到 ${what}（${ms}ms 上界）`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('the kernel hello + health frames reach onEvent in order, intact', async () => {
  const f = stubFetch()
  const seen: ServerEvent[] = []
  try {
    const close = openServerEvents({ baseUrl: 'http://127.0.0.1:1', token: 't', onEvent: (ev) => { seen.push(ev) } })
    await until(() => f.calls.length === 1, 1_000, '第一次 fetch')
    f.streams[0]!.push(enc.encode(helloFrame() + healthFrame({ sessionCount: 7 })))
    await until(() => seen.length === 2, 1_000, '两帧都落地')
    close()
  } finally { f.restore() }
  assert.deepEqual(seen.map((e) => e.kind), ['hello', 'health'])
  const first = seen[0]
  assert.ok(first && first.kind === 'hello')
  assert.equal(first.heartbeatMs, 5_000, 'hello 的 heartbeatMs 要透出来（审批兜底节奏用它，不是用它自己猜的数）')
  const health = seen[1]
  assert.ok(health && health.kind === 'health')
  assert.equal(health.data.sessionCount, 7, 'health 的 data 必须原样带过来——侧栏就是靠这两个计数决定要不要重读 /sessions')
})

test('a frame split across chunks — including inside a multi-byte character — yields one event', async () => {
  const f = stubFetch()
  const seen: ServerEvent[] = []
  try {
    const close = openServerEvents({ baseUrl: 'http://127.0.0.1:1', token: 't', onEvent: (ev) => { seen.push(ev) } })
    await until(() => f.calls.length === 1, 1_000, '第一次 fetch')
    const bytes = enc.encode(`event: health\ndata: ${JSON.stringify({ kind: 'health', ts: 2, data: { sessionCount: 1, runningCount: 0, note: '会话标题里有中文' } })}\n\n`)
    const cjkAt = bytes.indexOf(0xe4)
    assert.ok(cjkAt > 0, '夹具里必须真有多字节序列可切')
    f.streams[0]!.push(bytes.slice(0, cjkAt + 1))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(seen.length, 0, '半截帧不许吐半个事件')
    f.streams[0]!.push(bytes.slice(cjkAt + 1))
    await until(() => seen.length === 1, 1_000, '补齐后的那一帧')
    close()
  } finally { f.restore() }
  const h = seen[0]
  assert.ok(h && h.kind === 'health')
  assert.equal((h.data as unknown as { note: string }).note, '会话标题里有中文')
})

test('an unparseable frame is dropped without killing the connection; later frames still arrive', async () => {
  const f = stubFetch()
  const seen: ServerEvent[] = []
  const phases: string[] = []
  try {
    const close = openServerEvents({
      baseUrl: 'http://127.0.0.1:1', token: 't',
      onEvent: (ev) => { seen.push(ev) },
      onPhase: (p) => { phases.push(p) },
    })
    await until(() => f.calls.length === 1, 1_000, '第一次 fetch')
    f.streams[0]!.push(enc.encode('event: health\ndata: {"kind":"health","ts":\n\n'))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(seen.length, 0, '坏 JSON 不许变成一个假事件')
    f.streams[0]!.push(enc.encode(helloFrame()))
    await until(() => seen.length === 1, 1_000, '坏帧之后的好帧')
    close()
    assert.deepEqual(phases, ['connecting', 'live'], '丢帧不该让连接变成 down')
    assert.equal(f.calls.length, 1, '也不该因此重连')
  } finally { f.restore() }
})

test('the request carries the bearer token and asks for an event stream (the 401-vs-200 half)', async () => {
  const f = stubFetch()
  try {
    const close = openServerEvents({ baseUrl: 'http://x.test/api', token: 'sekret', onEvent: () => {} })
    await until(() => f.calls.length === 1, 1_000, '第一次 fetch')
    close()
  } finally { f.restore() }
  assert.equal(f.calls[0]!.url, 'http://x.test/api/events', '路径拼法就是这一面派生并真打过的那条')
  assert.equal(f.calls[0]!.headers['authorization'], 'Bearer sekret')
  assert.equal(f.calls[0]!.headers['accept'], 'text/event-stream')
})

test('dispose stops emission and no further fetch happens', async () => {
  const f = stubFetch()
  const seen: ServerEvent[] = []
  try {
    const close = openServerEvents({ baseUrl: 'http://127.0.0.1:1', token: 't', onEvent: (ev) => { seen.push(ev) } })
    await until(() => f.calls.length === 1, 1_000, '第一次 fetch')
    f.streams[0]!.push(enc.encode(helloFrame()))
    await until(() => seen.length === 1, 1_000, '第一帧')
    close()
    // dispose → controller.abort() → 共用解析器在 abort 时 cancel 掉 reader。所以这条流在客户端
    // 这一侧**已经关掉**：直接断言"再推一帧会抛"比"再推一帧不吐事件"更硬——它证明 abort 真走到了 reader。
    assert.throws(() => { f.streams[0]!.push(enc.encode(healthFrame())) })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(seen.length, 1, 'dispose 之后不许再收事件')
    assert.equal(f.calls.length, 1, 'dispose 之后不许再重连')
    close() // 幂等
  } finally { f.restore() }
})
