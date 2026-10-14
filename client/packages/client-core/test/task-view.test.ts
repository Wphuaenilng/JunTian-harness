/**
 * `/tasks` filtering — the half the sidecar does not do over HTTP.
 *
 * `GET /tasks` reads its filter from `body` and ignores the parameter carrying the query
 * (`src/server/task-routes.ts:194-200` vs `src/server/index.ts:83-92`), so a network client gets
 * the whole table whatever it asks for. Measured live 2026-10-13 in `scripts/accept-tasks.ts`.
 * These tests pin the client-side pass that makes `listTasks(filter)` mean what it says, and
 * that it stays a no-op on the day the server starts honouring the query.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectTasks, SidecarClient, type TaskRecord } from '../src/index.ts'

const row = (id: string, status: TaskRecord['status'], createdAt: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  prompt: `跑一下 ${id}`,
  source: 'cron',
  status,
  createdAt,
  timeoutMs: 3_600_000,
  callerId: 'cron-scheduler',
  idempotencyKey: `k-${id}`,
  force: false,
  ...extra,
})

const rowOld = row('task_old', 'failed', '2026-10-01T00:00:00.000Z')
const rowNew = row('task_new', 'cancelled', '2026-10-12T00:00:00.000Z')
const rowMid = row('task_mid', 'failed', '2026-10-05T00:00:00.000Z', { source: 'api', scheduledTaskId: 'cron_1' })
const TABLE: readonly TaskRecord[] = [rowOld, rowNew, rowMid]

test('a limit is a real ceiling even when the server sends back everything', () => {
  const page = selectTasks(TABLE, { limit: 2 })
  assert.deepEqual(page.map((t) => t.id), ['task_new', 'task_mid'], ' newest first, cut at 2')
  assert.equal(selectTasks(TABLE, { limit: 99 }).length, 3, 'a ceiling above the table size cuts nothing')
})

test('status is one "or" set, not a per-value equality', () => {
  assert.deepEqual(selectTasks(TABLE, { status: ['cancelled'] }).map((t) => t.id), ['task_new'])
  assert.deepEqual(selectTasks(TABLE, { status: ['failed', 'timed_out'] }).map((t) => t.id),
    ['task_mid', 'task_old'], 'both failures, newest first')
})

test('an empty status list means "no filter" — the same reading as the server\'s parser', () => {
  // `parseTaskFilter` only sets the filter when `statuses.length > 0` (task-routes.ts:27-30);
  // treating [] as "match nothing" would blank the board for a caller that clears a chip.
  assert.equal(selectTasks(TABLE, { status: [] }).length, 3)
  assert.equal(selectTasks(TABLE, {}).length, 3)
  assert.equal(selectTasks(TABLE).length, 3)
})

test('source and scheduledTaskId each match exactly', () => {
  assert.deepEqual(selectTasks(TABLE, { source: 'api' }).map((t) => t.id), ['task_mid'])
  assert.deepEqual(selectTasks(TABLE, { scheduledTaskId: 'cron_1' }).map((t) => t.id), ['task_mid'])
  assert.deepEqual(selectTasks(TABLE, { scheduledTaskId: 'cron_nope' }), [])
})

test('ordering is newest-first and the caller\'s array comes back untouched', () => {
  const unsorted = [rowNew, rowMid, rowOld]
  const sorted = selectTasks(unsorted, {})
  assert.deepEqual(sorted.map((t) => t.id), ['task_new', 'task_mid', 'task_old'])
  assert.deepEqual(unsorted.map((t) => t.id), ['task_new', 'task_mid', 'task_old'],
    'input order is not rewritten — the board and the cache share this array')
  assert.notEqual(sorted, unsorted, 'a new array, not the caller\'s')
})

test('a limit of zero or less cuts nothing (mirrors the store\'s `limit > 0` guard)', () => {
  assert.equal(selectTasks(TABLE, { limit: 0 }).length, 3)
  assert.equal(selectTasks(TABLE, { limit: -5 }).length, 3)
})

test('running it over an already-filtered page is a no-op — so this survives the kernel being fixed', () => {
  const asServerWould = selectTasks(TABLE, { status: ['failed'], limit: 1 })
  assert.deepEqual(asServerWould.map((t) => t.id), ['task_mid'])
  assert.deepEqual(selectTasks(asServerWould, { status: ['failed'], limit: 1 }).map((t) => t.id), ['task_mid'])
})

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

test('listTasks still puts the filter on the wire, and returns the page it asked for', async () => {
  // Two halves in one: dropping the query string would silently pin the client to the workaround
  // even after the kernel learns to read params; dropping the local pass would let the server's
  // "everything back" through as if it were the requested page.
  const f = stubFetch(() => ({ tasks: TABLE, count: TABLE.length }))
  try {
    const client = new SidecarClient({ baseUrl: 'http://127.0.0.1:9', token: 't' })
    const page = await client.listTasks({ status: ['failed'], limit: 1 })
    assert.match(f.urls[0]!, /\/tasks\?status=failed&limit=1$/, f.urls[0]!)
    assert.deepEqual(page.tasks.map((t) => t.id), ['task_mid'])
    assert.equal(page.count, page.tasks.length, 'count describes this page, not the registry')
  } finally {
    f.restore()
  }
})

test('the default request is the board\'s ceiling, not the entire history', async () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    row(`task_${String(i).padStart(3, '0')}`, 'completed', new Date(1_700_000_000_000 + i * 1000).toISOString()))
  const f = stubFetch(() => ({ tasks: many, count: many.length }))
  try {
    const client = new SidecarClient({ baseUrl: 'http://127.0.0.1:9', token: 't' })
    const page = await client.listTasks()
    assert.match(f.urls[0]!, /limit=50/, f.urls[0]!)
    assert.equal(page.tasks.length, 50, 'a 120-row registry must not land in the board whole')
    assert.equal(page.tasks[0]!.id, many[119]!.id, 'newest first')
  } finally {
    f.restore()
  }
})
