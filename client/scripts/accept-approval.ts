/**
 * accept-approval.ts — M1 acceptance: the three-state approval gate and the busy
 * queue, on a real run.
 *
 * Both need an actual tool call, which no amount of replay produces: approvals only
 * exist while an agent is mid-run. Costs upstream calls; reports the count.
 *
 *   node scripts/launch-sidecar.mjs && node scripts/accept-approval.ts
 */
import { readFileSync, existsSync, rmSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, SessionModel, openSessionStream } from '../packages/client-core/src/index.ts'
import type { ApprovalAnswerBody } from '../packages/client-core/src/index.ts'
import { assertInstanceAlive, openInstance, probeWorkspace } from './lib-instance.ts'
import { grantRecorded, roundFacts, spendOf } from './lib-spend.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 会话 cwd 用临时探针工作区，不用操作者仓根：内核会往**任何会话 cwd** 种 `.rivet/`（skills + 它自己的库），
// 而 `src/agent/memory-epoch.ts` 那份 LEGACY_FILES 又按 `<cwd>` **删**仓根 `.rivet/` 里已有的文件——
// 这一趟是付费真 run，正是把 #174 家族最后两处搬走的时机（`verify-accept-zero` 的 containment 判据
// 盯的就是这件事，只是它原来只管那 8 台零花费的）。
const ws = probeWorkspace('approval')
const probeRoot = ws.cwd
console.log(`probe root  ${probeRoot}${ws.note === '' ? '' : ` ｜ ${ws.note}`}`)
const handle = openInstance('M1 审批三态（允许一次／始终允许／拒绝）+ busy 队列', { spends: true })
const { api, info } = handle
await assertInstanceAlive(handle)

const health = await api.health()
if (!health.configured) { console.error('✗ provider not configured'); process.exit(1) }

const session = await api.createSession({ cwd: probeRoot, title: 'M1 approval probe', approvalMode: 'manual' })
const model = new SessionModel()
const events: string[] = []
let resolveApproval: ((v: string) => void) | null = null
const approvalSeen = new Promise<string>((rs) => { resolveApproval = rs })

const close = openSessionStream({
  baseUrl: info.baseUrl, token: info.token, sessionId: session.id, since: 0,
  onEvent: (e) => {
    const ev = e.event
    events.push(`${ev.seq} ${e.category} ${ev.type}`)
    model.apply(e)
    if (ev.type === 'approval_required' && resolveApproval) {
      const req = (ev.data['approval'] ?? ev.data) as { requestId?: string; toolName?: string }
      resolveApproval(`${req.requestId ?? ''}|${req.toolName ?? ''}`)
      resolveApproval = null
    }
  },
})

// 探针落点：会话 cwd 之内一枚（测常规审批）+ 两个**工作区外**的目录（测 remember）。
// 为什么非得出工作区：`src/agent/tool-pipeline.ts` 只在 `outOfWorkspaceFilePaths(...)` 有值时才消费
// `remember`——答一次就 `grantPath(dirname(p), mode, { persist: remember===true, cwd })`，
// persist 的才写进那份按工作存的授权表。而**即使不 remember，同会话内同一目录也不再问**（in-process grant），
// 所以"同会话第二轮不再弹卡"根本证明不了"始终允许"；能证明它的只有**换会话**。
const outGrant = mkdtempSync(join(tmpdir(), 'tianshu-probe-approval-out-'))
const outOnce = mkdtempSync(join(tmpdir(), 'tianshu-probe-approval-once-'))
const PROBES = {
  main: join(probeRoot, 'm1-approval-probe.txt'),
  alwaysGrant: join(outGrant, 'm1-always-grant.txt'),
  alwaysAfter: join(outGrant, 'm1-always-after.txt'),
  onceGrant: join(outOnce, 'm1-once-grant.txt'),
  onceAfter: join(outOnce, 'm1-once-after.txt'),
  deny: join(probeRoot, 'm1-deny-probe.txt'),
} as const

const PROMPT = `请用写文件工具创建这个文件（按给出的绝对路径写，不要改到别处）：${PROBES.main}，内容只有一行 ok-approved。写完就停，不要再做别的。`
const t0 = Date.now()
const busy = await api.prompt(session.id, { prompt: PROMPT })
console.log(`prompt → ${busy}`)

// --- three-state gate -------------------------------------------------------
let gate: string | null = null
try {
  gate = await Promise.race([
    approvalSeen,
    new Promise<string>((_, rj) => setTimeout(() => rj(new Error('no approval within 120s')), 120_000)),
  ])
} catch (e) {
  console.log(`⚠ ${(e as Error).message}`)
}

const pending = model.current.approvals
console.log(`approvals pending : ${pending.length}`)
for (const a of pending) console.log(`  ${a.requestId} tool=${a.toolName} input=${JSON.stringify(a.input).slice(0, 140)}`)

let answered = false
if (pending[0]) {
  // "允许一次" — the plain approve with no remember flag.
  await api.answerApproval(session.id, pending[0].requestId, { decision: 'approve' })
  answered = true
  console.log(`answered ${pending[0].requestId} decision=approve remember=false (+${Math.round((Date.now() - t0) / 1000)}s)`)
}

// --- busy → queue -----------------------------------------------------------
let queueResult = 'not-attempted'
if (answered && model.current.running) {
  queueResult = (await api.queue(session.id, '（排队验证）这条应当在 busy 时被接住')) === 'idle' ? 'idle' : 'queued'
  console.log(`queue while busy  : ${queueResult}`)
} else {
  // Force the busy path deterministically: a second /prompt must be refused with 409
  // while the first run is still going, otherwise the queue fallback is untested.
  const second = await api.prompt(session.id, { prompt: '第二条：应当在 busy 时被拒' })
  console.log(`second prompt     : ${second === 'busy' ? '409 busy (correct)' : second}`)
  if (second === 'busy') {
    queueResult = (await api.queue(session.id, '（排队验证）')) === 'idle' ? 'idle' : 'queued'
    console.log(`queue fallback    : ${queueResult}`)
  }
}

// manual approval mode gates EVERY tool call, so answering only the first would leave
// the run parked on the second. Keep a wiper going; the tested gate is still the first
// card, which had to be observed and answered over REST for anything to proceed.
const wiper = setInterval(() => {
  for (const a of model.current.approvals) {
    void api.answerApproval(session.id, a.requestId, { decision: 'approve' })
      .then(() => console.log(`  auto-answered follow-up ${a.requestId} (${a.toolName})`))
      .catch(() => undefined)
  }
}, 2000)

// Let the run finish after the approval.
const deadline = Date.now() + 150_000
while (model.current.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
clearInterval(wiper)
close()

const st = model.current
console.log(`\nfinal status : ${st.terminalStatus ?? (st.running ? 'running' : 'n/a')}, lastSeq=${st.lastSeq}`)
console.log(`tool blocks  : ${st.blocks.filter((b) => b.kind === 'tool').length}`)
for (const b of st.blocks.filter((x) => x.kind === 'tool')) {
  if (b.kind === 'tool') console.log(`  ${b.name} isError=${b.isError} result=${(b.result ?? '').slice(0, 90)}`)
}
console.log(`events       : ${events.length}`)
console.log(events.slice(-14).join('\n'))

const probeFile = PROBES.main
// The point of answering "allow once" is that the write then happens — verify it on
// disk, then clean up our own probe artifact.
const probeContent = existsSync(probeFile) ? readFileSync(probeFile, 'utf8').trim() : null
if (probeContent !== null) rmSync(probeFile, { force: true })
console.log(`probe file landed: ${probeContent !== null} (content=${JSON.stringify(probeContent).slice(0, 40)}, removed after check)`)

// --- 三态里此前欠的那两态：始终允许（grant 之后不再要审批）与拒绝（不落盘且带原因） ---
// 内核契约（本轮核过）：POST /sessions/:id/interventions/:requestId/answer 读 { decision, editedInput, remember }；
// 非 approve 的决定值一律当 reject，approval_resolved 只有 approve / reject 两种值。
// 所以「始终允许」= decision approve + remember:true，并且**下一次同工具调用不再产生 approval_required**；
// 「拒绝」必须另开一个会话——grant 一旦被记住，后面就没有卡片可拒了。
const drive = async (
  sid: string,
  mm: SessionModel,
  file: string,
  answer: ApprovalAnswerBody | null,
  label: string,
) => {
  const floor = mm.current.lastSeq
  const answeredIds = new Set<string>()
  // 流只负责**当场把卡片答掉**（不答 run 会一直parking）；所有读数改成从磁盘转录取。
  // 这一条是今天那发付费跑教的：`/stream` 关连接时补的那一帧空 `done` 会被"本轮终态"数进去，
  // 于是一轮什么都没看着（开跑=false）却报终态=true、卡片数 0——而转录里明明写着又弹了一张卡。
  const stop = openSessionStream({
    baseUrl: info.baseUrl, token: info.token, sessionId: sid, since: floor,
    onEvent: (e) => {
      mm.apply(e)
      if (e.event.type === 'approval_required' && answer) {
        const a = (e.event.data['approval'] ?? e.event.data) as { requestId?: string }
        const rid = String(a.requestId ?? '')
        if (rid && !answeredIds.has(rid)) {
          answeredIds.add(rid)
          void api.answerApproval(sid, rid, answer)
        }
      }
    },
  })
  const text = `请用写文件工具创建这个文件（按给出的绝对路径写，不要改到别处）：${file}，内容只有一行 ok。写完就停，不要再做别的。`
  let send = await api.prompt(sid, { prompt: text })
  let accepted = send !== 'busy'
  // 空闲与否只有服务端说了算：客户端的 running 会先落，而队列里的消息还在跑（今天实测撞过 409）。
  // 所以撞 busy 就重试，而不是信自己那份快照；上限 12×5s，超了就把"这一轮没发出去"如实报出来。
  for (let retry = 0; !accepted && retry < 12; retry++) {
    await new Promise((r) => setTimeout(r, 5000))
    send = await api.prompt(sid, { prompt: text })
    accepted = send !== 'busy'
  }
  if (!accepted) console.log(`⚠ ${label}：重试 12 次（60s）后 prompt 仍被 409 busy 拒——这一轮什么都没发出去`)
  let f = await roundFacts(api, sid, floor)
  const dl = Date.now() + 180_000
  while (Date.now() < dl && !(f.sawUser && f.sawTerminal)) {
    await new Promise((r) => setTimeout(r, 2000))
    f = await roundFacts(api, sid, floor)
  }
  stop()
  const onDisk = existsSync(file)
  if (onDisk) rmSync(file, { force: true })
  const errs = mm.current.blocks
    .flatMap((b) => (b.kind === 'tool' && b.isError ? [String(b.result ?? '').slice(0, 80)] : []))
    .filter((t) => t !== '')
  console.log(`${label}：本轮 seq ${f.from}…${f.to}（${f.rows} 条）· 新审批卡片 ${f.cards} 张 · 已答 ${f.answered} · 文件落盘=${onDisk} · 带报错的 tool_result ${errs.length} 条 · 发出=${accepted} 开跑=${f.sawRunning} 终态=${f.sawTerminal}`)
  return { cards: f.cards, onDisk, errs, accepted, sawStart: f.sawRunning, sawTerminal: f.sawTerminal, sawUser: f.sawUser }
}

// 「始终允许」＝那一份**持久化**的目录授权。内核只在 `outOfWorkspaceFilePaths` 有值时消费 `remember`，
// 而 `persist:false` 的授权**已在本会话内**免审同一目录 ⇒ "同会话第二轮不再弹卡"区分不了 remember 与 once，
// 今天那 0 张卡就是这么来的假信号。唯一能区分的是**换会话、同一工作区**：
//   A 会话 approve+remember:true 记住 OUT ⇒ B 会话（同 cwd）写同一目录**必须 0 张卡**；
//   对照组 C 会话只「允许一次」（不 persist）记 OUT₂ ⇒ D 会话（同 cwd）写 OUT₂ **必须再来一张**。
// 六个会话各开各的：主会话那边还挂着 busy→queue 的排队消息，同会话发第二条会撞 409（今天就是这样吞掉 grant 的）。
const alwaysSess = await api.createSession({ cwd: probeRoot, title: 'M1 always-allow probe', approvalMode: 'manual' })
const alwaysModel = new SessionModel()
const grantRound = await drive(alwaysSess.id, alwaysModel, PROBES.alwaysGrant, { decision: 'approve', remember: true }, '始终允许·A 会话发 grant')
const crossSess = await api.createSession({ cwd: probeRoot, title: 'M1 always-allow cross-session probe', approvalMode: 'manual' })
const crossModel = new SessionModel()
const afterGrant = await drive(crossSess.id, crossModel, PROBES.alwaysAfter, { decision: 'approve' }, '始终允许·B 会话（换了会话，期望 0 张卡）')
const onceSess = await api.createSession({ cwd: probeRoot, title: 'M1 once-only control probe', approvalMode: 'manual' })
const onceModel = new SessionModel()
const onceGrant = await drive(onceSess.id, onceModel, PROBES.onceGrant, { decision: 'approve' }, '对照组·C 会话只「允许一次」')
const onceCrossSess = await api.createSession({ cwd: probeRoot, title: 'M1 once-only cross-session probe', approvalMode: 'manual' })
const onceCrossModel = new SessionModel()
const onceAfter = await drive(onceCrossSess.id, onceCrossModel, PROBES.onceAfter, { decision: 'deny' }, '对照组·D 会话（没 persist 就该再弹一张）')
const denySess = await api.createSession({ cwd: probeRoot, title: 'M1 deny probe', approvalMode: 'manual' })
const denyModel = new SessionModel()
const denyRound = await drive(denySess.id, denyModel, PROBES.deny, { decision: 'deny' }, '拒绝（新会话）')
// 本轮的上游账单：从会话转录里数（冷通道回填到磁盘头），不是从 provider-calls.jsonl——
// 2026-10-15 那趟真跑实测：转录里有 usage，而 provider-calls.jsonl 根本没落盘。
// 数不出来的花费等于没花，这是自欺：取不到就红，让"花了多少"永远是这一趟自己报的。
const spendMain = await spendOf(api, session.id, model.current.lastSeq)
const spendAlways = await spendOf(api, alwaysSess.id, alwaysModel.current.lastSeq)
const spendCross = await spendOf(api, crossSess.id, crossModel.current.lastSeq)
const spendOnce = await spendOf(api, onceSess.id, onceModel.current.lastSeq)
const spendOnceCross = await spendOf(api, onceCrossSess.id, onceCrossModel.current.lastSeq)
const spendDeny = await spendOf(api, denySess.id, denyModel.current.lastSeq)
// 每一个会话都要数：上一趟 grant 那一轮根本不进账单，于是 12 发的真实成本被读成"主会话 + 拒绝会话"
// 两个数——加起来对不上的那一份，正是最贵的那一轮。
const parts = [
  { label: '主会话（允许一次 + busy/queue）', s: spendMain },
  { label: 'A 会话（发 grant）', s: spendAlways },
  { label: 'B 会话（跨会话，期望免审）', s: spendCross },
  { label: 'C 会话（对照组·允许一次）', s: spendOnce },
  { label: 'D 会话（对照组·跨会话，期望仍弹卡）', s: spendOnceCross },
  { label: '拒绝会话', s: spendDeny },
]
const spend = {
  calls: parts.reduce((n, p) => n + p.s.calls, 0),
  inTok: parts.reduce((n, p) => n + p.s.inTok, 0),
  outTok: parts.reduce((n, p) => n + p.s.outTok, 0),
  atHead: parts.every((p) => p.s.atHead),
}
console.log(`\n上游账单（本轮，来源=会话转录冷通道回填）：${spend.calls} 发 · 输入 ${spend.inTok} tok · 输出 ${spend.outTok} tok · 回填到磁盘头=${spend.atHead ? '是' : '否'}`)
for (const p of parts) console.log(`  ${p.label}：${p.s.calls} 发 / ${p.s.rows} 条事件`)

// 归档=DELETE（转录一起带走），所以每一行都必须排在账单之后。
for (const sid of [alwaysSess.id, crossSess.id, onceSess.id, onceCrossSess.id, denySess.id]) await api.archiveSession(sid)

// 收尾清扫：drive() 在收到本轮终态的下一刻就看 existsSync，而写入可能落在那之后。
// 上一趟就是这么留下一个 11 B 的 m1-approval-probe.txt（mtime 在那一次检查之后），
// 靠人工才发现。这里在流都关掉之后重看四类名字，并把归属直接打在数上：
// mtime ≥ 本轮开始 ⇒ 这一趟写的、drive() 没接住（红）；更早 ⇒ 前一趟的残留（如实报，不算本轮缺陷）。
const strays: { name: string; thisRun: boolean; detail: string }[] = []
for (const p of Object.values(PROBES)) {
  if (!existsSync(p)) continue
  const stt = statSync(p)
  const f = basename(p)
  strays.push({
    name: f,
    thisRun: stt.mtimeMs >= t0,
    detail: `${f} ${stt.size} B · mtime ${new Date(stt.mtimeMs).toISOString()} · 本轮起于 ${new Date(t0).toISOString()} · 内容 ${JSON.stringify(readFileSync(p, 'utf8').trim().slice(0, 40))}`,
  })
}
// 这些名字只属于本脚本的探针族（都落在临时目录里，不进仓），无论归属哪一趟都删掉。
for (const p of Object.values(PROBES)) rmSync(p, { force: true })
console.log(`\n残留探针清扫：${strays.length === 0 ? '六枚探针位都干净（本轮 0 个残留）' : `${strays.length} 个残留已删除\n  ${strays.map((s) => s.detail).join('\n  ')}`}`)

// 「始终允许」到底记没记住，唯一的机器可读观测量是那份**按工作区存的目录授权表**
// （`GET /config/path-grants?cwd=`，内核在答完审批后写它：`persist = remember===true`）。
// 卡片数在这个档里不能当判据：`approvalMode:'manual'` 下每一次工具调用都要审
// （`src/agent/tool-pipeline.ts` 的 `shouldAsk` 在 `pathGrantNeed` 之后还有一支
// `approvalMode==='manual' ? needsApproval`），所以记住了也照样弹卡——今天 B/D 两轮各一张卡就是这么来的。
const rawGet = async (path: string) => {
  const r = await fetch(`${info.baseUrl}${path}`, { headers: { authorization: `Bearer ${info.token}` } })
  return { status: r.status, body: await r.json().catch(() => null) as { grants?: { path?: string; mode?: string; exists?: boolean }[] } | null }
}
const grantsRes = await rawGet(`/config/path-grants?cwd=${encodeURIComponent(probeRoot)}`)
const grantList = grantsRes.body?.grants ?? []
const grantPaths = grantList.map((g) => String(g.path ?? ''))
const rememberedLanded = grantRecorded(grantList, outGrant)
const onceLanded = grantRecorded(grantList, outOnce)
console.log(`\n目录授权表（GET /config/path-grants?cwd=${probeRoot}）→ HTTP ${grantsRes.status}，${grantList.length} 条：${grantPaths.join(' 、') || '（空表）'}`)
console.log(`  i remember 的那个目录在表里=${rememberedLanded}（${outGrant}）；只「允许一次」的对照目录在表里=${onceLanded}（${outOnce}）`)

const failures: string[] = []
if (!gate) failures.push('no approval_required arrived — the three-state gate was not exercised')
if (answered === false) failures.push('approval never answered')
if (queueResult === 'not-attempted') failures.push('busy→queue path never attempted')
if (st.terminalStatus === 'failed') failures.push('run failed')
if (probeContent === null) failures.push('approved write never reached disk')
if (grantRound.cards < 1) failures.push('始终允许：A 会话那一次没有审批卡片可答（决定值没发出去）⇒ 授权表那条读数没有前提')
if (onceGrant.cards < 1) failures.push('对照组：C 会话没有卡片可答 ⇒ 它那一趟没走过真审批，"允许一次不 persist"这条没被真正对照过')
if (!afterGrant.sawUser) failures.push('始终允许：B 会话那一轮转录里没有本轮的 user 消息 ⇒ 那一轮压根没跑起来')
// 语义判据只看那张表：remember 的目录必须在、只「允许一次」的对照目录必须不在。
// **卡片数不参与判定**——上一版在这里判 `afterGrant.cards !== 0`，量的其实是"manual 档要不要审"：
// `shouldAsk` 在 `pathGrantNeed` 之后还有一支 `approvalMode==='manual' ? needsApproval`，
// 记住了也照样弹卡（今天 B 与对照 D 各一张卡就是这样把一次真跑读成"没兑现"的）。
if (!rememberedLanded) failures.push(`始终允许没兑现：内核按工作区存的授权表里没有 remember 的那个目录（表内 ${grantPaths.length} 条：${grantPaths.join(' 、') || '空'}）`)
if (onceLanded) failures.push('对照组失效：只「允许一次」的目录也进了授权表 ⇒ 这张表分不开 persist 与 in-process，上一条"记住了"因此不作数')
if (denyRound.cards < 1) failures.push('拒绝：新会话里没有审批卡片可拒')
if (denyRound.onDisk) failures.push('拒绝：被拒的写入仍然落盘了')
if (denyRound.errs.length === 0) failures.push('拒绝：tool_result 里没有非空的报错文本（内核那句"被拒"的字样没找到权威常量，故不钉字样——见 EVIDENCE 那格）')
for (const r of [grantRound, afterGrant, onceGrant, onceAfter, denyRound]) {
  if (!r.sawTerminal) failures.push(`有一轮（卡片数 ${r.cards}）在转录里没读到**本轮**终态 ⇒ 它的计数不作数（提前退出/断流都会让"0 张"看着像通过）`)
  if (!r.accepted) failures.push('有轮次的 prompt 没发出去（409 busy）⇒ 那一轮的计数、落盘与报错都不作数')
}
if (spend.calls === 0 || !spend.atHead) failures.push(`本轮花费无从核对（转录里读到 ${spend.calls} 发、回填到磁盘头=${spend.atHead}）⇒ 打了上游却拿不出账单，按"未测到"记红`)
if (!denyRound.sawTerminal) failures.push('拒绝：那一轮没读到终止事件 ⇒ 落盘与报错计数都不可信')
const lateStrays = strays.filter((s) => s.thisRun)
if (lateStrays.length > 0) {
  const ns = lateStrays.map((s) => s.name).join('、')
  failures.push(`探针在 drive() 检查之后才落盘（${ns}）⇒ 那一轮的落盘判定看早了：${lateStrays.some((s) => s.name === PROBES.deny) ? '其中被拒那一轮的文件落了盘，"拒绝不落盘"这条没通过' : '该轮的否定判定（"落盘=否"）不可信，只有正向落盘还算数'}`)
}

await api.archiveSession(session.id)
if (failures.length > 0) {
  console.error(`\n✗ M1 approval/queue FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ M1 审批三态 + busy→queue 实测通过（三态各自量到了什么：允许一次=卡片答掉且写落盘且下轮仍要审；拒绝=不落盘且带 isError；始终允许=那条目录授权真的 persist 进了按工作区存的表）')
