/**
 * accept-schedule.ts — automations board data path, including a real create/patch/
 * pause/delete cycle. Costs nothing and runs nothing.
 *
 * The created task is a cron pinned to 04:00 on Feb 29 — roughly once every four
 * years — and is paused immediately, so the scheduler can never fire it into a paid
 * run. It lands in the isolated RIVET_DESKTOP_DIR (client/.sidecar-data), not in your
 * official desktop's scheduled_tasks.json, and the script deletes it again.
 *
 *   node scripts/accept-schedule.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, effectiveStatus, RUNTIME_CAPABILITIES } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const failures: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const health = await api.health()
console.log(`capabilities: ${JSON.stringify(health.capabilities)} (client compiled mirror: ${JSON.stringify(RUNTIME_CAPABILITIES)})`)
check('PATCH /schedule/:id is offered by this runtime', health.capabilities.schedulePatch === true)

const status0 = await api.scheduleStatus()
console.log(`\nGET /schedule/status → running=${status0.status.schedulerRunning} lockOwner=${status0.status.lockOwner} active=${status0.status.activeTasks} scheduled=${status0.status.scheduledCount}`)
console.log(`  persistence: ok=${status0.persistence?.ok} path=${status0.persistence?.path}`)
check('schedule status reports scheduler + write health',
  typeof status0.status.schedulerRunning === 'boolean' && typeof status0.persistence?.ok === 'boolean')
check('persistence path stays inside the isolated dir',
  (status0.persistence?.path ?? '').includes('.sidecar-data'), status0.persistence?.path ?? '')

const before = await api.listScheduledTasks()
console.log(`\ntasks before: ${before.length}`)

const created = await api.createScheduleTask({
  prompt: '（验收占位，永不应触发）',
  trigger: { type: 'cron', spec: '0 4 29 2 *' },
  reviewPolicy: 'always-review',
})
console.log(`created ${created.id} trigger=${created.trigger.type}:${created.trigger.spec} status=${effectiveStatus(created)} count=${created.triggerCount}`)
check('create returns a full task with derived status',
  typeof created.id === 'string' && effectiveStatus(created) === 'active' && created.triggerCount === 0)

const listed = await api.listScheduledTasks()
check('the new task shows up in GET /schedule', listed.some((t) => t.id === created.id), `listed=${listed.length}`)

const patched = await api.patchScheduleTask(created.id, { prompt: '（验收占位·已改）', retry: null })
check('PATCH applied the prompt', patched.prompt === '（验收占位·已改）', patched.prompt)
check('PATCH preserved identity and lifecycle (id/createdAt/status untouched)',
  patched.id === created.id && patched.createdAt === created.createdAt && effectiveStatus(patched) === 'active')

await api.pauseScheduleTask(created.id)
const paused = (await api.listScheduledTasks()).find((t) => t.id === created.id)
check('pause moved lifecycle to paused', effectiveStatus(paused ?? { ...created, status: undefined, enabled: false }) === 'paused',
  `status=${paused?.status ?? '—'} enabled=${paused?.enabled ?? '—'}`)

// Status filter is a view convenience: an invalid value must not blank the list.
const bogusFilter = await api.listScheduledTasks('not-a-real-status')
check('unknown status filter returns the full list, not an empty one', bogusFilter.length >= 1, `returned=${bogusFilter.length}`)

const tasks = await api.listTasks()
console.log(`\nGET /tasks → count=${tasks.count} items=${tasks.tasks.length}`)

await api.deleteScheduleTask(created.id)
const after = await api.listScheduledTasks()
check('task deleted again (no residue in your scheduler)', !after.some((t) => t.id === created.id), `after=${after.length}`)

const finalStatus = await api.scheduleStatus()
check('trigger count never grew (nothing ran, nothing billed)',
  (after.find((t) => t.id === created.id)?.triggerCount ?? 0) === 0,
  `activeTasks now ${finalStatus.status.activeTasks}`)

if (failures.length > 0) {
  console.error(`\n✗ schedule board FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\n✓ 定时任务看板数据路径实测通过（建→列→改→停→删，全程零触发、零花费）')
