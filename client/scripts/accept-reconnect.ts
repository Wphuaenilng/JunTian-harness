/**
 * accept-reconnect.ts — §9 DoD「断网 10 秒恢复后事件不丢不重」跑在一条零花费的常驻线上。
 *
 * 两条档，按**这台实例看得见 key 吗**分流，屏幕上各自点名：
 *   档一 `configured:false` ⇒ 自己造现场：建会话→发第 1 发 prompt（注定失败：实测内核受理、在本地
 *     转约 4 秒、再自报 failed 并落下 `goal_state/error/done`）→开流、在重放**中途**切掉→**断线期间**
 *     再发第 2 发 prompt（这一发的全部事件都是在连接 down 的时候落盘的）→等满 10 秒→拿断线时的游标
 *     续读。常驻线走这一档，因为"断线期间真有新事件产生"这件事必须由我来制造：挂现机读一段早就
 *     静止的历史，"不丢"那一半是空转——没有人会在你看不见的时候补上事件。
 *   档二（看得见 key，或位置参数给了 sessionId）⇒ 只读那台的历史，一条 prompt 都不发；断线期间
 *     有新事件那一半在这条路上量不到，脚本把它写成**未测到**，不是通过。
 *
 * 两条判据此前结构上不存在：
 *  - "不重"此前只看客户端收到的 seq 有没有重复，而客户端传输层自己就按游标丢 `dup` 帧——所以
 *    "没有重复"可能是守卫自己滤掉的，而不是服务端没重放。现在补一条**绕过客户端直读 `/stream?since=K`**
 *    的线上控制（⑩）：去掉 `since=` 它就红。
 *  - "切在重放中途"此前没被量过：如果第一代其实是等流跑完才关的，整条续读判据就在空转。③ 钉它。
 *
 *   node scripts/accept-reconnect.ts [sessionId]                       # 档二
 *   node scripts/accept-reconnect.ts --info=<隔离实例的 .sidecar-info.json>   # 档一
 */
import { openSessionStream } from '../packages/client-core/src/index.ts'
import { forEachSseFrame } from '../packages/client-core/src/sse-frames.ts'
import { openInstance, probeWorkspace } from './lib-instance.ts'

const ws = probeWorkspace('reconnect')
const { api, info } = openInstance('断线 10 秒续读不丢不重（档一无 key 自己造现场与断线期间的事件）')

const failures: string[] = []
let ran = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  ran += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const enc = encodeURIComponent

// §9 那句话的字面数就是 10 秒，这里不缩写成"一个短窗口"。
const OUTAGE_MS = 10_000
const CUT_AT = 2

const health = await api.health().catch(() => null)
const keyless = health?.configured === false
const explicitId = process.argv.slice(2).find((a) => !a.startsWith('--'))
console.log(`configured  ${String(health?.configured)} — ${keyless
  ? '这台没有上游凭据：现场自己造，那几趟 run 出不去本机'
  : '这台看得见上游凭据：一条 prompt 都不发（断线期间有新事件那一半在这一档量不到）'}`)

const FIRST_PROMPT = 'accept-reconnect 第 1 发 · 流会在它还在吐事件的时候被切掉'
const GAP_PROMPT = 'accept-reconnect 第 2 发 · 我全部的事件都落在连接 down 的那 10 秒里'

let sessionId = ''
let manufactured = false

if (explicitId !== undefined) {
  const hit = (await api.listSessions({ includeArchived: true })).find((s) => s.id === explicitId)
  if (hit === undefined) {
    console.error(`✗ 这台实例上没有会话 ${explicitId} —— 档二要求显式给的 id 真存在，不去猜别条`)
    process.exit(1)
  }
  sessionId = hit.id
  console.log(`档二        读显式指定的会话 ${sessionId} title="${hit.title ?? ''}" lastSeq=${hit.lastSeq}`)
} else if (keyless) {
  manufactured = true
  const created = await api.createSession({
    title: 'reconnect outage probe',
    cwd: ws.cwd,
    workspaceMode: 'explicit',
  })
  sessionId = created.id
  check('① 档一：造现场的会话建成（只落在本次隔离库里）',
    typeof created.id === 'string' && created.id.length > 0, created.id)
  check('①b 会话 cwd 就在本次的临时落点里（内核会往任何会话 cwd 种 `.rivet/`——写进操作者的工作树就是隔离破了）',
    String(created.cwd ?? '').replace(/\\/g, '/').toLowerCase().startsWith(ws.cwd.replace(/\\/g, '/').toLowerCase()),
    `落点=${ws.cwd}，会话认的 cwd=${String(created.cwd)}${ws.note === '' ? '' : ` ｜ ${ws.note}`}`)
  console.log('  i 花费声明：这台 configured:false，接下来 2 发 /prompt 由内核本地受理、不会离开本机（实测随后自报 failed 并留下 error 事件）')
  const acc1 = await api.prompt(sessionId, { prompt: FIRST_PROMPT })
  let sawRunning = false
  for (let i = 0; i < 100 && !sawRunning; i++) {
    sawRunning = (await api.getSession(sessionId)).status === 'running'
    if (!sawRunning) await sleep(50)
  }
  check('② 第 1 发被受理且会话进过 running（流要在它还在吐事件的时候被切掉，才有"断线期间产生的事件"）',
    acc1 === 'ok' && sawRunning, `prompt 回 ${JSON.stringify(acc1)}，观察到 running=${String(sawRunning)}`)
} else {
  const sessions = await api.listSessions({ includeArchived: true })
  const best = [...sessions].sort((a, b) => b.lastSeq - a.lastSeq)[0]
  if (best === undefined || best.lastSeq < 6) {
    console.error(`✗ 档二没有可用的现场：这台 ${info.baseUrl} 配了 key（脚本不该在它上面发消息），`
      + `而现有会话里 lastSeq 最大的是 ${String(best?.lastSeq)}（要 ≥6 才谈得上"重放中途切断"）。给它一个 sessionId，或换一台 configured:false 的隔离实例。`)
    process.exit(1)
  }
  sessionId = best.id
  console.log(`档二        读现机最大的一条会话 ${sessionId} title="${best.title ?? ''}" lastSeq=${best.lastSeq}（未发消息）`)
}

// ---- 第一代：开流，在重放中途切掉
const firstGen: number[] = []
let metaFrames = 0
let closedBy = ''
await new Promise<void>((rs) => {
  const close = openSessionStream({
    baseUrl: info.baseUrl,
    token: info.token,
    sessionId,
    since: 0,
    onEvent: (ev) => {
      if (ev.event.seq === 0) { metaFrames += 1; return }
      firstGen.push(ev.event.seq)
      if (firstGen.length >= CUT_AT) { closedBy = `收到第 ${String(firstGen.length)} 条 timeline 帧时主动 close()`; close(); rs() }
    },
  })
  setTimeout(() => { if (closedBy === '') { closedBy = '5 秒上限到（没收到 CUT_AT 条）' }; close(); rs() }, 5_000)
})
const cursorAtCut = firstGen.length > 0 ? Math.max(...firstGen) : 0
console.log(`第一代      since=0 收到 seq [${firstGen.join(',')}]，seq=0 合成帧 ${String(metaFrames)} 条；切断方式=${closedBy}`)

// ---- 断线窗口：档一在这里制造"连接 down 期间落盘的事件"
const outageFrom = Date.now()
let gapTurnSeq: number | undefined
let gapLandedDuringOutage = false
if (manufactured) {
  for (let i = 0; i < 200; i++) {
    if ((await api.getSession(sessionId)).status !== 'running') break
    await sleep(100)
  }
  const acc2 = await api.prompt(sessionId, { prompt: GAP_PROMPT })
  for (let i = 0; i < 200; i++) {
    if ((await api.getSession(sessionId)).status !== 'running') break
    await sleep(100)
  }
  gapLandedDuringOutage = acc2 === 'ok'
  console.log(`断线期间    第 2 发 prompt 回 ${JSON.stringify(acc2)}（连接此时是 down 的）`)
}
const wait = OUTAGE_MS - (Date.now() - outageFrom)
if (wait > 0) await sleep(wait)
const outageMs = Date.now() - outageFrom

// ---- 第二代：拿断线时的游标续读。请求对象只建一次，日志打的就是它真带出去的那个值——
//      上一版日志另有其字面量，变异掉 opts 里的 `since` 时屏幕上仍写着 `since=2`（假陈述，虽然 ⑨ 抓到了）。
const resumeReq = {
  baseUrl: info.baseUrl,
  token: info.token,
  sessionId,
  since: cursorAtCut,
}
const secondGen: number[] = []
await new Promise<void>((rs) => {
  const close = openSessionStream({
    ...resumeReq,
    onEvent: (ev) => { if (ev.event.seq > 0) secondGen.push(ev.event.seq) },
  })
  setTimeout(() => { close(); rs() }, 3_000)
})
console.log(`第二代      请求带的是 since=${String(resumeReq.since)}，收到 seq [${secondGen.join(',')}]，断线实测 ${String(outageMs)}ms`)

// ---- 收尾读数：权威全表 + 一条绕过客户端的线上控制
const authoritative = await api.events(sessionId, 0)
const expected = authoritative.events.filter((e) => e.seq > 0).map((e) => e.seq)
const gapSeqs = expected.filter((s) => s > cursorAtCut)
gapTurnSeq = authoritative.events.find((e) => e.seq > 0 && e.type === 'user'
  && e.data['text'] === GAP_PROMPT)?.seq

// 第二代刚 close()，服务端那头可能还挂着这条 SSE；同一会话上开第三条连接时，实测出现过一次
// "一帧都没回"的读数（同一条变异第二次跑就正常）。所以先等一小段把上一条彻底关干净，再拿它做线上控制——
// 判据不因此变松：⑩ 红的时候会把 status 与 content-type 一起打出来，"没连上"与"连上但不重放"分得开。
await sleep(500)
const wireFrames: number[] = []
let wireStatus = 0
let wireCtype = ''
{
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4_000)
  try {
    const res = await fetch(`${info.baseUrl}/sessions/${enc(sessionId)}/stream?since=${String(cursorAtCut)}`,
      { headers: { authorization: `Bearer ${info.token}` }, signal: controller.signal })
    wireStatus = res.status
    wireCtype = res.headers.get('content-type') ?? '(没有 content-type)'
    if (res.ok && res.body) {
      await forEachSseFrame(res.body, controller.signal, (data) => {
        try {
          const j = JSON.parse(data) as { seq?: unknown }
          if (typeof j.seq === 'number') wireFrames.push(j.seq)
        } catch { /* 坏 JSON 不是这条判据要管的 */ }
      })
    }
  } catch { /* 到点 abort 走的这条路 */ }
  finally { clearTimeout(timer) }
}
const wireTimeline = wireFrames.filter((s) => s > 0)
const wireAtOrBeforeCursor = wireTimeline.filter((s) => s <= cursorAtCut)
console.log(`线上控制    绕过客户端直读 /stream?since=${String(cursorAtCut)}：seq=0 帧 ${String(wireFrames.length - wireTimeline.length)} 条，timeline 帧 [${wireTimeline.join(',')}]`)

const allGen = [...firstGen, ...secondGen]
const dupes = [...new Set(allGen.filter((s, i) => allGen.indexOf(s) !== i))]
const missing = expected.filter((s) => !allGen.includes(s))
const gapMissing = gapSeqs.filter((s) => !secondGen.includes(s))
const firstOfSecond = secondGen.length > 0 ? Math.min(...secondGen) : Number.NaN

check('③ 第一代是在重放**中途**切的（收到的条数既 ≥CUT_AT 又少于全表——等流跑完才切的话，续读判据就在空转）',
  firstGen.length >= CUT_AT && expected.length > firstGen.length,
  `第一代 ${String(firstGen.length)} 条 / 全表 ${String(expected.length)} 条，游标停在 ${String(cursorAtCut)}`)
check('④ 断线窗口按 DoD 那句等满了 10 秒（实测时长打出来，不缩写成"一个短窗口"）',
  outageMs >= OUTAGE_MS, `实测 ${String(outageMs)}ms`)
if (manufactured) {
  check('⑤ 断线期间真落下了新事件：第 2 发的 user 事件逐字等于我发出去的那句，且它的 seq 在断线游标之后',
    gapLandedDuringOutage && gapTurnSeq !== undefined && gapTurnSeq > cursorAtCut,
    gapTurnSeq === undefined
      ? `全表里没有一条 user 事件逐字等于我发出的那一句（断线游标=${String(cursorAtCut)}）——断线期间那一发没落下，"不丢"就没有被测的东西`
      : `第 2 发的 user 事件 seq=${String(gapTurnSeq)}，断线游标=${String(cursorAtCut)}，文本=${JSON.stringify(GAP_PROMPT.slice(0, 28))}…`)
} else {
  console.log('未测到      ⑤ 断线期间有新事件落下——这一档不发消息（在有 key 的机器上那就是花钱），量不到就不是通过')
}
check('⑥ 不丢（断线那一段）：seq 高于断线游标的每一条都由第二代补齐',
  gapSeqs.length > 0 && gapMissing.length === 0,
  `断线期间落下 ${String(gapSeqs.length)} 条 [${gapSeqs.join(',')}]，第二代没补齐的 ${String(gapMissing.length)} 条${gapMissing.length > 0 ? ` [${gapMissing.join(',')}]` : ''}`)
check('⑦ 不丢（整表口径）：两代合起来覆盖权威全表，一条不缺',
  missing.length === 0 && allGen.length > 0,
  missing.length > 0 ? `缺 ${String(missing.length)} 条 [${missing.slice(0, 12).join(',')}]` : `全表 ${String(expected.length)} 条，两代共投 ${String(allGen.length)} 次`)
check('⑧ 不重：两代合起来没有任何一个 seq 被投两次（游标守卫在真断线上生效，不只是单测里）',
  dupes.length === 0, dupes.length > 0 ? `重复的 seq [${dupes.join(',')}]——那就是界面会看见两遍的形状` : '无重复')
check('⑨ 续读起点确实高于断线游标（客户端把游标带进了请求，第二代没从 0 重放）',
  Number.isFinite(firstOfSecond) && firstOfSecond > cursorAtCut, `第二代最早一条 seq=${String(firstOfSecond)}，断线游标=${String(cursorAtCut)}`)
check('⑩ 线上控制（绕过客户端）：服务端自己按 since 重放——直读那一发收到的 timeline 帧全部 > 游标。⑧ 的"无重复"因此是**线上就没重放**，不是客户端守卫独自滤掉的（把 URL 里的 since= 拿掉这条就红）',
  wireTimeline.length > 0 && wireAtOrBeforeCursor.length === 0,
  wireAtOrBeforeCursor.length > 0
    ? `重放了 ${String(wireAtOrBeforeCursor.length)} 条 ≤ 游标的：[${wireAtOrBeforeCursor.slice(0, 10).join(',')}]——服务端没按 since 过滤`
    : wireTimeline.length === 0
      ? `这一发一条 timeline 帧都没回（合成帧 ${String(wireFrames.length)} 条）——没量到重放就不能算它认 since，红在这里而不是算过。为什么没回：status=${String(wireStatus)} content-type=${wireCtype}`
      : `timeline 帧 ${String(wireTimeline.length)} 条，全部 > ${String(cursorAtCut)}`)
check('⑪ seq=0 的合成帧没把游标顶掉（断线时记的游标就等于第一代收到的最大 timeline seq；这条流上确实过合成帧）',
  cursorAtCut === Math.max(...firstGen) && metaFrames > 0, `合成帧 ${String(metaFrames)} 条，游标=${String(cursorAtCut)}`)

if (manufactured) {
  const archived = await api.archiveSession(sessionId)
  check('⑫ 造的会话归档掉（隔离库里不留没主的活跃线程）', archived.archived === true, JSON.stringify(archived))
}

if (failures.length > 0) {
  console.error(`\n✗ reconnect check FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ 断线 10 秒续读不丢不重 — 两代共 ${String(allGen.length)} 次投递覆盖权威全表 ${String(expected.length)} 条，0 重复、0 缺失，线上控制证明服务端按 since 重放（${ran} 项判定；${manufactured ? '含断线期间真落下的事件' : '断线期间有新事件那一半未测到'}。零上游花费${manufactured ? '：两发 prompt 只在这台 configured:false 时发，那几趟 run 从未离开本机' : '：这一档一条消息都不发'}）`)
