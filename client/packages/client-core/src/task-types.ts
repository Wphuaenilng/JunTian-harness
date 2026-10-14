/**
 * Background-job types — a hand mirror of the sidecar's task records, following the same
 * rule as `request-types.ts`: transcribed from the route's own validation points with the
 * source line, because these shapes are not in the contract leaf (`protocol.ts`) and the
 * generator cannot reach them.
 */
import type { ApprovalRequest } from './protocol-types.ts'

/** `src/server/task-store.ts:18` — cancelled > timed_out > failed > completed. */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

/** `src/server/task-store.ts:42`. */
export type TaskSource = 'api' | 'cron' | 'manual' | 'internal'

/**
 * `src/server/task-store.ts:44-88`. Timestamps are ISO strings here, unlike `ScheduledTask`
 * which uses epoch numbers — reading both in one panel without checking that produces
 * `Invalid Date` for half the rows.
 *
 * This mirrors the fields the board renders, not the whole record: the server also carries
 * `retry`/`retryOf`/`haltedApp`/`approvalMode` and more. Adding them to a type nobody reads
 * would make the mirror look authoritative while drifting from the source, so they come
 * when a surface needs them.
 */
export interface TaskRecord {
  id: string
  prompt: string
  source: TaskSource
  status: TaskStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  timeoutMs: number
  callerId: string
  idempotencyKey: string
  force: boolean
  result?: { summary: string; changedFiles: string[]; exitCode?: number }
  error?: string
  allowedTools?: string[]
  /** Filled when a cron trigger runs a board definition, so rows can group by it. */
  scheduledTaskId?: string
  /** The visible session this run created, if any. */
  sessionId?: string
  /** Workspace the run used: a snapshot at creation for cron tasks. */
  cwd?: string
  /** Attempt counter, 1 for a first run. */
  attempt?: number
}

/**
 * `task-routes.ts:25-40`. These travel as a **query string** (`fetch` will not send a body with
 * GET), and the router does hand query params to the handler — in its **second** parameter
 * (`src/server/index.ts:83-92`), which `GET /tasks` calls `_params` and ignores while reading
 * the filter from `body` instead (`src/server/task-routes.ts:194-200`). Over HTTP that means the
 * server filters nothing and returns every record; `listTasks()` therefore applies this same
 * filter locally (`task-view.ts`), so a caller gets the page it asked for either way.
 */
export interface TaskFilterRequest {
  status?: readonly TaskStatus[]
  source?: TaskSource
  scheduledTaskId?: string
  limit?: number
}
