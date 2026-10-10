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

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

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

const failures: string[] = []
if (!gate) failures.push('no approval_required arrived — the three-state gate was not exercised')
if (answered === false) failures.push('approval never answered')
if (queueResult === 'not-attempted') failures.push('busy→queue path never attempted')
if (st.terminalStatus === 'failed') failures.push('run failed')
if (probeContent === null) failures.push('approved write never reached disk')

await api.archiveSession(session.id)
if (failures.length > 0) {
  console.error(`\n✗ M1 approval/queue FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ M1 审批三态 + busy→queue 实测通过')
