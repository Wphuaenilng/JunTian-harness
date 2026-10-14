/**
 * accept-tasks.ts — a real job record, manufactured for free.
 *
 * 台账把「`/tasks` 有数据的一行」记在"要一次真上游 run"那格。那条前提没验过：内核在 **执行之前**
 * 就落记录（`src/server/cron-wiring.ts:71-89`：task-due → `TaskRegistry.createTask(source:'cron')`，
 * 结果只是回写它的终态），所以一台没有 key 的 sidecar 照样会产出一行真任务——只是注定 `failed`。
 * 而 `POST /schedule/:id/run-now`（`src/server/cron-scheduler.ts:419-432`，试跑恒有人值守）
 * 让我们不必等那个 30 秒的 tick：定义钉在 2 月 29 日 04:00（自己永远轮不到触发），记录由这一次
 * 明确的试跑造出来。全程零上游花费——`configured:false` 那台出不了网。
 *
 * 量到什么就写什么：`?status=`/`?limit=` 在 HTTP 上根本不被读（判据 ⑪）、`cancelled` 不会被随后
 * 落地的 `failed` 回写盖掉（⑨）、job 记录没有删除端点（⑮）。
 *
 *   node scripts/accept-tasks.ts --info=<隔离实例的 .sidecar-info.json>
 */
import { openInstance } from './lib-instance.ts'
import type { TaskRecord } from '../packages/client-core/src/index.ts'

const { api, info } = openInstance('后台任务登记面：当场造两条真 job 记录，读回状态机、事件序列与过滤面的实情')

const failures: string[] = []
let ran = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  ran += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const H = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
const raw = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${info.baseUrl}${path}`, {
    method,
    headers: H,
    body: body === undefined ? null : JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null }
}
const enc = encodeURIComponent

const health = await raw('GET', '/health')
const keyless = (health.body?.configured as boolean | undefined) === false
console.log(`configured  ${String(health.body?.configured)} — 只有这一台是没有上游凭据的，试跑才不会打真上游`)

if (!keyless) {
  console.log('未测到  这台实例配了凭据（configured 不是 false）——整段跳过：造记录要发 prompt，在有 key 的机器上就是花钱')
  console.log('登记面那一半本轮**未测到**，不是通过')
} else {
  const tableOf = async () => (((await raw('GET', '/tasks')).body?.tasks ?? []) as TaskRecord[])
  const before = await tableOf()
  console.log(`baseline    GET /tasks → ${before.length} 条（本机登记面跑前的条数，收尾不复用这个数）`)

  const never = { type: 'cron' as const, spec: '0 4 29 2 *' }
  const defA = await api.createScheduleTask({ prompt: '登记面探针 A：试跑后放着，看无 key 的 run 自己走到哪个终态', trigger: never, allowedTools: [] })
  const defB = await api.createScheduleTask({ prompt: '登记面探针 B：试跑后在 running 上取消', trigger: never, allowedTools: [] })
  check(`① 两条定义建成（${never.spec} 自己永远轮不到，记录只由下面那两次试跑产生）`,
    typeof defA.id === 'string' && typeof defB.id === 'string' && defA.id !== defB.id, `${defA.id} / ${defB.id}`)

  const fireA = await raw('POST', `/schedule/${enc(defA.id)}/run-now`)
  const fireB = await raw('POST', `/schedule/${enc(defB.id)}/run-now`)
  check('② run-now 受理并回 triggered:true（不等 30s 的 tick）',
    fireA.status === 200 && fireA.body?.triggered === true && fireB.body?.triggered === true,
    `A ${fireA.status} ${JSON.stringify(fireA.body)} · B ${fireB.status} ${JSON.stringify(fireB.body)}`)

  const byDef = (rows: TaskRecord[], id: string) => rows.filter((r) => r.scheduledTaskId === id)
  let found: TaskRecord[] = []
  const waitFrom = Date.now()
  for (let i = 0; i < 40 && found.length < 2; i++) {
    await sleep(500)
    found = (await tableOf()).filter((r) => r.scheduledTaskId === defA.id || r.scheduledTaskId === defB.id)
  }
  const waitedMs = Date.now() - waitFrom
  const rowA = byDef(found, defA.id)[0]
  const rowB = byDef(found, defB.id)[0]
  check('③ 零花费当场造出两条真 job 记录（内核把 scheduledTaskId 回填，看板据此分组）',
    rowA !== undefined && rowB !== undefined, `等了 ${waitedMs}ms（上界 20000ms），实得 ${found.length}/2 条`)
  if (!rowA || !rowB) {
    console.log('\n✗ 没造出记录，后面的判据无从谈起')
    failures.push('造记录')
  } else {
    check('④ 记录体带着看板要用的字段（id 形状 / source / callerId / attempt / timeoutMs）',
      /^task_/.test(rowA.id) && typeof rowA.source === 'string' && rowA.callerId === 'cron-scheduler'
        && rowA.attempt === 1 && typeof rowA.timeoutMs === 'number',
      JSON.stringify({ id: rowA.id, source: rowA.source, callerId: rowA.callerId, attempt: rowA.attempt, timeoutMs: rowA.timeoutMs }))
    console.log(`  i 一次**手动试跑**的记录也写着 source="cron"、callerId="cron-scheduler"——登记面想区分"试跑"与"定时"，靠这四个字段分不出来（留给 #28 那格的取舍）`)
    check('⑤ 每次 run 都开出一个可见会话，并把 sessionId 回填到记录上',
      typeof rowA.sessionId === 'string' && rowA.sessionId.length > 0 && typeof rowB.sessionId === 'string' && rowB.sessionId.length > 0,
      `A→${rowA.sessionId} B→${rowB.sessionId}`)

    const preB = (await raw('GET', `/tasks/${enc(rowB.id)}`)).body?.task as TaskRecord | undefined
    const cancel = await raw('POST', `/tasks/${enc(rowB.id)}/cancel`)
    const postB = cancel.body?.task as TaskRecord | undefined
    check('⑥ running 上的 cancel 得到 200 且终态是 cancelled',
      cancel.status === 200 && postB?.status === (preB?.status === 'running' ? 'cancelled' : preB?.status),
      `cancel 前=${preB?.status ?? '?'} → 后=${postB?.status ?? '?'}（status=${cancel.status}）`)

    const detailA = await raw('GET', `/tasks/${enc(rowA.id)}`)
    check('⑦ GET /tasks/:id 把记录包在 {task:{}} 里回（不是裸记录——照裸形状解析的界面读到的是 undefined）',
      detailA.status === 200 && (detailA.body?.task as TaskRecord | undefined)?.id === rowA.id,
      `status=${detailA.status} keys=${Object.keys(detailA.body ?? {}).join(',')}`)

    let finalA = (detailA.body?.task as TaskRecord | undefined)?.status
    for (let i = 0; i < 40 && finalA !== 'failed' && finalA !== 'cancelled' && finalA !== 'completed' && finalA !== 'timed_out'; i++) {
      await sleep(500)
      finalA = ((await raw('GET', `/tasks/${enc(rowA.id)}`)).body?.task as TaskRecord | undefined)?.status
    }
    check('⑧ 无 key 的定时 run 自己走到 failed（不是停在 running 等超时）',
      finalA === 'failed', `实得 status=${finalA ?? '?'} · error=${JSON.stringify(((await raw('GET', `/tasks/${enc(rowA.id)}`)).body?.task as TaskRecord | undefined)?.error)?.slice(0, 110)}`)

    const afterA = (await raw('GET', `/tasks/${enc(rowB.id)}`)).body?.task as TaskRecord | undefined
    check('⑨ cancelled 没被随后落地的 failed 回写盖掉（终态优先级 cancelled>timed_out>failed>completed 真生效）',
      afterA?.status === 'cancelled', `A 已到 ${finalA}，B 读回 ${afterA?.status ?? '?'}`)

    const evOf = async (id: string) => (((await raw('GET', `/tasks/${enc(id)}/events`)).body?.events ?? []) as { seq: number; type: string }[])
    const evA = await evOf(rowA.id)
    const evB = await evOf(rowB.id)
    const contig = (e: { seq: number; type: string }[]) => e.every((x, i) => x.seq === i + 1)
    check('⑩ 事件流是从 1 连号的终态链（notifyPolicy=state_changes；界面拿它当增量游标用）',
      contig(evA) && contig(evB) && evA.at(-1)?.type === finalA && evB.at(-1)?.type === 'cancelled',
      `A ${JSON.stringify(evA.map((e) => `${e.seq}:${e.type}`))} · B ${JSON.stringify(evB.map((e) => `${e.seq}:${e.type}`))}`)

    const bogus = await raw('GET', '/tasks?status=nonsense&limit=1')
    const whole = await tableOf()
    check('⑪ 内核把 GET /tasks 的 query 当不存在：?status=nonsense&limit=1 原样返回整张表（这条红=它开始认 query 了，就去删 client-core 的本地兜底）',
      bogus.status === 200 && (bogus.body?.tasks as TaskRecord[] | undefined)?.length === whole.length,
      `整表 ${whole.length} 条 · 加了旗标的这一发 ${((bogus.body?.tasks as TaskRecord[] | undefined) ?? []).length} 条`)

    const page = await api.listTasks({ status: ['failed'], limit: 1 })
    check('⑫ 客户端说一就是一：listTasks({status:[failed],limit:1}) 自己把页裁出来',
      page.tasks.length === 1 && page.tasks[0]?.status === 'failed' && page.count === 1,
      `实得 ${page.tasks.length} 条 · count=${page.count} · 状态 ${page.tasks.map((x) => x.status).join(',')}`)

    const badShape = await raw('GET', '/tasks/not-a-task')
    const missing = await raw('GET', '/tasks/task_00000000')
    const cancelMissing = await raw('POST', '/tasks/task_00000000/cancel')
    const cancelTwice = await raw('POST', `/tasks/${enc(rowB.id)}/cancel`)
    check('⑬ 查无此记录一律 404（形状不合法的 id 也是 404，不是 400——界面拿 400 分支的话会漏）',
      badShape.status === 404 && missing.status === 404 && cancelMissing.status === 404,
      `形状不合法 ${badShape.status} · 不存在 ${missing.status} · cancel 不存在 ${cancelMissing.status}`)
    check('⑭ 对已终态的记录再 cancel 一次不报错，回的是同一条记录（幂等，界面可安全重放）',
      cancelTwice.status === 200 && (cancelTwice.body?.task as TaskRecord | undefined)?.status === 'cancelled',
      `status=${cancelTwice.status} 回读 ${(cancelTwice.body?.task as TaskRecord | undefined)?.status}`)

    const del = await fetch(`${info.baseUrl}/tasks/${enc(rowA.id)}`, { method: 'DELETE', headers: H })
    check('⑮ 记录没有删除端点（路由表只有 4 条 /tasks*）——所以隔离目录就是它的归宿，别在界面上放"清空历史"这种按钮',
      del.status === 404, `DELETE /tasks/:id → ${del.status}`)

    const runNowMissing = await raw('POST', '/schedule/cron_nosuch/run-now')
    check('⑯ 对不存在的定义试跑回 404 并说清原因（不是静默 200）',
      runNowMissing.status === 404 && typeof runNowMissing.body?.error === 'string',
      `${runNowMissing.status} ${JSON.stringify(runNowMissing.body?.error)}`)

    const sidA = rowA.sessionId
    const sidB = rowB.sessionId
    if (typeof sidA === 'string' && sidA.length > 0 && typeof sidB === 'string' && sidB.length > 0) {
      const archivedA = await api.archiveSession(sidA)
      const archivedB = await api.archiveSession(sidB)
      check('⑰ 两次 run 开出的会话都归档掉（跑到常驻实例上时不留下没主的活跃线程）',
        archivedA.archived === true && archivedB.archived === true, `${sidA} / ${sidB}`)
    } else {
      check('⑰ 两次 run 开出的会话都归档掉（跑到常驻实例上时不留下没主的活跃线程）', false,
        `没拿到 sessionId（见 ⑤），无从归档：A=${String(sidA)} B=${String(sidB)}`)
    }
  }

  await api.deleteScheduleTask(defA.id)
  await api.deleteScheduleTask(defB.id)
  const defsLeft = await api.listScheduledTasks()
  check('⑱ 两条定义删净（永不会触发的定义留在调度器里就是垃圾）',
    !defsLeft.some((x) => x.id === defA.id || x.id === defB.id), `调度器里还有 ${defsLeft.length} 条`)
  const after = await tableOf()
  console.log(`  i 收尾全表 ${after.length} 条（跑前 ${before.length} 条；多出来的就是本轮这两条，内核没有删记录的口子）`)
}

if (failures.length > 0) {
  console.error(`\n✗ 后台任务登记面 FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log(`\n✓ 后台任务登记面实测通过（${ran} 项判定${keyless ? '，含造出来的真记录' : '，登记面那一半未测到'}。零上游花费——两次 run 都出不了网）`)
