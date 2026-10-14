/**
 * Is a reconnect's resume point actually missing events, and if so can they still be read?
 *
 * The naive test — "the first seq I got is more than cursor+1, so I lost a stretch" — is wrong
 * on this protocol, for a reason that is visible only in the kernel:
 *
 *  - `src/server/replay-compaction.ts` `mergeRun()` collapses a run of consecutive
 *    `text_delta` / `thinking_delta` events into ONE event carrying `seq: last.seq`. So a replay
 *    legitimately jumps: seqs 10..13 did not vanish, their text is inside the event stamped 14,
 *    and that event says so via `data.streamStartSeq`.
 *  - `src/server/session-manager.ts:2124` `getReplayWindow()` reports the window in the server's
 *    own words — `floorSeq` (oldest still in the in-memory ring), `diskFirstSeq` (oldest still on
 *    disk), `diskLastSeq` (highest seq ever assigned). Whether a hole is *readable* is answered by
 *    those numbers, never by seq arithmetic on what arrived.
 *
 * So: a hole is real only when the retained head starts after what we still need AND no merged
 * run bridges it; and it is only *lost* when the disk no longer covers it either. The middle case
 * is the existing 「加载更早的历史」 cold channel, not a warning.
 */
export interface ReplayWindow {
  floorSeq: number
  diskFirstSeq: number
  diskLastSeq: number
}

export type ReplayGap =
  /** Nothing to report, with the reason kept so the UI can stay honest about *why* it is silent. */
  | { kind: 'none'; reason: 'cold-open' | 'no-window' | 'no-delivery' | 'at-head' | 'contiguous' | 'bridged-by-merge' }
  /** The ring dropped them, the log still has them — page them in instead of warning. */
  | { kind: 'earlier-on-disk'; from: number; to: number }
  /** Neither the ring nor the disk holds them: the timeline has a hole the user must see. */
  | { kind: 'lost'; from: number; to: number }

/** `replay_window`'s `data` is `Record<string, unknown>` on the wire; read it defensively. */
export function parseReplayWindow(d: Record<string, unknown> | undefined): ReplayWindow | undefined {
  if (!d) return undefined
  const floorSeq = Number(d.floorSeq ?? 0)
  const diskFirstSeq = Number(d.diskFirstSeq ?? floorSeq)
  const diskLastSeq = Number(d.diskLastSeq ?? 0)
  if (!Number.isFinite(floorSeq) || !Number.isFinite(diskLastSeq)) return undefined
  return { floorSeq, diskFirstSeq: Number.isFinite(diskFirstSeq) ? diskFirstSeq : floorSeq, diskLastSeq }
}

export function classifyReplayGap(input: {
  /** The cursor this generation connected with (`?since=`). */
  cursor: number
  /** This generation's `replay_window`, if the runtime sent one. */
  window?: ReplayWindow | undefined
  /** Seq of the first timeline event delivered this generation. */
  firstSeq?: number | undefined
  /** That event's `data.streamStartSeq`, set when a delta run was merged into it. */
  firstStreamStartSeq?: number | undefined
}): ReplayGap {
  const { cursor, window, firstSeq } = input
  // A cold open has no expectation to be unmet: the whole window is the delivery.
  if (cursor <= 0) return { kind: 'none', reason: 'cold-open' }
  // Without the server's own numbers there is nothing sound to say. Guessing here is how a
  // compacted replay gets reported as data loss.
  if (!window) return { kind: 'none', reason: 'no-window' }
  const need = cursor + 1
  if (need > window.diskLastSeq) return { kind: 'none', reason: 'at-head' }
  if (firstSeq === undefined) return { kind: 'none', reason: 'no-delivery' }
  const bridge = input.firstStreamStartSeq !== undefined && input.firstStreamStartSeq < firstSeq
  const start = bridge ? input.firstStreamStartSeq! : firstSeq
  if (start <= need) return { kind: 'none', reason: bridge ? 'bridged-by-merge' : 'contiguous' }
  return window.diskFirstSeq <= need
    ? { kind: 'earlier-on-disk', from: need, to: start - 1 }
    : { kind: 'lost', from: need, to: start - 1 }
}
