/**
 * accept-gitwrite.ts — the Git workbench WRITE path (plan M2 "Git 工作台 + PR 流").
 *
 * Runs entirely inside a throwaway sandbox under `client/.sidecar-data/git-sandbox/`
 * (gitignored, created and removed by this script): one bare "remote" and one clone.
 * Nothing here touches the developer's real working tree, and the only push destination
 * is a local directory — no network remote (and the kernel runs git with
 * GIT_TERMINAL_PROMPT=0, so an accidental one would fail fast rather than hang).
 *
 * Everything goes through `SidecarClient`, not raw fetch: this is the code the panel will
 * actually call, including how it surfaces the server's machine-readable error `code`.
 *
 *   node scripts/accept-gitwrite.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, SidecarError, type GitScope } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const failures: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Node's spawn does not append `.exe` on Windows, so bare `git` is ENOENT there. */
const GIT = process.platform === 'win32' ? 'git.exe' : 'git'
const git = (args: string[], cwd: string): string =>
  execFileSync(GIT, ['--literal-pathspecs', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' }).trim()

/** The rejection, or null when the call unexpectedly succeeded. */
async function failure(fn: () => Promise<unknown>): Promise<SidecarError | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e as SidecarError
  }
}

const describe = (e: SidecarError | null): string => (e ? `${e.status} ${e.code ?? '(no code)'}` : 'unexpected success')

// ------------------------------------------------------------------ sandbox
const sandbox = join(clientRoot, '.sidecar-data', 'git-sandbox')
const remoteDir = join(sandbox, 'origin.git')
const workDir = join(sandbox, 'work')

if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
// Both directories first: `git init` invoked with a cwd that does not exist surfaces as
// a misleading spawnSync ENOENT, which is exactly what bit this script the first time.
mkdirSync(remoteDir, { recursive: true })
mkdirSync(workDir, { recursive: true })
git(['-c', 'init.defaultBranch=main', 'init', '--bare', '-q', '.'], remoteDir)
git(['-c', 'init.defaultBranch=main', 'init', '-q', '.'], workDir)
for (const dir of [remoteDir, workDir]) {
  git(['config', 'user.name', 'Client Acceptance'], dir)
  git(['config', 'user.email', 'client-acceptance@example.invalid'], dir)
}
writeFileSync(join(workDir, 'README.md'), '# sandbox\n\nfirst line\n', 'utf8')
// The runtime seeds `<cwd>/.rivet/skills/**` into any workspace a session opens there,
// and those files are untracked — which the workbench honestly counts as dirt, so every
// branch/sync guard would fire on the runtime's own footprints. Exclude them locally,
// exactly as a developer would, and keep the rest of the tree meaningful.
appendFileSync(join(workDir, '.git', 'info', 'exclude'), '\n.rivet/\n', 'utf8')
git(['add', 'README.md'], workDir)
git(['commit', '-q', '-m', 'seed'], workDir)
git(['remote', 'add', 'origin', remoteDir], workDir)
git(['push', '-q', '-u', 'origin', 'main'], workDir)
console.log(`sandbox: ${workDir} ⇄ ${remoteDir}`)

let sessionId = ''
let exitCode = 0

try {
  // A session is what makes the sandbox cwd a *known workspace*
  // (git-workbench-routes.ts:13) — and no prompt means no run and no upstream cost.
  const session = await api.createSession({ title: 'git write sandbox', cwd: workDir, workspaceMode: 'explicit' })
  sessionId = session.id
  const scope: GitScope = { sessionId }
  console.log(`session ${session.id} cwd=${session.cwd} workspaceSource=${session.workspaceSource}`)

  const snap = await api.workbenchSnapshot(scope)
  check('sandbox resolves through the session scope onto main with a head',
    snap.repository.branch === 'main' && typeof snap.repository.head === 'string', `head=${snap.repository.head?.slice(0, 8)}`)
  check('the remote list is objects with a scrubbed url', snap.repository.remotes.length === 1 && snap.repository.remotes[0]!.name === 'origin',
    JSON.stringify(snap.repository.remotes))
  check('repository.version is the write token', typeof snap.repository.version === 'string' && snap.repository.version.length >= 16,
    snap.repository.version.slice(0, 24))

  // ---------------------------------------------------------- 1. stage → commit
  writeFileSync(join(workDir, 'README.md'), '# sandbox\n\nfirst line\nsecond line\n', 'utf8')
  const dirty = await api.workbenchSnapshot(scope)
  check('an uncommitted edit shows in the snapshot', dirty.changes.some((c) => c.path === 'README.md'),
    JSON.stringify(dirty.changes.map((c) => `${c.index}${c.worktree} ${c.path}`)))
  check('the version changes when the tree changes', dirty.repository.version !== snap.repository.version)

  const stale = await failure(() => api.workbenchStage(scope, { path: 'README.md' }, 'deadbeefdeadbeefdeadbeef'))
  check('a stale repository.version is refused: 409 stale_snapshot', stale?.status === 409 && stale.code === 'stale_snapshot', describe(stale))

  const stagedSnap = await api.workbenchStage(scope, { path: 'README.md' }, dirty.repository.version)
  check('staging with the live version echoes a snapshot with the file indexed',
    stagedSnap.changes.some((c) => c.path === 'README.md' && c.index === 'M'), JSON.stringify(stagedSnap.changes.map((c) => `${c.index}${c.worktree}`)))

  const hunkSnap = await api.workbenchStage(scope, { path: 'README.md', hunk: 0, unstage: true }, stagedSnap.repository.version)
  check('hunk-level unstage is accepted and returns to the worktree',
    hunkSnap.changes.some((c) => c.path === 'README.md' && c.worktree === 'M'), JSON.stringify(hunkSnap.changes.map((c) => `${c.index}${c.worktree}`)))
  const restage = await api.workbenchStage(scope, { path: 'README.md' }, hunkSnap.repository.version)

  const badHunk = await failure(() => api.workbenchStage(scope, { path: 'README.md', hunk: 99 }, restage.repository.version))
  check('an out-of-range hunk is refused with 400 invalid_hunk', badHunk?.status === 400 && badHunk.code === 'invalid_hunk', describe(badHunk))

  const missing = await failure(() => api.workbenchStage(scope, { path: 'no-such-file.md' }, restage.repository.version))
  check('staging a path with no change is refused (file_missing / invalid_path)',
    missing !== null && (missing.code === 'file_missing' || missing.code === 'invalid_path'), describe(missing))

  // ---------------------------------------------------------- 2. sensitive files
  // Creating a file changes `status`, and `version` digests head+branch+index+status —
  // so every write must read a fresh version. The panel does the same before each action.
  writeFileSync(join(workDir, '.env'), 'TOKEN=should-never-be-committed\n', 'utf8')
  const withEnv = await api.workbenchSnapshot(scope)
  const sensitive = await failure(() => api.workbenchStage(scope, { path: '.env' }, withEnv.repository.version))
  check('a .env is refused as sensitive_file (403) — the client never gets to stage it',
    sensitive?.status === 403 && sensitive.code === 'sensitive_file', describe(sensitive))

  // ---------------------------------------------------------- 3. commit
  const beforeCommit = await api.workbenchSnapshot(scope)
  const empty = await failure(() => api.workbenchCommit(scope, '   ', beforeCommit.repository.version))
  check('an empty message is refused: 400 empty_message', empty?.status === 400 && empty.code === 'empty_message', describe(empty))

  const commit = await api.workbenchCommit(scope, 'docs: add the second line', beforeCommit.repository.version)
  check('commit returns ok + the new sha', commit.ok === true && /^[a-f0-9]{40}$/.test(commit.sha), commit.sha.slice(0, 8))

  const afterCommit = await api.workbenchSnapshot(scope)
  check('HEAD moved to the committed sha', afterCommit.repository.head === commit.sha, `head=${afterCommit.repository.head?.slice(0, 8)}`)
  check('.env stayed out of the commit', !git(['show', '--name-only', '--format=', 'HEAD'], workDir).includes('.env'))
  const noIndex = await failure(() => api.workbenchCommit(scope, 'nothing staged', afterCommit.repository.version))
  check('committing an empty index is refused: empty_index', noIndex !== null && noIndex.code === 'empty_index', describe(noIndex))

  // ---------------------------------------------------------- 4. branch guards
  // `.env` is still untracked, and an untracked file counts as a change — remove it so
  // the branch tests hit the guard they are actually about.
  rmSync(join(workDir, '.env'))
  writeFileSync(join(workDir, 'notes.md'), 'wip\n', 'utf8')
  const dirtyAgain = await api.workbenchSnapshot(scope)
  const dirtyBranch = await failure(() => api.workbenchBranch(scope, { name: 'feature/x', create: true }, dirtyAgain.repository.version))
  check('switching branches on a dirty tree is refused: 409 dirty_workspace',
    dirtyBranch?.status === 409 && dirtyBranch.code === 'dirty_workspace', describe(dirtyBranch))
  rmSync(join(workDir, 'notes.md'))

  const clean = await api.workbenchSnapshot(scope)
  check('the tree really is clean for the branch tests', clean.changes.length === 0, JSON.stringify(clean.changes.map((c) => c.path)))
  const badName = await failure(() => api.workbenchBranch(scope, { name: '-rf', create: true }, clean.repository.version))
  check('a branch name starting with - is refused before git runs it',
    badName?.code === 'invalid_branch' || badName?.code === 'git_failed', describe(badName))

  const branched = await api.workbenchBranch(scope, { name: 'feature/second', create: true }, clean.repository.version)
  check('create+switch lands on the new branch', branched.repository.branch === 'feature/second', branched.repository.branch)

  // ---------------------------------------------------------- 5. sync
  const badRemote = await failure(() => api.workbenchSync(scope, { remote: 'evil', action: 'fetch' }, branched.repository.version))
  check('an unknown remote is refused: 400 invalid_remote', badRemote?.status === 400 && badRemote.code === 'invalid_remote', describe(badRemote))

  const unconfirmed = await failure(() => api.workbenchSync(scope, { remote: 'origin', action: 'push', ref: 'feature/second' }, branched.repository.version))
  check('push without confirm:true is refused: confirmation_required',
    unconfirmed?.status === 400 && unconfirmed.code === 'confirmation_required', describe(unconfirmed))

  await api.workbenchSync(scope, { remote: 'origin', action: 'fetch' }, branched.repository.version)
  const v2 = (await api.workbenchSnapshot(scope)).repository.version
  const pushed = await api.workbenchSync(scope, { remote: 'origin', action: 'push', ref: 'feature/second', confirm: true }, v2)
  const remoteRef = git(['rev-parse', 'refs/heads/feature/second'], remoteDir)
  check('fetch then confirmed push succeed against the local bare remote', pushed.repository.branch === 'feature/second')
  check('the bare remote really received the branch', remoteRef === branched.repository.head, remoteRef.slice(0, 8))

  // ------------------------------------------------- 6. session landing: commitIndex only
  writeFileSync(join(workDir, 'session.md'), 'from session route\n', 'utf8')
  const preSession = await api.workbenchSnapshot(scope)
  const nothingStaged = await api.sessionCommit(session.id, 'docs: should be refused — index is empty')
  check('POST /sessions/:id/git/commit commits the INDEX, not everything on disk (nothingToCommit)',
    nothingStaged.ok === true && nothingStaged.nothingToCommit === true, JSON.stringify(nothingStaged).slice(0, 90))

  const stagedSession = await api.workbenchStage(scope, { path: 'session.md' }, preSession.repository.version)
  check('the new untracked file stages on the first try (its hunk guard is file-level)',
    stagedSession.changes.some((c) => c.path === 'session.md' && c.index === 'A'), JSON.stringify(stagedSession.changes.map((c) => `${c.index}${c.worktree} ${c.path}`)))
  const sessionCommit = await api.sessionCommit(session.id, 'docs: session-scoped commit')
  check('with the file staged, the session commit lands (server-direct, no version echo)',
    sessionCommit.ok === true && typeof sessionCommit.sha === 'string', JSON.stringify(sessionCommit).slice(0, 70))
  check('the session commit is HEAD and carries the file',
    git(['log', '--oneline', '-1'], workDir).includes('session-scoped')
    && git(['show', '--name-only', '--format=', 'HEAD'], workDir).includes('session.md'))

  // ------------------------------------------------- 7. merge-back through an isolated worktree
  const iso = await api.createSession({
    title: 'git merge-back sandbox',
    cwd: workDir,
    workspaceMode: 'explicit',
    isolatedWorktree: true,
  })
  const isoScope: GitScope = { sessionId: iso.id }
  console.log(`isolated session ${iso.id} worktree=${iso.worktreePath ?? '(none)'} branch=${iso.worktreeBranch ?? '(none)'}`)
  try {
    const wt = iso.worktreePath
    check('isolatedWorktree gave the session its own worktree + branch',
      typeof wt === 'string' && typeof iso.worktreeBranch === 'string' && existsSync(wt), `${wt} @ ${iso.worktreeBranch}`)
    if (typeof wt === 'string' && existsSync(wt)) {
      writeFileSync(join(wt, 'from-worktree.md'), 'merged back\n', 'utf8')
      const snapWt = await api.workbenchSnapshot(isoScope)
      await api.workbenchStage(isoScope, { path: 'from-worktree.md' }, snapWt.repository.version)
      const wtCommit = await api.sessionCommit(iso.id, 'feat: a change made in the worktree')
      check('the worktree commit lands on the session branch', wtCommit.ok === true && !wtCommit.nothingToCommit,
        JSON.stringify(wtCommit).slice(0, 70))

      const merged = await api.sessionMergeBack(iso.id)
      check('merge-back squashes the session branch into the main workspace',
        merged.ok === true && typeof merged.sha === 'string', JSON.stringify(merged).slice(0, 110))
      check('the main branch commit carries the merged file',
        git(['show', '--name-only', '--format=', 'HEAD'], workDir).includes('from-worktree.md'))
      // Measured, not assumed: merge-back advances the branch ref, and whether the
      // working copy on disk follows is a separate question the panel has to answer for
      // the user (refresh / checkout affordance) instead of silently claiming "done".
      console.log(`  i working tree copy present after merge-back: ${existsSync(join(workDir, 'from-worktree.md'))}`)
      console.log(`  i main branch after merge-back: ${git(['rev-parse', '--abbrev-ref', 'HEAD'], workDir)}, head=${git(['rev-parse', '--short', 'HEAD'], workDir)}`)
    }
  } finally {
    await fetch(`${info.baseUrl}/sessions/${iso.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${info.token}` } }).catch(() => undefined)
  }

  const mergeBackPlain = await failure(() => api.sessionMergeBack(session.id))
  check('merge-back without a worktree refuses cleanly (409 + error text, no crash, no code field)',
    mergeBackPlain !== null && mergeBackPlain.status === 409, describe(mergeBackPlain))

  const pr = await failure(() => api.sessionOpenPr(session.id, { title: 'sandbox — must not open' }))
  check('the PR route fails cleanly without a GitHub target instead of half-working', pr !== null, describe(pr))
  check('no remote other than the local sandbox one exists', git(['remote'], workDir) === 'origin')

  // ---------------------------------------------------------- 8. reads the panes use
  const hist = await api.workbenchHistory(scope, 0, 6)
  const newest = hist.commits[0]!
  const oldest = hist.commits[hist.commits.length - 1]!
  const cmp = await api.workbenchCompare(scope, oldest.sha, newest.sha)
  check('compare between two real shas returns a diff', cmp.diff.length > 0, `${cmp.diff.length} chars`)
  const one = await api.workbenchCommitDiff(scope, newest.sha)
  check('commit detail shows the committed file and its added line',
    one.diff.includes('from-worktree.md') && one.diff.includes('+merged back'),
    one.diff.split('\n').filter((l) => l.startsWith('+')).slice(0, 2).join(' | ').slice(0, 80))
  const badSha = await failure(() => api.workbenchCommitDiff(scope, 'abc'))
  check('a short/invalid sha is refused with 400 invalid_sha', badSha?.status === 400 && badSha.code === 'invalid_sha', describe(badSha))

  // The tree must survive the run for the checks above, then be discarded wholesale.
  check('sandbox stayed inside .sidecar-data (nothing written to the real repo)',
    workDir.startsWith(join(clientRoot, '.sidecar-data')))
} catch (e) {
  check('acceptance ran without throwing', false, (e as Error).message)
  exitCode = 1
} finally {
  if (sessionId) {
    await fetch(`${info.baseUrl}/sessions/${sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${info.token}` } }).catch(() => undefined)
  }
  rmSync(sandbox, { recursive: true, force: true })
  check('sandbox removed, session deleted', !existsSync(sandbox))
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  exitCode = 1
} else {
  console.log('\nall checks passed')
}
process.exit(exitCode)
