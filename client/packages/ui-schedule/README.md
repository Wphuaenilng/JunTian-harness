# @tianshu/ui-schedule

Automations board (plan M2 定时任务看板): scheduled tasks, scheduler health, create /
pause / resume / delete.

## Endpoints consumed

| Endpoint | Use |
|---|---|
| `GET /schedule` | task list (optional `?status=` view filter) |
| `GET /schedule/status` | scheduler running + **write health** (`persistence.ok`) |
| `POST /schedule` | create — needs `{prompt, trigger:{type,spec}}`; time triggers require `spec` |
| `PATCH /schedule/:id` | in-place update; gated on `capabilities.schedulePatch` |
| `POST /schedule/:id/pause` · `DELETE /schedule/:id` | lifecycle |
| `GET /tasks` | background-job registry |

## Things this panel must not get wrong

- **`status` vs `enabled`.** Lifecycle is `status`, but rows written before #236 have
  no `status` and only `enabled`, so the panel renders `effectiveStatus()` — the same
  precedence the server uses. Reading `task.status` directly shows old tasks as
  neither active nor paused.
- **Write health is a poll field, not a save toast.** The server ships `persistence`
  on the status endpoint so a save that never hit disk stays visible after the user
  stops looking at the form; the 30s reload re-reads it.
- **An unknown `?status=` value returns everything, not nothing** (the filter is a view
  convenience). The panel therefore never treats a bad filter as "no automations".
- **Create defaults to a spec that cannot fire soon** (`0 4 29 2 *`). A dashboard whose
  default is `interval: 60000` turns a typo into a recurring paid run.
- New tasks snapshot the session's `cwd`; without that every automation would land in
  the sidecar's launch directory when several projects share one runtime.

## Verified

`scripts/accept-schedule.ts` runs the whole cycle against a live sidecar — create →
list → patch → pause → delete — and asserts the id/createdAt/lifecycle invariants, that
nothing ever triggered (`triggerCount === 0`, so nothing was billed), that the store
path stayed inside the isolated dir, and that no residue is left behind.

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 10 个：`cancelTask`、`createScheduleTask`、`deleteScheduleTask`、`getTask`、`listScheduledTasks`、`listTasks`、`patchScheduleTask`、`pauseScheduleTask`、`runNowSchedule`、`scheduleStatus`

| 面 | 消费内容 |
|---|---|
| 端点 | `DELETE /schedule/:id`、`GET /schedule`、`GET /schedule/status`、`GET /tasks`、`GET /tasks/:id`、`PATCH /schedule/:id`、`POST /schedule`、`POST /schedule/:id/pause`、`POST /schedule/:id/run-now`、`POST /tasks/:id/cancel` |
| 事件类（wire 名） | — |
| 折叠块类型 | — |
| 宿主回调 props | — |
<!-- protocol-ledger:end -->
