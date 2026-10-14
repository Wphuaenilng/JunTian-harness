/**
 * GET /events — the sidecar-wide channel.
 *
 * Verified against a live runtime (not assumed): frames are `event: hello` with
 * `{kind:'hello', heartbeatMs:5000}` followed by `event: health` every 5 seconds
 * carrying the full HealthBody. That reading is no longer a hand-run note — it is a
 * standing judgement now: `scripts/verify-rest-surface.mjs` derives this exact call
 * site from source, opens the stream against a keyless sidecar, and asserts the first
 * two frames are `hello` then `health` (plus a 401 when the token is missing).
 * It has no `seq` and no replay semantics, so it is
 * NOT the session timeline: it is a liveness + invalidation signal. sessionCount
 * and runningCount on that heartbeat are what tell the sidebar to re-read /sessions.
 */
import type { HealthBody } from './sidecar-client.ts'
import { forEachSseFrame } from './sse-frames.ts'

export type ServerEvent =
  | { kind: 'hello'; ts: number; heartbeatMs: number }
  | { kind: 'health'; ts: number; data: HealthBody }

export interface ServerEventsOptions {
  baseUrl: string
  token: string
  onEvent?: (ev: ServerEvent) => void
  onPhase?: (phase: 'connecting' | 'live' | 'down') => void
}

export function openServerEvents(opts: ServerEventsOptions): () => void {
  const controller = new AbortController()
  let cancelled = false
  let backoff = 500

  const loop = async (): Promise<void> => {
    while (!cancelled) {
      opts.onPhase?.('connecting')
      try {
        const res = await fetch(`${opts.baseUrl}/events`, {
          headers: { authorization: `Bearer ${opts.token}`, accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`/events → ${res.status}`)
        opts.onPhase?.('live')
        backoff = 500
        // 分帧走两条流共用的那一份（`sse-frames.ts`）。这里的判定与 `readSse` **必须不同**：
        // 全局流的帧是 `{kind, ts, …}`，没有 `seq`，也没有回放语义——它是一次心跳信号，不是时间线。
        await forEachSseFrame(res.body, controller.signal, (data) => {
          if (cancelled) return
          try {
            opts.onEvent?.(JSON.parse(data) as ServerEvent)
          } catch {
            // Unknown frame shape: keep the connection, drop the frame.
          }
        })
      } catch {
        if (cancelled) return
      }
      if (cancelled) return
      opts.onPhase?.('down')
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(backoff, 10_000)))
      backoff = Math.min(backoff * 2, 10_000)
    }
  }
  void loop()
  return () => {
    cancelled = true
    controller.abort()
  }
}
