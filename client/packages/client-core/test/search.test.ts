import test from 'node:test'
import assert from 'node:assert/strict'
import { SidecarClient, SEARCH_MIN_QUERY } from '../src/sidecar-client.ts'

/**
 * Search contract, pinned at the client boundary.
 *
 * The 2-character floor is not invented here: against a live sidecar, `q=a` answers
 * `400 {"error":"Query \"q\" must be at least 2 characters"}` while `q=ab` answers 200 with
 * `meta.scannedFiles`. Before this guard, that 400 reached the user as a 搜索失败 banner after a
 * single keystroke. The `limit` parameter used to be sent and is not — the route reads only `q`.
 */
const stubFetch = (respond: (url: string) => unknown) => {
  const urls: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    const body = respond(url)
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as typeof fetch
  return { urls, restore: () => { globalThis.fetch = real } }
}

const client = () => new SidecarClient({ baseUrl: 'http://127.0.0.1:9', token: 't' })

test('the floor is the number the live sidecar was measured to require', () => {
  assert.equal(SEARCH_MIN_QUERY, 2)
})

test('a one-character query never leaves the process, and says why instead of "no matches"', async () => {
  const f = stubFetch(() => { throw new Error('fetch must not be called') })
  try {
    const page = await client().searchSessions('a')
    assert.deepEqual(page, { hits: [], scannedFiles: null, tooShort: true })
    assert.deepEqual(f.urls, [])
  } finally { f.restore() }
})

test('the scan count comes back with the hits, and no inert limit is sent', async () => {
  const f = stubFetch(() => ({
    results: [{ sessionId: 's-1', title: '修复登录页', snippet: '…登录页样式…' }],
    meta: { durationMs: 1.2, scannedFiles: 130 },
  }))
  try {
    const page = await client().searchSessions('  hello world  ')
    assert.equal(page.hits.length, 1)
    assert.equal(page.scannedFiles, 130)
    assert.equal(page.tooShort, false)
    assert.equal(f.urls.length, 1)
    const url = f.urls[0]
    assert.ok(url !== undefined && url.includes('q=hello%20world'), `query was trimmed and encoded: ${String(url)}`)
    assert.ok(url !== undefined && !url.includes('limit='), `the route ignores limit: ${String(url)}`)
  } finally { f.restore() }
})

test('a response without meta is reported as "unknown scan count", not as zero', async () => {
  const f = stubFetch(() => ({ results: [] }))
  try {
    const page = await client().searchSessions('hello')
    assert.equal(page.scannedFiles, null)
    assert.equal(page.hits.length, 0)
  } finally { f.restore() }
})
