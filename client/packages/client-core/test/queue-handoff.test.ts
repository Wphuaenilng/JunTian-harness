import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SidecarClient } from '../src/sidecar-client.ts'

/**
 * §6 M1: 「busy 走 `/queue`（输入不丢）」. The kernel refuses in both directions — `/prompt` answers
 * 409 while a run is active, `/queue` answers 409 `code:'idle'` when the run closed in between
 * (`src/server/session-routes.ts:1204`，`code: 'idle'` 那一支) — and neither stores the text it rejected. Before
 * `sendOrQueue`, the host called `queue` and dropped its return value, so the second refusal lost
 * the user's input silently. These tests walk the request sequence, not the wording.
 */
type Reply = { status: number; body?: Record<string, unknown> }

function harness(replies: readonly Reply[]) {
  const paths: string[] = []
  const real = globalThis.fetch
  let turn = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    paths.push(new URL(String(input)).pathname)
    const r = replies[Math.min(turn, replies.length - 1)]!
    turn += 1
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as unknown as Response
  }) as typeof fetch
  return {
    api: new SidecarClient({ baseUrl: 'http://127.0.0.1:0', token: 't' }),
    paths,
    restore: (): void => { globalThis.fetch = real },
  }
}

const IDLE = { status: 409, body: { error: 'Session is not running; use /prompt to start a turn', code: 'idle' } }
const BUSY = { status: 409, body: { error: 'A turn is already running', code: 'run_busy' } }
const ACCEPTED = { status: 200, body: { started: true } }
const QUEUED = { status: 200, body: { queued: true, laneId: 'lane-1' } }

test('a free session goes straight to /prompt and never touches /queue', async () => {
  const h = harness([ACCEPTED])
  try {
    assert.equal(await h.api.sendOrQueue('s1', '你好'), 'ok')
    assert.deepEqual(h.paths, ['/sessions/s1/prompt'])
  } finally { h.restore() }
})

test('a running session parks the text in /queue exactly once', async () => {
  const h = harness([BUSY, QUEUED])
  try {
    assert.equal(await h.api.sendOrQueue('s2', '你好'), 'queued')
    assert.deepEqual(h.paths, ['/sessions/s2/prompt', '/sessions/s2/queue'])
  } finally { h.restore() }
})

test('the double race hands back to /prompt instead of dropping the input', async () => {
  const h = harness([BUSY, IDLE, ACCEPTED])
  try {
    assert.equal(await h.api.sendOrQueue('s3', '你好'), 'ok')
    assert.deepEqual(h.paths, ['/sessions/s3/prompt', '/sessions/s3/queue', '/sessions/s3/prompt'])
  } finally { h.restore() }
})

test('when both endpoints refuse twice the result is "lost" — the host must restore the draft', async () => {
  const h = harness([BUSY, IDLE, BUSY])
  try {
    assert.equal(await h.api.sendOrQueue('s4', '你好'), 'lost')
    assert.equal(h.paths.length, 3, `the hand-off must stop after one retry, saw ${h.paths.join(' → ')}`)
  } finally { h.restore() }
})

test('a queue acceptance is never re-sent (no duplicate turn)', async () => {
  const h = harness([BUSY, QUEUED, ACCEPTED])
  try {
    assert.equal(await h.api.sendOrQueue('s5', '你好'), 'queued')
    assert.deepEqual(h.paths, ['/sessions/s5/prompt', '/sessions/s5/queue'], 'the third reply must not be consumed')
  } finally { h.restore() }
})
