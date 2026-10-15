/**
 * accept-approval.ts — M1 acceptance: the three-state approval gate and the busy
 * queue, on a real run.
 *
 * Both need an actual tool call, which no amount of replay produces: approvals only
 * exist while an agent is mid-run. Costs upstream calls; reports the count.
 *
 *   node scripts/launch-sidecar.mjs && node scripts/accept-approval.ts
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, SessionModel, openSessionStream } from '../packages/client-core/src/index.ts'
import type { ApprovalAnswerBody } from '../packages/client-core/src/index.ts'
import { assertInstanceAlive, openInstance } from './lib-instance.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const handle = openInstance('M1 审批三态（允许一次／始终允许／拒绝）+ busy 队列', { spends: true })
const { api, info } = handle
await assertInstanceAlive(handle)

const health = await api.health()
if (!health.configured) { console.error('✗ provider not configured'); process.exit(1) }

const session = await api.createSession({ cwd: repoRoot, title: 'M1 approval probe', approvalMode: 'manual' })
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

const PROMPT = '请用写文件工具在仓库根目录创建文件 m1-approval-probe.txt，内容只有一行 ok-approved。写完就停，不要再做别的。'
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

const probeFile = join(repoRoot, 'm1-approval-probe.txt')
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
  const seen: string[] = []
  const answered = new Set<string>()
  let sawStart = false
  let sawTerminal = false
  const stop = openSessionStream({
    baseUrl: info.baseUrl, token: info.token, sessionId: sid, since: mm.current.lastSeq,
    onEvent: (e) => {
      mm.apply(e)
      if (e.event.type === 'status' && (e.event.data as { status?: string }).status === 'running') sawStart = true
      if (e.event.type === 'turn_complete' || e.event.type === 'done') sawTerminal = true
      if (e.event.type === 'approval_required') {
        const a = (e.event.data['approval'] ?? e.event.data) as { requestId?: string }
        const rid = String(a.requestId ?? '')
        seen.push(rid)
        if (answer && rid && !answered.has(rid)) {
          answered.add(rid)
          void api.answerApproval(sid, rid, answer)
        }
      }
    },
  })
  const before = seen.length
  const send = await api.prompt(sid, { prompt: `请用写文件工具在仓库根目录创建文件 ${file}，内容只有一行 ok。写完就停，不要再做别的。` })
  if (send === 'busy') console.log(`⚠ ${label}：上一条 run 还占着会话，prompt 被 409 拒了`)
  const dl = Date.now() + 150_000
  const grace = Date.now() + 25_000
  while (Date.now() < dl && !sawTerminal) {
    if (!sawStart && Date.now() > grace) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  stop()
  const onDisk = existsSync(join(repoRoot, file))
  if (onDisk) rmSync(join(repoRoot, file), { force: true })
  const errs = mm.current.blocks
    .flatMap((b) => (b.kind === 'tool' && b.isError ? [String(b.result ?? '').slice(0, 80)] : []))
    .filter((t) => t !== '')
  console.log(`${label}：新审批卡片 ${seen.length - before} 张 · 文件落盘=${onDisk} · 带报错的 tool_result ${errs.length} 条 · 开跑=${sawStart} 终止事件=${sawTerminal}`)
  return { cards: seen.length - before, onDisk, errs, sawStart, sawTerminal }
}

const grantRound = await drive(session.id, model, 'm1-always-grant.txt', { decision: 'approve', remember: true }, '始终允许·发 grant')
const afterGrant = await drive(session.id, model, 'm1-always-after.txt', null, '始终允许·grant 之后')
const denySess = await api.createSession({ cwd: repoRoot, title: 'M1 deny probe', approvalMode: 'manual' })
const denyModel = new SessionModel()
const denyRound = await drive(denySess.id, denyModel, 'm1-deny-probe.txt', { decision: 'deny' }, '拒绝（新会话）')
await api.archiveSession(denySess.id)

const failures: string[] = []
if (!gate) failures.push('no approval_required arrived — the three-state gate was not exercised')
if (answered === false) failures.push('approval never answered')
if (queueResult === 'not-attempted') failures.push('busy→queue path never attempted')
if (st.terminalStatus === 'failed') failures.push('run failed')
if (probeContent === null) failures.push('approved write never reached disk')
if (grantRound.cards < 1) failures.push('始终允许：grant 那一次没有审批卡片可答，决定值根本没发出去')
if (afterGrant.cards !== 0) failures.push(`始终允许：记住 grant 之后又来了 ${afterGrant.cards} 张审批卡片`)
if (!afterGrant.onDisk) failures.push('始终允许：grant 之后第二次调用的文件没落盘')
if (denyRound.cards < 1) failures.push('拒绝：新会话里没有审批卡片可拒')
if (denyRound.onDisk) failures.push('拒绝：被拒的写入仍然落盘了')
if (denyRound.errs.length === 0) failures.push('拒绝：tool_result 里没有非空的报错文本（内核那句"被拒"的字样没找到权威常量，故不钉字样——见 EVIDENCE 那格）')
if (!grantRound.sawTerminal) failures.push('始终允许：发 grant 那一轮没读到终止事件 ⇒ 卡片计数不可信（替身/断流会让"0 张"看着像通过）')
if (!afterGrant.sawTerminal) failures.push('始终允许：grant 之后那一轮没读到终止事件 ⇒ "0 张审批卡片"不作数，可能是提前退出而不是 grant 生效')
if (!denyRound.sawTerminal) failures.push('拒绝：那一轮没读到终止事件 ⇒ 落盘与报错计数都不可信')

await api.archiveSession(session.id)
if (failures.length > 0) {
  console.error(`\n✗ M1 approval/queue FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ M1 审批三态 + busy→queue 实测通过')
