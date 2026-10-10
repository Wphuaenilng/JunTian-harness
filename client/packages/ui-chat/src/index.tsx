import { memo, useEffect, useRef, useState } from 'react'
import { AppFrame, DiffBlock, MarkdownBlock, ToolOutputBlock, diffStats, looksLikeHtmlDocument, looksLikePatch, parseUnifiedDiff } from '@tianshu/ui-primitives'
import { type Block, type SidecarClient } from '@tianshu/client-core'
import { loadBefore, resolveAsk, type BeforeState } from './before-view.ts'
import { useT } from '@tianshu/locale'

export { ContextPanel, type ContextPanelProps } from './context-panel.tsx'

export interface ChatStreamProps {
  blocks: readonly Block[]
  running: boolean
  /** Present only when replay_window says the on-disk log has a head we don't hold. */
  onLoadEarlier?: (() => void) | undefined
  loadingEarlier?: boolean
  /**
   * `api` + `sessionId` + `cwd` together switch on the before-view (Cline 三件套, plan
   * §2.3). Optional because the M0 spike renders the same stream without a sidecar
   * client at all.
   */
  api?: SidecarClient | undefined
  sessionId?: string | undefined
  cwd?: string | null
  /** Resolved light/dark, forwarded to an embedded frame over the bridge. */
  theme?: 'light' | 'dark' | undefined
}

/**
 * Auto-follow the tail, but stop yanking the viewport down as soon as the reader
 * scrolls up — a stream that fights your scroll position is unreadable.
 */
export function ChatStream({ blocks, running, onLoadEarlier, loadingEarlier = false, api, sessionId, cwd = null, theme }: ChatStreamProps) {
  const t = useT()
  const host = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const onScroll = (): void => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = host.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [blocks])

  return (
    <div className="uc" ref={host}>
      <div className="uc__col">
        {onLoadEarlier && (
          <div className="uc__earlier">
            <button onClick={onLoadEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? t('chat.loading') : t('chat.loadEarlier')}
            </button>
          </div>
        )}
        {blocks.map((b) => <BlockView key={b.id} block={b} api={api} sessionId={sessionId} cwd={cwd} theme={theme} />)}
        {running && blocks.length === 0 && <div className="uc__pending">{t('chat.pending')}</div>}
      </div>
    </div>
  )
}

type ToolBlock = Extract<Block, { kind: 'tool' }>
type Ctx = { api?: SidecarClient | undefined; sessionId?: string | undefined; cwd?: string | null; theme?: 'light' | 'dark' | undefined }

// Subscribing per block rather than threading `t` down means memo() still short-circuits
// on unchanged blocks, and a language flip reaches every block that is memoised out.
const BlockView = memo(function BlockView({ block, ...ctx }: { block: Block } & Ctx) {
  const t = useT()
  switch (block.kind) {
    case 'user':
      return <div className="uc__row"><div className="uc__bubble">{block.text}</div></div>
    case 'text':
      return <div className="uc__row"><MarkdownBlock id={block.id} source={block.text} open={block.open} /></div>
    case 'thinking':
      return (
        <div className="uc__row">
          <details className="uc__think" open={block.open}>
            <summary>{block.open ? t('chat.thinking') : t('chat.thinkingDone')}</summary>
            <div className="uc__think-body">{block.text}</div>
          </details>
        </div>
      )
    case 'tool':
      return (
        <div className="uc__row">
          <div className={`uc__tool${block.open ? ' uc__tool--pending' : ''}`}>
            <div className="uc__tool-head">
              <span className="uc__tool-name">{block.name || t('chat.toolUnnamed')}</span>
              {block.isError && <span className="uc__tool-err">{t('chat.toolFailed')}</span>}
              {block.open && <span className="uc__tool-run">{t('chat.toolRunning')}</span>}
            </div>
            {Object.keys(block.input).length > 0 && (
              <pre className="uc__tool-input">{preview(block.input)}</pre>
            )}
            {block.uiContent !== undefined && looksLikeHtmlDocument(block.uiContent)
              ? <AppCard html={block.uiContent} theme={ctx.theme} sessionId={ctx.sessionId} />
              : <ToolDiff block={block} {...ctx} />}
            {block.result && <p className="uc__tool-note">{block.result}</p>}
          </div>
        </div>
      )
    case 'error':
      return (
        <div className="uc__row">
          <div className="uc__error">
            <div className="uc__error-title">{block.errorKind ? `${block.errorKind} · ` : ''}{t('chat.error')}</div>
            <div className="uc__error-body">{block.text}</div>
            {block.guidance && <div className="uc__error-guide">{block.guidance}</div>}
          </div>
        </div>
      )
    case 'turn':
      return block.truncated ? <div className="uc__divider">{t('chat.turnTruncated')}</div> : null
    default:
      return null
  }
})

/**
 * The three pieces, adapted to what this wire actually carries:
 *
 * 1. intent — `tool_use.input` arrives complete (there is no input-delta event among
 *    the 56 protocol types, so per-token patch streaming is not reachable without
 *    touching the kernel, which is a plan non-goal). While the call is open the card
 *    shows what is *about* to land, with a pending accent on the card itself.
 * 2. fact — `tool_result.uiContent` carries the real unified diff; the prose receipt
 *    never does. `outputTruncated` is the server's own 2000-char flag.
 * 3. before-view — `GET /sessions/:id/git/file-base?path=`, asked lazily on open and
 *    only for a single-file mutator whose path is inside the session cwd.
 */
/**
 * A tool result that is an HTML document, not text about one (MCP Apps 预留). The frame
 * is sandboxed by `AppFrame`; the source stays one click away because an embed a reader
 * cannot inspect is not an honest embed.
 */
function AppCard({ html, theme, sessionId }: { html: string; theme?: 'light' | 'dark' | undefined; sessionId?: string | undefined }) {
  const t = useT()
  return (
    <div className="uc__app">
      <AppFrame html={html} label={t('chat.appFrame')} theme={theme} {...(sessionId ? { sessionId } : {})} />
      <details className="uc__app-src">
        <summary>{t('chat.appSource')}</summary>
        <pre className="uc__intent-body">{html.slice(0, 20_000)}</pre>
      </details>
    </div>
  )
}

function ToolDiff({ block, api, sessionId, cwd }: { block: ToolBlock } & Ctx) {
  const t = useT()
  const [before, setBefore] = useState<BeforeState | null>(null)

  const ask = resolveAsk(api, sessionId, block.filePath, cwd)
  const patch = block.uiContent !== undefined && looksLikePatch(block.uiContent) ? block.uiContent : null
  const stats = patch ? diffStats(parseUnifiedDiff(patch)) : null
  const intent = block.open ? intentText(block.input) : null

  if (!ask && !patch && !intent) {
    // Nothing to decorate. A non-file tool (bash, read_file) stays exactly as before.
    return block.uiContent ? <ToolOutputBlock text={block.uiContent} /> : null
  }

  return (
    <div className="uc__diffwrap">
      {intent && (
        <div className="uc__intent">
          <div className="uc__diff-head">{t('chat.diffIntent')}</div>
          <pre className="uc__intent-body">{intent.slice(0, 2000)}</pre>
        </div>
      )}
      {patch && (
        <div className="uc__landed">
          <div className="uc__diff-head">
            <span>{t('chat.diffLanded')}</span>
            <span className="uc__diff-stats">+{stats?.added ?? 0} −{stats?.removed ?? 0}</span>
          </div>
          <DiffBlock patch={patch} />
          {block.truncated && <p className="uc__diff-warn">{t('chat.diffTruncated')}</p>}
        </div>
      )}
      {!patch && block.uiContent && <ToolOutputBlock text={block.uiContent} />}
      {ask && (
        <details
          className="uc__before"
          onToggle={(e) => {
            if (e.currentTarget.open && before === null) void loadBefore(ask, setBefore)
          }}
        >
          <summary>{t('chat.beforeView')}</summary>
          {!before && <p className="uc__before-note">{t('chat.beforeLoading')}</p>}
          {before?.state === 'failed' && <p className="uc__before-error">{t('chat.beforeFailed', { message: before.message })}</p>}
          {before?.state === 'new' && <p className="uc__before-note">{t('chat.beforeNewFile')}</p>}
          {before?.state === 'text' && <pre className="uc__before-body">{before.text.slice(0, 20_000)}</pre>}
        </details>
      )}
    </div>
  )
}

/** What the model asked to write, before the runtime has run it. */
function intentText(input: Record<string, unknown>): string | null {
  for (const key of ['content', 'new_string', 'newText']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

function preview(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return s.length > 1500 ? `${s.slice(0, 1500)}\n…` : s
}
