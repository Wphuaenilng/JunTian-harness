/**
 * accept-always-cross.ts — 「始终允许」的**跨进程**活验：只有重启能量到那一半。
 *
 * 为什么必须是两阶段 + 中间重启：内核的目录授权有两层
 * （`src/tools/path-grants.ts`：in-process 与 persisted per-workspace）。
 * 在同一进程里，"允许一次"也已经免审同一目录（上一版判据就死在这条上——
 * 它拿 manual 档的卡片数当"记没记住"，而 manual 档每次工具调用都要审）。
 * 只有**换了进程**还认的那一份，才是 `remember` 独有的东西。
 * 而档位用 `auto-safe`：`src/agent/tool-pipeline.ts` 的 `shouldAsk` 在
 * `pathGrantNeed` 之后还有 `approvalMode === 'manual' ? needsApproval` 那一支，
 * manual 档下卡片数与授权无关，量不出免审。
 *
 *   node scripts/launch-sidecar.mjs --desktop-dir <keyed> --isolate-home
 *   node scripts/accept-always-cross.ts --phase=setup
 *   node scripts/launch-sidecar.mjs --stop && 再起一次（同 desktop-dir、同旗标）
 *   node scripts/accept-always-cross.ts --phase=verify
 *
 * 两阶段合起来 4 个 prompt；脚本自己报上游账单（发数与 token），不靠人事后数。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionModel, openSessionStream } from '../packages/client-core/src/index.ts'
import type { ApprovalAnswerBody } from '../packages/client-core/src/index.ts'
import { assertInstanceAlive, openInstance, probeWorkspace } from './lib-instance.ts'
import { grantRecorded, roundFacts, spendOf } from './lib-spend.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const phase = (process.argv.slice(2).find((a) => a.startsWith('--phase=')) ?? '--phase=setup').slice('--phase='.length)
if (phase !== 'setup' && phase !== 'verify') {
  console.error(`✗ --phase 只认 setup / verify，收到 ${JSON.stringify(phase)}`)
  process.exit(2)
}

const handle = openInstance(`「始终允许」的跨进程活验（${phase === 'setup' ? '第一阶段：答两次审批，一次 remember 一次只允许' : '第二阶段：重启之后看哪一份还认'}）`, { spends: true })
const { api, info } = handle
await assertInstanceAlive(handle)

const health = await api.health()
if (!health.configured) {
  console.error('✗ provider not configured —— 这一档要的是真上游：无 key 的 run 走不到审批之后那一步')
  process.exit(1)
}

// 固定的两个出界目录与固定的会话工作区：两阶段之间**路径不许变**，
// 否则第二阶段的 slug 与目录都不是同一个，跨进程这件事就根本没被问到一个对象上。
const ws = probeWorkspace('always-cross')
const probeRoot = ws.cwd
const dirRemembered = join(resolve(probeRoot, '..'), 'tianshu-always-cross-remembered')
const dirOnceOnly = join(resolve(probeRoot, '..'), 'tianshu-always-cross-once-only')
for (const d of [dirRemembered, dirOnceOnly]) mkdirSync(d, { recursive: true })
console.log(`probe root  ${probeRoot}${ws.note === '' ? '' : ` ｜ ${ws.note}`}`)
console.log(`出界目录 ·  会被 remember 的：${dirRemembered}\n            只「允许一次」的：${dirOnceOnly}`)

const raw = async (verb: 'GET' | 'DELETE', path: string) => {
  const r = await fetch(`${info.baseUrl}${path}`, { method: verb, headers: { authorization: `Bearer ${info.token}` } })
  return { status: r.status, body: await r.json().catch(() => null) as unknown }
}
const readGrants = async () => {
  const res = await raw('GET', `/config/path-grants?cwd=${encodeURIComponent(probeRoot)}`)
  return ((res.body as { grants?: { path?: string; mode?: string }[] } | null)?.grants ?? [])
}

/** 发一轮、把第一张卡按给定决定答掉、以转录为准等它收尾，然后报这轮看到了什么。 */
const round = async (sid: string, mm: SessionModel, file: string, answer: ApprovalAnswerBody | null, label: string) => {
  const floor = mm.current.lastSeq
  const answeredIds = new Set<string>()
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
  for (let retry = 0; !accepted && retry < 12; retry++) {
    await new Promise((r) => setTimeout(r, 5000))
    send = await api.prompt(sid, { prompt: text })
    accepted = send !== 'busy'
  }
  if (!accepted) console.log(`⚠ ${label}：重试 12 次后仍被 409 busy 拒 ⇒ 这一轮什么都没发出去`)
  let f = await roundFacts(api, sid, floor)
  const dl = Date.now() + 180_000
  while (Date.now() < dl && !(f.sawUser && f.sawTerminal)) {
    await new Promise((r) => setTimeout(r, 2000))
    f = await roundFacts(api, sid, floor)
  }
  stop()
  const onDisk = existsSync(file)
  const bytes = onDisk ? `${String(statSync(file).size)} B` : '—'
  if (onDisk) rmSync(file, { force: true })
  console.log(`${label}：本轮 seq ${f.from}…${f.to}（${f.rows} 条）· 审批卡片 ${f.cards} 张 · 已答 ${f.answered} · 文件落盘=${onDisk}（${bytes}，检查后删掉）· 发出=${accepted} 开跑=${f.sawRunning} 终态=${f.sawTerminal}`)
  return { cards: f.cards, answered: f.answered, onDisk, accepted, sawTerminal: f.sawTerminal, sawUser: f.sawUser }
}

// 四个会话都写成字面 `api.createSession({`：`check:docs` 的账单覆盖面判据按这个形状数会话，
// 藏在工厂函数里它就数不到（数不到就该红，而不是静默放过）——所以这里宁可重复四行。
const failures: string[] = []
const t0 = Date.now()

if (phase === 'setup') {
  // 先把两个目录的旧授权都撤干净，并现读确认表里都没有它们——
  // 不撤就开工的话，"这一轮没弹卡"可能只是上一次 run 留下的 persist，不是本轮的 remember。
  for (const d of [dirRemembered, dirOnceOnly]) await raw('DELETE', `/config/path-grants?cwd=${encodeURIComponent(probeRoot)}&path=${encodeURIComponent(d)}`)
  const cleared = await readGrants()
  console.log(`开局授权表：${cleared.length} 条（应两条都不是本次的对象）${grantRecorded(cleared, dirRemembered) || grantRecorded(cleared, dirOnceOnly) ? ' ｜ 撤销没生效！' : ''}`)
  if (grantRecorded(cleared, dirRemembered) || grantRecorded(cleared, dirOnceOnly)) failures.push('setup：撤销旧授权没生效，表里还认这两个目录 ⇒ 后面的读数全部失真')

  const sA = await api.createSession({ cwd: probeRoot, title: 'M1 always-cross setup · remember', approvalMode: 'auto-safe' })
  const mA = new SessionModel()
  const rA = await round(sA.id, mA, join(dirRemembered, 'setup-remembered.txt'), { decision: 'approve', remember: true }, 'setup·remember（期望弹卡后落盘）')
  const sB = await api.createSession({ cwd: probeRoot, title: 'M1 always-cross setup · once', approvalMode: 'auto-safe' })
  const mB = new SessionModel()
  const rB = await round(sB.id, mB, join(dirOnceOnly, 'setup-once.txt'), { decision: 'approve' }, 'setup·允许一次（期望弹卡后落盘）')

  const after = await readGrants()
  const remembered = grantRecorded(after, dirRemembered)
  const onceRecorded = grantRecorded(after, dirOnceOnly)
  console.log(`收尾授权表：${after.length} 条 = ${after.map((g) => `${String(g.path)}[${String(g.mode)}]`).join(' 、') || '（空）'}`)
  console.log(`  i remember 的目录在表里=${remembered} · 只「允许一次」的在表里=${onceRecorded}`)
  if (rA.cards < 1 || rB.cards < 1) failures.push('setup：出界写入没有弹卡（auto-safe 档下也一样）⇒ 这一阶段没造出"答过审批"的对象')
  if (!rA.onDisk || !rB.onDisk) failures.push('setup：答完之后文件没落盘 ⇒ 授权路径没走完，第二阶段的前提不成立')
  if (!remembered) failures.push('setup：remember 没进表 ⇒ 第二阶段无从谈起（这是 remember 本身的缺陷，不是测量问题）')
  if (onceRecorded) failures.push('setup 的对照失效：只「允许一次」的目录也进了表 ⇒ 这张表分不开 persist 与 in-process，remember 那条不作数')

  const sA2 = await spendOf(api, sA.id, mA.current.lastSeq)
  const sB2 = await spendOf(api, sB.id, mB.current.lastSeq)
  console.log(`\n上游账单（setup）：${sA2.calls + sB2.calls} 发 · 输入 ${sA2.inTok + sB2.inTok} tok · 输出 ${sA2.outTok + sB2.outTok} tok · 回填到磁盘头=${sA2.atHead && sB2.atHead ? '是' : '否'}`)
  await api.archiveSession(sA.id)
  await api.archiveSession(sB.id)
} else {
  const before = await readGrants()
  console.log(`重启后开局授权表：${before.length} 条 = ${before.map((g) => `${String(g.path)}[${String(g.mode)}]`).join(' 、') || '（空）'}`)
  if (!grantRecorded(before, dirRemembered)) failures.push('verify：重启之后表里已经没有 remember 的那个目录 ⇒ 持久层没跨进程，"始终允许"只是本进程内的免审')

  const sC = await api.createSession({ cwd: probeRoot, title: 'M1 always-cross verify · remembered dir', approvalMode: 'auto-safe' })
  const mC = new SessionModel()
  const rC = await round(sC.id, mC, join(dirRemembered, 'verify-remembered.txt'), null, 'verify·写 remember 过的目录（期望 0 张卡并落盘）')
  const sD = await api.createSession({ cwd: probeRoot, title: 'M1 always-cross verify · once-only dir', approvalMode: 'auto-safe' })
  const mD = new SessionModel()
  const rD = await round(sD.id, mD, join(dirOnceOnly, 'verify-once.txt'), { decision: 'deny' }, 'verify·写只「允许一次」的目录（正控：期望仍弹卡）')

  if (!rC.sawUser || !rC.sawTerminal) failures.push('verify：remember 那一轮没跑完整（转录里缺本轮的 user 或终态）⇒ "0 张卡"不作数')
  if (rC.cards !== 0) failures.push(`verify：跨进程之后写 remember 过的目录仍弹了 ${rC.cards} 张卡 ⇒ persisted 授权没有被下一次兑现`)
  if (!rC.onDisk) failures.push('verify：跨进程那一轮文件没落盘（没弹卡却没写=免审没走到执行）')
  if (rD.cards < 1) failures.push('verify 的对照失效：只「允许一次」的目录跨进程后也不弹卡 ⇒ 这把尺子分不开 persist 与 in-process，上面那条"免审"不作数')
  if (rD.onDisk) failures.push('verify：被拒的写入落盘了')

  const sC2 = await spendOf(api, sC.id, mC.current.lastSeq)
  const sD2 = await spendOf(api, sD.id, mD.current.lastSeq)
  console.log(`\n上游账单（verify）：${sC2.calls + sD2.calls} 发 · 输入 ${sC2.inTok + sD2.inTok} tok · 输出 ${sC2.outTok + sD2.outTok} tok · 回填到磁盘头=${sC2.atHead && sD2.atHead ? '是' : '否'}`)
  await api.archiveSession(sC.id)
  await api.archiveSession(sD.id)
}

console.log(`\n这一阶段耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
if (failures.length > 0) {
  console.error(`✗ 「始终允许」跨进程活验（${phase}）失败：\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`✓ 「始终允许」跨进程活验（${phase}）通过`)
