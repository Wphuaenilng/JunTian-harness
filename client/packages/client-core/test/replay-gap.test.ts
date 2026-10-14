import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyReplayGap, parseReplayWindow } from '../src/replay-gap.ts'
import { openSessionStream } from '../src/session-stream.ts'
import type { ReplayGap } from '../src/replay-gap.ts'
import type { SessionEvent } from '../src/protocol-types.ts'

/**
 * §9 MVP keeps one honest "not tested" line: a reconnect whose resume point sits *above* what
 * the client holds showed nothing. The judgement is easy to get wrong — the kernel merges a run
 * of deltas into one event stamped with the LAST seq of the run (`replay-compaction.ts` mergeRun),
 * so forward seq jumps are the normal shape of a replay. These tests are built around that trap,
 * and the last three drive the real reconnect loop against a scripted transport (no sidecar, no
 * key, no upstream call).
 */

const W = (floorSeq: number, diskFirstSeq: number, diskLastSeq: number) => ({ floorSeq, diskFirstSeq, diskLastSeq })

test('a cold open is not a gap, whatever the window says', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 0, window: W(14, 1, 20), firstSeq: 14 }), { kind: 'none', reason: 'cold-open' })
})

test('no replay_window means no claim: guessing is what would lie', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 9, firstSeq: 14 }), { kind: 'none', reason: 'no-window' })
})

test('the compaction trap: a merged run bridging the cursor is NOT loss', () => {
  // seqs 10..13 were merged into the event stamped 14, which says so with streamStartSeq.
  const g = classifyReplayGap({ cursor: 9, window: W(14, 1, 20), firstSeq: 14, firstStreamStartSeq: 10 })
  assert.deepEqual(g, { kind: 'none', reason: 'bridged-by-merge' })
})

test('a contiguous resume is silent', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 9, window: W(10, 1, 20), firstSeq: 10 }), { kind: 'none', reason: 'contiguous' })
})

test('already at the head is silent', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 20, window: W(14, 1, 20), firstSeq: undefined }), { kind: 'none', reason: 'at-head' })
})

test('ring lost them but the log has them: that is the cold channel, not a warning', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 9, window: W(14, 1, 20), firstSeq: 14 }),
    { kind: 'earlier-on-disk', from: 10, to: 13 })
})

test('ring AND log past the cursor: a real hole, with its span', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 9, window: W(14, 14, 20), firstSeq: 14 }),
    { kind: 'lost', from: 10, to: 13 })
})

test('nothing arrived on a generation that owed events is reported as unjudged, not as loss', () => {
  assert.deepEqual(classifyReplayGap({ cursor: 9, window: W(14, 1, 20) }), { kind: 'none', reason: 'no-delivery' })
})

test('parseReplayWindow reads the wire defensively', () => {
  assert.deepEqual(parseReplayWindow({ floorSeq: '12', diskLastSeq: '30' }), { floorSeq: 12, diskFirstSeq: 12, diskLastSeq: 30 })
  assert.equal(parseReplayWindow(undefined), undefined)
  assert.equal(parseReplayWindow({ floorSeq: 'x', diskLastSeq: 5 }), undefined)
})

// ----------------------------------------------------------------- through the real stream

const enc = new TextEncoder()
const frame = (ev: SessionEvent): string => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
const mk = (seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ seq, ts: seq, type: type as SessionEvent['type'], data })

/** One connection: replay the given frames, then stay open like a live socket. */
function onceWith(frames: string[]): void {
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)) } })
    return { ok: true, status: 200, body } as unknown as Response
  }) as typeof fetch
}

async function gapFor(frames: string[], since: number): Promise<ReplayGap | null> {
  onceWith(frames)
  let seen: ReplayGap | null = null
  const close = openSessionStream({
    baseUrl: 'http://127.0.0.1:0', token: 't', sessionId: 's', since,
    minBackoffMs: 1, maxBackoffMs: 2,
    onGap: (g) => { seen = g },
  })
  try {
    const deadline = Date.now() + 1_500
    while (Date.now() < deadline && seen === null) await new Promise((r) => setTimeout(r, 5))
  } finally {
    close()
  }
  return seen
}

const WINDOW = (floorSeq: number, diskFirstSeq: number, diskLastSeq: number): string =>
  frame(mk(0, 'replay_window', { floorSeq, diskFirstSeq, diskLastSeq }))

test('stream reports a merged replay as no gap', async () => {
  const g = await gapFor([
    WINDOW(14, 1, 20),
    frame(mk(14, 'text_delta', { text: 'abcd', streamStartSeq: 10 })),
    frame(mk(0, 'approval_snapshot', { pending: [] })),
  ], 9)
  assert.deepEqual(g, { kind: 'none', reason: 'bridged-by-merge' })
})

test('stream reports the ring-truncated-but-on-disk case as paged, not lost', async () => {
  const g = await gapFor([
    WINDOW(14, 1, 20),
    frame(mk(14, 'tool_result', { ok: true })),
    frame(mk(0, 'approval_snapshot', { pending: [] })),
  ], 9)
  assert.deepEqual(g, { kind: 'earlier-on-disk', from: 10, to: 13 })
})

test('stream reports the unreachable hole', async () => {
  const g = await gapFor([
    WINDOW(14, 14, 20),
    frame(mk(15, 'tool_result', { ok: true })),
    frame(mk(0, 'approval_snapshot', { pending: [] })),
  ], 9)
  assert.deepEqual(g, { kind: 'lost', from: 10, to: 14 })
})
