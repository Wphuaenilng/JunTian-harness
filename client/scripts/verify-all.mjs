#!/usr/bin/env node
/**
 * verify-all.mjs — 把"这条线现有的零花费证据"收成一条命令。
 *
 *   node scripts/verify-all.mjs                 # 全部（先重打产物，再跑门与验法）
 *   node scripts/verify-all.mjs build test drift devproxy   # 只跑选中的几步
 *
 * 为什么第一步是 build：这个仓的证据规矩是"门读被伺服的产物"，而 `scripts/lib-freshness.mjs`
 * 现在会让读 dist 的门在产物过期时**直接红**。先重打，一次命令产出的才是当前代码的证据。
 *
 * 两道**故意红、未接 CI**的门（liverender 的锚点、geometry 的差集）在这里记为 parked：它们被跑、
 * 被打印，但不决定退出码。（`check:contrast` 曾在这份名单里，2026-10-12 裁定 ① 把它做完之后
 * 它跑绿并接进了 ci-smoke——"决定做完了"就要从 parked 名单里走出去，留在这里会变成永久豁免。）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProjectRuntimes } from './lib-instance.mjs'
import { kernelSidecarFreshness } from './lib-freshness.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STEPS = [
  { key: 'build', label: '重打产物（corepack pnpm build）', cmd: 'corepack', args: ['pnpm', 'build'] },
  { key: 'test', label: '单测（corepack pnpm test）', cmd: 'corepack', args: ['pnpm', 'test'] },
  // 类型面此前只在 CI 示例里跑，本地"一条命令"反倒漏了它——而 `apps/web/tsconfig` 的 include 覆盖
  // 全部 `packages/*/src/**`，也就是说这条是唯一在看 12 个包类型正确性的判据。
  { key: 'typecheck', label: '类型面 typecheck（client-core + apps/web + 全量档：测试与验收脚本也在面内）', cmd: 'corepack', args: ['pnpm', 'typecheck'] },
  { key: 'drift', label: '静态门（ci-smoke --drift；道数以那一步自己打印的 ✓ 行为准，不在这里抄数）', cmd: process.execPath, args: [join(clientRoot, 'scripts/ci-smoke.mjs'), '--drift'] },
  { key: 'liverender', label: '像素门 check:liverender（故意红：只剩那条**已裁定不做**的自绘标题栏）', cmd: process.execPath, args: [join(clientRoot, 'scripts/check-live-geometry.mjs')], parked: true },
  { key: 'mockuprender', label: '定稿设计资产可复现 check:mockup-render（源稿重渲 vs 两张入库 PNG，像素差）', cmd: process.execPath, args: [join(clientRoot, 'scripts/check-mockup-render.mjs')] },
  { key: 'acceptzero', label: '零花费验收面 verify-accept-zero（schedule / settings / gitwrite / queue / tasks / history / reconnect / panel，各跑在一台隔离无 key 实例上）', cmd: process.execPath, args: [join(clientRoot, 'scripts/verify-accept-zero.mjs')] },
  { key: 'geometry', label: '几何差集 check:geometry（故意红：一条已裁定的取舍——不做自绘标题栏）', cmd: process.execPath, args: [join(clientRoot, 'scripts/check-mockup-geometry.mjs')], parked: true },
  { key: 'contrast', label: '配色 AA check:contrast（硬门：2026-10-12 裁定之后它已经绿，红就是挡）', cmd: process.execPath, args: [join(clientRoot, 'scripts/check-contrast.mjs')] },
  { key: 'desktop', label: '桌面壳 verify-desktop', cmd: process.execPath, args: [join(clientRoot, 'scripts/verify-desktop.mjs')] },
  { key: 'store', label: '会话库 verify-desktop-store', cmd: process.execPath, args: [join(clientRoot, 'scripts/verify-desktop-store.mjs')] },
  { key: 'instance', label: '单实例锁 verify-single-instance', cmd: process.execPath, args: [join(clientRoot, 'scripts/verify-single-instance.mjs')] },
  { key: 'devproxy', label: 'dev 形态 verify-dev-proxy', cmd: process.execPath, args: [join(clientRoot, 'scripts/verify-dev-proxy.mjs')] },
  { key: 'restsurface', label: '读写 REST 面 + 两条 SSE 流的头帧 verify-rest-surface（路径从 client-core 源码派生）', cmd: process.execPath, args: [join(clientRoot, 'scripts/verify-rest-surface.mjs')] },
]

const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'))
// filter 会静默丢掉不认识的步骤名，于是 `verify-all desktop singleinstance` 只跑 1 步却打印"1 步：失败 0"——
// 那一格是"没测到"，不是"过了"。
const unknown = picked.filter((a) => !STEPS.some((s) => s.key === a))
if (unknown.length > 0) {
  console.error(`✗ 不认识的步骤名：${unknown.join(', ')}`)
  console.error(`  可用：${STEPS.map((s) => s.key).join(' / ')}`)
  process.exit(2)
}
const chosen = picked.length ? STEPS.filter((s) => picked.includes(s.key)) : STEPS
if (chosen.length === 0) {
  console.error(`没有匹配的步子。可用：${STEPS.map((s) => s.key).join(', ')}`)
  process.exit(2)
}

// 预飞：整条线里 `drift` 之后的每一步（像素门 / 零花费面 / 桌面壳 / 会话库 / dev 形态 / rest 面）起的都是
// 同一份 `dist/cli/entry.js`。本命令第一步重打的是**客户端产物**，内核那份不会跟着变——源码比它新时，
// 后面每一条读数描述的都是已经不存在的实现。同一条问句在 `ci-smoke` 第二级也有，两处共用
// `lib-freshness.mjs` 那一家；非 ok 就在这里停，别让它长成一个像客户端缺陷的红。
{
  const k = kernelSidecarFreshness(resolve(clientRoot, '..'))
  console.log(`${k.status === 'ok' ? '✓' : '✗'} sidecar 产物不早于内核源码（整条线的每一步都起这一份） — ${k.message}`)
  if (k.status !== 'ok') {
    // 这道预飞是不是"顺手挡一下"，还是要命的承重墙？拿现测回答，不靠记忆：按步骤表里每条命令指向的那份
    // 脚本**自身文本**（一层，不追传递导入）分两类——会起 sidecar 的、以及其中自带新鲜度自查的。
    // 未被自带自查盖住的那些台，就是这道全局预飞去不得的理由；这个数会随实现变，所以每次失败都现算现打。
    // 面为空时**不许给结论**（0 份脚本推不出"每台都自保"），扫描面按平台分隔符都认（Windows 的反斜杠是关键）。
    const pointed = chosen.flatMap((s) => (s.args ?? []).map((a) => String(a))).filter((a) => /[\\/]scripts[\\/][\w.-]+\.(mjs|ts)$/.test(a))
    const scripts = [...new Set(pointed.map((p) => p.split(/[\\/]/).pop()))]
    const bodies = new Map(scripts.map((n) => {
      const p = join(clientRoot, 'scripts', n)
      return [n, existsSync(p) ? readFileSync(p, 'utf8') : '']
    }))
    const booters = scripts.filter((n) => /launch-sidecar|openInstance|kernelSidecarFreshness|serve-client/.test(bodies.get(n) ?? ''))
    const selfGuarded = booters.filter((n) => /lib-freshness/.test(bodies.get(n) ?? ''))
    const uncovered = booters.filter((n) => !selfGuarded.includes(n))
    const absent = scripts.filter((n) => bodies.get(n) === '')
    const face = scripts.length === 0 ? '（本趟挑的步骤里没有一条命令指向 `scripts/` 下的脚本——扫描面为空，这句不作数）'
      : booters.length === 0 ? `本趟挑到的 ${scripts.length} 份脚本都不起 sidecar，这道预飞对本趟那几步没有影响（要跑会起进程的步，这里就会逐台点名）`
        : `本趟挑到的步指向 ${scripts.length} 份脚本${absent.length ? `，其中 ${absent.length} 份不在盘上（${absent.join(' , ')}）` : ''}，`
          + `判定会起 sidecar 的 ${booters.length} 台（${booters.join(' , ')}），其中自带新鲜度自查的 ${selfGuarded.length} 台（${selfGuarded.join(' , ') || '无'}），`
          + `只靠这道全局预飞兜住的 ${uncovered.length} 台${uncovered.length > 0 ? `（${uncovered.join(' , ')}）⇒ 这道去不得` : '⇒ 本趟这些台各自已自保'}`
    console.log(`   预飞是不是承重的：${face}。分类按脚本自身文本判（一层，不追传递导入）。`)
    process.exit(1)
  }
}

const out = []
// 全线的 containment 监视：`verify-accept-zero` 那一条只守它自己那 8 台，而 2026-10-15 实测到
// 仓根 `.rivet/` 在**一次 14 步跑完之后**又少了 10 个文件（`ci-smoke --drift` 与 `pnpm test` 都被
// 同一把尺子量成清白，见 EVIDENCE 那一格）——也就是说真删除者跑在这 14 步里，而当时没人看着。
// 内核会往**会话 cwd 的父项目根**种并清 `.rivet/`（`src/agent/memory-epoch.ts` 那份 LEGACY_FILES
// 按 `<cwd>` 删文件），所以"哪一步动的"必须逐台阶梯比，而不是只在首尾比一次。
// 面 = 名字集合（数量会被内核正常写入的文件骗到）；判据 = 删了任何一条即红；新增**只打不判**
// （那正是内核会做的事：skills/、artifacts/，把它判成违规会把修复本身挡在门外）。
const rivetWatch = join(resolve(clientRoot, '..'), '.rivet')
const listTree = (root) => {
  const acc = []
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
      else acc.push(p.slice(root.length + 1).replace(/\\/g, '/'))
    }
  }
  return acc.sort()
}
const rivetExists = existsSync(rivetWatch)
let rivetNames = rivetExists ? listTree(rivetWatch) : []
const rivetDrift = []
if (!rivetExists) console.log(`  i containment 监视未启动：${rivetWatch} 不在（这台没跑过任何会话），下面那条判据会如实写"没在量"`)
for (const s of chosen) {
  const started = Date.now()
  // 命令与参数都是本文件里的字面量（picked 只用于筛选，不进命令行），所以 shell:true 不引入注入面。
  const r = spawnSync(s.cmd, s.args, { cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const code = r.status ?? -1
  // 失败步骤必须**自带可诊断输出**：只留末行时，一次 node 崩溃的末行就是 "Node.js v24.13.0"，
  // 汇总入口反而比单跑更难查（真踩过：verify-desktop 红了一次，日志里只剩一句栈尾）。
  const all = String(r.stdout || '').concat(String(r.stderr || '')).trim().split(/\r?\n/).filter(Boolean)
  out.push({ ...s, code, secs: (Date.now() - started) / 1000, tail: (all.at(-1) ?? '').slice(0, 120), lines: all.slice(-24) })
  console.log(`${code === 0 ? '✓' : s.parked ? '•' : '✗'} ${s.label} — exit ${code}，${(Date.now() - started) / 1000}s`)
  if (rivetExists) {
    const nowNames = listTree(rivetWatch)
    const gone = rivetNames.filter((x) => !nowNames.includes(x))
    const fresh = nowNames.filter((x) => !rivetNames.includes(x))
    if (gone.length > 0 || fresh.length > 0) {
      console.log(`  i ${s.key} 这步动了仓根 .rivet/：删了 ${gone.join('、') || '（无）'}｜新增 ${fresh.join('、') || '（无）'}`)
      if (gone.length > 0) rivetDrift.push(`${s.key}：删了 ${gone.join('、')}`)
    }
    rivetNames = nowNames
  }
}

const failed = out.filter((s) => s.code !== 0 && !s.parked)
const parked = out.filter((s) => s.code !== 0 && s.parked)
// 干净 checkout（CI）上仓根可能根本没有 `.rivet/`——那种情形不许恒红（那是 #nongoals 那四条正控踩过的
// 坑：把判据绑在脏工作树上）。所以**没目录就打一行"没在量"，不动退出码**；有目录而少了文件才红。
console.log(`${rivetExists ? (rivetDrift.length === 0 ? '✓' : '✗') : 'i'} 验证跑不往操作者的工作树里删东西（仓根 \`.rivet/\` 的名字集合逐步相等；新增只报不判——内核本来会往会话 cwd 种 \`skills/\`） — ${rivetExists ? `全线跑完仍是 ${rivetNames.length} 个文件${rivetDrift.length ? `，越界的台子：${rivetDrift.join(' ｜ ')}` : '，逐步比对无一台删掉已有文件'}` : `${rivetWatch} 不存在 ⇒ 这一条本轮没在量任何东西（不是通过）`}`)
if (rivetDrift.length > 0) failed.push({ key: 'containment', label: '验证跑不往操作者的工作树里删东西（仓根 `.rivet/`）', code: 1, secs: 0, tail: rivetDrift.join(' ｜ ').slice(0, 120), lines: rivetDrift })
console.log(`\n${out.length} 步：失败 ${failed.length}，故意红 ${parked.length}${parked.length ? `（那 ${parked.length} 道门在等方向或记录已定的取舍，不是故障）` : '（没有）'}`)
// 收尾自查（**只报不判，更不杀**）：这趟跑完本仓还剩几台 runtime 活着。
// 2026-10-12 实测到的成因：崩在半路的运行会留下 `entry.js serve --port N` 的 daemon，而"照登记文件收"
// 收不到它们（登记文件已被换掉/删掉），下一趟就死在 data-dir-locked 上（#120 的根因）。命令行看不出
// 哪台是操作者自己在用的，所以这行只是让下一个人少花二十分钟——不红、不杀。
try {
  console.log(`  i 收尾自查：本仓还有 ${listProjectRuntimes().length} 台 runtime 活着（要收请你自己按 PID 决定）`)
} catch { /* 探针坏了不影响这条线 */ }
for (const f of failed) {
  console.log(`\n──── ${f.label} 失败细节（末 ${f.lines.length} 行）`)
  for (const l of f.lines) console.log(`  | ${l.slice(0, 200)}`)
}
process.exit(failed.length === 0 ? 0 : 1)
