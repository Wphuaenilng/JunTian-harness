/**
 * Session SSE connection — generations, seq dedupe, reconnect (plan §4.3 #1/#2).
 *
 * One connection = one generation. A reconnect starts a new generation and the
 * consumer must drop anything partial it built under the old one, because the
 * server replays from `?since=` and the two views would otherwise overlap.
 *
 * EventSource is not usable here: the sidecar is Bearer-authed and EventSource
 * cannot set an Authorization header. So this is fetch + ReadableStream, which
 * also means the token can be injected by the same-origin proxy instead.
 */
import type { SessionEvent } from './protocol-types.ts'
import { classifyStreamEvent } from './stream-accept.ts'
import { categorize, type EventCategory } from './event-category.ts'
import { classifyReplayGap, parseReplayWindow, type ReplayGap, type ReplayWindow } from './replay-gap.ts'
import { forEachSseFrame } from './sse-frames.ts'

/** Live handoff marker: session-routes.ts:1825 sends approval_snapshot immediately before `catchingUp = false`. */
const LIVE_HANDOFF_EVENT = 'approval_snapshot'

export type StreamPhase = 'connecting' | 'replay' | 'live' | 'down'

export interface StreamedEvent {
  event: SessionEvent
  category: EventCategory
  generation: number
  /** Whether this event arrived inside the connect replay or after the handoff. */
  phase: 'replay' | 'live'
}

export interface SessionStreamOptions {
  baseUrl: string
  token: string
  sessionId: string
  /** 0 = cold open, full replay window. Otherwise resume after that seq. */
  since?: number
  /** Ties this socket to E4 delegate capabilities; teardown clears the slot. */
  clientId?: string
  onEvent?: (ev: StreamedEvent) => void
  onPhase?: (phase: StreamPhase, generation: number) => void
  /**
   * Once per connection: whether this generation's resume point actually missed events.
   * The judgement reads the server's `replay_window` and the merged-run `streamStartSeq`, so a
   * compacted replay is never reported as loss — see `replay-gap.ts`.
   */
  onGap?: (gap: ReplayGap, generation: number) => void
  /**
   * §4.3 #2 的 REST 兜底：SSE 通道还没回来时，先拿落盘日志的尾段把时间线推上去，
   * 别让界面在断线期间冻在最后一个事件上。游标归传输层持有，所以**由它来拉**：拉回来的
   * 事件走与回放完全相同的去重与推进路径，于是通道恢复后 `?since=` 用的就是被推进过的游标，
   * 同一批 seq 不会被投第二次，宿主的分类计数也不会被推两遍。
   */
  pullRest?: (since: number) => Promise<SessionEvent[]>
  /** 连续失败到第几次开始拉兜底（默认 2——约等于断线 1.5 秒之后；节奏由退避本身限制）。 */
  restFallbackAfterAttempt?: number
  minBackoffMs?: number
  maxBackoffMs?: number
  /**
   * Reconnect-pacing seams, existing so §4.3 #2's numbers can be asserted without waiting on
   * wall clocks: `rand` replaces the jitter draw, `sleepMs` replaces the wait itself. Defaults are
   * the production behaviour (`Math.random` and `setTimeout`).
   */
  rand?: () => number
  sleepMs?: (ms: number) => Promise<void>
}

/**
 * §4.3 #2: the reconnect wait's ceiling for a given run of *consecutive* failures — doubling from
 * `minBackoffMs` and saturating at `maxBackoffMs`. What the loop actually waits is a full-jitter
 * draw over `[0, ceiling]`, and the run resets the moment a connection delivers anything, so a
 * long healthy period is never punished with a saturated first retry.
 */
export function reconnectCeiling(attempt: number, minBackoffMs: number, maxBackoffMs: number): number {
  return Math.min(minBackoffMs * 2 ** Math.max(0, attempt), maxBackoffMs)
}

export type CloseStream = () => void

export function openSessionStream(opts: SessionStreamOptions): CloseStream {
  const minBackoff = opts.minBackoffMs ?? 500
  const maxBackoff = opts.maxBackoffMs ?? 10_000
  const restAfter = opts.restFallbackAfterAttempt ?? 2
  const rand = opts.rand ?? Math.random
  const sleepMs = opts.sleepMs ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const controller = new AbortController()
  let cancelled = false
  let generation = 0
  let lastSeq = opts.since ?? 0

  const emitPhase = (phase: StreamPhase): void => { opts.onPhase?.(phase, generation) }

  const connect = async (): Promise<void> => {
    // 连续失败次数（不是"这条流重连过几次"）：任何一帧到达都归零，见下面 readSse 的复位。
    let attempt = 0
    while (!cancelled) {
      generation += 1
      const myGeneration = generation
      let phase: 'replay' | 'live' = 'replay'
      // Per-connection facts the gap judgement needs, captured before anything moves them.
      const cursorAtConnect = lastSeq
      let replayWindow: ReplayWindow | undefined
      let gapJudged = false
      emitPhase('connecting')
      try {
        const qs = new URLSearchParams({ since: String(lastSeq) })
        if (opts.clientId) qs.set('clientId', opts.clientId)
        const res = await fetch(
          `${opts.baseUrl}/sessions/${encodeURIComponent(opts.sessionId)}/stream?${qs}`,
          { headers: { authorization: `Bearer ${opts.token}` }, signal: controller.signal },
        )
        if (cancelled) {
          await res.body?.cancel()
          return
        }
        if (!res.ok || !res.body) throw new Error(`/stream → ${res.status}`)
        emitPhase('replay')
        await readSse(res.body, (raw) => {
          if (cancelled) return
          // §4.3 #2 的复位。阶梯按「本次断线连续失败几次」算，而不是按这条流历史上总共
          // 重连过几次——否则健康跑了一小时之后第一次断线，也要等满 10 秒才回来。
          // 任何一帧到达都证明这条连接能用，所以每帧都归零。
          attempt = 0
          const kind = classifyStreamEvent(raw.seq, lastSeq)
          // seq=0 meta events (replay_window / job_snapshot / delegation_snapshot /
          // approval_snapshot) pass through without moving lastSeq — they are
          // authoritative snapshots, not timeline entries.
          if (kind === 'dup') return
          const data = (raw.data ?? {}) as Record<string, unknown>
          if (kind === 'meta' && raw.type === 'replay_window') replayWindow = parseReplayWindow(data)
          if (kind === 'next' && !gapJudged) {
            gapJudged = true
            opts.onGap?.(classifyReplayGap({
              cursor: cursorAtConnect,
              window: replayWindow,
              firstSeq: raw.seq,
              firstStreamStartSeq: typeof data.streamStartSeq === 'number' ? data.streamStartSeq : undefined,
            }), myGeneration)
          }
          if (kind === 'next') lastSeq = raw.seq
          if (raw.type === LIVE_HANDOFF_EVENT && raw.seq === 0 && phase === 'replay') {
            phase = 'live'
            emitPhase('live')
          }
          opts.onEvent?.({
            event: raw,
            category: categorize(raw.type),
            generation: myGeneration,
            phase,
          })
        }, controller.signal)
        if (phase === 'replay') {
          // No handoff marker on this runtime (pre-approval_snapshot builds): the
          // stream is still usable, so do not strand the UI in 'replay' forever.
          phase = 'live'
          emitPhase('live')
        }
      } catch {
        if (cancelled) return
      }
      if (cancelled) return
      emitPhase('down')
      // §4.3 #2 的兜底：这一轮没连上，就先问 REST 要尾段。放在退避之前、每次退避都允许拉，
      // 是因为拉的节奏本来就等于退避节奏（最长 10 秒一发），而空尾段就是一次廉价 no-op。
      if (opts.pullRest && attempt >= restAfter) {
        try {
          for (const raw of await opts.pullRest(lastSeq)) {
            if (cancelled) return
            const kind = classifyStreamEvent(raw.seq, lastSeq)
            if (kind === 'dup') continue
            if (kind === 'next') lastSeq = raw.seq
            opts.onEvent?.({ event: raw, category: categorize(raw.type), generation: myGeneration, phase: 'replay' })
          }
        } catch {
          // 兜底那一发没拉到**不算故障**：SSE 自己还在退避重试，状态条已经是「断线」了，
          // 这里再抛只会把退避循环弄死——那正是这条兜底要防的那件事。
        }
      }
      // Full jitter, not equal jitter: many tabs reconnecting at once would
      // otherwise stampede a sidecar that is already recovering.
      const delay = rand() * reconnectCeiling(attempt, minBackoff, maxBackoff)
      attempt += 1
      await sleepMs(delay)
    }
  }

  void connect()
  return () => {
    cancelled = true
    controller.abort()
  }
}

/** Frames are `event: <type>` + `data: <SessionEvent json>`, separated by a blank line; `:` lines are keepalives.
 *  分帧本身住在 `sse-frames.ts`（两条流共用一份），这里只留**会话流自己的形状判定**：一帧要落到
 *  调用方，必须是 `{seq:number, type:string}`。全局 `/events` 的帧没有 `seq`，所以那条走另一套判定，
 *  不能把这个函数当成两条流的公共解析器（见 `sse-frames.ts` 头部那段理由）。 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SessionEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  await forEachSseFrame(body, signal, (data) => {
    try {
      const ev = JSON.parse(data) as SessionEvent
      if (typeof ev?.seq === 'number' && typeof ev?.type === 'string') onEvent(ev)
    } catch {
      // Unparseable frame: ignore rather than kill the stream (forward compat).
    }
  })
}
