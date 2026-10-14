import type { SessionEventType } from './protocol-types.ts'

/**
 * The snapshot keys a view is allowed to name.
 *
 * `SessionModel` folds the `state`/`custom` categories into a bag keyed by **protocol event type**
 * (`snapshots: Record<string, Record<string, unknown>>`). That is the one place where the wire
 * vocabulary has to exist, so it is also the one place it should be *written down*: a panel that
 * types `snapshots.context_budget` is a panel that knows a protocol event name, and plan §4.1's
 * 「ui-* 只面对五类事件，不见 sidecar 原始协议」 would be true of the transport only.
 *
 * So the names live here, once, and `check:layers` fails if a UI package spells one directly.
 * Values are checked against the generated mirror: a protocol rename stops compiling here instead
 * of silently leaving a panel reading `undefined`.
 */
export const SNAP = {
  contextBudget: 'context_budget',
  phase: 'phase',
  status: 'status',
  done: 'done',
  queuePending: 'queue_pending',
  queueStatus: 'queue_status',
  goalState: 'goal_state',
  domainUsage: 'domain_usage',
  landing: 'landing',
  hookResult: 'hook_result',
  replayWindow: 'replay_window',
} as const

/** Read one snapshot without spelling the wire name outside this module. */
export function snapshotOf(
  bag: Readonly<Record<string, Record<string, unknown>>>,
  key: (typeof SNAP)[keyof typeof SNAP],
): Record<string, unknown> | undefined {
  return bag[key]
}

/** Compile-time proof that every key above is still a real event type in this build's mirror. */
const snapshotKeysAreReal: SessionEventType[] = Object.values(SNAP)
void snapshotKeysAreReal

/** Every snapshot the panel renders with meaning; anything outside this set still shows, raw. */
export const TYPED_SNAPSHOT_KEYS: ReadonlySet<string> = new Set<string>(Object.values(SNAP))
