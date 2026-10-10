/**
 * GET /events — the sidecar-wide channel.
 *
 * Verified against a live runtime (not assumed): frames are `event: hello` with
 * `{kind:'hello', heartbeatMs:5000}` followed by `event: health` every 5 seconds
 * carrying the full HealthBody. It has no `seq` and no replay semantics, so it is
 * NOT the session timeline: it is a liveness + invalidation signal. sessionCount
 * and runningCount on that heartbeat are what tell the sidebar to re-read /sessions.
 */
import type { HealthBody } from './sidecar-client.ts'

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
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
            if (!data) continue
            try {
              opts.onEvent?.(JSON.parse(data) as ServerEvent)
            } catch {
              // Unknown frame shape: keep the connection, drop the frame.
            }
          }
        }
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
