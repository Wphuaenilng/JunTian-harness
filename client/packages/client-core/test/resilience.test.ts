import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openSessionStream, reconnectCeiling, type StreamedEvent } from '../src/session-stream.ts'
import { SessionModel } from '../src/session-model.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

/**
 * DoD §9 MVP, the half that unit tests of `classifyStreamEvent` cannot reach: "断网 10 秒
 * 恢复后事件不丢不重" lives in the reconnect *loop* — the resume cursor it asks for, the
 * overlapping replay it must swallow, and the generation it must seal. So this drives the
 * real `openSessionStream` against a scripted fake transport: no sidecar, no key, no money.
 *
 * The fake is deliberately harsher than the sidecar: on reconnect it replays a window that
 * starts *before* the cursor the client resumes from. A client that trusts "server frames
 * are never redundant" renders the duplicated syllables twice, and the assertion is on the
 * final rendered text rather than on event counts, because duplicated prose is what the
 * user actually sees.
 */

const enc = new TextEncoder()
const frame = (ev: SessionEvent): string => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
const ev = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: seq, type: type as SessionEvent['type'], data })

/** A body that emits `chunks` and then stays open forever, like a live SSE socket. */
function hangingBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)) },
  })
}

/**
 * A body that emits `chunks` and then dies mid-stream — the socket breaking, not a clean
 * EOF. The error has to come from `pull`, one read *after* the last chunk: erroring the
 * controller inside `start` discards the queue it just filled, so the client would see an
 * empty stream and the test would silently stop exercising anything past seq 0.
 */
function dyingBody(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) { c.enqueue(enc.encode(chunks[i++])); return }
      c.error(new Error('fake socket died'))
    },
  })
}

// Each delta carries its own spacing so a duplicated one is visible as "Hello wo" + " wo".
const DELTAS = [ev(2, 'text_delta', { text: 'He' }), ev(3, 'text_delta', { text: 'llo' }),
  ev(4, 'text_delta', { text: ' wo' }), ev(5, 'text_delta', { text: 'rld' }), ev(6, 'text_delta', { text: '!' })]

test('a break mid-stream resumes from the cursor and re-renders each byte exactly once', async () => {
  const since: number[] = []
  const delivered: StreamedEvent[] = []
  const phases: string[] = []
  const model = new SessionModel()

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    since.push(Number(url.searchParams.get('since')))
    if (since.length === 1) {
      // Connection one: user echo + three deltas, then the socket breaks. seq 5..7 are
      // produced during the outage and must survive into attempt two.
      return { ok: true, body: dyingBody([frame(ev(1, 'user', { text: 'say hello' })), ...DELTAS.slice(0, 3).map(frame)]) } as unknown as Response
    }
    // Connection two: the replay window opens one event *before* the cursor, and its first
    // frame is a timeline event (not a seq=0 meta) so the dedupe path is the one under test.
    return { ok: true, body: hangingBody([
      // Field names come from the contract: protocol.ts:203-204 says the replay_window
      // payload is { floorSeq, diskFirstSeq, diskLastSeq }. An earlier draft of this
      // fixture invented `memFirstSeq`, which made the fold see floorSeq=0 and pass
      // vacuously rather than prove anything.
      frame(ev(1, 'replay_window', { floorSeq: 1, diskFirstSeq: 1, diskLastSeq: 7 })),
      frame(ev(0, 'replay_window', { floorSeq: 1, diskFirstSeq: 1, diskLastSeq: 7 })),
      ...DELTAS.slice(1).map(frame),
      frame(ev(7, 'turn_complete', { stopReason: 'end_turn' })),
      frame(ev(0, 'approval_snapshot', { pending: [] })),
    ])} as unknown as Response
  }) as typeof fetch

  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 1, maxBackoffMs: 2,
    onEvent: (e) => { delivered.push(e); model.apply(e) },
    // Same contract apps/web/src/App.tsx:241 uses.
    onPhase: (p, gen) => { if (p === 'connecting' && gen > 1) model.sealGeneration(); phases.push(p) },
  })

  try {
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline && !delivered.some((d) => d.event.seq === 7)) {
      await new Promise((r) => setTimeout(r, 5))
    }
  } finally {
    close()
    globalThis.fetch = realFetch
  }

  assert.ok(delivered.some((d) => d.event.seq === 7), 'seq 7 never arrived after the break')

  // 1. the resume cursor: cold open, then exactly what the client already holds. Anything
  //    lower re-reads the world, anything higher loses it.
  assert.deepEqual(since, [0, 4], `since= sequence was ${JSON.stringify(since)}`)

  // 2. 不丢: everything produced across the break reached the model, and nothing redundant
  //    was forwarded to it.
  assert.deepEqual(delivered.filter((d) => d.event.seq > 0).map((d) => d.event.seq), [1, 2, 3, 4, 5, 6, 7])

  // 3. 不重, asserted on rendered text — the only form of duplication a user can observe.
  const texts = model.current.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text)
  assert.deepEqual(texts, ['Hello wo', 'rld!'], 'the replayed deltas must not append a second " wo"')
  assert.equal(texts.join(''), 'Hello world!')

  // 4. sealing is what makes those two blocks instead of one: the reconnect closed the
  //    partial, so the post-break text starts fresh.
  assert.equal(model.current.blocks.map((b) => b.kind).join('+'), 'user+text+text')

  // 5. generations: the consumer needs the new one to know which partial to drop.
  const genOfSeq = (seq: number): number => delivered.find((d) => d.event.seq === seq)?.generation ?? -1
  assert.equal(genOfSeq(4), 1)
  assert.equal(genOfSeq(5), 2)
  assert.ok(phases.includes('down'), 'the break never surfaced as a phase')
  assert.equal(phases.filter((p) => p === 'connecting').length, 2)

  // 6. seq=0 meta events are snapshots: they arrive, they never advance the cursor.
  assert.equal(model.current.lastSeq, 7)
  assert.equal(delivered.filter((d) => d.event.seq === 0).length, 2)
})

test('a socket that dies before delivering anything keeps the cursor at zero', async () => {
  const since: number[] = []
  const realFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    since.push(Number(url.searchParams.get('since')))
    attempts += 1
    const body = attempts < 3
      ? dyingBody([])
      : hangingBody([frame(ev(1, 'user', { text: 'hi' })), frame(ev(0, 'approval_snapshot', { pending: [] }))])
    return { ok: true, body } as unknown as Response
  }) as typeof fetch

  const model = new SessionModel()
  const delivered: StreamedEvent[] = []
  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 1, maxBackoffMs: 2,
    onEvent: (e) => { delivered.push(e); model.apply(e) },
    onPhase: (p, gen) => { if (p === 'connecting' && gen > 1) model.sealGeneration() },
  })
  try {
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline && !delivered.some((d) => d.event.seq === 1)) {
      await new Promise((r) => setTimeout(r, 5))
    }
  } finally {
    close()
    globalThis.fetch = realFetch
  }

  // A dead socket that emitted nothing must not move the cursor — a phantom advance would
  // silently drop the events it never delivered.
  assert.deepEqual(since, [0, 0, 0])
  assert.equal(model.current.lastSeq, 1)
})

/**
 * §4.3 #2 names the numbers — 「指数退避 500ms→10s 加抖动」 — and until now nothing in the tree
 * pinned them. The pacing is now a pure ceiling plus two injectable seams (`rand`, `sleepMs`), so
 * the ladder and its reset are assertable without waiting on wall clocks.
 */
test('the reconnect ladder is 500ms doubling into a 10s cap', () => {
  assert.equal(reconnectCeiling(0, 500, 10_000), 500)
  assert.equal(reconnectCeiling(1, 500, 10_000), 1_000)
  assert.equal(reconnectCeiling(4, 500, 10_000), 8_000)
  assert.equal(reconnectCeiling(5, 500, 10_000), 10_000, 'the ramp saturates instead of running away')
  assert.equal(reconnectCeiling(60, 500, 10_000), 10_000, '2**60 must not overflow past the cap')
  assert.equal(reconnectCeiling(-3, 500, 10_000), 500, 'a negative attempt reads as the floor')
})

test('a connection that delivers resets the ladder, so a healthy period is not punished on its first drop', async () => {
  const waits: number[] = []
  const since: number[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    since.push(Number(url.searchParams.get('since')))
    if (since.length <= 2) return { ok: false, status: 503 } as unknown as Response
    if (since.length === 3) {
      // This one works: it delivers seq 1, then the socket breaks. The delivery is the whole
      // point — it is what must zero the run of failures.
      return { ok: true, body: dyingBody([frame(ev(1, 'user', { text: 'hi' }))]) } as unknown as Response
    }
    return { ok: true, body: hangingBody([frame(ev(2, 'text_delta', { text: 'ok' }))]) } as unknown as Response
  }) as typeof fetch

  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
    minBackoffMs: 40, maxBackoffMs: 10_000,
    rand: () => 1,                       // full jitter draw at its maximum ⇒ delay == ceiling
    sleepMs: async (ms) => { waits.push(ms) },  // the wait itself is observed, not slept through
  })
  try {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && waits.length < 3) await new Promise((r) => setTimeout(r, 2))
  } finally {
    close()
    globalThis.fetch = realFetch
  }

  // Two refusals ramp (40 → 80); the third connection delivers, so the drop after it starts the
  // ladder over again rather than waiting 160ms.
  assert.deepEqual(waits, [40, 80, 40], `observed waits ${JSON.stringify(waits)}`)
  assert.deepEqual(since.slice(0, 4), [0, 0, 0, 1], 'the cursor only moves once a frame actually arrived')
})

/**
 * Both ladder tests above inject `rand: () => 1`, and at that draw "full jitter" and "no jitter at
 * all" give the identical number — so nothing in the tree could tell the two apart, and dropping
 * `* rand()` from the delay would have left every check green. This test puts the draw in the
 * middle, where the three writings disagree: full jitter ⇒ draw × ceiling (10/20/40), equal jitter
 * ⇒ half the ceiling plus draw × half (25/50/100), no jitter ⇒ the ceiling (40/80/160).
 */
test('the jitter draw is really multiplied in — full jitter, not equal jitter, not none', async () => {
  const run = async (draw: () => number): Promise<number[]> => {
    const waits: number[] = []
    const realFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      // Three refusals so the ladder ramps; the fourth parks on a body that never emits. Without
      // that park the loop spins in microtasks forever — `sleepMs` is observed here, not slept
      // through, so nothing throttles it.
      if (requests <= 3) return { ok: false, status: 503 } as unknown as Response
      return { ok: true, body: hangingBody([]) } as unknown as Response
    }) as typeof fetch
    const close = openSessionStream({
      baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's',
      minBackoffMs: 40, maxBackoffMs: 10_000,
      rand: draw,
      sleepMs: async (ms) => { waits.push(ms) },
    })
    try {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline && waits.length < 3) await new Promise((r) => setTimeout(r, 2))
    } finally {
      close()
      globalThis.fetch = realFetch
    }
    return waits.slice(0, 3)
  }
  assert.deepEqual(await run(() => 0.25), [10, 20, 40], 'draw 0.25 must scale the whole ceiling — equal jitter would be [25, 50, 100], none would be [40, 80, 160]')
  assert.deepEqual(await run(() => 0), [0, 0, 0], 'a zero draw must be allowed to wait nothing; a floor here would mean the draw is being ignored or clamped')
})

