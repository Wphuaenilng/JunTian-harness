/**
 * React-free session object layer (plan §4.3 #4).
 *
 * The message timeline is business data, so it does NOT live in the global store:
 * components subscribe to one Session, and the store only carries view state (which
 * session is open, panel collapse, theme). This keeps 44-event churn out of React
 * and makes the fold testable without a DOM — see test/session-model.test.ts, which
 * replays a real capture from a live sidecar.
 *
 * `fold` is the PartialAccumulator: deltas fold into an immutable block array, so a
 * renderer can diff by identity and only re-parse the tail.
 */
import type { ApprovalRequest, ApprovalSnapshot, SessionEvent } from './protocol-types.ts'
import type { StreamedEvent } from './session-stream.ts'
import { toolFilePath } from './tool-file.ts'

export type Block =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'text'; id: number; text: string; open: boolean }
  | { kind: 'thinking'; id: number; text: string; open: boolean }
  | {
    kind: 'tool'
    id: number
    name: string
    input: Record<string, unknown>
    callId?: string
    /** The kernel's prose receipt (`result`) — what the runtime says it did. */
    result?: string
    /**
     * The kernel's UI payload (`uiContent`): for file tools this is the real unified
     * diff, which `result` deliberately does not carry. Truncated to 2000 chars on the
     * wire (session-manager.ts:6243) — `truncated` is the server's own flag, not ours.
     */
    uiContent?: string
    truncated?: boolean
    /** Session-targetable file for single-file mutators; the before-view asks with it. */
    filePath?: string
    isError: boolean
    open: boolean
  }
  | { kind: 'error'; id: number; text: string; errorKind?: string; guidance?: string }
  /** A turn worth marking. `truncated` is the fact; the wording is the view's job. */
  | { kind: 'turn'; id: number; truncated: boolean }

export interface SessionState {
  blocks: readonly Block[]
  approvals: readonly ApprovalRequest[]
  /** state/custom categories are last-wins snapshots, keyed by event type. */
  snapshots: Readonly<Record<string, Record<string, unknown>>>
  running: boolean
  lastSeq: number
  /** Lowest timeline seq we hold — what to ask `before=` with. 0 = nothing yet. */
  oldestSeq: number
  /** Set when the run ended failed/aborted — drives the composer's 继续 affordance. */
  terminalStatus?: string
}

/**
 * Whether the in-memory replay window is missing the head of the on-disk log — the
 * only signal that a "load earlier" affordance should appear. `replay_window` is the
 * server's own bookkeeping (protocol.ts:202), so this is never guessed client-side.
 */
export function shouldOfferEarlier(win: Record<string, unknown> | undefined): boolean {
  if (!win) return false
  const floorSeq = Number(win.floorSeq ?? 0)
  const diskFirstSeq = Number(win.diskFirstSeq ?? floorSeq)
  return diskFirstSeq > 0 && floorSeq > 0 && diskFirstSeq < floorSeq
}

const emptyState = (): SessionState => ({
  blocks: [],
  approvals: [],
  snapshots: {},
  running: false,
  lastSeq: 0,
  oldestSeq: 0,
})

export class SessionModel {
  private state: SessionState = emptyState()
  private nextId = 1
  private readonly listeners = new Set<(s: SessionState) => void>()
  /**
   * Timeline events in seq order (seq=0 synthetics excluded). Kept so an older page
   * fetched from the cold channel can be replayed into a clean fold instead of being
   * spliced into already-derived blocks, which would break open/pairing state.
   */
  private log: SessionEvent[] = []
  private replaying = false
  /**
   * Gates this client has already seen resolved. A REST/snapshot poll can arrive out of
   * order — the server's list was taken before the answer landed — and without this the
   * card the user just dismissed would come back for up to a poll interval. Resolution is
   * monotone within a session view, so the set is never cleared.
   */
  private readonly resolvedRequestIds = new Set<string>()

  private dropResolved(list: readonly ApprovalRequest[]): readonly ApprovalRequest[] {
    if (this.resolvedRequestIds.size === 0) return list
    return list.filter((a) => !this.resolvedRequestIds.has(a.requestId))
  }

  get current(): SessionState {
    return this.state
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  /** Bootstrap from a REST event page (cold open before the stream attaches). */
  loadEvents(events: readonly SessionEvent[]): void {
    for (const ev of events) this.applyEvent(ev)
  }

  apply(streamed: StreamedEvent): void {
    this.applyEvent(streamed.event)
  }

  /**
   * Cold-channel back-fill: prepend a page of events older than what we hold and
   * re-derive the timeline. Returns how many events were actually new, so the UI can
   * stop asking once the disk is exhausted (plan M2 历史向上分页, triggered by
   * replay_window's diskFirstSeq < floorSeq).
   */
  prependEvents(events: readonly SessionEvent[]): number {
    const have = new Set(this.log.map((e) => e.seq))
    const older = events.filter((e) => e.seq > 0 && !have.has(e.seq))
    if (older.length === 0) return 0
    const bySeq = [...older, ...this.log].sort((a, b) => a.seq - b.seq)
    this.log = bySeq
    const keepLastSeq = this.state.lastSeq
    this.replaying = true
    try {
      this.state = emptyState()
      for (const ev of bySeq) this.applyEvent(ev)
    } finally {
      this.replaying = false
    }
    this.mutate((s) => ({ ...s, lastSeq: Math.max(keepLastSeq, s.lastSeq) }))
    return older.length
  }

  /**
   * Cold-start authority for pending gates: the REST snapshot, not the event ring.
   * An empty list is a clear signal, so it must still replace what we held.
   */
  applySnapshot(snap: ApprovalSnapshot): void {
    this.mutate((s) => ({ ...s, approvals: this.dropResolved(Array.isArray(snap.approvals) ? snap.approvals : []) }))
  }

  /**
   * A new connection invalidates whatever the previous generation was mid-render of
   * (§4.3 #1): the partial stays as history but stops absorbing deltas, so a replay
   * that re-delivers text cannot double-append it.
   */
  sealGeneration(): void {
    this.mutate((s) => ({ ...s, blocks: s.blocks.map((b) => ('open' in b ? { ...b, open: false } : b)) }))
  }

  private notify(next: SessionState): void {
    this.state = next
    for (const fn of this.listeners) fn(next)
  }

  private mutate(fn: (s: SessionState) => SessionState): void {
    this.notify(fn(this.state))
  }

  private applyEvent(ev: SessionEvent): void {
    const d = (ev.data ?? {}) as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    // seq=0 is synthetic-meta territory and must not move the cursor (same rule as
    // stream-accept); dedupe already happened upstream, so this is a plain max.
    if (ev.seq > this.state.lastSeq) this.state = { ...this.state, lastSeq: ev.seq }
    if (ev.seq > 0 && (this.state.oldestSeq === 0 || ev.seq < this.state.oldestSeq)) {
      this.state = { ...this.state, oldestSeq: ev.seq }
    }
    if (!this.replaying && ev.seq > 0) this.log.push(ev)

    switch (ev.type) {
      case 'user':
        this.mutate((s) => ({ ...s, blocks: [...this.closeOpen(s.blocks), { kind: 'user', id: this.nextId++, text: str(d.text) }] }))
        return
      case 'text_delta':
        this.appendTail('text', str(d.text ?? d.delta ?? d.textDelta))
        return
      case 'thinking_delta':
        this.appendTail('thinking', str(d.text ?? d.delta ?? d.thinking))
        return
      case 'tool_use': {
        const name = str(d.name ?? d.toolName) || 'tool'
        const input = (d.input ?? d.args ?? {}) as Record<string, unknown>
        const callId = str(d.id ?? d.toolUseId) || undefined
        const filePath = toolFilePath(name, input)
        this.mutate((s) => ({
          ...s,
          blocks: [...this.closeOpen(s.blocks), {
            kind: 'tool',
            id: this.nextId++,
            name,
            input,
            ...(callId ? { callId } : {}),
            ...(filePath ? { filePath } : {}),
            isError: false,
            open: true,
          }],
        }))
        return
      }
      case 'tool_result': {
        const content = str(d.content ?? d.result ?? d.output)
        const uiContent = str(d.uiContent) || undefined
        const truncated = d.outputTruncated === true
        const callId = str(d.toolUseId ?? d.id) || undefined
        const isError = d.isError === true
        this.mutate((s) => {
          const idx = findToolToClose(s.blocks, callId)
          if (idx < 0) {
            // No matching tool_use in this window (older runtime, or the call scrolled
            // out of the replay): surface it standalone rather than dropping it. The
            // name is left empty for the view to label — client-core holds no wording.
            return {
              ...s,
              blocks: [...this.closeOpen(s.blocks), {
                kind: 'tool',
                id: this.nextId++,
                name: str(d.name),
                input: {},
                result: content,
                ...(uiContent ? { uiContent } : {}),
                ...(truncated ? { truncated: true } : {}),
                isError,
                open: false,
              }],
            }
          }
          const blocks = s.blocks.slice()
          const target = blocks[idx] as Extract<Block, { kind: 'tool' }>
          blocks[idx] = {
            ...target,
            result: content,
            ...(uiContent ? { uiContent } : {}),
            ...(truncated ? { truncated: true } : {}),
            isError,
            open: false,
          }
          return { ...s, blocks }
        })
        return
      }
      case 'error':
        this.mutate((s) => ({
          ...s,
          blocks: [...this.closeOpen(s.blocks), {
            kind: 'error',
            id: this.nextId++,
            text: str(d.error),
            ...(typeof d.kind === 'string' ? { errorKind: d.kind } : {}),
            ...(typeof d.guidance === 'string' ? { guidance: d.guidance } : {}),
          }],
        }))
        return
      case 'turn_complete': {
        // Only an unusual turn end produces a divider, and the model carries the fact
        // rather than a sentence — client-core is React-free and language-free (plan §4.3 #4).
        const truncated = d.stopReason === 'max_tokens'
        this.mutate((s) => {
          const closed = this.closeOpen(s.blocks)
          return {
            ...s,
            blocks: truncated ? [...closed, { kind: 'turn', id: this.nextId++, truncated: true }] : closed,
            running: true,
          }
        })
        return
      }
      case 'approval_required': {
        const req = (d.approval ?? d) as unknown as ApprovalRequest
        if (typeof req?.requestId !== 'string') return
        // Same ordering defence as the snapshot paths: a replay can hand us the request
        // frame after we already folded its resolution.
        if (this.resolvedRequestIds.has(req.requestId)) return
        this.mutate((s) => ({ ...s, approvals: upsertApproval(s.approvals, req) }))
        return
      }
      case 'approval_resolved': {
        const requestId = str(d.requestId)
        if (requestId) this.resolvedRequestIds.add(requestId)
        this.mutate((s) => ({ ...s, approvals: s.approvals.filter((a) => a.requestId !== requestId) }))
        return
      }
      case 'approval_snapshot': {
        // Authoritative full set — including the empty list, which is the clear signal
        // (pending approvals survive event-ring eviction; REST/snapshot is ground truth).
        const list = Array.isArray(d.approvals) ? (d.approvals as ApprovalRequest[]) : []
        this.mutate((s) => ({ ...s, approvals: this.dropResolved(list) }))
        return
      }
      case 'status':
        if (d.status === 'running') this.mutate((s) => ({ ...s, running: true }))
        return
      case 'done': {
        const status = str(d.status)
        this.mutate((s) => ({
          ...s,
          running: false,
          blocks: this.closeOpen(s.blocks),
          ...(status ? { terminalStatus: status } : {}),
        }))
        return
      }
      case 'replay_window': {
        // Cold open (since=0) replaces the window; a resume only re-reads the tail.
        const floorSeq = Number(d.floorSeq ?? 0)
        if (this.state.lastSeq === 0 && floorSeq <= 1) this.notify({ ...emptyState(), lastSeq: 0 })
        this.mutate((s) => ({ ...s, snapshots: { ...s.snapshots, replay_window: d } }))
        return
      }
      default: {
        // Every other event is a state/custom snapshot: last one per type wins, so
        // panels read a stable shape instead of a growing log.
        this.mutate((s) => ({ ...s, snapshots: { ...s.snapshots, [ev.type]: d } }))
      }
    }
  }

  /** Append to the open tail block of this kind, or start one (immutable replace). */
  private appendTail(kind: 'text' | 'thinking', delta: string): void {
    if (!delta) return
    this.mutate((s) => {
      const tail = s.blocks.at(-1)
      if (tail && tail.kind === kind && tail.open) {
        const blocks = s.blocks.slice(0, -1).concat({ ...tail, text: tail.text + delta })
        return { ...s, blocks }
      }
      const fresh: Block = kind === 'text'
        ? { kind: 'text', id: this.nextId++, text: delta, open: true }
        : { kind: 'thinking', id: this.nextId++, text: delta, open: true }
      return { ...s, blocks: [...this.closeOpen(s.blocks), fresh] }
    })
  }

  private closeOpen(blocks: readonly Block[]): readonly Block[] {
    return blocks.some((b) => 'open' in b && b.open) ? blocks.map((b) => ('open' in b ? { ...b, open: false } : b)) : blocks
  }
}

function findToolToClose(blocks: readonly Block[], callId: string | undefined): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b?.kind === 'tool' && b.open && (callId === undefined || b.callId === callId || !b.callId)) return i
  }
  return -1
}

function upsertApproval(list: readonly ApprovalRequest[], req: ApprovalRequest): readonly ApprovalRequest[] {
  return list.some((a) => a.requestId === req.requestId) ? list : [...list, req]
}
