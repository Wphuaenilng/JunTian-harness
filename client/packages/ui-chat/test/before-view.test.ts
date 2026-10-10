import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadBefore, resolveAsk } from '../src/before-view.ts'

type Client = Parameters<typeof loadBefore>[0]['client']
type Ask = NonNullable<ReturnType<typeof resolveAsk>>

const stub = (impl: (rel: string) => Promise<{ exists: boolean; content: string }>): Client =>
  ({ sessionFileBase: (_id: string, rel: string) => impl(rel) }) as unknown as Client

const askWith = (client: Client, rel = 'src/a.ts'): Ask => ({ client, sessionId: 's1', rel })

test('resolveAsk needs all three of client, session and an addressable path', () => {
  const client = stub(async () => ({ exists: true, content: '' }))
  assert.deepEqual(resolveAsk(client, 's1', 'F:\\proj\\src\\a.ts', 'F:\\proj'), { client, sessionId: 's1', rel: 'src/a.ts' })
  assert.equal(resolveAsk(undefined, 's1', 'F:\\proj\\a.ts', 'F:\\proj'), null)
  assert.equal(resolveAsk(client, undefined, 'F:\\proj\\a.ts', 'F:\\proj'), null)
  assert.equal(resolveAsk(client, 's1', undefined, 'F:\\proj'), null, 'not a single-file mutator')
  assert.equal(resolveAsk(client, 's1', 'F:\\other\\a.ts', 'F:\\proj'), null, 'outside the session cwd')
  assert.equal(resolveAsk(client, 's1', 'F:\\proj', 'F:\\proj'), null, 'the cwd itself is not a file')
})

test('the before-view has exactly three outcomes, and they are distinct', async () => {
  const seen: unknown[] = []
  const collect = (s: unknown): void => { seen.push(s) }

  await loadBefore(askWith(stub(async () => ({ exists: true, content: 'line one\nline two' }))), collect)
  await loadBefore(askWith(stub(async () => ({ exists: false, content: '' }))), collect)
  await loadBefore(askWith(stub(async () => { throw new Error('Path outside session cwd') })), collect)

  assert.deepEqual(seen, [
    { state: 'text', text: 'line one\nline two' },
    { state: 'new' },
    { state: 'failed', message: 'Path outside session cwd' },
  ])
})

test('a refused baseline is reported, never silently shown as an empty file', async () => {
  // The kernel answers 500 for an escaping path; mapping that to `text: ''` would render
  // an empty before-pane and read as "the file was empty", which is a lie.
  let out: unknown
  await loadBefore(askWith(stub(async () => { throw new Error('Internal server error') })), (s) => { out = s })
  assert.equal((out as { state: string }).state, 'failed')
  assert.ok(!('text' in (out as object)))
})
