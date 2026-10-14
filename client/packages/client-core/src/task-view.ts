/**
 * The `/tasks` view filter, applied where the client can actually enforce it.
 *
 * `SidecarClient.listTasks()` sends `status`/`source`/`scheduledTaskId`/`limit` as a query
 * string, and the sidecar **ignores all four over HTTP**: the `GET /tasks` handler reads the
 * filter out of its first parameter (`body` — empty for a GET) and names the parameter that
 * actually carries the query `_params` (`src/server/task-routes.ts:194-200`, while the router
 * hands query params in that second slot, `src/server/index.ts:83-92`). In-process callers can
 * put a filter in `body`, which is how the kernel's own tests pass; a network client cannot.
 * Measured 2026-10-13 on a live keyless sidecar: `?status=failed`, `?status=nonsense` and
 * `?limit=1` all answered with the whole two-row table — see `scripts/accept-tasks.ts`.
 *
 * So this mirrors the kernel's own semantics (`parseTaskFilter` + `matchesFilter` +
 * `createdAt` desc + `slice(limit)`, `src/server/task-store.ts:279-288` and `:197-201`) and runs
 * on the response. The query string stays on the wire: the day the kernel reads `params`, the
 * server narrows first and this pass becomes a no-op — `check:layers` turns red at that moment
 * so the workaround and the comment get deleted together instead of fossilising.
 */
import type { TaskFilterRequest, TaskRecord } from './task-types.ts'

export function selectTasks(tasks: readonly TaskRecord[], filter: TaskFilterRequest = {}): TaskRecord[] {
  const statuses = filter.status && filter.status.length > 0 ? new Set<string>(filter.status) : null
  const kept = tasks.filter((t) =>
    (!statuses || statuses.has(t.status)) &&
    (!filter.source || t.source === filter.source) &&
    (!filter.scheduledTaskId || t.scheduledTaskId === filter.scheduledTaskId))
  kept.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return filter.limit && filter.limit > 0 ? kept.slice(0, filter.limit) : kept
}
