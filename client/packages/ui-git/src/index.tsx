import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT, type LocaleKey } from '@tianshu/locale'
import {
  SidecarError,
  localBranches,
  type BranchInfo,
  type GitChange,
  type GitScope,
  type RewindPoint,
  type SidecarClient,
  type WorkbenchSnapshot,
  type CommitEntry,
} from '@tianshu/client-core'
import { DiffBlock, diffStats, parseUnifiedDiff } from '@tianshu/ui-primitives'

export interface CheckpointPanelProps {
  api: SidecarClient
  sessionId: string | null
  /** Called after a rewind lands, so the host can re-open the truncated session. */
  onRewound?: () => void
}

/** Kept as key + raw message so an on-screen error re-renders when the language flips. */
type Failure = { key: LocaleKey; message: string; code?: string }

/**
 * Shadow checkpoint timeline (plan §2.3, Cline row). The kernel already takes the
 * checkpoints and owns the rollback — this panel only surfaces them and addresses a
 * rewind, which is why there is no client-side snapshot logic to drift.
 *
 * Rewind is destructive (it truncates the conversation, and optionally the working
 * tree), so it is two explicit steps: select → confirm. Nothing here fires on click
 * alone, and `rollbackFiles` is opt-in rather than implied.
 */
export function CheckpointPanel({ api, sessionId, onRewound }: CheckpointPanelProps) {
  const t = useT()
  const [points, setPoints] = useState<readonly RewindPoint[]>([])
  const [error, setError] = useState<Failure | null>(null)
  const [pending, setPending] = useState<RewindPoint | null>(null)
  const [rollbackFiles, setRollbackFiles] = useState(false)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    if (!sessionId) { setPoints([]); return }
    void api.rewindPoints(sessionId)
      .then((p) => { setPoints(p); setError(null) })
      .catch((e: Error) => setError({ key: 'git.loadPointsFailed', message: e.message }))
  }, [api, sessionId])

  useEffect(reload, [reload])

  const confirmRewind = async (): Promise<void> => {
    if (!sessionId || !pending) return
    setBusy(true); setError(null)
    try {
      await api.rewind(sessionId, pending.index, rollbackFiles)
      setPending(null)
      onRewound?.()
      reload()
    } catch (e) {
      setError({ key: 'git.rewindFailed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (!sessionId) return <div className="ckp__empty">{t('git.selectSessionFirst')}</div>

  return (
    <div className="ckp">
      <div className="ckp__head">
        <h4>{t('git.checkpointTitle')}</h4>
        <button className="ckp__mini" onClick={reload} disabled={busy}>{t('git.refresh')}</button>
      </div>
      {error && <div className="ckp__error">{t(error.key, { message: error.message })}</div>}
      {points.length === 0 && !error && (
        <p className="ckp__empty">
          {t('git.noCheckpoints')}{' '}<code>config.checkpointEveryTurns</code> {t('git.checkpointCadence')}
        </p>
      )}
      <ol className="ckp__list">
        {points.map((p) => (
          <li key={`${p.index}-${p.seq}`} className={`ckp__item${pending?.index === p.index ? ' ckp__item--pending' : ''}`}>
            <div className="ckp__meta">
              <span>#{p.index}</span>
              <span>seq {p.seq}</span>
              <span>{new Date(p.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="ckp__content">{p.content.slice(0, 160)}</div>
            {pending?.index === p.index ? (
              <div className="ckp__confirm">
                <label>
                  <input type="checkbox" checked={rollbackFiles} onChange={(e) => setRollbackFiles(e.target.checked)} />
                  {t('git.rollbackFiles')}
                </label>
                <div className="ckp__actions">
                  <button className="ckp__btn ckp__btn--danger" disabled={busy} onClick={() => void confirmRewind()}>
                    {busy ? t('git.rewinding') : t('git.rewindConfirm', { index: p.index })}
                  </button>
                  <button className="ckp__btn" disabled={busy} onClick={() => setPending(null)}>{t('git.cancel')}</button>
                </div>
              </div>
            ) : (
              <button className="ckp__btn" disabled={busy} onClick={() => setPending(p)}>{t('git.rewindTo')}</button>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function statusChars(c: GitChange): string {
  return `${c.index || ' '}${c.worktree || ' '}${c.conflict ? '!' : ''}`
}

/**
 * Porcelain writes a *space* in the column that does not apply, so "not staged" arrives
 * as `' '`, not `''` — measured against the real workbench (unstaged edit = " M", staged
 * = "M "). Testing `!== ''` treats every file as staged and offers to unstage changes
 * that were never staged.
 */
function isStaged(c: GitChange): boolean {
  return c.index.trim() !== ''
}

/**
 * The server's machine-readable reason → a localized sentence. Branching on `code`
 * rather than the message text is deliberate: the message is the kernel's Chinese
 * presentation and is free to change; `code` is its contract (git-workbench.ts:7-9).
 */
const ERROR_KEYS: Record<string, LocaleKey> = {
  stale_snapshot: 'git.errStale',
  dirty_workspace: 'git.errDirty',
  sensitive_file: 'git.errSensitive',
  confirmation_required: 'git.errConfirm',
  empty_message: 'git.errEmptyMessage',
  empty_index: 'git.errEmptyIndex',
  invalid_hunk: 'git.errHunk',
  file_missing: 'git.errMissing',
  invalid_remote: 'git.errRemote',
  invalid_branch: 'git.errBranchName',
  invalid_ref: 'git.errRemote',
  invalid_sha: 'git.errSha',
  invalid_path: 'git.errWorkspace',
  unknown_workspace: 'git.errWorkspace',
  session_missing: 'git.errSession',
  context_missing: 'git.errWorkspace',
  non_repository: 'git.errNotRepo',
  git_failed: 'git.errGit',
}

function toFailure(e: unknown): Failure {
  const se = e instanceof SidecarError ? e : null
  const code = se?.code
  const key = code !== undefined ? ERROR_KEYS[code] ?? 'git.errGeneric' : 'git.errGeneric'
  return { key, message: (e as Error).message, ...(code !== undefined ? { code } : {}) }
}

/** A read that failed for no stated reason is a load failure, not a generic one. */
function readFailure(e: unknown, fallbackKey: LocaleKey): Failure {
  const f = toFailure(e)
  return f.code !== undefined ? f : { ...f, key: fallbackKey }
}

export interface GitPanelProps {
  api: SidecarClient
  sessionId: string | null
  cwd: string | null
  /** The session record knows whether it owns an isolated worktree branch. */
  canMergeBack?: boolean
}

/**
 * Workbench over the session's repository — reads and writes.
 *
 * Every write echoes `repository.version`, the optimistic lock over
 * head+branch+index+status (git-workbench.ts:92-100). Three rules fall out of that and
 * are not negotiable in the UI:
 *   - a 409 `stale_snapshot` re-reads the tree and **asks again**; it never auto-retries,
 *     because "the repository moved" usually means the user has to look again too;
 *   - `porcelain` puts a *space*, not an empty string, in the column that does not apply
 *     (`isStaged`), so an unstaged edit is `" M"` and a staged one is `"M "`;
 *   - anything that mutates the working tree — including the runtime seeding
 *     `.rivet/skills/**` into a session cwd — changes the version and counts as dirt, so
 *     the branch/sync guards fire on it; the panel states the kernel's reason instead of
 *     working around it.
 */
export function GitPanel({ api, sessionId, cwd, canMergeBack = false }: GitPanelProps) {
  const t = useT()
  const [snap, setSnap] = useState<WorkbenchSnapshot | null>(null)
  const [commits, setCommits] = useState<readonly CommitEntry[]>([])
  const [branches, setBranches] = useState<readonly BranchInfo[]>([])
  const [error, setError] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [patch, setPatch] = useState('')
  const [hunkCount, setHunkCount] = useState(0)
  const [message, setMessage] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [remote, setRemote] = useState('')
  const [confirmPush, setConfirmPush] = useState(false)
  const [busy, setBusy] = useState(false)

  const scope: GitScope | null = cwd ? { cwd } : sessionId ? { sessionId } : null
  const staged = useMemo(() => (snap?.changes ?? []).filter(isStaged), [snap])
  const clean = (snap?.changes ?? []).length === 0

  const reload = useCallback((): void => {
    if (!scope) { setSnap(null); setCommits([]); setBranches([]); return }
    void Promise.all([api.workbenchSnapshot(scope), api.workbenchHistory(scope, 0, 8), api.workbenchBranches(scope)])
      .then(([s, h, b]) => {
        setSnap(s)
        setCommits(h.commits)
        setBranches(b.branches)
        if (!remote && s.repository.remotes[0]) setRemote(s.repository.remotes[0].name)
      })
      .catch((e: unknown) => setError(readFailure(e, 'git.loadRepoFailed')))
  }, [api, remote, scope])

  useEffect(reload, [reload])

  /** Run one write, then re-read. A stale lock also re-reads so the next click is valid. */
  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    if (!scope) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await fn()
      setNotice(t('git.wroteOk', { label }))
      reload()
    } catch (e) {
      setError(toFailure(e))
      reload()
    } finally {
      setBusy(false)
    }
  }

  const openDiff = (path: string): void => {
    if (!scope) return
    setSelected(path)
    setPatch('')
    void api.workbenchDiff(scope, path)
      .then((d) => {
        setPatch(d.diff)
        // Same split the server uses for its hunk index (git-workbench-routes.ts:59),
        // so "stage hunk 2" here means exactly hunk 2 there.
        setHunkCount(d.diff.split(/(?=^@@ )/m).length - 1)
      })
      .catch((e: unknown) => setError(readFailure(e, 'git.diffFailed')))
  }

  if (!scope) return <div className="ckp__empty">{t('git.selectSessionFirst')}</div>
  const version = snap?.repository.version ?? ''
  const stats = patch ? diffStats(parseUnifiedDiff(patch)) : null

  return (
    <div className="wb">
      <div className="ckp__head">
        <h4>{t('git.repo')}</h4>
        <button className="ckp__mini" onClick={reload} disabled={busy}>{t('git.refresh')}</button>
      </div>
      {error && (
        <div className="ckp__error ckp__error--write">
          <div>{t(error.key, { message: error.message })}</div>
          {error.code && <code className="wb__code">{error.code}</code>}
        </div>
      )}
      {notice && <div className="wb__ok">{notice}</div>}
      {snap && (
        <div className="wb__repo">
          <div className="wb__line"><span>{t('git.branch')}</span><code>{snap.repository.branch || t('git.detached')}</code></div>
          <div className="wb__line"><span>{t('git.head')}</span><code>{snap.repository.head?.slice(0, 8) ?? '—'}</code></div>
          <div className="wb__line"><span>{t('git.upstream')}</span><code>{snap.repository.upstream ?? '—'} · ↑{snap.repository.ahead} ↓{snap.repository.behind}</code></div>
          <div className="wb__line"><span>{t('git.state')}</span><code>{snap.repository.state}</code></div>
        </div>
      )}

      <h5 className="wb__sub">{t('git.changes')} {snap ? t('git.stagedCount', { staged: staged.length, total: snap.changes.length }) : ''}</h5>
      <ul className="wb__changes">
        {(snap?.changes ?? []).slice(0, 300).map((c) => (
          <li key={c.path} className={`wb__row${selected === c.path ? ' wb__row--on' : ''}`}>
            <button className="wb__change" onClick={() => openDiff(c.path)}>
              <code className="wb__status">{statusChars(c)}</code>
              <span className="wb__path">{c.path}</span>
            </button>
            <button
              className="ckp__mini"
              disabled={busy || !version}
              onClick={() => void run(c.path, () => api.workbenchStage(scope, { path: c.path, ...(isStaged(c) ? { unstage: true } : {}) }, version))}
            >
              {isStaged(c) ? t('git.unstageFile') : t('git.stageFile')}
            </button>
          </li>
        ))}
        {snap && snap.changes.length === 0 && <li className="ckp__empty">{t('git.cleanTree')}</li>}
      </ul>

      {snap && snap.changes.length > 0 && (
        <div className="wb__commit">
          <input
            className="set__select wb__msg"
            type="text"
            value={message}
            placeholder={t('git.commitMsg')}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="ckp__btn"
            disabled={busy || staged.length === 0 || message.trim() === ''}
            title={t('git.commitBox')}
            onClick={() => void run('commit', () => api.workbenchCommit(scope, message.trim(), version))}
          >
            {t('git.commitNow', { count: staged.length })}
          </button>
        </div>
      )}

      {selected && (
        <div className="wb__diff">
          <div className="wb__diff-head">
            <code>{selected}</code>
            {stats && <span className="wb__stats">+{stats.added} −{stats.removed}</span>}
            <button className="fl__close" onClick={() => { setSelected(null); setPatch(''); setHunkCount(0) }}>✕</button>
          </div>
          {patch ? <DiffBlock patch={patch} /> : <p className="ckp__empty">{t('git.noDiff')}</p>}
          {hunkCount > 1 && (
            <div className="wb__hunks">
              {Array.from({ length: hunkCount }, (_, i) => (
                <button
                  key={i}
                  className="ckp__mini"
                  disabled={busy || !version}
                  onClick={() => void run(`hunk ${i}`, () => api.workbenchStage(scope, { path: selected, hunk: i }, version))}
                >
                  {t('git.stageHunk', { index: i })}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="wb__group">
        <h5 className="wb__sub">{t('git.branches')}</h5>
        <div className="wb__row">
          <select className="set__select" value="" disabled={busy || !clean} onChange={(e) => {
            const name = e.target.value
            if (name) void run(name, () => api.workbenchBranch(scope, { name }, version))
          }}>
            <option value="">{clean ? t('git.switchTo', { name: '…' }) : t('git.branchGuard')}</option>
            {localBranches(branches, snap?.repository.remotes ?? [])
              .filter((b) => b.name !== snap?.repository.branch)
              .map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
          </select>
        </div>
        <div className="wb__row">
          <input
            className="set__select wb__msg"
            type="text"
            value={newBranch}
            placeholder={t('git.newBranchName')}
            disabled={busy || !clean}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <button
            className="ckp__btn"
            disabled={busy || !clean || newBranch.trim() === ''}
            onClick={() => void run(newBranch.trim(), () => api.workbenchBranch(scope, { name: newBranch.trim(), create: true }, version))}
          >
            {t('git.createBranch')}
          </button>
        </div>
        {!clean && <p className="ckp__empty">{t('git.branchGuard')}</p>}
      </div>

      <div className="wb__group">
        <h5 className="wb__sub">{t('git.sync')}</h5>
        <div className="wb__row">
          <select className="set__select" value={remote} disabled={busy} onChange={(e) => setRemote(e.target.value)}>
            {snap?.repository.remotes.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
          <button className="ckp__mini" disabled={busy || !remote} onClick={() => void run('fetch', () => api.workbenchSync(scope, { remote, action: 'fetch' }, version))}>
            {t('git.fetch', { remote })}
          </button>
          <button className="ckp__mini" disabled={busy || !remote || !clean} onClick={() => void run('pull', () => api.workbenchSync(scope, { remote, action: 'pull', confirm: true }, version))}>
            {t('git.pull', { remote })}
          </button>
        </div>
        <label className="wb__confirm">
          <input type="checkbox" checked={confirmPush} onChange={(e) => setConfirmPush(e.target.checked)} />
          {t('git.confirmPush', { remote, ref: snap?.repository.branch ?? 'HEAD' })}
        </label>
        <button
          className="ckp__btn ckp__btn--danger"
          disabled={busy || !remote || !clean || !confirmPush}
          onClick={() => void run('push', () => api.workbenchSync(scope, { remote, action: 'push', ...(snap?.repository.branch ? { ref: snap.repository.branch } : {}), confirm: true }, version))}
        >
          {t('git.push', { remote })}
        </button>
      </div>

      {sessionId && (
        <div className="wb__group">
          <h5 className="wb__sub">{t('git.landing')}</h5>
          <div className="wb__row">
            <button
              className="ckp__mini"
              disabled={busy}
              title={t('git.sessionCommit')}
              onClick={() => void run('session commit', () => api.sessionCommit(sessionId, message.trim() || undefined))}
            >
              {t('git.sessionCommit')}
            </button>
            <button
              className="ckp__mini"
              disabled={busy || !canMergeBack}
              title={canMergeBack ? t('git.mergeBack') : t('git.mergeBackNeedsWorktree')}
              onClick={() => void run('merge-back', () => api.sessionMergeBack(sessionId))}
            >
              {t('git.mergeBack')}
            </button>
            <button
              className="ckp__mini"
              disabled={busy || message.trim() === ''}
              onClick={() => void run('pr', () => api.sessionOpenPr(sessionId, { title: message.trim() }))}
            >
              {t('git.openPr')}
            </button>
          </div>
          {!canMergeBack && <p className="ckp__empty">{t('git.mergeBackNeedsWorktree')}</p>}
        </div>
      )}

      <h5 className="wb__sub">{t('git.history')}</h5>
      <ul className="wb__hist">
        {commits.map((c) => (
          <li key={c.sha}>
            <code>{c.sha.slice(0, 8)}</code>
            <span className="wb__subject">{c.subject}</span>
            <span className="wb__when">{new Date(c.time * 1000).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
