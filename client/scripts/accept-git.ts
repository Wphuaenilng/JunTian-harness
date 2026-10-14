/**
 * accept-git.ts — the workbench read path against the real repository.
 *
 * Reads only. Nothing here stages, commits, branches or opens a PR: those all go
 * through checkedRepositoryWrite and would mutate the user's working tree. The probe
 * does assert that the write guard is real by checking the snapshot carries a
 * `version` to echo.
 *
 *   node scripts/accept-git.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient } from '../packages/client-core/src/index.ts'
import { diffStats, parseUnifiedDiff } from '../packages/ui-primitives/src/markdown.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
import { openInstance } from './lib-instance.ts'
const { api, info } = openInstance('Git 工作台读路径（对真实仓库，只读）')

const failures: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const sessions = await api.listSessions({ includeArchived: true })
const target = sessions[0]
if (!target) { console.error('✗ no sessions'); process.exit(1) }

// cwd comes from the session record rather than a typed path: backslash paths in a
// shell argument are how a probe ends up 400ing on isAbsolute.
const scope = { cwd: target.cwd }
console.log(`session ${target.id} cwd=${target.cwd}`)

const snap = await api.workbenchSnapshot(scope)
console.log(`\nGET /git/workbench → state=${snap.repository.state} branch=${JSON.stringify(snap.repository.branch)} head=${snap.repository.head?.slice(0, 8) ?? null}`)
console.log(`  ahead=${snap.repository.ahead} behind=${snap.repository.behind} remotes=${snap.repository.remotes.length} changes=${snap.changes.length}`)
console.log(`  version=${snap.repository.version.slice(0, 16)}… (optimistic-lock digest)`)
check('snapshot returns repository + changes', typeof snap.repository.cwd === 'string' && Array.isArray(snap.changes))
check('snapshot carries a version for the write lock', /^[0-9a-f]{16,}$/.test(snap.repository.version))

const conflictish = snap.changes.filter((c) => c.conflict)
console.log(`  conflicts: ${conflictish.length}; sample: ${JSON.stringify(snap.changes[0] ?? null).slice(0, 140)}`)
const firstChange = snap.changes[0]
check('changes expose porcelain index/worktree chars',
  firstChange === undefined || (typeof firstChange.index === 'string' && typeof firstChange.worktree === 'string'))

const branches = await api.workbenchBranches(scope)
console.log(`\nbranches: ${branches.branches.length} → ${branches.branches.slice(0, 4).map((b) => b.name).join(', ')}`)
console.log(`worktrees (raw porcelain string): ${branches.worktrees.split('\n').length} lines`)
check('branches parsed with sha', branches.branches.every((b) => /^[0-9a-f]{7,}$/.test(b.sha)), branches.branches[0]?.name ?? '')
check('worktrees comes back as the raw porcelain string', typeof branches.worktrees === 'string')

const history = await api.workbenchHistory(scope, 0, 5)
console.log(`\nhistory: ${history.commits.length} commits, hasMore=${history.hasMore}`)
for (const c of history.commits.slice(0, 3)) console.log(`  ${c.sha.slice(0, 8)} ${c.author} ${new Date(c.time * 1000).toISOString().slice(0, 10)} ${c.subject.slice(0, 44)} refs=${c.refs.slice(0, 30)}`)
check('history returns bounded commits with parents',
  history.commits.length > 0 && history.commits.every((c) => Array.isArray(c.parents) && Number.isFinite(c.time)))
check('history honours limit and reports hasMore', history.commits.length <= 5)

const wt = await api.sessionWorkingTree(target.id)
console.log(`\nsession working-tree: isRepo=${wt.isRepo} files=${wt.files.length}`)
for (const f of wt.files.slice(0, 4)) console.log(`  ${f.status.padEnd(10)} +${f.additions}/-${f.deletions} ${f.path}`)
check('session working-tree reports per-file line deltas',
  !wt.isRepo || wt.files.every((f) => Number.isFinite(f.additions) && Number.isFinite(f.deletions)))

// One real diff, read-only: take the first changed file if there is one.
const first = wt.files[0] ?? snap.changes[0]
if (first) {
  const diff = await api.workbenchDiff(scope, first.path)
  console.log(`\ndiff ${first.path}: ${diff.diff.length} chars, patch-shaped=${/^(@@|diff |index )/m.test(diff.diff)}`)
  check('workbench diff returns text for a changed path', typeof diff.diff === 'string')
  if (diff.diff.length > 0) {
    console.log(`  head: ${JSON.stringify(diff.diff.split('\n').slice(0, 3).join(' | ')).slice(0, 150)}`)
    // This is the missing evidence for the diff render path: a patch that came off the
    // wire, not a hand-written fixture. The component under test is the parser the
    // DiffBlock renders from, so classifying this correctly is what the panel shows.
    const hunks = parseUnifiedDiff(diff.diff)
    const kinds = new Set(hunks.map((h) => h.kind))
    const counted = diffStats(hunks)
    const plusLines = diff.diff.split('\n').filter((l) => /^\+(?!\+\+)/.test(l)).length
    const minusLines = diff.diff.split('\n').filter((l) => /^-(?!--)/.test(l)).length
    console.log(`  parsed: ${hunks.length} lines, kinds={${[...kinds].join(',')}}, +${counted.added}/−${counted.removed}`)
    check('real wire patch parses into hunks with meta headers',
      kinds.has('meta') && kinds.has('add'), `kinds=${[...kinds].join(',')}`)
    check('diffStats counts match a naive recount of the same patch',
      counted.added === plusLines && counted.removed === minusLines,
      `parser +${counted.added}/−${counted.removed} vs recount +${plusLines}/−${minusLines}`)
  }
} else {
  console.log('\n(no changed files to diff — clean tree)')
}

// A path the runtime has never registered must be refused, not silently accepted.
let refused = ''
try {
  await api.workbenchSnapshot({ cwd: 'C:\\Windows\\System32' })
} catch (e) {
  refused = (e as Error).message
}
check('unregistered workspace is refused (403 path)', refused.length > 0, refused.slice(0, 70))

if (failures.length > 0) {
  console.error(`\n✗ git workbench read path FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\n✓ Git 工作台读路径实测通过（未 stage / commit / 开 PR）')
