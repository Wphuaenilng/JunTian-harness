import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import {
  SidecarClient,
  SessionModel,
  shouldOfferEarlier,
  PROTOCOL_VERSION,
  openSessionStream,
  type ReplayGap,
  openServerEvents,
  categorize,
  formatCockpit,
  tokensPerSecond,
  formatThroughput,
  isStalled,
  shouldArmStall,
  createLatestGate,
  type CockpitSnapshot,
  type ThroughputSample,
  type SessionRecord,
  type SessionSearchHit,
  type HealthBody,
  type ApprovalAnswerBody,
  type EventCategory,
  type StreamPhase,
} from '@tianshu/client-core'
// 快照键由 client-core 命名（§4.1：产品面不写协议事件名），这里只取键与读取器。
import { SNAP, snapshotOf } from '@tianshu/client-core'
import { SessionList } from '@tianshu/ui-session'
import { SectionGroup, submitsOnEnter } from '@tianshu/ui-primitives'
import { ChatStream, ContextPanel, contextPercentOf } from '@tianshu/ui-chat'
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

/**
 * The collapsed rail's icons (定稿 第二张图 `.d-rail`): one glyph per group, and clicking one
 * opens that group *and* expands the rail — the strip is a jump target, not just an open button.
 * `◔` and `↩` are the drawing's own characters for 上下文 / 检查点; the other four are ours
 * because the drawing only drew four of our six groups.
 */
const RAIL_TABS: Array<{ id: RightTab; labelKey: LocaleKey; glyph: string }> = [
  { id: 'settings', labelKey: 'app.tabSettings', glyph: '⚙' },
  { id: 'context', labelKey: 'app.tabContext', glyph: '◔' },
  { id: 'checkpoints', labelKey: 'app.tabCheckpoints', glyph: '↩' },
  { id: 'git', labelKey: 'app.tabGit', glyph: '⑄' },
  { id: 'automations', labelKey: 'app.tabAutomations', glyph: '⏱' },
  { id: 'files', labelKey: 'app.tabFiles', glyph: '▤' },
]

/** Kept as key + raw message so an on-screen banner re-renders when the language flips. */
type Failure = { key: LocaleKey; message: string; seconds?: number }

const NO_SEARCH_META: { scannedFiles: number | null; tooShort: boolean } = { scannedFiles: null, tooShort: false }

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
  /**
   * The right rail is a stack of collapsible groups (定稿 设计要点「折叠组右栏」), not mutually
   * exclusive tabs. `rightTab` stays in the store — it already persisted, and its meaning carries
   * over as "the group opened last", which is what a reload should restore. Which groups are open
   * right now is view-local: several can be open at once, and that is not something to persist.
   * A group's panel mounts the first time it opens and stays mounted after, so six panels never
   * stampede the sidecar on every session switch while a collapsed-and-reopened group keeps its state.
   */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<RightTab>>(() => new Set<RightTab>([rightTab]))
  const [mountedGroups, setMountedGroups] = useState<ReadonlySet<RightTab>>(() => new Set<RightTab>([rightTab]))
  const setGroupOpen = useCallback((id: RightTab, next: boolean): void => {
    setOpenGroups((prev) => {
      const out = new Set(prev)
      if (next) out.add(id)
      else out.delete(id)
      return out
    })
    if (next) {
      setMountedGroups((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      view.setState({ rightTab: id })
    }
  }, [view])
  const draft = useStore(view, (s) => (s.openSessionId ? s.drafts[s.openSessionId] ?? '' : ''))

  const [sessions, setSessions] = useState<readonly SessionRecord[]>([])
  const [health, setHealth] = useState<HealthBody | null>(null)
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [banner, setBanner] = useState<Failure | null>(null)
  // Search state is per-view and ephemeral, so it stays local rather than in the
  // view store (which holds the things that must survive a remount).
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly SessionSearchHit[] | null>(null)
  const [searchMeta, setSearchMeta] = useState<{ scannedFiles: number | null; tooShort: boolean }>(NO_SEARCH_META)
  const [searchPending, setSearchPending] = useState(false)
  // One gate per host mount: the newest search request is the only one allowed to write state.
  const searchGate = useMemo(() => createLatestGate(), [])
  // 冷通道"加载更早"那一槽同理：换会话时旧那一发只许丢弃（见 loadEarlier）。
  const historyGate = useMemo(() => createLatestGate(), [])
  // 会话名册的读回只许最新那一发落地：归档 / 取消归档 / 改名各发一发，旧的那发后落地就会把
  // 刚归档的那行显示回未归档——看起来像"点了没生效"。
  const rosterGate = useMemo(() => createLatestGate(), [])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme())
  // The concrete value painted into `data-theme`, held as state so a change re-renders
  // and reaches consumers outside the CSS cascade (an embedded MCP frame gets its theme
  // push from here). `theme` alone cannot do this job: mode 'system' stays 'system'.
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolvedTheme())
  // Cockpit is only answerable while an agent exists for the session (an archived or
  // never-run session 404s), so a failure is "no live cockpit" and not an error band.
  const [cockpit, setCockpit] = useState<CockpitSnapshot | null>(null)
  // 状态条图上第一格「⚡ 42 tok/s」。内核里没有速度这个字段，所以它是**客户端采样**：
  // 相邻两次 cockpit 轮询之间新增的 outputTokens ÷ 实测间隔。公式只有一个事实源
  // （client-core 的 tokensPerSecond），这里只负责取样本和摆放格子。
  const [speedTps, setSpeedTps] = useState<number | null>(null)
  const speedSample = useRef<ThroughputSample | null>(null)
  /** Per-connection verdict from the stream: did resuming actually miss events? */
  const [replayGap, setReplayGap] = useState<ReplayGap | null>(null)

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
    if (!q) { searchGate.invalidate(); setHits(null); setSearchMeta(NO_SEARCH_META); setSearchPending(false); return }
    setSearchPending(true)
    const token = searchGate.begin()
    // Debounced: every keystroke hitting a disk-scanning endpoint is how search gets
    // blamed for a laggy sidebar. A query shorter than the sidecar accepts never goes out
    // (it used to come back as a 搜索失败 banner after one character).
    // The debounce only stops requests that never left; one already in flight for a query the user
    // has since abandoned (cleared the box, typed past it) still lands and used to write hits back
    // — over an empty search box. The gate decides who may touch state; the request is not cancelled.
    const timer = setTimeout(() => {
      void api.searchSessions(q)
        .then((page) => {
          if (!searchGate.isCurrent(token)) return
          setHits(page.hits)
          setSearchMeta({ scannedFiles: page.scannedFiles, tooShort: page.tooShort })
          setSearchPending(false)
        })
        .catch((e: Error) => {
          if (!searchGate.isCurrent(token)) return
          setBanner({ key: 'app.searchFailed', message: e.message }); setSearchPending(false)
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [api, query, searchGate])

  // The Session instance is state, not a ref: useSyncExternalStore must re-subscribe
  // when a different session's model takes over, and a ref swap would leave it
  // listening to the previous session forever.
  const [model, setModel] = useState(() => new SessionModel())
  const subscribe = useCallback((cb: () => void) => model.subscribe(cb), [model])
  const getSnapshot = useCallback(() => model.current, [model])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Offered only when the server's own replay_window says the disk log has a head we
  // were not given — never a guessed threshold.
  const offerEarlier = shouldOfferEarlier(snapshotOf(state.snapshots, SNAP.replayWindow))
  // The collapsed rail's 上下文 icon puts this number in its tooltip. It comes from the same
  // algebra as the ring, so the strip and the panel can never read differently; null means no
  // budget snapshot has arrived yet — then the tooltip says the group name and nothing else.
  const railContextPct = contextPercentOf(snapshotOf(state.snapshots, SNAP.contextBudget))

  // Cockpit reads live-agent state, so it is polled only while this session runs: an
  // archived or never-run session answers 404 (handled as "no live cockpit", not an error
  // band), and polling regardless turns idle browsing into a 404 storm — measured 17 of 39
  // requests in one pass over the panels.
  useEffect(() => {
    if (!openSessionId || !state.running) { setCockpit(null); setSpeedTps(null); speedSample.current = null; return }
    // 换会话、或这一轮跑完之后又跑起来，都要把基线清掉：留着上一份样本，第一格就会把
    // 跨会话（或跨空闲期）的 token 差除以一段根本没在产出的时间。
    speedSample.current = null
    let stopped = false
    const pull = (): void => {
      api.cockpit(openSessionId).then((c) => {
        if (stopped) return
        // 时间戳取响应落地那一刻，不取定时器 firing 那一刻——轮询慢的那几秒是真实发生的，
        // 拿固定的 10s 当分母就会把它抹掉。
        const next: ThroughputSample = { outputTokens: c.model.outputTokens, atMs: Date.now() }
        setSpeedTps(tokensPerSecond(speedSample.current, next))
        speedSample.current = next
        setCockpit(c)
      }).catch(() => {
        if (!stopped) { setCockpit(null); setSpeedTps(null); speedSample.current = null }
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
    const token = historyGate.begin()
    // 换会话或又点一次之后，旧那一发只许丢弃：它若照旧写回，`.finally` 会把**新会话**那发的
    // "加载中" spinner 提前关掉——spinner 说"完了"而尾段还在网上飞。
    void api.historyPage(openSessionId, oldest, 200)
      .then((page) => { if (historyGate.isCurrent(token)) model.prependEvents(page.events) })
      .catch((e: Error) => { if (historyGate.isCurrent(token)) setBanner({ key: 'app.historyFailed', message: e.message }) })
      .finally(() => { if (historyGate.isCurrent(token)) setLoadingEarlier(false) })
  }, [api, model, openSessionId, historyGate])

  const refreshSessions = useCallback(async () => {
    const token = rosterGate.begin()
    try {
      const { includeArchived: showArchived } = view.getState()
      const list = await api.listSessions(showArchived ? { includeArchived: true } : undefined)
      if (rosterGate.isCurrent(token)) setSessions(list)
    } catch (e) {
      if (rosterGate.isCurrent(token)) setBanner({ key: 'app.loadSessionsFailed', message: (e as Error).message })
    }
  }, [api, rosterGate, view])

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
    // 上一会话那发还在飞的"更早"从此不许写回，spinner 也不能由它来关。
    historyGate.invalidate()
    setLoadingEarlier(false)

    // Cold start order (plan §4.3 #1): REST approvals are ground truth for pending
    // gates, then the stream replays the window.
    void api.interventions(openSessionId)
      .then((snap) => m.applySnapshot(snap))
      .catch(() => undefined)
    setReplayGap(null)

    const close = openSessionStream({
      baseUrl: API_BASE,
      token: '',
      sessionId: openSessionId,
      since: 0,
      onGap: (g) => { if (g.kind !== 'none') setReplayGap(g) },
      // §4.3 #2 的 REST 兜底：断线退避到第 2 次起，先拿游标去问落盘日志要尾段。传输层把它当回放
      // 投给模型并推进自己的游标，所以通道回来后 `?since=` 不会把这批 seq 再投一遍。
      pullRest: (since) => api.events(openSessionId, since).then((p) => p.events),
      onEvent: (ev) => {
        disarmStall()
        // 状态条的「分类计数」统计的是**这会话里真发生过的事**。seq=0 是连接期的合成元事件
        // （实测一开流就有 4 条：replay_window / delegation_snapshot / job_snapshot /
        // approval_snapshot，其中两条归 tool），它们和游标那条规则同源——**不该推计数**，
        // 否则刚连上一个空会话就显示 `tool 2 · lifecycle 2`，而且每重连一次再加一遍。
        if (ev.event.seq > 0) tally.record(ev.event.type)
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
  }, [api, disarmStall, historyGate, openSessionId, tally, setConnection, view])

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
      const outcome = await api.sendOrQueue(openSessionId, text)
      if (outcome === 'lost') {
        // Both endpoints refused in the same breath (a run started, then closed). The draft was
        // already cleared for optimism — put the text back, or "输入不丢" would be a lie.
        setDraft(view, openSessionId, text)
        setBanner({ key: 'app.sendLost', message: '' })
        return
      }
      // Only a directly accepted run is a stall candidate: a queued input is parked by
      // design, and warning about it would be a false alarm.
      if (shouldArmStall(outcome)) armStall(seqAtSend)
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
          onUnarchive={(id) => { void api.unarchiveSession(id).then(refreshSessions) }}
          onRename={(id, title) => { void api.renameSession(id, title).then(refreshSessions).catch((e: Error) => setBanner({ key: 'app.renameFailed', message: e.message })) }}
          query={query}
          onQueryChange={setQuery}
          hits={hits}
          searchPending={searchPending}
          searchScanned={searchMeta.scannedFiles}
          searchTooShort={searchMeta.tooShort}
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
                    onKeyDown={(e) => { if (submitsOnEnter({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); void send() } }}
                    rows={1}
                    placeholder={t('app.composerPlaceholder')}
                  />
                  <button className="app__send" title={t('app.send')} aria-label={t('app.send')} onClick={() => void send()}>➤</button>
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
              <span className="app__secs-title">{t('app.railGroups')}</span>
              <button className="app__railclose" onClick={() => view.setState({ panels: { right: false } })}>✕</button>
            </header>
            <div className="app__panel-body app__secs">
              {RAIL_TABS.map((g) => (
                <SectionGroup
                  key={g.id}
                  id={g.id}
                  title={t(g.labelKey)}
                  open={openGroups.has(g.id)}
                  onOpenChange={(next) => setGroupOpen(g.id, next)}
                >
                  {mountedGroups.has(g.id) && g.id === 'settings' && <SettingsPanel api={api} onClose={() => view.setState({ panels: { right: false } })} />}
                  {mountedGroups.has(g.id) && g.id === 'context' && (
                    <ContextPanel
                      snapshots={state.snapshots}
                      onRetract={(laneId) => { if (openSessionId !== null) void api.retractQueued(openSessionId, laneId) }}
                    />
                  )}
                  {mountedGroups.has(g.id) && g.id === 'checkpoints' && (
                    <CheckpointPanel
                      api={api}
                      sessionId={openSessionId}
                      onRewound={() => { void refreshSessions() }}
                    />
                  )}
                  {mountedGroups.has(g.id) && g.id === 'git' && (
                    <GitPanel
                      api={api}
                      sessionId={openSessionId}
                      cwd={sessionCwd}
                      canMergeBack={typeof session?.worktreeBranch === 'string' && session.worktreeBranch !== ''}
                    />
                  )}
                  {mountedGroups.has(g.id) && g.id === 'automations' && (
                    <AutomationBoard
                      api={api}
                      canPatch={health?.capabilities.schedulePatch === true}
                      defaultCwd={sessionCwd}
                    />
                  )}
                  {mountedGroups.has(g.id) && g.id === 'files' && (
                    <FileBrowser
                      api={api}
                      sessionId={openSessionId}
                      onPick={(p) => { if (openSessionId) setDraft(view, openSessionId, `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${p} `) }}
                    />
                  )}
                </SectionGroup>
              ))}
            </div>
          </div>
        ) : (
          <nav className="app__railstrip" aria-label={t('app.railLabel')}>
            <button
              className="app__railexpand"
              title={t('app.expandRail')}
              aria-label={t('app.expandRail')}
              onClick={() => view.setState({ panels: { right: true } })}
            >
              «
            </button>
            {RAIL_TABS.map((g) => (
              <button
                key={g.id}
                className="app__railbtn"
                title={g.id === 'context' && railContextPct !== null ? `${t(g.labelKey)} ${railContextPct}%` : t(g.labelKey)}
                aria-label={t(g.labelKey)}
                onClick={() => { setGroupOpen(g.id, true); view.setState({ panels: { right: true } }) }}
              >
                {g.glyph}
                {g.id === 'context' && railContextPct !== null && <span className="app__railmini" aria-hidden="true" />}
              </button>
            ))}
          </nav>
        )}
      </aside>

      <footer className="app__status">
        <span><i className={`app__dot app__dot--${connection}`} />{phaseLabel(t, connection)}</span>
        <span>gen {generation}</span>
        <span>seq {lastSeq}</span>
        {/* §9 MVP 那一格「续读起点高于游标」的可见化：判定成立才显示，而且分两种口径——
            环里没了但磁盘里还有的是"可以加载更早"，不是"丢了"。判据在 client-core/replay-gap.ts
            （合并回放带 streamStartSeq，所以 seq 跳跃本身不算证据）。 */}
        {replayGap && replayGap.kind !== 'none' && (
          <span className={`app__gap app__gap--${replayGap.kind}`}>
            {t(replayGap.kind === 'lost' ? 'status.gapLost' : 'status.gapDisk', { count: replayGap.to - replayGap.from + 1 })}
          </span>
        )}
        <span>{Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>
        <span className="app__grow" />
        {/* 定稿底部状态条：速度 / 上下文 / 缓存命中 / 成本。整块只在有 live agent 时有值——
            归档或从未跑过的会话 404，那时不渲染而不是显示 0。速度那一格还要再晚一拍：
            两次轮询才成一个数，第一次没有读数就整格不出现（同样不是显示 0）。 */}
        {cockpit && (() => {
          const c = formatCockpit(cockpit)
          const speed = formatThroughput(speedTps)
          return (
            <span className="app__cockpit">
              <b>{c.model}</b>
              {speed && <span className="app__speed">⚡ {speed}</span>}
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
