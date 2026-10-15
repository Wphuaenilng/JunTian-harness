#!/usr/bin/env node
/**
 * verify-accept-zero.mjs — the zero-cost acceptance surface, as a step instead of a memory.
 *
 * `accept-*.ts` are the plan's acceptance scripts. The ones listed in `SCRIPTS` below need no
 * provider key and no pre-existing run — but before this file existed they were green only because
 * someone typed them. Anything that is only green when someone remembers to run it is not evidence;
 * this turns that whole face into one command against a freshly launched, fully isolated keyless
 * sidecar. `SCRIPTS` is the one roster: `check:docs` compares the CI step name and the `verify-all`
 * step label against it, so a script added here and not there goes red instead of silently not
 * running in the pipeline.
 *
 * Isolation is the point, not a nicety: the scripts used to read `client/.sidecar-info.json`, which
 * can hold a stale or *operator* instance, so an acceptance run could have created sessions and
 * patched provider config on the wrong server. They now print which instance they dial, and here
 * that is asserted rather than trusted — the run fails if the registration the child sees points
 * outside this temp dir, which is also what catches a mistyped `--info` flag silently falling back.
 *
 *   node scripts/verify-accept-zero.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const SCRIPTS = [
  ['accept-schedule.ts', '自动化看板：建→列→改→停→删（零触发）'],
  ['accept-settings.ts', '设置中心读写 + 明文不外泄 + 还原原值'],
  ['accept-gitwrite.ts', '工作台写路径（bare 仓沙箱：worktree→改→提交→PR 草稿）'],
  // 第三个字段是这台步骤**必须在自己输出里说出口的一句话**：`accept-queue` 的忙时那一半在看得见 key
  // 的实例上会整段跳过（那是对的，不能拿付费换证据），但"跳过了"不许在这条常驻线上被读成"过了"。
  // 本子进程本来就跑在临时隔离的无 key 实例上，所以这句必须出现。
  ['accept-queue.ts', '排队交接的线上契约（空闲 /queue ⇒ 409 code=idle；忙时 /prompt ⇒ 409 busy、/queue 给 laneId、sendOrQueue 落 queued——prompt 只在这台 configured:false 时发，run 不出本机）', '含忙时那一半'],
  ['accept-tasks.ts', '后台任务登记面（run-now 当场造两条真 job 记录：终态链、事件 seq、cancel 是否终局、?status/?limit 在 HTTP 上不被读——同样只在 configured:false 时发）', '含造出来的真记录'],
  // 冷通道分页此前只有"挂着一台有转录的实例"才量得到（§4.3 #2 那一格于是取决于有人记得手跑）。
  // 无 key 的实例现在能自己造转录：12 发注定失败的 prompt ⇒ 49 条事件 ⇒ before= 逐页回填到磁盘头。
  ['accept-history.ts', 'M2 历史向上分页（无 key 当场造 12 发注定失败的 prompt ⇒ 冷通道 before= 逐页回填到磁盘头 ⇒ 时间线首块逐字等于发出的那句）', '含当场造出来的会话'],
  // §9 DoD 那句「断网 10 秒恢复后事件不丢不重」以前也只在挂现机时才跑，而且挂现机读到的是一段**静止**
  // 的历史——断线期间没有任何新事件产生，"不丢"那半句就在空转。现在连接真关 10 秒，期间由第二发 prompt
  // 落下事件，续读必须把它们补齐；另有一条绕过客户端的线上控制，专防"无重复其实只是客户端自己滤掉的"。
  ['accept-reconnect.ts', '断线 10 秒续读（无 key 当场造会话：第一代切在重放中途 ⇒ 断线期间第二发 prompt 落下事件 ⇒ 拿断线游标续读补齐，0 丢 0 重；另有一条绕过客户端的 /stream?since= 线上控制）', '含断线期间真落下的事件'],
  // 面板那一档以前"要一台有会话的实例"才跑，而它读的其实是**文件**——文件是可以自己造的。
  // 现在挂一棵已知的小树当会话 cwd，正文按字节逐字比、@file 命中集合双向核、三种失败码各归各位；
  // 检查点那一半（要真工具落盘）留在付费那格，屏幕上写成"未测到"，不许混进绿里。
  ['accept-panel.ts', '检查点/文件面板的数据路径（当场造一棵已知小树挂成会话 cwd ⇒ 正文逐字字节、@file 命中集合双向核、403/404/400 三种码互不相同；检查点那一半明写未测到）', '含当场造出来的沙箱树'],
]

const failures = []
let checksRun = 0
const check = (label, ok, detail = '') => {
  checksRun += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const dir = mkdtempSync(join(tmpdir(), 'accept-zero-'))
const infoPath = join(dir, '.sidecar-info.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The other half of isolation: the store is not the only thing a session touches — the runtime seeds
 * `<session cwd>/.rivet/` (skills + its own db), which `accept-panel.ts` asserts as its judgement ⑥.
 * Several probes used the **repo root** as their session cwd, so an acceptance run wrote runtime files
 * into the operator's working tree no matter how well the store was isolated. Count that tree before
 * and after; growth is this suite dirtying the operator's checkout, and it must name the mechanism.
 */
const countTree = (root) => {
  let n = 0
  const stack = [root]
  while (stack.length > 0) {
    const d = stack.pop()
    let names
    try { names = readdirSync(d) } catch { continue }
    for (const name of names) {
      const p = join(d, name)
      n += 1
      try { if (statSync(p).isDirectory()) stack.push(p) } catch { /* 别人正开着或刚被收走 */ }
    }
  }
  return n
}
const seedWatch = join(resolve(clientRoot, '..'), '.rivet')
const seedBefore = countTree(seedWatch)
/** 不只数个数：记下每一次比对时的**文件名集合**，这样才能答"是哪一台动的、动了哪一个文件"。 */
const listTree = (root) => {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const d = stack.pop()
    let names = []
    try { names = readdirSync(d) } catch { continue }
    for (const name of names) {
      const p = join(d, name)
      let isDir = false
      try { isDir = statSync(p).isDirectory() } catch { continue }
      if (isDir) stack.push(p)
      else out.push(p.slice(root.length + 1).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}
let seedNames = listTree(seedWatch)
const seedDrift = []

const run = (args, timeout = 180_000) =>
  spawnSync(node, args, { cwd: clientRoot, encoding: 'utf8', timeout, env: process.env })

let launched = false
try {
  // Same three isolation flags the desktop verifiers use; without --isolate-home the daemon would
  // write RIVET_HOME (missions/, transcripts) into the operator's ~/.rivet.
  const up = run(['scripts/launch-sidecar.mjs', '--state-dir', dir, '--desktop-dir', join(dir, 'data'), '--isolate-home'])
  launched = up.status === 0
  check('无 key sidecar 起在临时隔离目录（launch-sidecar 自己的健康门通过）', up.status === 0, `exit=${String(up.status)}`)
  if (up.status !== 0) console.log(String(up.stderr ?? '').split('\n').slice(-6).join('\n'))

  for (const [file, what, mustSay] of SCRIPTS) {
    const r = run([join(clientRoot, 'scripts', file), `--info=${infoPath}`], 300_000)
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const green = out.split('\n').filter((l) => l.trimStart().startsWith('✓')).length
    const red = out.split('\n').filter((l) => l.trimStart().startsWith('✗'))
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
    // 真判据：子进程打印的「info file」必须就是本次临时目录里那份登记文件。旗标写错时会静默回落到
    // `client/.sidecar-info.json`（可能是旧端口或操作者那台），这一条就是抓那个的。
    const infoLine = (/^info file\s+(.+)$/m.exec(out) ?? [])[1] ?? ''
    const dialedThisBoot = infoLine.length > 0 && norm(infoLine) === norm(infoPath)
    const saidIt = mustSay === undefined || out.includes(mustSay)
    check(`${file}（${what}）`,
      r.status === 0 && green > 0 && red.length === 0 && dialedThisBoot && saidIt,
      `exit=${String(r.status)} ✓=${green} ✗=${red.length} 登记来源=${infoLine || '（子进程没打印 info file）'}${dialedThisBoot ? '' : ' ≠ 本次临时目录'}${saidIt ? '' : `；它没说出「${mustSay}」这句话——那一半没量到`}`)
    for (const line of red.slice(0, 4)) console.log(`    ${line.trim().slice(0, 170)}`)
    const nowNames = listTree(seedWatch)
    const gone = seedNames.filter((x) => !nowNames.includes(x))
    const fresh = nowNames.filter((x) => !seedNames.includes(x))
    if (gone.length + fresh.length > 0) {
      seedDrift.push(`${file} 这台上：${gone.length > 0 ? `删了 ${gone.join(', ')}` : ''}${gone.length > 0 && fresh.length > 0 ? '；' : ''}${fresh.length > 0 ? `多了 ${fresh.join(', ')}` : ''}`)
    }
    seedNames = nowNames
  }
  const seedAfter = countTree(seedWatch)
  check('验证跑不往操作者的工作树里写（仓根 .rivet/ 的文件集合前后完全相等；不等就点名是哪一台动的、动了哪个文件）',
    seedAfter === seedBefore && seedDrift.length === 0,
    `开跑前 ${seedBefore} 个文件，跑完 ${seedAfter} 个`
    + (seedDrift.length === 0 ? '' : `；逐台比对的漂移：${seedDrift.join(' ｜ ')}`)
    + (seedAfter > seedBefore
      ? '——多出来说明有探针把会话 cwd 设在仓根，而内核会往任何会话 cwd 里种 .rivet/（skills + 它自己的库，accept-panel 判据⑥量的正是这件事）。存储层隔离得再好，工作树照样被写脏。'
      : seedAfter < seedBefore
        ? `——少了说明这一跑删掉了仓根 .rivet/ 里**已有**的东西，比写脏更糟。`
        + (/\/vsw\/|^vsw\//.test(seedDrift.join(' '))
          ? '（点名的路径落在 .rivet/vsw/ 下：与内核的死会话 worktree 清扫一致——它的根是 `join(baseCwd, \'.rivet\', \'vsw\')`，而隔离 sidecar 不搬会话库，于是会在操作者的仓根里收别人的 worktree。假设，未用重跑验证。）'
          : '')
        : ''))
} finally {
  if (launched) {
    const stop = run(['scripts/launch-sidecar.mjs', '--state-dir', dir, '--stop'], 60_000)
    check('隔离 sidecar 已停（不会留后台进程）', stop.status === 0, `exit=${String(stop.status)}`)
  }
  await sleep(300)
  try { rmSync(dir, { recursive: true, force: true }) }
  catch (e) { console.log(`  i 临时目录没删净（Windows 上常见 EBUSY，不是失败）：${String(e).slice(0, 80)}`) }
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log(`\nzero-cost acceptance checks passed (${checksRun} checks)`)
process.exit(0)
