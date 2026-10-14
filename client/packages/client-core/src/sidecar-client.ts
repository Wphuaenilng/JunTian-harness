/**
 * Sidecar REST surface — ported from `vscode-extension/src/sidecar/client.ts`.
 *
 * The sidecar is the ONLY channel this client uses: no reading ~/.rivet files, no
 * direct SQLite access (the Goose dual-track lesson, plan §2.2). Anything the UI
 * needs must be reachable over these endpoints.
 */
import type {
  ApprovalSnapshot,
  RuntimeCapabilities,
  SessionEvent,
  SessionRecord,
} from './protocol-types.ts'
import type { ApprovalAnswerBody, CreateSessionRequest, PromptRequest } from './request-types.ts'
import type {
  ApprovalConfig,
  CheckpointConfig,
  CreateCustomProviderRequest,
  DefaultModelConfig,
  DomainConfig,
  ProviderConfigList,
  SetKeyRequest,
} from './settings-types.ts'
import type { DirListing, RewindPoint } from './workspace-types.ts'
import type {
  BranchRequest,
  BranchesPage,
  CommitResult,
  DiffResult,
  GitScope,
  HistoryPage,
  SessionWorkingTree,
  StageRequest,
  SyncRequest,
  WorkbenchSnapshot,
} from './git-types.ts'
import type {
  CreateScheduleRequest,
  SchedulePatch,
  ScheduleStatus,
  ScheduledTask,
  TaskListPage,
} from './schedule-types.ts'
import type { TaskFilterRequest } from './task-types.ts'
import { selectTasks } from './task-view.ts'
import type { CockpitSnapshot } from './cockpit-types.ts'

function gitScopeQuery(scope: GitScope): string {
  return scope.cwd !== undefined
    ? `cwd=${encodeURIComponent(scope.cwd)}`
    : `sessionId=${encodeURIComponent(scope.sessionId)}`
}

export interface SidecarEndpoints {
  baseUrl: string
  token: string
}

export interface HealthBody {
  readiness: 'ready' | 'initializing' | 'failed'
  ok: boolean
  version: string
  protocolVersion: number
  capabilities: RuntimeCapabilities
  sessionCount: number
  runningCount: number
  configured: boolean
  initializationError?: string
  storeLockHolder?: { pid?: number; hostname?: string }
}

/**
 * GET /sessions/:id/events?since= — the hot path. `src/server/session-manager.ts` 的
 * `getEventsAsync` 只回 `{ events, lastSeq }`：**没有** `firstSeq`，所以这条读数无法告诉你磁盘头
 * 在哪（2026-10-13 在无 key 实例上实测，见 scripts/accept-history.ts 的 ⑩b 常驻判据）。
 */
export interface EventWindow {
  events: SessionEvent[]
  lastSeq: number
}

/**
 * GET /sessions/:id/events?before= — the cold path, and the only one that reports the disk head:
 * `firstSeq` 是磁盘日志里最早的 seq，`events[0].seq === firstSeq` 就是"没有更早的页了"的信号。
 * 类型分成两份的理由：把它们合成一个 `firstSeq: number` 的 `EventPage` 会让热通道那条谎写进类型里
 * （`exactOptionalPropertyTypes` 下 `page.firstSeq === 1` 照样编译通过，运行时永远是 false）。
 */
export interface ColdEventPage extends EventWindow {
  firstSeq: number
}

/** GET /sessions/search item — snippet is the matched body excerpt, title is display-only. */
export interface SessionSearchHit {
  sessionId: string
  title: string
  snippet: string
}

/** Shortest query the sidecar accepts. `check:docs` compares this against the kernel's own guard. */
export const SEARCH_MIN_QUERY = 2

export interface SessionSearchPage {
  hits: SessionSearchHit[]
  /** Transcripts the kernel actually read; null when the query never went out. */
  scannedFiles: number | null
  /** True when the query is shorter than the sidecar accepts — no request was made. */
  tooShort: boolean
}

export class SidecarError extends Error {
  readonly status: number
  /**
   * The server's own machine-readable reason (`stale_snapshot`, `dirty_workspace`,
   * `sensitive_file`, `confirmation_required`, …). The workbench UI must branch on this,
   * not on the Chinese message text, which is presentation and can change.
   */
  readonly code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

/** Build the rejection for a non-2xx response, keeping status + code for the caller. */
async function rejectWith(res: Response, label: string): Promise<never> {
  const detail = await res.json().catch(() => ({ error: '', code: '' })) as { error?: string; code?: string }
  throw new SidecarError(`${label} → ${res.status}${detail.error ? `: ${detail.error}` : ''}`, res.status, detail.code)
}

/**
 * 409 is a normal outcome here, not an error: /prompt and /steer race the moment a
 * run closes. Callers fall back (prompt ⇄ queue) so the user's input is never lost,
 * which is why these return a union instead of throwing.
 */
export type BusyResult = 'busy' | 'ok'

export class SidecarClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(endpoints: SidecarEndpoints) {
    this.baseUrl = endpoints.baseUrl.replace(/\/$/, '')
    this.token = endpoints.token
  }

  private headers(): Record<string, string> {
    // Empty token = the same-origin layer owns Authorization (it overrides whatever
    // the browser sends), so do not put a bogus `Bearer ` on the wire.
    const h: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token) h.authorization = `Bearer ${this.token}`
    return h
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: this.headers() }
    // Assign only when present: exactOptionalPropertyTypes rejects `body: undefined`.
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(`${this.baseUrl}${path}`, init)
    if (!res.ok) await rejectWith(res, `${method} ${path}`)
    return (await res.json()) as T
  }

  /** Ask capabilities, never the version (plan §5.1) — the version is only a fence. */
  health(): Promise<HealthBody> {
    return this.request('GET', '/health')
  }

  async protocolVersion(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/sessions`, { headers: { authorization: `Bearer ${this.token}` } })
    return Number(res.headers.get('x-tianshu-protocol') ?? 0)
  }

  listSessions(opts?: { includeArchived?: boolean }): Promise<SessionRecord[]> {
    const q = opts?.includeArchived ? '?includeArchived=true' : ''
    return this.request<{ sessions: SessionRecord[] }>('GET', `/sessions${q}`).then((b) => b.sessions)
  }

  getSession(id: string): Promise<SessionRecord> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}`)
  }

  createSession(req: CreateSessionRequest): Promise<SessionRecord> {
    return this.request('POST', '/sessions', req)
  }

  archiveSession(id: string): Promise<{ archived: boolean }> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(id)}`)
  }

  unarchiveSession(id: string): Promise<{ archived: boolean }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/unarchive`, {})
  }

  renameSession(id: string, title: string): Promise<{ id: string; title: string }> {
    return this.request('PATCH', `/sessions/${encodeURIComponent(id)}`, { title })
  }

  /**
   * Full-text search over session **event bodies**, not titles — verified live: a
   * session titled "proxy sse check" does not match `q=proxy` but does match text in
   * its messages, and the response carries `meta.scannedFiles`. So the UI must not
   * present this as a title filter, and an empty result means "no body matched".
   */
  /**
   * Full-text search over the sidecar's own session transcripts — `~/.rivet/sessions/<项目>/<id>.jsonl`,
   * one file per session, read for every session the registry lists.
   *
   * The 2-character floor is measured, not guessed: a shorter query is answered with
   * `HTTP 400 {"error":"Query \"q\" must be at least 2 characters"}` (kernel
   * `session-routes.ts:870`), which used to reach the user as a 搜索失败 banner after a single
   * keystroke. We refuse locally and let the UI say why.
   *
   * `scannedFiles` comes back with the results because "no matches after reading 1 transcript" is a
   * different statement from "no matches after reading 130" — a session that never ran has no
   * transcript to read, and the empty state should not pretend the search covered it.
   */
  async searchSessions(q: string): Promise<SessionSearchPage> {
    const trimmed = q.trim()
    if (trimmed.length < SEARCH_MIN_QUERY) return { hits: [], scannedFiles: null, tooShort: true }
    const body = await this.request<{
      results: SessionSearchHit[]
      meta?: { durationMs: number; scannedFiles: number }
    }>('GET', `/sessions/search?q=${encodeURIComponent(trimmed)}`)
    return { hits: body.results, scannedFiles: body.meta?.scannedFiles ?? null, tooShort: false }
  }

  /** Hot path. 409 = the session is running; caller should /queue instead. */
  prompt(id: string, req: PromptRequest): Promise<BusyResult> {
    return this.postExpectingBusy(`/sessions/${encodeURIComponent(id)}/prompt`, req)
  }

  /** busy 期间排队跟进；409 = 已空闲，caller 回退 /prompt。 */
  queue(id: string, text: string): Promise<{ laneId: string } | 'idle'> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/queue`, { text }, 409).then((v) =>
      v === 'conflict' ? ('idle' as const) : (v as { laneId: string }))
  }

  /**
   * The plan's 「busy 走 `/queue`（输入不丢）」 (§6 M1) as one call. Neither endpoint keeps the text
   * when it refuses: `/prompt` answers 409 busy, and `/queue` answers 409 `code:'idle'` if the run
   * closed in between (`src/server/session-routes.ts:1204`，`code: 'idle'` 那一支) — so a single hand-off can drop the
   * input on the floor. Ping-pong once: prompt ⇒ queue ⇒ prompt again.
   */
  async sendOrQueue(id: string, text: string): Promise<'ok' | 'queued' | 'lost'> {
    if ((await this.prompt(id, { prompt: text })) === 'ok') return 'ok'
    if ((await this.queue(id, text)) !== 'idle') return 'queued'
    return (await this.prompt(id, { prompt: text })) === 'ok' ? 'ok' : 'lost'
  }

  retractQueued(id: string, laneId: string): Promise<boolean> {
    return this.postJson(`/sessions/${encodeURIComponent(id)}/queue/retract`, { laneId }, 404, 409)
      .then((v) => v !== 'conflict')
  }

  abort(id: string): Promise<{ aborted: boolean }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/abort`, {})
  }

  /** Cold channel: pages older than the in-memory ring (plan M2, triggered by replay_window). */
  historyPage(id: string, before: number, limit = 200): Promise<ColdEventPage> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/events?before=${before}&limit=${limit}`)
  }

  /** Hot path (`?since=`) — reads the in-memory ring/loaded log; carries no disk-head field. */
  events(id: string, since = 0): Promise<EventWindow> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/events?since=${since}`)
  }

  /** Approval ground truth for cold start — pending state survives event-ring eviction. */
  interventions(id: string): Promise<ApprovalSnapshot> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/interventions`)
  }

  answerApproval(id: string, requestId: string, answer: ApprovalAnswerBody): Promise<{ ok: boolean }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/interventions/${encodeURIComponent(requestId)}/answer`, answer)
  }

  // --- settings surface (plan §4.2 ui-settings; shapes in settings-types.ts) --------

  getApprovalConfig(): Promise<ApprovalConfig> {
    return this.request('GET', '/config/approval')
  }

  setApprovalConfig(cfg: ApprovalConfig): Promise<ApprovalConfig> {
    return this.request('PUT', '/config/approval', cfg)
  }

  getDefaultModelConfig(): Promise<DefaultModelConfig> {
    return this.request('GET', '/config/default-model')
  }

  /** The server demands 'provider:modelId' — a bare model id is a 400. */
  setDefaultModelConfig(defaultModel: string): Promise<DefaultModelConfig> {
    return this.request('PUT', '/config/default-model', { defaultModel })
  }

  getDomainConfig(): Promise<DomainConfig> {
    return this.request('GET', '/config/default-domain')
  }

  getCheckpointConfig(): Promise<CheckpointConfig> {
    return this.request('GET', '/config/checkpoint')
  }

  getProviders(): Promise<ProviderConfigList> {
    return this.request('GET', '/config/providers')
  }

  /**
   * Write a credential into one key slot. `apiKey` and `apiKeyEnv` are mutually
   * exclusive server-side (config-routes-keys.ts:137) and SetKeyRequest encodes that.
   * There is no matching read: `keyStatus.ref` is masked by the server, and the client
   * must never expect to see a plaintext key back.
   */
  setProviderKey(name: string, keyId: string, req: SetKeyRequest): Promise<unknown> {
    return this.request('PUT', `/config/providers/${encodeURIComponent(name)}/keys/${encodeURIComponent(keyId)}/key`, req)
  }

  createCustomProvider(req: CreateCustomProviderRequest): Promise<{ ok: boolean; providerName: string }> {
    return this.request('POST', '/config/providers/custom', req)
  }

  deleteProvider(name: string): Promise<unknown> {
    return this.request('DELETE', `/config/providers/${encodeURIComponent(name)}`)
  }

  setDefaultProvider(name: string): Promise<unknown> {
    return this.request('POST', `/config/providers/${encodeURIComponent(name)}/default`, {})
  }

  /**
   * Shadow checkpoints the runtime can roll back to (plan §2.3 Cline row: the kernel
   * already has checkpoint/rewind, the client only surfaces and triggers it).
   * Verified shape: `{points:[{index, content, timestamp, seq}]}`.
   */
  async rewindPoints(id: string): Promise<RewindPoint[]> {
    const body = await this.request<{ points: RewindPoint[] }>('GET', `/sessions/${encodeURIComponent(id)}/rewind-points`)
    return body.points
  }

  /**
   * Destructive: truncates the conversation and optionally the working tree. Kept
   * separate from the read path so no UI can call it by accident — it requires the
   * caller to pass the index explicitly.
   */
  rewind(id: string, messageIndex: number, rollbackFiles?: boolean): Promise<SessionRecord> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/rewind`, {
      messageIndex,
      ...(rollbackFiles === undefined ? {} : { rollbackFiles }),
    })
  }

  /** @file candidates — server applies gitignore filtering and relevance ranking. */
  async listFiles(id: string, q: string, limit = 30): Promise<string[]> {
    const body = await this.request<{ files: string[] }>(
      'GET',
      `/sessions/${encodeURIComponent(id)}/files?q=${encodeURIComponent(q)}&limit=${limit}`,
    )
    return body.files
  }

  /** Preview a workspace file. Content arrives as stored (CRLF preserved). */
  fileContent(id: string, path: string): Promise<{ path: string; content: string }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/file-content?path=${encodeURIComponent(path)}`)
  }

  listDir(id: string, path: string): Promise<DirListing> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/list-dir?path=${encodeURIComponent(path)}`)
  }

  async artifacts(id: string): Promise<unknown[]> {
    const body = await this.request<{ artifacts: unknown[] }>('GET', `/sessions/${encodeURIComponent(id)}/artifacts`)
    return body.artifacts
  }

  /**
   * Rollback preview — the confirmation token is what makes the destructive POST safe:
   * preview first, show the diff, then send the token back with the actual rollback.
   */
  rollbackPreview(id: string): Promise<{ available: boolean; text?: string; confirmationToken?: string }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/rollback/preview`)
  }

  /**
   * Git workbench reads. Scope is either an explicit cwd or a session — the server
   * resolves a session to its worktree path first, then refuses anything not in a
   * registered workspace (git-workbench-routes.ts:8-16), so `unknown_workspace` 403
   * is the normal answer for a path the runtime has never seen.
   */
  workbenchSnapshot(scope: GitScope): Promise<WorkbenchSnapshot> {
    return this.request('GET', `/git/workbench?${gitScopeQuery(scope)}`)
  }

  workbenchBranches(scope: GitScope): Promise<BranchesPage> {
    return this.request('GET', `/git/workbench/branches?${gitScopeQuery(scope)}`)
  }

  workbenchHistory(scope: GitScope, offset = 0, limit = 50): Promise<HistoryPage> {
    return this.request('GET', `/git/workbench/history?${gitScopeQuery(scope)}&offset=${offset}&limit=${limit}`)
  }

  workbenchDiff(scope: GitScope, path: string, staged = false): Promise<DiffResult> {
    return this.request('GET', `/git/workbench/diff?${gitScopeQuery(scope)}&path=${encodeURIComponent(path)}&staged=${staged}`)
  }

  /** Range diff between two full shas (git-workbench-routes.ts:36-41). */
  workbenchCompare(scope: GitScope, from: string, to: string): Promise<DiffResult> {
    return this.request('GET', `/git/workbench/compare?${gitScopeQuery(scope)}&from=${from}&to=${to}`)
  }

  /** One commit as shown by `git show` (git-workbench-routes.ts:42-47). */
  workbenchCommitDiff(scope: GitScope, sha: string): Promise<DiffResult> {
    return this.request('GET', `/git/workbench/commit?${gitScopeQuery(scope)}&sha=${sha}`)
  }

  /**
   * Workbench writes. Each one echoes the `version` it read; a stale one is refused with
   * 409 `stale_snapshot` (git-workbench.ts:97) and the caller must re-read and re-ask —
   * never re-send blindly, or the optimistic lock is decoration.
   *
   * Scope travels in the **body** for writes: the route merges `{...params, ...body}`
   * before resolving the cwd (git-workbench-routes.ts:19), so omitting it here is a 400
   * `context_missing`, not a 404 — a mistake this client actually made once.
   */
  workbenchStage(scope: GitScope, body: StageRequest, version: string): Promise<WorkbenchSnapshot> {
    return this.request('POST', '/git/workbench/stage', { ...scope, ...body, version })
  }

  workbenchCommit(scope: GitScope, message: string, version: string): Promise<CommitResult> {
    return this.request('POST', '/git/workbench/commit', { ...scope, message, version })
  }

  /** Refused outright while the tree is dirty (git-workbench-routes.ts:75). */
  workbenchBranch(scope: GitScope, body: BranchRequest, version: string): Promise<WorkbenchSnapshot> {
    return this.request('POST', '/git/workbench/branch', { ...scope, ...body, version })
  }

  /** `pull`/`push` additionally require `confirm: true`; `fetch` does not. */
  workbenchSync(scope: GitScope, body: SyncRequest, version: string): Promise<WorkbenchSnapshot> {
    return this.request('POST', '/git/workbench/sync', { ...scope, ...body, version })
  }

  /**
   * Session-scoped landing routes (session-routes.ts:2403-2430). These are the
   * server-direct path — they act on the session's own cwd / worktree branch and take no
   * `version` echo, which is why the UI keeps them behind an explicit button rather than
   * an automatic action.
   */
  sessionCommit(id: string, message?: string): Promise<{ ok: boolean; [k: string]: unknown }> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/git/commit`, message !== undefined ? { message } : {})
  }

  sessionMergeBack(id: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/git/merge-back`, {})
  }

  sessionOpenPr(id: string, body: { title?: string; body?: string }): Promise<Record<string, unknown>> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/git/pr`, body)
  }

  /** Per-file line deltas against the task baseline — mid-run commits still show. */
  sessionWorkingTree(id: string, includeIgnored = false): Promise<SessionWorkingTree> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/git/working-tree${includeIgnored ? '?includeIgnored=true' : ''}`)
  }

  sessionFileDiff(id: string, path: string): Promise<DiffResult> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/git/diff?path=${encodeURIComponent(path)}`)
  }

  /** Full content of a file at the task baseline (left side of a two-pane diff). */
  sessionFileBase(id: string, path: string): Promise<{ exists: boolean; content: string }> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/git/file-base?path=${encodeURIComponent(path)}`)
  }

  /**
   * Automations board. Writes go through these only on the isolated desktop dir, and
   * `capabilities.schedulePatch` (issue #266) tells us whether PATCH exists at all on
   * the connected runtime — ask the capability, never a version number.
   */
  listScheduledTasks(status?: string): Promise<ScheduledTask[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : ''
    return this.request<{ tasks: ScheduledTask[] }>('GET', `/schedule${q}`).then((b) => b.tasks)
  }

  scheduleStatus(): Promise<ScheduleStatus> {
    return this.request('GET', '/schedule/status')
  }

  createScheduleTask(req: CreateScheduleRequest): Promise<ScheduledTask> {
    return this.request('POST', '/schedule', req)
  }

  /** Tri-state fields: omit to leave alone, null to clear (scheduled-task-model.ts:79). */
  patchScheduleTask(id: string, patch: SchedulePatch): Promise<ScheduledTask> {
    return this.request('PATCH', `/schedule/${encodeURIComponent(id)}`, patch)
  }

  pauseScheduleTask(id: string): Promise<unknown> {
    return this.request('POST', `/schedule/${encodeURIComponent(id)}/pause`, {})
  }

  deleteScheduleTask(id: string): Promise<unknown> {
    return this.request('DELETE', `/schedule/${encodeURIComponent(id)}`)
  }

  /**
   * Background jobs (bash run_in_background and scheduled runs). The filter travels as a
   * **query string** (`fetch` rejects a GET that carries a body) — but the sidecar does not read
   * it over HTTP: `GET /tasks` takes the filter from its first parameter (`body`, empty for a
   * GET) and names the parameter the router fills with the query `_params`
   * (`src/server/task-routes.ts:194-200`, `src/server/index.ts:83-92`). Measured on a live
   * instance in `scripts/accept-tasks.ts`: `?status=…` and `?limit=1` both answer with the whole
   * table. So the page is narrowed here as well, by `selectTasks()` mirroring the kernel's own
   * semantics — the query string stays on the wire so this turns into a no-op the day the
   * server honours it (and `check:layers` says so).
   */
  listTasks(filter: TaskFilterRequest = { limit: 50 }): Promise<TaskListPage> {
    const qs = new URLSearchParams()
    if (filter.status?.length) qs.set('status', filter.status.join(','))
    if (filter.source) qs.set('source', filter.source)
    if (filter.scheduledTaskId) qs.set('scheduledTaskId', filter.scheduledTaskId)
    if (filter.limit) qs.set('limit', String(filter.limit))
    const q = qs.toString()
    return this.request<TaskListPage>('GET', `/tasks${q ? `?${q}` : ''}`)
      .then((page) => {
        const tasks = selectTasks(page.tasks, filter)
        return { tasks, count: tasks.length }
      })
  }

  /**
   * Cockpit strip — context occupancy, compaction state, cache-hit and cost. Only
   * available while an agent is built for the session: an archived or never-run
   * session answers 404 'Session agent not built yet', so callers must treat 404 as
   * "no live cockpit", not as an error to surface.
   */
  cockpit(id: string): Promise<CockpitSnapshot> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/cockpit`)
  }

  private async postJson(path: string, body: unknown, ...conflictStatuses: number[]): Promise<unknown | 'conflict'> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (conflictStatuses.includes(res.status)) return 'conflict'
    if (!res.ok) await rejectWith(res, `POST ${path}`)
    return res.status === 204 ? {} : await res.json().catch(() => ({}))
  }

  private async postExpectingBusy(path: string, body: unknown): Promise<BusyResult> {
    const out = await this.postJson(path, body, 409)
    return out === 'conflict' ? 'busy' : 'ok'
  }
}
