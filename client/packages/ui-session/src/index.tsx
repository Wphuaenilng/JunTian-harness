import { useT, type Translator } from '@tianshu/locale'
import type { SessionRecord, SessionSearchHit } from '@tianshu/client-core'

export interface SessionListProps {
  sessions: readonly SessionRecord[]
  openSessionId: string | null
  includeArchived: boolean
  onToggleArchived: (on: boolean) => void
  onOpen: (id: string) => void
  onCreate: () => void
  onArchive: (id: string) => void
  onRename: (id: string, title: string) => void
  /** Full-text query over event bodies (see client-core searchSessions). */
  query: string
  onQueryChange: (q: string) => void
  /** null = no search has run yet; array = results to show instead of the plain list. */
  hits: readonly SessionSearchHit[] | null
  /** A query is in flight — must be shown as such, never as "no matches". */
  searchPending?: boolean
}

/**
 * Rows show `pendingApprovals` because a session waiting on a decision is not
 * "running" — without this the sidebar lies about what needs attention (the
 * silent-hang failure mode the plan calls out for OpenCode #16367).
 */
export function SessionList({
  sessions, openSessionId, includeArchived, onToggleArchived, onOpen, onCreate, onArchive,
  onRename, query, onQueryChange, hits, searchPending = false,
}: SessionListProps) {
  const t = useT()
  const searching = query.trim().length > 0
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
        {!searching && sessions.map((s) => (
          <div
            key={s.id}
            className={`us__row${s.id === openSessionId ? ' us__row--sel' : ''}`}
            onClick={() => onOpen(s.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(s.id) }}
          >
            <div className="us__title">{s.title || s.id.slice(0, 12)}</div>
            <div className="us__meta">
              <span className={`us__dot us__dot--${s.status}`} />
              <span>{statusLabel(t, s.status)}</span>
              {s.pendingApprovals > 0 && <span className="us__badge">{t('session.pendingApprovals', { count: s.pendingApprovals })}</span>}
              {s.worktreeBranch && <span className="us__branch">{s.worktreeBranch}</span>}
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
                title={t('session.archive')}
                onClick={(e) => { e.stopPropagation(); onArchive(s.id) }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        {searching && searchPending && <div className="us__empty">{t('session.searchPending')}</div>}
        {searching && !searchPending && (hits ?? []).length === 0 && (
          <div className="us__empty">
            {t('session.noBodyMatch')}{' '}<strong>{t('session.searchScansProjectLocal')}</strong>{' '}
            {/* The path stays verbatim in both languages — translating a filename breaks the hint. */}
            <code>{'.rivet/sessions/<id>.jsonl'}</code> {t('session.searchNote')}
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
