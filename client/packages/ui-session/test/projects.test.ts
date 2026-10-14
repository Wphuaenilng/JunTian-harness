import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionRecord } from '@tianshu/client-core'
import { groupSessionsByProject, projectNameFor, SYNTH_PROJECT_KEY, type ProjectGroup } from '../src/projects.ts'

/** Only the fields the grouping reads; the cast is deliberate — the real record has ~40 more. */
const session = (id: string, cwd: string, updatedAt: number, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({ id, cwd, updatedAt, ...extra }) as unknown as SessionRecord

const keys = (groups: ProjectGroup[]) => groups.map((g) => g.key)

test('one group per distinct cwd, newest activity first', () => {
  const groups = groupSessionsByProject([
    session('a', '/work/alpha', 10),
    session('b', '/work/beta', 30),
    session('c', '/work/alpha', 20),
  ])
  assert.deepEqual(keys(groups), ['/work/beta', '/work/alpha'])
  assert.deepEqual(groups[1]!.sessions.map((s) => s.id), ['c', 'a'])
  assert.equal(groups[0]!.name, 'beta')
  assert.equal(groups[0]!.cwd, '/work/beta')
})

test('a group ordered by its newest session, not by insertion order', () => {
  const groups = groupSessionsByProject([
    session('old', '/work/alpha', 5),
    session('new', '/work/beta', 8),
    session('spark', '/work/alpha', 99),
  ])
  assert.equal(groups[0]!.cwd, '/work/alpha')
  assert.equal(groups[0]!.updatedAt, 99)
})

test('scratch sessions share one synthetic bucket with no cwd', () => {
  const groups = groupSessionsByProject([
    session('x', '/tmp/rivet-scratch-1', 3, { workspaceSource: 'scratch' }),
    session('y', '/tmp/rivet-scratch-2', 9, { workspaceSource: 'scratch' }),
    session('z', '/work/alpha', 5),
  ])
  const temp = groups.find((g) => g.key === SYNTH_PROJECT_KEY)
  assert.ok(temp, 'expected a scratch bucket')
  assert.equal(temp.cwd, null)
  assert.deepEqual(temp.sessions.map((s) => s.id), ['y', 'x'])
  assert.deepEqual(keys(groups).filter((k) => k !== SYNTH_PROJECT_KEY), ['/work/alpha'])
})

test('a record without a usable cwd lands in the scratch bucket instead of an empty header', () => {
  const groups = groupSessionsByProject([
    session('n', '', 1),
    session('m', undefined as unknown as string, 2),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.key, SYNTH_PROJECT_KEY)
  assert.equal(groups[0]!.sessions.length, 2)
})

test('same-second activity breaks on the path, so the order does not shift between renders', () => {
  const once = keys(groupSessionsByProject([session('a', '/work/zeta', 7), session('b', '/work/alpha', 7)]))
  const twice = keys(groupSessionsByProject([session('b', '/work/alpha', 7), session('a', '/work/zeta', 7)]))
  assert.deepEqual(once, ['/work/alpha', '/work/zeta'])
  assert.deepEqual(twice, once)
})

test('project names come off the last segment for both path styles', () => {
  assert.equal(projectNameFor('/work/tianshu-harness'), 'tianshu-harness')
  assert.equal(projectNameFor('F:\\workspace\\AI-Harness\\Tianshu-harness'), 'Tianshu-harness')
  assert.equal(projectNameFor('/home/user/proj/'), 'proj')
  assert.equal(projectNameFor('/'), '/')
  assert.equal(projectNameFor('C:\\'), 'C:')
})

test('a session left on the sidecar runtime-default cwd is not presented as a project', () => {
  const groups = groupSessionsByProject([
    session('r', 'F:\\workspace\\somewhere\\kernel', 4, { workspaceSource: 'runtime-default' }),
    session('e', 'F:\\workspace\\somewhere\\kernel', 6, { workspaceSource: 'explicit' }),
  ])
  // Same directory, two different meanings: only the user-chosen one gets a header.
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.cwd, 'F:\\workspace\\somewhere\\kernel')
  assert.equal(groups[0]!.name, 'kernel')
  assert.equal(groups[1]!.key, SYNTH_PROJECT_KEY)
  assert.deepEqual(groups[1]!.sessions.map((s) => s.id), ['r'])
})

test('config-default is a real project — it is the workspace the user configured', () => {
  const groups = groupSessionsByProject([session('c', '/home/me/notes', 1, { workspaceSource: 'config-default' })])
  assert.deepEqual(keys(groups), ['/home/me/notes'])
})
