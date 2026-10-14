import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSse } from '../src/session-stream.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

/**
 * `readSse` had no direct test: the stream-level suites fed it whole frames, so every byte-boundary
 * case was only implied by the buffer code. These fixtures are the kernel's own framing
 * (`src/server/sse-stream.ts:48` writes `event: <type>\ndata: <json>\n\n`, line 76 a `: ping\n\n`
 * heartbeat, line 91 the terminating `event: done\ndata: {}`), cut at arbitrary places, because that
 * is what a socket does to a frame.
 */
const enc = new TextEncoder()

const frameOf = (ev: Record<string, unknown>): string => `event: ${String(ev['type'])}\ndata: ${JSON.stringify(ev)}\n\n`

const delta = (seq: number, text: string): Record<string, unknown> => ({
  seq, ts: 1_700_000_000_000, type: 'text_delta', data: { text },
})

async function collectBytes(bytes: readonly Uint8Array[]): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = []
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(b)
      c.close()
    },
  })
  await readSse(stream, (ev) => { seen.push(ev) }, new AbortController().signal)
  return seen
}

async function collect(chunks: readonly string[]): Promise<SessionEvent[]> {
  return collectBytes(chunks.map((c) => enc.encode(c)))
}

test('a multi-byte character split across chunks decodes intact', async () => {
  const payload = frameOf(delta(13, '中文正文，逐字流入'))
  const bytes = enc.encode(payload)
  // Cut inside the UTF-8 sequence of a CJK character: only a streaming decoder reassembles it.
  const cjkAt = bytes.indexOf(0xe4)
  assert.ok(cjkAt > 0, 'fixture must contain a CJK byte to split')
  const seen = await collectBytes([bytes.slice(0, cjkAt + 1), bytes.slice(cjkAt + 1)])
  assert.equal(seen.length, 1, 'a half character must not be parsed as a broken frame')
  assert.equal((seen[0]?.data as { text: string }).text, '中文正文，逐字流入')
})

test('a frame delivered in one chunk arrives as exactly one event', async () => {
  const seen = await collect([frameOf(delta(1, '第一段')), frameOf(delta(2, '第二段'))])
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map((e) => e.seq), [1, 2])
})

test('a frame cut in the middle of its JSON is stitched back into one event', async () => {
  const payload = frameOf(delta(7, '跨块的正文'))
  const head = payload.slice(0, 24)
  const tail = payload.slice(24)
  const seen = await collect([head, tail])
  assert.equal(seen.length, 1, `expected one stitched event, got ${seen.length}`)
  assert.equal(seen[0]?.seq, 7)
  assert.deepEqual((seen[0]?.data as { text: string }).text, '跨块的正文')
})

test('a frame whose \\n\\n separator straddles two chunks still ends the frame', async () => {
  const payload = frameOf(delta(8, 'x'))
  const sep = payload.indexOf('\n\n')
  // First chunk ends after the first "\n" of the terminator, second carries the rest.
  const seen = await collect([payload.slice(0, sep + 1), payload.slice(sep + 1)])
  assert.equal(seen.length, 1, 'splitting the terminator across chunks must not swallow or duplicate the frame')
  assert.equal(seen[0]?.seq, 8)
})

test('a ": ping" heartbeat produces no event and does not desync the stream', async () => {
  const seen = await collect([': ping\n\n', frameOf(delta(9, 'y')), ': ping\n\n', frameOf(delta(10, 'z'))])
  assert.deepEqual(seen.map((e) => e.seq), [9, 10], 'heartbeats must be skipped, not parsed into phantom events')
})

test('the terminating "event: done" with an empty payload is not turned into an event', async () => {
  const seen = await collect([frameOf(delta(11, 'w')), 'event: done\ndata: {}\n\n'])
  assert.deepEqual(seen.map((e) => e.seq), [11], 'a frame without seq/type must be dropped by the guard')
})

test('a frame whose payload is not JSON is ignored without killing the reader', async () => {
  const seen = await collect(['event: text_delta\ndata: {not json}\n\n', frameOf(delta(12, 'v'))])
  assert.deepEqual(seen.map((e) => e.seq), [12], 'one bad frame must not cost the rest of the stream')
})
