/**
 * accept-history.ts — M2 历史向上分页（§4.3 #2 的冷通道）现在跑在一条零花费的常驻线上。
 *
 * 两条档，按**这台实例看得见 key 吗**分流，屏幕上各自点名：
 *   档一 `configured:false` ⇒ 当场造现场：建一条会话，连发 4 发注定失败的 prompt（无 key 的 run
 *     出不去本机：实测被受理后在本地转几秒，再自报 failed 并留下 error 事件），等事件落盘，拿这条
 *     会话走冷通道。常驻面走这一档的理由不是"顺手"：prompt 文字是脚本自己写的字面量，所以"翻到头
 *     之后时间线首块逐字等于发出的那句"是对真实外部世界的断言；档二只能拿最旧事件的文本当期望值，
 *     那是从同一份读数里回推出来的弱判据。
 *   档二（看得见 key，或位置参数给了 sessionId）⇒ 只读那台的真历史，一条消息都不发，零花费不变。
 *
 * 在此之前它只有档二，于是 §4.3 #2 这一格绿不绿取决于"有人记得手跑一次挂现机的脚本"。
 *
 * 三条判据是这轮新加的，因为旧脚本结构上看不见它们：
 *  - 内核认不认 `before=`：旧版先 `filter(seq < cursor)` 再数页数，越界返回的事件被滤掉 ⇒
 *    "内核把 before 当不存在"（本仓在 `GET /tasks` 上实测过这个形状）与"内核读了"打印出来一模一样。
 *    现在整页原样核对，把 URL 里的 `before=` 拿掉立刻红。
 *  - 分页**之前**首块不许就是那句 prompt：截断没发生的话，逐字判据会在空转里假绿。
 *  - 「最旧事件没有 text」旧版写作 `if (originalText && …)` ⇒ 量不到时静默跳过、照旧绿；
 *    现在那是一条会红的判据。
 *
 *   node scripts/accept-history.ts [sessionId]                       # 档二：指定或自动挑 lastSeq 最大的一条
 *   node scripts/accept-history.ts --info=<隔离实例的 .sidecar-info.json>   # 档一：无 key，当场造
 */
import { SessionModel, type SessionEvent } from '../packages/client-core/src/index.ts'
import { openInstance, probeWorkspace } from './lib-instance.ts'

const ws = probeWorkspace('history')
const { api, info } = openInstance('M2 历史向上分页：冷通道 before= 逐页回填到磁盘头')

const failures: string[] = []
let ran = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  ran += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ⑪ 用的比较函数。它故意小得只有一句 `===`：两条合成正控钉的就是**这个函数**，
// 所以谁把它放宽成 `includes`/`startsWith`，正控会当场红，而不是让 ⑪ 悄悄变得更宽松。
const leadsVerbatim = (blockText: string, expected: string): boolean => blockText === expected

const health = await api.health().catch(() => null)
const keyless = health?.configured === false
const explicitId = process.argv.slice(2).find((a) => !a.startsWith('--'))
console.log(`configured  ${String(health?.configured)} — ${keyless
  ? '这台没有上游凭据：现场可以自己造，那几趟 run 出不去本机'
  : '这台看得见上游凭据：一条消息都不发，只读现机真历史'}`)

// 12 发不是随手写的数：内核的冷页会把页首**向前对齐到最近的 user 事件**（session-manager.ts
// 的 getHistoryPage：limit 不够就按 4 倍扩窗），所以一页实际能吃下 limit + 一整段 turn。上一版只造
// 4 发（早于窗口的历史共 8 条、limit=4），第一次请求就把 8 条全包了 ⇒ ⑦ 当场红一次，红得对：
// 现场太小，压根没分页可量。12 发 = 早于窗口的那段约 24 条 ≈ 6 段 turn，limit 派生成 3，
// 对齐余量约 5 ⇒ 至少三四页，"逐页回填"这件事才有得量。
const TURNS = 12
const PROMPTS = Array.from({ length: TURNS }, (_, i) =>
  `accept-history 第 ${String(i + 1)} 发 · 无 key 的 run 只会自报 failed，它留下的那几条事件把磁盘日志推长到真能翻页`)

let sessionId = ''
let litPrompt: string | undefined
let probeSession = false

if (explicitId !== undefined) {
  const hit = (await api.listSessions({ includeArchived: true })).find((s) => s.id === explicitId)
  if (hit === undefined) {
    console.error(`✗ 这台实例上没有会话 ${explicitId} —— 档二要求显式给的 id 真存在，不去猜别条`)
    process.exit(1)
  }
  sessionId = hit.id
  console.log(`档二        读显式指定的会话 ${sessionId} title="${hit.title ?? ''}" lastSeq=${hit.lastSeq}`)
} else if (keyless) {
  probeSession = true
  const created = await api.createSession({
    title: 'history cold-channel probe',
    cwd: ws.cwd,
    workspaceMode: 'explicit',
  })
  sessionId = created.id
  litPrompt = PROMPTS[0]
  check('① 档一：造现场的会话建成（只落在本次隔离库里，prompt 文字是脚本自己写的字面量）',
    typeof created.id === 'string' && created.id.length > 0, created.id)
  check('①b 会话 cwd 就在本次的临时落点里（内核会往任何会话 cwd 种 `.rivet/`——写进操作者的工作树就是隔离破了）',
    String(created.cwd ?? '').replace(/\\/g, '/').toLowerCase().startsWith(ws.cwd.replace(/\\/g, '/').toLowerCase()),
    `落点=${ws.cwd}，会话认的 cwd=${String(created.cwd)}${ws.note === '' ? '' : ` ｜ ${ws.note}`}`)
  console.log(`  i 花费声明：这台 configured:false，接下来 ${String(TURNS)} 发 /prompt 由内核本地受理、不会离开本机（实测随后自报 failed 并留下 error 事件；第 2 发起每发只用约 0.1 秒——第 1 发那 4.4 秒是内核第一次解析模型档）`)
  const turns: { acc: string; final: string; ms: number; sawRunning: boolean }[] = []
  for (const text of PROMPTS) {
    const t0 = Date.now()
    const acc = await api.prompt(sessionId, { prompt: text })
    let status = ''
    let sawRunning = false
    for (let i = 0; i < 600; i++) {
      status = (await api.getSession(sessionId)).status
      if (status === 'running') sawRunning = true
      else break
      await sleep(100)
    }
    turns.push({ acc, final: status, ms: Date.now() - t0, sawRunning })
  }
  const notOk = turns.filter((t) => t.acc !== 'ok').length
  const unfinished = turns.filter((t) => t.final === 'running').length
  check(`② ${String(TURNS)} 发 prompt 全部被受理并各自走完（有一发停在 running 就没法保证分页读到的是一段定型的日志）`,
    turns.length === PROMPTS.length && notOk === 0 && unfinished === 0,
    `逐发 ${turns.map((t) => `${t.acc}→${t.final} ${t.ms}ms${t.sawRunning ? '' : '（未见 running）'}`).join(' · ')}`)

  let settled = 0
  for (let i = 0; i < 60; i++) {
    const n = (await api.events(sessionId, 0)).events.filter((e) => e.seq > 0 && e.type === 'user').length
    if (n === PROMPTS.length) { settled = n; break }
    settled = n
    await sleep(250)
  }
  check('③ 每一发都在日志里留下一条 user 事件（造出来的现场真有那么多段历史可翻）',
    settled === PROMPTS.length, `user 事件 ${settled}/${PROMPTS.length} 条（等落盘等到这里）`)
} else {
  const sessions = await api.listSessions({ includeArchived: true })
  const best = [...sessions].sort((a, b) => b.lastSeq - a.lastSeq)[0]
  if (best === undefined || best.lastSeq < 40) {
    console.error(`✗ 档二没有可用的现场：这台 ${info.baseUrl} 配了 key（不该由脚本发消息造现场），`
      + `而现有机里 lastSeq 最大的是 ${String(best?.lastSeq)}（要 ≥40 才谈得上分页）。要么给它一个 sessionId，要么换一台 configured:false 的隔离实例。`)
    process.exit(1)
  }
  sessionId = best.id
  console.log(`档二        读现机最大的一条会话 ${sessionId} title="${best.title ?? ''}" lastSeq=${best.lastSeq}（未发消息）`)
}

const whole = await api.events(sessionId, 0)
const timeline = whole.events.filter((e) => e.seq > 0)
if (timeline.length < 4) {
  console.error(`✗ 会话 ${sessionId} 只有 ${timeline.length} 条事件 —— 冷开通切不出两半，分页无从谈起`)
  process.exit(1)
}
const seqsAll = timeline.map((e) => e.seq)
const maxSeq = Math.max(...seqsAll)
const minSeq = Math.min(...seqsAll)
const typeHist = Object.entries(timeline.reduce<Record<string, number>>((m, e) => {
  m[e.type] = (m[e.type] ?? 0) + 1
  return m
}, {})).map(([t, n]) => `${t}=${n}`).join(' ')
// 类型面上热通道（EventWindow）没有 firstSeq；运行时到底有没有，得从 JSON 读数里探——这一探就是 ⑩b 的证据。
const hotHead = (whole as { firstSeq?: number }).firstSeq
const hotHasFirstSeq = hotHead !== undefined
console.log(`现场        session=${sessionId} 事件=${String(timeline.length)} 条 seq ${String(minSeq)}..${String(maxSeq)}，lastSeq=${String(whole.lastSeq)}，?since= 那一发的回包里 firstSeq=${hotHasFirstSeq ? String(hotHead) : '（没有这个字段）'}`)
console.log(`  i 事件类型分布：${typeHist}`)

const oldest = timeline.reduce((a, b) => (b.seq < a.seq ? b : a))
const oldestText = typeof oldest.data['text'] === 'string' ? oldest.data['text'] : ''
const expected = litPrompt ?? oldestText
check('④ 期望文字拿得到（档一用脚本自己写的字面量，档二从最旧事件里读；读不到就红——旧版那句 `if (originalText && …)` 是量不到也照绿）',
  expected.length > 0, `来源=${litPrompt === undefined ? `最旧事件 seq=${oldest.seq} type=${oldest.type}` : '脚本写下的字面量'}，长度=${expected.length}`)

// 冷开通：环只把尾段交给我们（§4.3 #2 描述的那个形状）。
const SPLIT = Math.max(minSeq + 2, Math.floor(maxSeq / 2) + 1)
const tail = timeline.filter((e) => e.seq >= SPLIT)
const olderTotal = timeline.filter((e) => e.seq < SPLIT).length
// limit 从现场规模派生（八分之一，下限 2）：写死一个数就等于把"分页"这件事变成对某一次读数的复述。
const LIMIT = Math.max(2, Math.floor(olderTotal / 8))
const model = new SessionModel()
model.loadEvents(tail)
const blocksBefore = model.current.blocks.length
const firstUserBefore = model.current.blocks.find((b) => b.kind === 'user')
console.log(`冷开通窗口  seq>=${SPLIT}（${tail.length} 条）⇒ blocks=${blocksBefore}；磁盘上更早的还有 ${olderTotal} 条，每页 limit=${LIMIT}（从现场规模派生，不是写死的）`)
check('⑤ 截断真的发生过：分页之前的首个 user 块不是那句 prompt（否则 ⑪ 的逐字判据是在空转里假绿）',
  (firstUserBefore?.kind !== 'user' || firstUserBefore.text !== expected) && olderTotal > 0,
  `分页前首块=${firstUserBefore?.kind === 'user' ? JSON.stringify(firstUserBefore.text.slice(0, 40)) : '(窗口里没有 user 块)'}，更早的事件 ${olderTotal} 条`)

interface PageRec { before: number; seqs: number[]; added: number; firstSeq: number; outOfRange: number[] }
const pages: PageRec[] = []
let cursor = SPLIT
let guardRanOut = true
let headFirstSeq = Number.NaN
const GUARD = 64
for (let i = 0; i < GUARD; i++) {
  const page = await api.historyPage(sessionId, cursor, LIMIT)
  const pageSeqs = page.events.map((e) => e.seq)
  const outOfRange = pageSeqs.filter((s) => !(s > 0 && s < cursor))
  const older = page.events.filter((e) => e.seq > 0 && e.seq < cursor)
  if (older.length === 0) {
    headFirstSeq = page.firstSeq
    guardRanOut = false
    console.log(`停止        第 ${i + 1} 次请求 before=${cursor} 回 ${pageSeqs.length} 条、其中 0 条早于游标；内核报的磁盘头 firstSeq=${page.firstSeq}`)
    break
  }
  const added = model.prependEvents(older)
  pages.push({ before: cursor, seqs: pageSeqs, added, firstSeq: page.firstSeq, outOfRange })
  console.log(`page ${pages.length}:  before=${cursor} 回 ${pageSeqs.length} 条 [${pageSeqs.join(',')}] 收编 ${added} 条 firstSeq=${page.firstSeq} blocks=${model.current.blocks.length}`)
  cursor = Math.min(...pageSeqs.filter((s) => s > 0))
  headFirstSeq = page.firstSeq
}

const allPageSeqs = pages.flatMap((p) => p.seqs)
const outOfDay = pages.flatMap((p) => p.outOfRange)
check('⑥ 内核真读了 before=：每一页返回的 seq 都早于该页的游标（整页原样核对，没有先滤掉越界的）',
  pages.length > 0 && outOfDay.length === 0,
  outOfDay.length > 0
    ? `有 ${outOfDay.length} 条越界（${outOfDay.slice(0, 8).join(',')}）—— 内核把 before 当不存在，把 URL 里的 before= 拿掉就是这个形状`
    : `${pages.length} 页 × 全部在界内`)
check('⑦ 分页真存在：不止一次请求就把更早的历史翻完（页数 ≥2）',
  pages.length >= 2, `${pages.length} 页，每页条数 ${pages.map((p) => p.seqs.length).join('/')}`)
const cursors = pages.map((p) => p.before)
const monoOk = cursors.every((c, i) => i === 0 || c < (cursors[i - 1] ?? Number.POSITIVE_INFINITY))
const dupCount = allPageSeqs.length - new Set(allPageSeqs).size
check('⑧ 游标逐页严格递减且页间零重叠（同一个 seq 不会被两页都交回来）',
  monoOk && dupCount === 0, `游标 ${cursors.join('→')}${dupCount > 0 ? `；重叠 ${dupCount} 个 seq` : '；无重叠'}`)

const adopted = new Set([...allPageSeqs, ...tail.map((e) => e.seq)])
const missing = timeline.filter((e) => e.seq < SPLIT && !adopted.has(e.seq))
check('⑨ 早于冷开通窗口的事件一条不缺（回填的完备性，按最旧读数逐条点名）',
  missing.length === 0 && allPageSeqs.length > 0,
  missing.length > 0 ? `缺 ${missing.length} 条：${missing.slice(0, 8).map((e) => `${e.seq}:${e.type}`).join(',')}` : `收编 ${allPageSeqs.length} 条，磁盘上早于窗口的共 ${olderTotal} 条`)
const extras = allPageSeqs.filter((s) => !seqsAll.includes(s))
check('⑩ 盘尽有可观察信号：翻到的最小 seq 就是内核报的磁盘头 firstSeq，且分页是因为"没有更早的了"才停，不是撞满迭代上限',
  !guardRanOut && Number.isFinite(headFirstSeq) && Math.min(...[...adopted]) === headFirstSeq,
  `最小 seq=${Math.min(...[...adopted])}，内核报的磁盘头 firstSeq=${Number.isFinite(headFirstSeq) ? headFirstSeq : '?'}，停止方式=${guardRanOut ? `撞满 ${String(GUARD)} 次上限（没观察到尽头）` : '拿到零条更早的事件'}${extras.length > 0 ? `；另有 ${extras.length} 条 seq 不在整表读数里（冷页各自合并 delta run，属预期）` : ''}`)

check('⑩b 盘尽信号只在冷通道上：?since= 那一发的回包里没有任何磁盘头字段（内核 getEventsAsync 只回 {events,lastSeq}），而 ?before= 那一路有——所以客户端要判断"翻到头了"必须走冷通道，不能拿整表读数猜',
  !hotHasFirstSeq && pages.length > 0 && Number.isFinite(headFirstSeq),
  `热通道 firstSeq 字段=${hotHasFirstSeq ? `在（值=${String(hotHead)}）——内核改了，可以去掉一次冷通道往返` : '不在'}；冷通道最近一次报的磁盘头=${Number.isFinite(headFirstSeq) ? String(headFirstSeq) : '?'}`)

const blocks = model.current.blocks
const firstUser = blocks.find((b) => b.kind === 'user')
check('⑪ 回填到磁盘头之后，时间线首个 user 块逐字等于那句 prompt（不是子串、不是前缀）',
  firstUser?.kind === 'user' && leadsVerbatim(firstUser.text, expected),
  `实得 ${firstUser?.kind === 'user' ? JSON.stringify(firstUser.text.slice(0, 60)) : '(没有 user 块)'}`)
check('⑫ 正控：⑪ 那个比较函数对"完全相同"必须放行，对"被夹在中间"和"少一截"必须都拦下（把它放宽成 includes 这一条当场红）',
  expected.length > 0 && leadsVerbatim(expected, expected)
    && !leadsVerbatim(`前缀 ${expected}`, expected) && !leadsVerbatim(expected.slice(0, -3), expected),
  `三例：相同=${leadsVerbatim(expected, expected)} 夹在中间=${leadsVerbatim(`前缀 ${expected}`, expected)} 少一截=${leadsVerbatim(expected.slice(0, -3), expected)}`)
const zeroAdd = pages.filter((p) => p.added === 0)

check('⑬ 每一页都真被模型收编（prependEvents 返回的新条数 > 0），且块数随分页增长',
  zeroAdd.length === 0 && blocks.length > blocksBefore, `每页收编 ${pages.map((p) => p.added).join('/')}，blocks ${blocksBefore}→${blocks.length}`)
check('⑭ 回填之后 model 的 lastSeq 没回退（往前翻页不许把正在读的位置弄丢）',
  model.current.lastSeq >= maxSeq, `lastSeq=${model.current.lastSeq}，现场最大 seq=${maxSeq}`)

const userTexts = [...new Set(timeline.filter((e) => e.type === 'user')
  .map((e) => (typeof e.data['text'] === 'string' ? e.data['text'] : '')))]
const absent = userTexts.filter((t) => !blocks.some((b) => b.kind === 'user' && b.text === t))
check(`⑮ 时间线里每一条 user 文本（档一就是我发出的那 ${PROMPTS.length} 句）回填后都在块里，一条不少`,
  absent.length === 0 && userTexts.length > 0, `${userTexts.length} 句 / 缺席 ${absent.length}${absent.length > 0 ? `：${absent.slice(0, 3).map((t) => JSON.stringify(t.slice(0, 24))).join(' ')}` : ''}`)

if (probeSession) {
  const archived = await api.archiveSession(sessionId)
  check('⑯ 造出来的会话归档掉（隔离库里不留没主的活跃线程；这条库本身随临时目录一起删）',
    archived.archived === true, JSON.stringify(archived))
}

if (failures.length > 0) {
  console.error(`\n✗ history paging FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ M2 历史向上分页 — 冷通道 before= 逐页回填到磁盘头，首块逐字等于发出去的那句（${ran} 项判定；${probeSession ? `含当场造出来的会话与那 ${String(TURNS)} 发 prompt` : '读的是现机真历史，未造现场'}。零上游花费${probeSession
  ? '：prompt 只在这台 configured:false 时发，那几趟 run 从未离开本机' : '：这一档一条消息都不发'}）`)
