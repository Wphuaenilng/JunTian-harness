/**
 * The wait bookkeeping behind plan M1's 「审批挂起 30s 显式提醒」, extracted so it can be
 * tested. The panel used to compute `stalled`/`hint` inline from a ref map — which meant the
 * 30-second branch could only be observed by leaving a real gate pending for 30 seconds, i.e.
 * by paying for an upstream run and deliberately not answering it. Every live approval so far
 * was answered at ~9 s, so the alarm branch was shipped unverified.
 */

/** Quiet for the first stretch, then a hint, then the alarm. Both tick in whole seconds. */
export const APPROVAL_HINT_AFTER_MS = 8_000

export interface ApprovalWait {
  /** Elapsed whole seconds shown as a quiet hint, or null. */
  hintSeconds: number | null
  /** Elapsed whole seconds shown as the loud reminder, or null. Wins over the hint. */
  stallSeconds: number | null
}

export function describeWait(waitedMs: number, stallAfterMs: number): ApprovalWait {
  const seconds = Math.floor(waitedMs / 1000)
  if (waitedMs >= stallAfterMs) return { hintSeconds: null, stallSeconds: seconds }
  if (waitedMs > APPROVAL_HINT_AFTER_MS) return { hintSeconds: seconds, stallSeconds: null }
  return { hintSeconds: null, stallSeconds: null }
}

/**
 * Keep `arrived` in sync with the currently pending ids.
 *
 * Pruning matters: an id that was answered and later reappears (a retried tool call reusing
 * the key, or a reconnect replaying the same pending set) must start its clock fresh, or the
 * panel would paint it as already-stalled on the first frame.
 */
export function syncArrivals(
  arrived: Map<string, number>,
  pendingIds: readonly string[],
  now: number,
): Map<string, number> {
  const seen = new Set(pendingIds)
  for (const id of pendingIds) if (!arrived.has(id)) arrived.set(id, now)
  for (const id of [...arrived.keys()]) if (!seen.has(id)) arrived.delete(id)
  return arrived
}
