/**
 * accept-queue.ts — the wire contract behind `sendOrQueue`, observed rather than quoted.
 *
 * The hand-off retries `/prompt` because the kernel answers **409 `code:'idle'`** to `/queue` when
 * no turn is running (`src/server/session-routes.ts:1204`，`code: 'idle'` 那一支). Until now that was a line read off the
 * kernel source; this run asks the live sidecar instead.
 *
 * It costs nothing. The busy half (§4 below) does call `POST /prompt` — but only after reading
 * `/health` on *this* instance and seeing `configured: false`, where the run cannot leave the
 * machine (measured: it is accepted, spins ~4s locally, then reports itself failed with an `error`
 * event). If a key is ever visible, that whole section is skipped and says so on screen as
 * **未测到**, never as a pass. `/queue` and `/queue/retract` cannot start a turn either way — a
 * queue entry is only taken up by the *next* prompt.
 *
 *   node scripts/accept-queue.ts --info=<隔离实例的 .sidecar-info.json>
 */
import { openInstance, probeWorkspace } from './lib-instance.ts'

const { api, info } = openInstance('排队交接的线上契约：空闲时的 /queue 到底回什么')

const failures: string[] = []
let ran = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  ran += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let busyMeasured = false

const ws = probeWorkspace('queue')
const session = await api.createSession({
  title: 'queue hand-off probe',
  cwd: ws.cwd,
  workspaceMode: 'explicit',
})
check('探针会话建成（只在隔离实例里，不碰你的产品库）', typeof session.id === 'string' && session.id.length > 0, session.id)
check('探针会话的 cwd 就在本次的临时落点里（内核会往**任何**会话 cwd 种 `.rivet/`，写进你的工作树就是隔离破了）',
  String(session.cwd ?? '').replace(/\\/g, '/').toLowerCase().startsWith(ws.cwd.replace(/\\/g, '/').toLowerCase()),
  `落点=${ws.cwd}，会话认的 cwd=${String(session.cwd)}${ws.note === '' ? '' : ` ｜ ${ws.note}`}`)

// 1) 客户端的映射：空闲 ⇒ 联合类型里的 'idle'——`sendOrQueue` 的回退就认这个值。
const queued = await api.queue(session.id, '探针文字（不会起 run）')
check('SidecarClient.queue 在空闲会话上映射成 "idle"', queued === 'idle', `实得 ${JSON.stringify(queued)}`)

// 2) 内核自己怎么说的（绕过客户端直读），证明上面那个映射是运行时的，不是我编的。
const raw = await fetch(`${info.baseUrl}/sessions/${encodeURIComponent(session.id)}/queue`, {
  method: 'POST',
  headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ text: '探针文字（不会起 run）' }),
})
const rawBody = await raw.json().catch(() => ({})) as { error?: string; code?: string }
check('内核对空闲会话的 /queue 回 409 且 code="idle"',
  raw.status === 409 && rawBody.code === 'idle', `status=${raw.status} body=${JSON.stringify(rawBody)}`)
check('它的报错文字就写着该往哪退（/prompt）',
  typeof rawBody.error === 'string' && /\/prompt/.test(rawBody.error), rawBody.error ?? '(没有 error 文字)')

// 3) 撤回一条从没排过的 lane：报 false，而不是抛出去把界面炸了。
const retracted = await api.retractQueued(session.id, 'no-such-lane')
check('retractQueued 遇到不存在的 lane 报 false 而非抛错', retracted === false, `实得 ${JSON.stringify(retracted)}`)

// 4) 忙时那一半——计划 §6 M1 的「busy 走 `/queue`（输入不丢）」此前只有 *空闲* 那半边有现场。
//    先读**这台**实例的 /health：只有 `configured:false` 才发 prompt（无 key 的 prompt 出不去这台机器，
//    实测被受理后在本地跑一会儿再自报 failed，那一段就是"正在跑"的形状——多长取决于会话 cwd：落在仓根时
//    内核有一半时间在替我们种 `.rivet/`，落到临时目录只剩一两百毫秒，所以下面每次都重新造忙）。
//    看不见 key 就整段跳过，并在屏幕上写成**未测到**——不是通过。
const health = await api.health().catch(() => null)
if (health?.configured === false) {
  console.log('  i 花费声明：这台 configured:false，接下来几发 /prompt 由内核本地受理、不会离开本机（实测随后自报 failed 并留下 error 事件）')
  const first = await api.prompt(session.id, { prompt: 'accept-queue: 造一条只在机器上活着的 run' })
  let running = false
  for (let i = 0; i < 30 && !running; i++) {
    running = (await api.getSession(session.id)).status === 'running'
    if (!running) await sleep(150)
  }
  busyMeasured = true
  check('无 key 的 /prompt 被受理后会话真进入 running（这条 run 从未出门）',
    running, `prompt 回 ${first}；health.configured=${String(health.configured)}`)
  if (running) {
    const second = await api.prompt(session.id, { prompt: 'accept-queue: 忙时补一发' })
    check('忙时第二发 /prompt 得到 busy（409 在客户端映射成 busy）', second === 'busy', `实得 ${second}`)
    const rawBusy = await fetch(`${info.baseUrl}/sessions/${encodeURIComponent(session.id)}/prompt`, {
      method: 'POST',
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'accept-queue: 绕过客户端再看一眼内核' }),
    })
    const rawBusyBody = await rawBusy.json().catch(() => ({})) as { error?: string; code?: string }
    check('内核自己说的确实是 409 / code="busy"（证明上面那个映射不是客户端编的）',
      rawBusy.status === 409 && rawBusyBody.code === 'busy', `status=${rawBusy.status} body=${JSON.stringify(rawBusyBody)}`)
    const lane = await api.queue(session.id, '忙时的排队文字（输入不丢）')
    check('忙时 /queue 不再报 idle，而是给出 laneId', lane !== 'idle' && typeof lane.laneId === 'string' && lane.laneId.length > 0,
      JSON.stringify(lane))
    // 排进去的那条能不能撤：这一格此前写在台账里是"要 busy 才测得了，属付费那一格"——现在忙时能自己造，
    // 就顺手量掉（`retractQueued` 对不存在的 lane 上面已量过 false，这一条量真的是 true 的那一半）。
    // 排两条、撤第一条：这一格台账原先记成"要 busy 才测得了，属付费那一格"——忙时既然能自己造，就一并量掉。
    // 没有列 lane 的读端点，所以用"撤了的再撤一次必 false、没撤过的那条仍 true"来证明两条 lane 互不相干。
    if (lane !== 'idle') {
      const first2 = await api.queue(session.id, '忙时排队的第二条')
      const lane2 = typeof (first2 as { laneId?: string }).laneId === 'string' ? (first2 as { laneId: string }).laneId : ''
      check('忙时能连续排进两条（第二条也拿到自己的 laneId）', lane2.length > 0 && lane2 !== lane.laneId, `${lane.laneId} vs ${lane2 || JSON.stringify(first2)}`)
      const back = await api.retractQueued(session.id, lane.laneId)
      check('忙时排进去的那条真能被撤回（retractQueued 对存在的 lane 回 true）', back === true, `实得 ${JSON.stringify(back)}`)
      const again = await api.retractQueued(session.id, lane.laneId)
      const still = await api.retractQueued(session.id, lane2)
      check('撤过的再撤回 false，而没动过的那条仍撤得掉（两条 lane 互不相干）',
        again === false && still === true, `第二次撤 = ${JSON.stringify(again)}；另一条 = ${JSON.stringify(still)}`)
    }
    // 判的是"忙时 sendOrQueue 会不会转成 queued"，不是"我押不押得中那一瞬"。这条原先排在这一串 await
    // 的最后，靠第一条 run 的在飞窗口撑着——而那个窗口原本是几秒，是因为**会话 cwd 是仓根**，内核那一发
    // 有一半时间在我们的树里种 `.rivet/`；cwd 换成临时落点后窗口只剩一两百毫秒，它就露出来红了。
    // 所以每次押注都重新造一次忙：发 prompt，**紧接着**调 sendOrQueue，中间不隔 await。
    const tried: string[] = []
    let handoff = ''
    for (let attempt = 0; attempt < 4 && handoff !== 'queued'; attempt++) {
      const armed = await api.prompt(session.id, { prompt: `accept-queue: 第 ${attempt + 1} 次造忙（一发只在机器上活着的 run）` })
      handoff = String(await api.sendOrQueue(session.id, 'accept-queue: 整趟交接走一遍'))
      tried.push(`第 ${attempt + 1} 次：prompt=${armed} → sendOrQueue=${handoff}`)
    }
    check('sendOrQueue 在忙时落进 "queued"（§6 M1 那句「busy 走 /queue（输入不丢）」的线上形状）',
      handoff === 'queued', `${tried.join(' ｜ ')}（每次都重新造忙再紧接着调；四次都不是 queued 才是真红）`)
    await api.abort(session.id).catch(() => undefined)
  }
} else {
  console.log(`  i 这台实例的 health.configured 不是 false（实得 ${String(health?.configured)}）——忙时那一半**未测到**，不是通过`)
}

const archived = await api.archiveSession(session.id)
check('探针会话已归档（隔离库里不留残迹）', archived.archived === true, JSON.stringify(archived))

if (failures.length > 0) {
  console.error(`\n✗ 排队交接契约 FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log(`\n✓ 排队交接的线上契约实测通过（${ran} 项判定；${busyMeasured ? '含忙时那一半' : '忙时那一半未测到'}。零上游花费：prompt 只在这台 configured:false 时发，那条 run 从未离开本机）`)
