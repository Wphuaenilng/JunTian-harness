/**
 * SSE frame acceptance — ported from `vscode-extension/src/sidecar/stream-accept.ts`.
 *
 * seq=0 is reserved for synthetic meta events (replay_window / job_snapshot /
 * delegation_snapshot / approval_snapshot). They must pass through but must never
 * advance lastSeq, otherwise a reconnect replays from 0 and loses real events.
 */
export type StreamAcceptance = 'meta' | 'next' | 'dup'

export function classifyStreamEvent(evSeq: number, lastSeq: number): StreamAcceptance {
  if (evSeq === 0) return 'meta'
  if (evSeq > lastSeq) return 'next'
  return 'dup'
}
