import { useMemo, useState } from 'react'
import { useT, type Translator } from '@tianshu/locale'
import { SEARCH_MIN_QUERY, type SessionRecord, type SessionSearchHit } from '@tianshu/client-core'
import { groupSessionsByProject, SYNTH_PROJECT_KEY } from './projects.ts'

export interface SessionListProps {
  sessions: readonly SessionRecord[]
  openSessionId: string | null
  includeArchived: boolean
  onToggleArchived: (on: boolean) => void
  onOpen: (id: string) => void
  onCreate: () => void
  onArchive: (id: string) => void
  /** Only offered on rows the sidecar marks `archived` — the row swaps its action, not its layout. */
  onUnarchive: (id: string) => void
  onRename: (id: string, title: string) => void
  /** Full-text query over event bodies (see client-core searchSessions). */
  query: string
  onQueryChange: (q: string) => void
  /** null = no search has run yet; array = results to show instead of the plain list. */
  hits: readonly SessionSearchHit[] | null
  /** A query is in flight — must be shown as such, never as "no matches". */
  searchPending?: boolean
  /** Transcripts the sidecar actually read; null when no request went out. */
  searchScanned?: number | null
  /** The query is shorter than the sidecar accepts — say so instead of "no matches". */
  searchTooShort?: boolean
}

/**
 * Two levels, as the approved drawing has it: a project header (its `.prow`) over the recent
 * conversations (its `.srow`s). Grouping is derived in `projects.ts` from the cwd each session
 * record already carries — the sidecar has no project concept.
 *
 * Rows show `pendingApprovals` because a session waiting on a decision is not
 * "running" — without this the sidebar lies about what needs attention (the
 * silent-hang failure mode the plan calls out for OpenCode #16367).
 */
export function SessionList({
  sessions, openSessionId, includeArchived, onToggleArchived, onOpen, onCreate, onArchive, onUnarchive,
  onRename, query, onQueryChange, hits, searchPending = false, searchScanned = null, searchTooShort = false,
}: SessionListProps) {
  const t = useT()
  const searching = query.trim().length > 0
  const groups = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const hitRows = searching
    ? (hits ?? []).map((h) => (
      <div
        key={h.sessionId}
        className={`us__row${h.sessionId === openSessionId ? ' us__row--sel' : ''}`}
        onClick={() => onOpen(h.sessionId)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onOpen(h.sessionId) }}
      >
        <div className="us__title">{h.title || h.sessionId.slice(0, 12)}</div>
        <div className="us__snippet">{h.snippet}</div>
      </div>
    ))
    : null

  return (
    <nav className="us">
      <div className="us__brand">
        <span className="us__mark" aria-hidden="true">{t('app.brandMark')}</span>
        <b>{t('app.brand')}</b>
        <span>client</span>
      </div>
      <button className="us__new" onClick={onCreate}>{t('session.new')}</button>
      <input
        className="us__search"
        type="search"
        value={query}
        placeholder={t('session.searchPlaceholder')}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <label className="us__filter">
        <input type="checkbox" checked={includeArchived} onChange={(e) => onToggleArchived(e.target.checked)} />
        {t('session.showArchived')}
      </label>
      <div className="us__list">
        {hitRows}
        {!searching && groups.map((g) => (
          <section className="us__group" key={g.key}>
            <button
              className={`us__proj${collapsed.has(g.key) ? ' us__proj--collapsed' : ''}`}
              title={g.cwd ?? undefined}
              aria-expanded={!collapsed.has(g.key)}
              onClick={() => setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(g.key)) next.delete(g.key)
                else next.add(g.key)
                return next
              })}
            >
              <span className="us__proj-mark" aria-hidden="true">{(g.key === SYNTH_PROJECT_KEY ? t('session.noProject') : g.name).slice(0, 1).toUpperCase()}</span>
              <span className="us__proj-name">{g.key === SYNTH_PROJECT_KEY ? t('session.noProject') : g.name}</span>
              <span className="us__proj-count">{g.sessions.length}</span>
              <span className="us__proj-caret" aria-hidden="true" />
            </button>
            {!collapsed.has(g.key) && g.sessions.map((s) => (
              <div
                key={s.id}
                className={`us__row${s.id === openSessionId ? ' us__row--sel' : ''}`}
                onClick={() => onOpen(s.id)}
                role="button"
                tabIndex={0}
                title={statusLabel(t, s.status)}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpen(s.id) }}
              >
                {/* One line, like the drawing's `.srow`: 16px slot for the status dot, ellipsised
                    title, then the right-hand readouts. The textual status label moved into the
                    row's `title` because a second line is exactly what the drawing does not have —
                    the dot keeps carrying colour, and `pendingApprovals` stays visible, since a
                    session waiting on a human decision must never read as merely "running". */}
                <span className="us__slot" aria-hidden="true"><span className={`us__dot us__dot--${s.status}`} /></span>
                <div className="us__title">{s.title || s.id.slice(0, 12)}</div>
                {s.worktreeBranch && <span className="us__branch">{s.worktreeBranch}</span>}
                {s.pendingApprovals > 0 && <span className="us__badge">{t('session.pendingApprovals', { count: s.pendingApprovals })}</span>}
                <button
                  className="us__rename"
                  title={t('session.rename')}
                  onClick={(e) => {
                    e.stopPropagation()
                    const next = window.prompt(t('session.renamePrompt'), s.title ?? '')
                    if (next !== null && next.trim()) onRename(s.id, next.trim())
                  }}
                >
                  ✎
                </button>
                <button
                  className="us__archive"
                  title={t(s.archived ? 'session.unarchive' : 'session.archive')}
                  onClick={(e) => { e.stopPropagation(); if (s.archived) onUnarchive(s.id); else onArchive(s.id) }}
                >
                  {/* Same slot, same style; the glyph is the whole difference. An archived row's
                      only missing affordance was the way back — the sidebar could already show
                      them (`显示已归档`), but once shown they were a dead end. */}
                  {s.archived ? '↩' : '✕'}
                </button>
              </div>
            ))}
          </section>
        ))}
        {searching && searchPending && <div className="us__empty">{t('session.searchPending')}</div>}
        {searching && !searchPending && searchTooShort && (
          <div className="us__empty">{t('session.searchTooShort', { count: SEARCH_MIN_QUERY })}</div>
        )}
        {searching && !searchPending && !searchTooShort && (hits ?? []).length === 0 && (
          <div className="us__empty">
            {t('session.noBodyMatch')}{' '}
            {/* 这条路径是实测出来的：搜索用 `sessionsDir(cwd)/<id>.jsonl`（内核 session-search.ts:114），
                而写入侧把每个会话存成 `<id>/` 目录（`<id>/events.jsonl`、`<id>/ui-history.jsonl`）。
                两边不一致，所以正文查不到——这句不是猜测，是本轮在隔离 sidecar 里发一条无 key prompt
                后 `search` 三连 0 命中、而 `GET /events` 明明读回那句用户正文测出来的。 */}
            <code>{'.rivet/sessions/<slug>/<id>.jsonl'}</code>{' '}
            {searchScanned === null
              ? t('session.searchNoteUnknown')
              : t('session.searchNoteScanned', { count: searchScanned })}
            {' '}{t('session.searchNoteRuntime')}
          </div>
        )}
        {!searching && sessions.length === 0 && <div className="us__empty">{t('session.empty')}</div>}
      </div>
    </nav>
  )
}

function statusLabel(t: Translator, status: SessionRecord['status']): string {
  switch (status) {
    case 'idle': return t('session.statusIdle')
    case 'running': return t('session.statusRunning')
    case 'completed': return t('session.statusCompleted')
    case 'failed': return t('session.statusFailed')
    case 'aborted': return t('session.statusAborted')
    case 'interrupted': return t('session.statusInterrupted')
    default: return status
  }
}
