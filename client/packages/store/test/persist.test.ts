import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadView, saveView, attachViewPersistence, PERSISTED_FIELDS, STORAGE_KEY, type KeyedStore } from '../src/persist.ts'
import { createViewStore, setDraft, type ViewState } from '../src/index.ts'

function fakeStore(seed: Record<string, string> = {}): KeyedStore & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(seed))
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

const full: ViewState = {
  openSessionId: '20261010abc',
  includeArchived: true,
  panels: { right: false },
  rightTab: 'git',
  drafts: { '20261010abc': 'half-typed: sk-LEAKME' },
  connection: 'live',
  generation: 7,
  lastSeq: 4242,
}

test('round-trips exactly the layout fields', () => {
  const s = fakeStore()
  saveView(full, s)
  assert.deepEqual(loadView(s), {
    openSessionId: '20261010abc',
    includeArchived: true,
    rightTab: 'git',
    panels: { right: false },
  })
})

test('the stored blob never carries drafts or transport mirrors', () => {
  const s = fakeStore()
  saveView(full, s)
  const written = s.data.get(STORAGE_KEY) ?? ''
  assert.ok(written.length > 0, 'nothing was written')
  for (const forbidden of ['sk-LEAKME', 'half-typed', 'lastSeq', 'connection', 'generation', 'drafts']) {
    assert.ok(!written.includes(forbidden), `${forbidden} must never be persisted: ${written}`)
  }
  assert.deepEqual(PERSISTED_FIELDS, ['openSessionId', 'includeArchived', 'rightTab', 'panels'])
})

test('a corrupt or hostile blob degrades to defaults instead of throwing', () => {
  assert.deepEqual(loadView(fakeStore({ [STORAGE_KEY]: '{not json' })), {})
  assert.deepEqual(loadView(fakeStore({ [STORAGE_KEY]: '"just a string"' })), {})
  assert.deepEqual(loadView(fakeStore({ [STORAGE_KEY]: '[1,2,3]' })), {})
  assert.deepEqual(loadView(fakeStore()), {}, 'no entry at all')
})

test('field-level validation: bad rightTab and panels drop out, good ones survive', () => {
  const s = fakeStore({
    [STORAGE_KEY]: JSON.stringify({ openSessionId: 'x', rightTab: 'secrets', panels: { right: 'yes' }, includeArchived: 'true' }),
  })
  assert.deepEqual(loadView(s), { openSessionId: 'x' }, 'string "true" is not a boolean; "yes" is not a boolean; unknown tab rejected')

  const ok = fakeStore({ [STORAGE_KEY]: JSON.stringify({ rightTab: 'automations', panels: { right: true }, includeArchived: false }) })
  assert.deepEqual(loadView(ok), { rightTab: 'automations', panels: { right: true }, includeArchived: false })

  // null is a legitimate openSessionId (no session open), not a missing field.
  const nul = fakeStore({ [STORAGE_KEY]: JSON.stringify({ openSessionId: null }) })
  assert.deepEqual(loadView(nul), { openSessionId: null })
})

test('storage that throws on touch cannot break the app', () => {
  const evil: KeyedStore = {
    getItem: () => { throw new Error('SecurityError: private mode') },
    setItem: () => { throw new Error('QuotaExceeded') },
  }
  assert.deepEqual(loadView(evil), {})
  assert.doesNotThrow(() => saveView(full, evil))
  assert.doesNotThrow(() => saveView(full, null))
})

test('streaming mirrors never touch localStorage; a layout change does', () => {
  const s = fakeStore()
  let writes = 0
  const counting: KeyedStore = { getItem: (k) => s.getItem(k), setItem: (k, v) => { writes++; s.setItem(k, v) } }
  const view = createViewStore()
  const detach = attachViewPersistence(view, counting)

  // What apps/web actually does per streamed event: seq/generation mirrors and drafts move,
  // nothing persisted does. Without the subset guard this loop is 60 blocking writes.
  for (let seq = 1; seq <= 60; seq++) {
    view.setState((state) => { state.lastSeq = seq; state.generation = 1 })
    setDraft(view, 'sess-x', `typing ${seq}`)
  }
  assert.equal(writes, 0, `streaming must not persist (saw ${writes} writes)`)

  view.setState((state) => { state.rightTab = 'git' })
  assert.equal(writes, 1, 'a real layout change persists exactly once')

  for (let seq = 61; seq <= 120; seq++) view.setState((state) => { state.lastSeq = seq })
  assert.equal(writes, 1, 'still exactly one write after more streaming')

  view.setState((state) => { state.openSessionId = 'sess-y'; state.includeArchived = true })
  assert.equal(writes, 2)

  detach()
  view.setState((state) => { state.rightTab = 'files' })
  assert.equal(writes, 2, 'detach really unsubscribes')
  assert.deepEqual(loadView(s), { openSessionId: 'sess-y', includeArchived: true, rightTab: 'git', panels: { right: true } },
    'the blob reflects the last write, not the last state')
})

test('a store hydrated from the blob keeps defaults for everything not persisted', () => {
  const s = fakeStore({ [STORAGE_KEY]: JSON.stringify({ rightTab: 'files', openSessionId: 'abc' }) })
  const view = createViewStore(loadView(s))
  const st = view.getState()
  assert.equal(st.rightTab, 'files')
  assert.equal(st.openSessionId, 'abc')
  assert.equal(st.includeArchived, false, 'default survives')
  assert.equal(st.connection, 'idle', 'transport mirror starts honest')
  assert.deepEqual(st.drafts, {}, 'drafts are not restored from disk')
})
