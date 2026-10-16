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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
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
 * into the operator's working tree no matter how well the store was isolated. Compare that tree's
 * *file-name set* before and after — one ruler for both the count printed and the verdict made
 * (an entry-count helper here once disagreed with the name list by 10 directories while claiming
 * "N 个文件", which is exactly the two-homes failure this repo keeps hunting).
 */
const seedWatch = join(resolve(clientRoot, '..'), '.rivet')
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
// 这把集合比对刀自己要有反例：旧版判据比的是**条目计数**，"删一枚又种一枚"在那里两个数相等就放行。
// 现在只比 sorted 名字集合；上面那句宣称靠这 4 条夹具自证，不靠读代码的人信我。
const sameTree = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const TREE_FIX = [
  { n: '两棵相等', a: ['x.md', 'y.md'], b: ['x.md', 'y.md'], want: true },
  { n: '多一枚', a: ['x.md', 'y.md'], b: ['x.md', 'y.md', 'z.md'], want: false },
  { n: '等长但换名（计数版会在这里放行）', a: ['playbook.jsonl', 'y.md'], b: ['knowledge/memory.jsonl', 'y.md'], want: false },
  { n: '少一枚', a: ['a', 'b'], b: ['a'], want: false },
]
for (const f of TREE_FIX) {
  if (sameTree(f.a, f.b) !== f.want) {
    console.error(`✗ containment 判据自己的集合比对没过夹具「${f.n}」（期望 ${String(f.want)}，实读 ${String(sameTree(f.a, f.b))}）——这一条不作数`)
    process.exit(1)
  }
}
const seedNames0 = listTree(seedWatch)
let seedNames = seedNames0
const seedDrift = []
const goneNames = []
// 内核那把"按会话 cwd 删存量"的刀，清单从它自己的源码现读，不手抄：`src/agent/memory-epoch.ts`
// 的 LEGACY_FILES 是相对 `<cwd>` 的一组名字，逐个 `rmSync(join(cwd, rel))`。它的 epoch 标记写在
// stateDir()（= RIVET_HOME），而这一趟带 `--isolate-home` ⇒ 每一跑都是一次全新尝试，不是"上一次
// 已经清过了所以这次安全"。仓根的 `.rivet/` 少了东西时，先看少的那枚在不在这份清单里。
const legacyNames = (() => {
  try {
    const src = readFileSync(join(clientRoot, '..', 'src', 'agent', 'memory-epoch.ts'), 'utf8')
    const block = (/const LEGACY_FILES = \[([\s\S]*?)\]/.exec(src) ?? [])[1] ?? ''
    return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.rivet\//, ''))
  } catch {
    return []
  }
})()
// 打出来：这份清单要是解析空了，"认出靶子"那一支就永远不会触发，而读者看不出少了这一档。
console.log(`  i 内核存量刀清单（现读 src/agent/memory-epoch.ts）：${legacyNames.length > 0 ? legacyNames.join('、') : `没读到——若这轮有缺席，归属只能列名不能认`}；仓根 .rivet/ 开跑前 ${String(seedNames.length)} 枚`)

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
      for (const g of gone) if (!goneNames.includes(g)) goneNames.push(g)
      seedDrift.push(`${file} 这台上：${gone.length > 0 ? `删了 ${gone.join(', ')}` : ''}${gone.length > 0 && fresh.length > 0 ? '；' : ''}${fresh.length > 0 ? `多了 ${fresh.join(', ')}` : ''}`)
    }
    seedNames = nowNames
  }
  const seedEnd = listTree(seedWatch)
  const sameSet = sameTree(seedNames0, seedEnd)
  const lateDrift = !sameTree(seedNames, seedEnd)
  check('验证跑不往操作者的工作树里写（仓根 .rivet/ 的文件名字集合前后完全相等；不等就点名是哪一台动的、动了哪个文件）',
    sameSet && seedDrift.length === 0,
    `开跑前 ${String(seedNames0.length)} 个文件，跑完 ${String(seedEnd.length)} 个`
    + (lateDrift ? '；且这份收尾读数与"最后一台跑完那一刻"的集合又不一样——变化落在最后一台之后、收尾之前，归不到任何一台脚本名下' : '')
    + (seedDrift.length === 0 ? '' : `；逐台比对的漂移：${seedDrift.join(' ｜ ')}`)
    + (seedEnd.length === seedNames0.length && !sameSet
      ? '——两个数相等而集合不等：这一跑删了一枚又种了一枚。旧版这里比的是**条目计数**（还把目录也算进去，于是它打印的"文件数"和逐名比对的并不是同一棵树），那种写法会在这里放行，所以现在只比名字集合。'
      : seedEnd.length > seedNames0.length
      ? '——多出来说明有探针把会话 cwd 设在仓根，而内核会往任何会话 cwd 里种 .rivet/（skills + 它自己的库，accept-panel 判据⑥量的正是这件事）。存储层隔离得再好，工作树照样被写脏。'
      : seedEnd.length < seedNames0.length
        ? `——少了说明这一跑删掉了仓根 .rivet/ 里**已有**的东西，比写脏更糟。`
        + (/\/vsw\/|^vsw\//.test(seedDrift.join(' '))
          ? '（点名的路径落在 .rivet/vsw/ 下：与内核的死会话 worktree 清扫一致——它的根是 `join(baseCwd, \'.rivet\', \'vsw\')`，而隔离 sidecar 不搬会话库，于是会在操作者的仓根里收别人的 worktree。假设，未用重跑验证。）'
          : '')
        + (goneNames.length > 0 && legacyNames.some((n) => goneNames.includes(n))
          ? `（少的这些里认出了内核那把存量刀的靶子：清单从 \`src/agent/memory-epoch.ts\` 现读 = ${legacyNames.join('、')}，删法是逐个 \`rmSync(join(<会话 cwd>, rel))\`，而它的 epoch 标记在 RIVET_HOME 里、这一跑带 \`--isolate-home\` ⇒ 每跑都是全新一次，不是"上次清过这次就安全"。这不是"存储层没隔离"，是**还有一台的会话 cwd 落在仓根**；落点这件事由 check:docs 里那条按 \`createSession\` 的 \`cwd:\` 做传递闭包的判定守着，它不需要有人真跑这一趟。）`
          : goneNames.length > 0 && legacyNames.length === 0
            ? `（内核那份 LEGACY_FILES 没读到（源码路径或形状变了），所以这轮缺席的 ${goneNames.length} 枚我只列出来、认不出归属——归属认不出不改变结论：集合不等本身就是红。）`
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
