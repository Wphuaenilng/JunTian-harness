/**
 * Scheduled-automation wire shapes — transcribed from `cron-scheduler.ts:80-110`
 * and `scheduled-task-model.ts`.
 *
 * Two details the board must not paper over:
 *  - `status` vs `enabled`: lifecycle is `status`, but the runtime keeps `enabled`
 *    as a mirror for old persisted rows (`enabled = status === 'active'`). A task can
 *    therefore be `status: undefined` on data written before #236 — derive, don't assume.
 *  - `cwd` is snapshotted at creation. The desktop hosts several projects on one
 *    sidecar, so without that snapshot every automation would fire in the sidecar's
 *    launch directory.
 */

/** cron-scheduler.ts:59 */
export type CronTriggerType =
  | 'interval' | 'cron' | 'oneshot'
  | 'startup' | 'app-open' | 'file-change' | 'git-push' | 'focus-change'

/** Event triggers may omit `spec`; time triggers must not (schedule-routes.ts:155-160). */
export interface CronTrigger {
  type: CronTriggerType
  spec?: string
}

/** scheduled-task-model.ts:16 */
export interface ScheduledTaskRetry {
  attempts?: number
  backoffMs?: number
  [k: string]: unknown
}

/** scheduled-task-model.ts:30 */
export type ReviewPolicy = 'always-review' | 'first-runs' | 'auto-proceed'

/** scheduled-task-model.ts:44 */
import type { TaskRecord } from './task-types.ts'

export type ScheduledTaskStatus = 'active' | 'paused' | 'stopped'

export interface ScheduledTask {
  id: string
  prompt: string
  allowedTools: string[]
  trigger: CronTrigger
  recurringMaxAgeMs?: number
  agentId?: string
  /** ISO string. */
  createdAt: string
  lastTriggeredAt?: string
  triggerCount: number
  status?: ScheduledTaskStatus
  enabled?: boolean
  retry?: ScheduledTaskRetry
  reviewPolicy?: ReviewPolicy
  /** Narrowed to auto-accept / auto-safe when set (issue #259). */
  approval?: string
  cwd?: string
}

/**
 * GET /schedule/status — `persistence` was added so the board's 30s poll can also
 * notice "the last save never hit the disk", rather than only flagging it at save time.
 */
export interface ScheduleStatus {
  status: {
    schedulerRunning: boolean
    lockOwner: boolean
    activeTasks: number
    scheduledCount: number
  }
  persistence?: { path: string; ok: boolean }
}

/** POST /schedule — schedule-routes.ts:142-161. */
export interface CreateScheduleRequest {
  prompt: string
  trigger: CronTrigger
  allowedTools?: string[]
  agentId?: string
  retry?: ScheduledTaskRetry
  reviewPolicy?: ReviewPolicy
  approval?: string
}

/**
 * PATCH /schedule/:id — scheduled-task-model.ts:79-88. Tri-state on the optional
 * fields: `undefined` = leave alone, `null` = clear, value = overwrite. Genuinely a
 * three-state API, so callers must not send `undefined` as "no change" via spread.
 * Requires `capabilities.schedulePatch` (this build reports true, issue #266).
 */
export interface SchedulePatch {
  prompt?: string
  trigger?: CronTrigger
  allowedTools?: string[]
  reviewPolicy?: ReviewPolicy | null
  retry?: ScheduledTaskRetry | null
  agentId?: string | null
  approval?: string | null
}

/** GET /tasks — background job registry. */
export interface TaskListPage {
  /** Real records, not `unknown[]`: the board renders status/source/timing from them. */
  tasks: TaskRecord[]
  count: number
}

/** Derived lifecycle, mirroring the server's resolveTaskStatus precedence. */
export function effectiveStatus(task: ScheduledTask): ScheduledTaskStatus {
  if (task.status) return task.status
  return task.enabled === false ? 'paused' : 'active'
}
