import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import {
  SidecarClient,
  SessionModel,
  shouldOfferEarlier,
  PROTOCOL_VERSION,
  openSessionStream,
  openServerEvents,
  categorize,
  formatCockpit,
  isStalled,
  shouldArmStall,
  type CockpitSnapshot,
  type SessionRecord,
  type SessionSearchHit,
  type HealthBody,
  type ApprovalAnswerBody,
  type EventCategory,
  type StreamPhase,
} from '@tianshu/client-core'
import { SessionList } from '@tianshu/ui-session'
import { ChatStream, ContextPanel } from '@tianshu/ui-chat'
import { ApprovalPanel } from '@tianshu/ui-approval'
import { SettingsPanel } from '@tianshu/ui-settings'
import { CheckpointPanel, GitPanel } from '@tianshu/ui-git'
import { FileBrowser } from '@tianshu/ui-files'
import { AutomationBoard } from '@tianshu/ui-schedule'
import { createViewStore, setDraft, createFrameScheduler, loadView, attachViewPersistence, type RightTab } from '@tianshu/store'
import { applyTheme, resolvedTheme, storeTheme, readStoredTheme, watchSystemTheme, type ThemeMode } from '@tianshu/ui-theme'
import { cycleLocale, getLocale, translate, useT, type LocaleKey, type Translator } from '@tianshu/locale'

/** Same-origin: the proxy owns Authorization, so the browser never holds a token. */
const API_BASE = '/api'

const EMPTY_COUNTS: Record<EventCategory, number> = { lifecycle: 0, text: 0, tool: 0, state: 0, custom: 0 }

/** cockpit `compactionState` values that mean "nothing to report" (observed: ready, healthy). */
const CALM_COMPACTION_STATES = new Set(['ready', 'healthy', 'idle', 'none'])

const RAIL_TABS: Array<{ id: RightTab; labelKey: LocaleKey }> = [
  { id: 'settings', labelKey: 'app.tabSettings' },
  { id: 'context', labelKey: 'app.tabContext' },
  { id: 'checkpoints', labelKey: 'app.tabCheckpoints' },
  { id: 'git', labelKey: 'app.tabGit' },
  { id: 'automations', labelKey: 'app.tabAutomations' },
  { id: 'files', labelKey: 'app.tabFiles' },
]

/** Kept as key + raw message so an on-screen banner re-renders when the language flips. */
type Failure = { key: LocaleKey; message: string; seconds?: number }

/**
 * How long a send may sit with no event at all before the client says so. The kernel's
 * own loop-stall watchdog fires at 2s and only logs; a keyless `/prompt` answers
 * 200 `running` and then produces nothing at all, which the UI would otherwise render as
 * a healthy run forever. 20s is deliberately generous — slower than any real first token.
 */
const SEND_STALL_MS = 20_000
/** How often to re-ask for pending gates while a run is live (§7 兜底轮询). */
const APPROVAL_POLL_MS = 20_000

export function App() {
  const t = useT()
  const api = useMemo(() => new SidecarClient({ baseUrl: API_BASE, token: '' }), [])

  // View state lives in the store (plan §4.3 #4): open session, archived filter,
  // per-session composer drafts, connection readout. Message timelines do NOT — those
  // stay in SessionModel below.
  const view = useMemo(() => createViewStore(loadView()), [])

  // Write-back only when the persisted subset changes. A plain `subscribe(() => saveView())`
  // would write on every event: `view.setState({ lastSeq, generation })` runs per streamed
  // delta, zustand notifies regardless of which field moved, and localStorage is
  // synchronous — so an archived session replaying 50 events would block 50 times.
  useEffect(() => attachViewPersistence(view), [view])
  const openSessionId = useStore(view, (s) => s.openSessionId)
  const includeArchived = useStore(view, (s) => s.includeArchived)
  const connection = useStore(view, (s) => s.connection)
  const generation = useStore(view, (s) => s.generation)
  const lastSeq = useStore(view, (s) => s.lastSeq)
  const rightOpen = useStore(view, (s) => s.panels.right)
  const rightTab = useStore(view, (s) => s.rightTab)
  const draft = useStore(view, (s) => (s.openSessionId ? s.drafts[s.openSessionId] ?? '' : ''))

  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [health, setHealth] = useState<HealthBody | null>(null)
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [banner, setBanner] = useState<Failure | null>(null)
  // Search state is per-view and ephemeral, so it stays local rather than in the
  // view store (which holds the things that must survive a remount).
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly SessionSearchHit[] | null>(null)
  const [searchPending, setSearchPending] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme())
  // The concrete value painted into `data-theme`, held as state so a change re-renders
  // and reaches consumers outside the CSS cascade (an embedded MCP frame gets its theme
  // push from here). `theme` alone cannot do this job: mode 'system' stays 'system'.
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolvedTheme())
  // Cockpit is only answerable while an agent exists for the session (an archived or
  // never-run session 404s), so a failure is "no live cockpit" and not an error band.
  const [cockpit, setCockpit] = useState<CockpitSnapshot | null>(null)

  // Cycle system → light → dark. The boot script in index.html already painted the
  // stored value before first paint; this only keeps React's view of it in sync.
  const cycleTheme = useCallback(() => {
    const order: ThemeMode[] = ['system', 'light', 'dark']
    const idx = order.indexOf(readStoredTheme())
    const next = order[(idx + 1) % order.length] ?? 'system'
    storeTheme(next)
    applyTheme(next)
    setResolved(resolvedTheme())
    setTheme(next)
  }, [])

  // Mode 'system' is the one case where the painted value is not a function of React
  // state, so it needs the media query subscription — otherwise an OS dark-mode switch
  // restamps nothing and the embedded frames keep the old theme.
  useEffect(() => {
    if (theme !== 'system') return
    return watchSystemTheme(setResolved)
  }, [theme])

  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits(null); setSearchPending(false); return }
    setSearchPending(true)
    // Debounced: every keystroke hitting a disk-scanning endpoint is how search gets
    // blamed for a laggy sidebar.
    const timer = setTimeout(() => {
      void api.searchSessions(q)
        .then((r) => { setHits(r); setSearchPending(false) })
        .catch((e: Error) => { setBanner({ key: 'app.searchFailed', message: e.message }); setSearchPending(false) })
    }, 250)
    return () => clearTimeout(timer)
  }, [api, query])

  // The Session instance is state, not a ref: useSyncExternalStore must re-subscribe
  // when a different session's model takes over, and a ref swap would leave it
  // listening to the previous session forever.
  const [model, setModel] = useState(() => new SessionModel())
  const subscribe = useCallback((cb: () => void) => model.subscribe(cb), [model])
  const getSnapshot = useCallback(() => model.current, [model])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Offered only when the server's own replay_window says the disk log has a head we
  // were not given — never a guessed threshold.
  const offerEarlier = shouldOfferEarlier(state.snapshots.replay_window)

  // Cockpit reads live-agent state, so it is polled only while this session runs: an
  // archived or never-run session answers 404 (handled as "no live cockpit", not an error
  // band), and polling regardless turns idle browsing into a 404 storm — measured 17 of 39
  // requests in one pass over the panels.
  useEffect(() => {
    if (!openSessionId || !state.running) { setCockpit(null); return }
    let stopped = false
    const pull = (): void => {
      api.cockpit(openSessionId).then((c) => { if (!stopped) setCockpit(c) }).catch(() => {
        if (!stopped) setCockpit(null)
      })
    }
    pull()
    const timer = setInterval(pull, 10_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [api, openSessionId, state.running])
  const loadEarlier = useCallback(() => {
    if (!openSessionId) return
    const oldest = model.current.oldestSeq
    if (oldest <= 1) return
    setLoadingEarlier(true)
    void api.historyPage(openSessionId, oldest, 200)
      .then((page) => model.prependEvents(page.events))
      .catch((e: Error) => setBanner({ key: 'app.historyFailed', message: e.message }))
      .finally(() => setLoadingEarlier(false))
  }, [api, model, openSessionId])

  const refreshSessions = useCallback(async () => {
    try {
      const { includeArchived: showArchived } = view.getState()
      setSessions(await api.listSessions(showArchived ? { includeArchived: true } : undefined))
    } catch (e) {
      setBanner({ key: 'app.loadSessionsFailed', message: (e as Error).message })
    }
  }, [api, view])

  const setConnection = useCallback((p: StreamPhase | 'idle') => view.setState({ connection: p }), [view])

  // Send-stall watchdog: armed when a prompt is accepted, cancelled by the first event.
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarmStall = useCallback(() => {
    if (stallTimer.current !== null) {
      clearTimeout(stallTimer.current)
      stallTimer.current = null
    }
  }, [])
  const armStall = useCallback((seqAtSend: number) => {
    disarmStall()
    const armedAt = Date.now()
    stallTimer.current = setTimeout(() => {
      stallTimer.current = null
      if (isStalled({ seqAtSend, afterMs: SEND_STALL_MS }, model.current.lastSeq, Date.now() - armedAt)) {
        setBanner({ key: 'app.sendStalled', message: '', seconds: Math.round(SEND_STALL_MS / 1000) })
      }
    }, SEND_STALL_MS)
  }, [disarmStall, model])
  useEffect(disarmStall, [disarmStall, openSessionId])

  // Sidecar-wide liveness. sessionCount/runningCount on the 5s health heartbeat are
  // the invalidation signal for the sidebar (see client-core/server-events.ts).
  const listSignature = useRef('')
  useEffect(() => {
    const close = openServerEvents({
      baseUrl: API_BASE,
      token: '',
      onEvent: (ev) => {
        if (ev.kind !== 'health') return
        setHealth(ev.data)
        // A mismatch is rendered from `health` itself (see the danger band below), so
        // this path has no banner to raise — the band is what makes it loud.
        const sig = `${ev.data.sessionCount}:${ev.data.runningCount}`
        if (sig !== listSignature.current) {
          listSignature.current = sig
          void refreshSessions()
        }
      },
    })
    return close
  }, [refreshSessions])

  useEffect(() => { void refreshSessions() }, [includeArchived, refreshSessions])

  const tally = useMemo(() => {
    const acc: Record<EventCategory, number> = { ...EMPTY_COUNTS }
    const flush = createFrameScheduler(() => setCounts({ ...acc }))
    return { acc, record: (type: string) => { acc[categorize(type)]++; flush() } }
  }, [])

  useEffect(() => {
    if (!openSessionId) return
    const m = new SessionModel()
    setModel(m)
    setCounts(EMPTY_COUNTS)
    view.setState({ lastSeq: 0, generation: 0 })

    // Cold start order (plan §4.3 #1): REST approvals are ground truth for pending
    // gates, then the stream replays the window.
    void api.interventions(openSessionId)
      .then((snap) => m.applySnapshot(snap))
      .catch(() => undefined)

    const close = openSessionStream({
      baseUrl: API_BASE,
      token: '',
      sessionId: openSessionId,
      since: 0,
      onEvent: (ev) => {
        disarmStall()
        tally.record(ev.event.type)
        m.apply(ev)
        view.setState({ lastSeq: m.current.lastSeq, generation: ev.generation })
      },
      onPhase: (p, gen) => {
        // Every reconnect is a new generation: close the previous partial so a
        // replay that re-delivers its text cannot append onto it twice.
        if (p === 'connecting' && gen > 1) m.sealGeneration()
        setConnection(p)
        view.setState({ generation: gen })
      },
    })

    // 兜底轮询：计划 §7 给「审批静默挂死」（OpenCode #16367 同款坑）开的方子是
    // 超时提醒 + `/interventions` 快照兜底。提醒有了，这里补上后半：错过一条
    // approval_required 不该让界面永远安静地等一个用户看不见的闸。只在 running 时问——
    // 一个闸只可能在一次 run 期间挂着，归档会话上不该有周期性请求。
    const gateTimer = setInterval(() => {
      if (!m.current.running) return
      api.interventions(openSessionId).then((snap) => m.applySnapshot(snap)).catch(() => undefined)
    }, APPROVAL_POLL_MS)

    return () => { clearInterval(gateTimer); close() }
  }, [api, disarmStall, openSessionId, tally, setConnection, view])

  const createSession = useCallback(async () => {
    try {
      const s = await api.createSession({
        title: translate(getLocale(), 'app.sessionTitleNew', { time: new Date().toLocaleTimeString() }),
        approvalMode: 'manual',
      })
      await refreshSessions()
      view.setState({ openSessionId: s.id })
      setBanner(null)
    } catch (e) {
      setBanner({ key: 'app.createSessionFailed', message: (e as Error).message })
    }
  }, [api, refreshSessions, view])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !openSessionId) return
    setDraft(view, openSessionId, '')
    const seqAtSend = model.current.lastSeq
    try {
      const busy = await api.prompt(openSessionId, { prompt: text })
      if (busy === 'busy') await api.queue(openSessionId, text)
      // Only a directly accepted run is a stall candidate: a queued input is parked by
      // design, and warning about it would be a false alarm.
      if (shouldArmStall(busy)) armStall(seqAtSend)
    } catch (e) {
      setBanner({ key: 'app.sendFailed', message: (e as Error).message })
    }
  }, [api, armStall, draft, model, openSessionId, view])

  const answer = useCallback((requestId: string, a: ApprovalAnswerBody) => {
    if (!openSessionId) return
    void api.answerApproval(openSessionId, requestId, a).catch((e: Error) => setBanner({ key: 'app.answerFailed', message: e.message }))
  }, [api, openSessionId])

  const abort = useCallback(() => {
    if (!openSessionId) return
    void api.abort(openSessionId).catch((e: Error) => setBanner({ key: 'app.abortFailed', message: e.message }))
  }, [api, openSessionId])

  const mismatch = health !== null && health.protocolVersion !== PROTOCOL_VERSION
  const session = sessions.find((s) => s.id === openSessionId) ?? null
  const sessionCwd = session?.cwd ?? null

  return (
    <div className="app">
      <aside>
        <SessionList
          sessions={sessions}
          openSessionId={openSessionId}
          includeArchived={includeArchived}
          onToggleArchived={(on) => view.setState({ includeArchived: on })}
          onOpen={(id) => view.setState({ openSessionId: id })}
          onCreate={() => void createSession()}
          onArchive={(id) => { void api.archiveSession(id).then(refreshSessions) }}
          onRename={(id, title) => { void api.renameSession(id, title).then(refreshSessions).catch((e: Error) => setBanner({ key: 'app.renameFailed', message: e.message })) }}
          query={query}
          onQueryChange={setQuery}
          hits={hits}
          searchPending={searchPending}
        />
      </aside>

      <main>
        {banner && (
          <div className="app__banner">
            {t(banner.key, { message: banner.message, seconds: banner.seconds ?? 0 })}
            <button onClick={() => setBanner(null)}>✕</button>
          </div>
        )}
        {mismatch && (
          <div className="app__banner app__banner--danger" title={t('app.protocolMismatchDetail', { runtime: health?.protocolVersion ?? '?', compiled: PROTOCOL_VERSION })}>
            {t('app.protocolMismatch', { runtime: health?.protocolVersion ?? '?', compiled: PROTOCOL_VERSION })}
          </div>
        )}

        {openSessionId ? (
          <>
            <ChatStream
              blocks={state.blocks}
              running={state.running}
              onLoadEarlier={offerEarlier ? loadEarlier : undefined}
              loadingEarlier={loadingEarlier}
              api={api}
              sessionId={openSessionId}
              cwd={sessionCwd}
              theme={resolved}
            />
            <div className="app__composer">
              <div className="app__composer-col">
                {state.approvals.length > 0 && <ApprovalPanel approvals={state.approvals} onAnswer={answer} />}
                <div className="app__input-row">
                  <textarea
                    value={draft}
                    onChange={(e) => { if (openSessionId) setDraft(view, openSessionId, e.target.value) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                    rows={1}
                    placeholder={t('app.composerPlaceholder')}
                  />
                  <button className="app__send" onClick={() => void send()}>{t('app.send')}</button>
                  <button className="app__ghost" onClick={abort} disabled={!state.running}>{t('app.abort')}</button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="app__empty">{t('app.emptySession')}</div>
        )}
      </main>

      {/* 定稿的折叠组右栏：展开时是设置面板，收起时退成 44px 图标细条
          （design/tianshu-desktop-mockup-dsh-collapsed.png）。 */}
      <aside className={`app__rail${rightOpen ? ' app__rail--open' : ''}`}>
        {rightOpen ? (
          <div className="app__panel">
            <header className="app__panel-head">
              <nav className="app__tabs">
                {RAIL_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    className={`app__tab${rightTab === tab.id ? ' app__tab--on' : ''}`}
                    onClick={() => view.setState({ rightTab: tab.id })}
                  >
                    {t(tab.labelKey)}
                  </button>
                ))}
              </nav>
              <button className="set__close" onClick={() => view.setState({ panels: { right: false } })}>✕</button>
            </header>
            <div className="app__panel-body">
              {rightTab === 'settings' && <SettingsPanel api={api} onClose={() => view.setState({ panels: { right: false } })} />}
              {rightTab === 'context' && <ContextPanel snapshots={state.snapshots} />}
              {rightTab === 'checkpoints' && (
                <CheckpointPanel
                  api={api}
                  sessionId={openSessionId}
                  onRewound={() => { void refreshSessions() }}
                />
              )}
              {rightTab === 'git' && (
                <GitPanel
                  api={api}
                  sessionId={openSessionId}
                  cwd={sessionCwd}
                  canMergeBack={typeof session?.worktreeBranch === 'string' && session.worktreeBranch !== ''}
                />
              )}
              {rightTab === 'automations' && (
                <AutomationBoard
                  api={api}
                  canPatch={health?.capabilities.schedulePatch === true}
                  defaultCwd={sessionCwd}
                />
              )}
              {rightTab === 'files' && (
                <FileBrowser
                  api={api}
                  sessionId={openSessionId}
                  onPick={(p) => { if (openSessionId) setDraft(view, openSessionId, `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${p} `) }}
                />
              )}
            </div>
          </div>
        ) : (
          <button
            className="app__railbtn"
            title={t('app.expandRail')}
            onClick={() => view.setState({ panels: { right: true } })}
          >
            {t('app.railLabel')}
          </button>
        )}
      </aside>

      <footer className="app__status">
        <span><i className={`app__dot app__dot--${connection}`} />{phaseLabel(t, connection)}</span>
        <span>gen {generation}</span>
        <span>seq {lastSeq}</span>
        <span>{Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
        <span className="app__grow" />
        {/* 定稿底部状态条：上下文 / 缓存命中 / 成本。仅在有 live agent 时有值——
            归档或从未跑过的会话 404，此时整块不渲染而不是显示 0。 */}
        {cockpit && (() => {
          const c = formatCockpit(cockpit)
          return (
            <span className="app__cockpit">
              <b>{c.model}</b>
              <span>{t('app.context')} {c.contextLabel}</span>
              <span className={c.cachePct >= 80 ? 'app__cache--good' : ''}>{t('app.cacheHit')} {c.cachePct}%</span>
              <span>{c.tokensLabel}</span>
              <span>{c.costLabel}</span>
              {/* Observed live: compactionState also carries ordinary values like
                  'healthy', so the chip is limited to states where something is
                  actually happening — otherwise it reads as a false alarm. */}
              {c.compactionState && !CALM_COMPACTION_STATES.has(c.compactionState) && (
                <span className="app__compact">{t('app.compacting', { state: c.compactionState })}</span>
              )}
            </span>
          )
        })()}
        <button className="app__theme" onClick={cycleTheme} title={t('app.themeCycle')}>
          {theme === 'system' ? t('app.themeSystem') : theme === 'light' ? t('app.themeLight') : t('app.themeDark')}
        </button>
        {/* Offer the language you are not reading, in its own script. */}
        <button className="app__theme" onClick={cycleLocale} title={t('app.langCycle')}>
          {getLocale() === 'zh' ? t('app.langEnglish') : t('app.langChinese')}
        </button>
        {health && (
          <span>
            {t('app.sessionsCount', { count: health.sessionCount })} · {t('app.runningCount', { count: health.runningCount })}
            {health.configured === false ? ` · ${t('app.noProviderKey')}` : ''}
          </span>
        )}
      </footer>
    </div>
  )
}

function phaseLabel(t: Translator, p: 'idle' | StreamPhase): string {
  return p === 'live' ? t('app.phaseLive')
    : p === 'replay' ? t('app.phaseReplay')
    : p === 'down' ? t('app.phaseDown')
    : p === 'connecting' ? t('app.phaseConnecting')
    : t('app.phaseIdle')
}
