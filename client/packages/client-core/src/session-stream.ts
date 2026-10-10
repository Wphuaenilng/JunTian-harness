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
  minBackoffMs?: number
  maxBackoffMs?: number
}

export type CloseStream = () => void

export function openSessionStream(opts: SessionStreamOptions): CloseStream {
  const minBackoff = opts.minBackoffMs ?? 500
  const maxBackoff = opts.maxBackoffMs ?? 10_000
  const controller = new AbortController()
  let cancelled = false
  let generation = 0
  let lastSeq = opts.since ?? 0

  const emitPhase = (phase: StreamPhase): void => { opts.onPhase?.(phase, generation) }

  const connect = async (): Promise<void> => {
    let backoff = minBackoff
    while (!cancelled) {
      generation += 1
      const myGeneration = generation
      let phase: 'replay' | 'live' = 'replay'
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
          const kind = classifyStreamEvent(raw.seq, lastSeq)
          // seq=0 meta events (replay_window / job_snapshot / delegation_snapshot /
          // approval_snapshot) pass through without moving lastSeq — they are
          // authoritative snapshots, not timeline entries.
          if (kind === 'dup') return
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
      // Full jitter, not equal jitter: many tabs reconnecting at once would
      // otherwise stampede a sidecar that is already recovering.
      const delay = Math.random() * Math.min(backoff, maxBackoff)
      backoff = Math.min(backoff * 2, maxBackoff)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  void connect()
  return () => {
    cancelled = true
    controller.abort()
  }
}

/** Frames are `event: <type>` + `data: <SessionEvent json>`, separated by a blank line; `:` lines are keepalives. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SessionEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done || signal.aborted) return
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        try {
          const ev = JSON.parse(dataLines.join('\n')) as SessionEvent
          if (typeof ev?.seq === 'number' && typeof ev?.type === 'string') onEvent(ev)
        } catch {
          // Unparseable frame: ignore rather than kill the stream (forward compat).
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
