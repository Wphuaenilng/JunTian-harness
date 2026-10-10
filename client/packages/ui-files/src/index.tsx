import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT, type LocaleKey } from '@tianshu/locale'
import type { SidecarClient, DirEntry } from '@tianshu/client-core'
import { ToolOutputBlock } from '@tianshu/ui-primitives'

export interface FileBrowserProps {
  api: SidecarClient
  sessionId: string | null
  /** Insert the picked path into the composer instead of only previewing it. */
  onPick?: (path: string) => void
}

const PREVIEW_LIMIT = 60_000

/**
 * Failures are kept as key + message rather than a formatted sentence, so flipping the
 * language re-renders an error that is already on screen instead of freezing it in
 * whichever language it happened to arrive in.
 */
type Failure = { key: LocaleKey; message: string }

/**
 * Workspace browser over the session's own endpoints. The server does the gitignore
 * filtering and relevance ranking for search (`/files`), so this panel never
 * re-implements ignore rules — that is how a client ends up offering files the agent
 * cannot see.
 */
export function FileBrowser({ api, sessionId, onPick }: FileBrowserProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly string[]>([])
  const [cwd, setCwd] = useState<readonly DirEntry[]>([])
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [truncated, setTruncated] = useState(false)
  // The first query per session cold-scans the tree and can take over a second
  // (measured: empty at 1.5s, 20 hits at 4s). "No matches" before the answer arrives
  // is a lie users act on, so the in-flight state is rendered distinctly.
  const [searching, setSearching] = useState(false)

  // Unquoted search lists the session's directory tree; a query switches to ranked
  // file candidates. Both are the same endpoint with different shapes, so keep the
  // modes explicit rather than guessing from the response length.
  const loadDir = useCallback(() => {
    if (!sessionId) return
    void api.listDir(sessionId, path)
      .then((d) => { setCwd(d.entries); setError(null) })
      .catch((e: Error) => setError({ key: 'files.listFailed', message: e.message }))
  }, [api, path, sessionId])

  useEffect(loadDir, [loadDir])

  useEffect(() => {
    if (!sessionId || !query.trim()) { setHits([]); setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(() => {
      void api.listFiles(sessionId, query.trim())
        .then((f) => { setHits(f); setSearching(false) })
        .catch((e: Error) => { setError({ key: 'files.searchFailed', message: e.message }); setSearching(false) })
    }, 200)
    return () => clearTimeout(timer)
  }, [api, query, sessionId])

  const open = useCallback((file: string): void => {
    if (!sessionId) return
    void api.fileContent(sessionId, file)
      .then((f) => {
        setTruncated(f.content.length > PREVIEW_LIMIT)
        setPreview({ path: f.path, content: f.content.slice(0, PREVIEW_LIMIT) })
        setError(null)
      })
      .catch((e: Error) => setError({ key: 'files.previewFailed', message: e.message }))
  }, [api, sessionId])

  const parentOf = useMemo(() => {
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    return parts.join('/')
  }, [path])

  if (!sessionId) return <div className="fl__empty">{t('files.selectSessionFirst')}</div>

  return (
    <div className="fl">
      <input
        className="fl__search"
        type="search"
        value={query}
        placeholder={t('files.searchPlaceholder')}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className="fl__error">{t(error.key, { message: error.message })}</div>}

      {query.trim() ? (
        <ul className="fl__list">
          {hits.map((f) => (
            <li key={f}>
              <button className="fl__file" onClick={() => open(f)}>{f}</button>
              {onPick && <button className="fl__pick" title={t('files.insertToComposer')} onClick={() => onPick(f)}>＋</button>}
            </li>
          ))}
          {searching && <li className="fl__empty">{t('files.searchPending')}</li>}
          {!searching && hits.length === 0 && <li className="fl__empty">{t('files.noMatch')}</li>}
        </ul>
      ) : (
        <>
          <div className="fl__crumb">
            {path ? (
              <button className="fl__up" onClick={() => setPath(parentOf)}>{t('files.parent', { path: parentOf || t('files.rootCrumb') })}</button>
            ) : <span className="fl__up">{t('files.workspaceRoot')}</span>}
            <code>{path || '.'}</code>
          </div>
          <ul className="fl__list">
            {cwd.map((e) => (
              <li key={e.name}>
                {e.isDirectory
                  ? <button className="fl__dir" onClick={() => setPath(path ? `${path}/${e.name}` : e.name)}>▸ {e.name}/</button>
                  : (
                    <>
                      <button className="fl__file" onClick={() => open(path ? `${path}/${e.name}` : e.name)}>{e.name}</button>
                      {onPick && <button className="fl__pick" title={t('files.insertToComposer')} onClick={() => onPick(path ? `${path}/${e.name}` : e.name)}>＋</button>}
                    </>
                  )}
              </li>
            ))}
          </ul>
        </>
      )}

      {preview && (
        <div className="fl__preview">
          <div className="fl__preview-head">
            <code>{preview.path}</code>
            <button className="fl__close" onClick={() => setPreview(null)}>✕</button>
          </div>
          {/* Reuse the terminal block: file content is exactly the "not a patch, show
              it raw" case, and line endings come back as stored (CRLF preserved). */}
          <ToolOutputBlock text={preview.content} />
          {truncated && <p className="fl__note">{t('files.previewTruncated', { kb: Math.round(PREVIEW_LIMIT / 1000) })}</p>}
        </div>
      )}
    </div>
  )
}
