/**
 * 「速度」— the mockup's *first* status-bar cell (`⚡ 42 tok/s`,
 * `analysis-reports/定稿-天枢客户端方案/design/desktop-mockup-dsh-style.html:736`).
 *
 * The kernel has no rate: `src/tui/cockpit/types.ts` and `src/server/protocol.ts` carry no
 * `speed` / `perSec` / `tps` field (the only `durationMs` there is per tool call, not per turn).
 * So this is a **client-side sample** of two consecutive cockpit polls — newly added
 * `model.outputTokens` over the wall time between the two responses. Both inputs are the
 * kernel's own numbers: nothing is estimated from text length, and the interval is measured
 * rather than assumed to be the 10s timer (a slow response shifts it).
 */
export interface ThroughputSample {
  /** `model.outputTokens` as reported by the kernel. */
  outputTokens: number
  /** Epoch ms of the instant this reading was taken. */
  atMs: number
}

/** Tokens per second between two polls, or null when no rate can be claimed. */
export function tokensPerSecond(prev: ThroughputSample | null, next: ThroughputSample): number | null {
  if (prev === null) return null
  const dtMs = next.atMs - prev.atMs
  if (!(dtMs > 0)) return null
  const dTok = next.outputTokens - prev.outputTokens
  // No new output is not a speed of 0, and a backwards counter means the agent was rebuilt
  // (so the totals restarted). Either way there is no rate to report — the cell disappears
  // instead of reading like a model that went slow.
  if (!(dTok > 0)) return null
  return (dTok / dtMs) * 1000
}

/** The drawing's format: whole tok/s; a real-but-sub-1 rate says `<1` rather than `0`. */
export function formatThroughput(tps: number | null): string | null {
  if (tps === null || !(tps > 0)) return null
  return tps < 1 ? '<1 tok/s' : `${Math.round(tps)} tok/s`
}
