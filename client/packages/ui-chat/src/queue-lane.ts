/** Snapshot bags are keyed by event type and hold only what this session reported, so every read
 *  here is against a possibly-missing bag with possibly-missing fields. */
export type SnapshotBag = Record<string, unknown> | undefined

const text = (d: SnapshotBag, k: string): string => {
  const v = d?.[k]
  return typeof v === 'string' ? v : ''
}

/**
 * Is the lane behind a `queue_pending` snapshot still waiting?
 *
 * The kernel echoes `queue_status` naming the lane it took out of the queue: `steered` when it is
 * folded into the running turn, `retracted` after a successful retract, `merged` per entry at the
 * next prompt — and all three mean "no longer queued", which is also what makes a second retract
 * answer 409 (`lane_not_queued`). So the lane id alone decides; the status word adds nothing the
 * panel could act on.
 *
 * This is why the retract button can disappear without the client keeping any queue state of its
 * own: the retract that succeeded arrives back over the same event stream the panel already folds.
 */
export function laneIsWaiting(pending: SnapshotBag, laneStatus: SnapshotBag): boolean {
  const laneId = text(pending, 'laneId')
  return laneId !== '' && text(laneStatus, 'laneId') !== laneId
}
