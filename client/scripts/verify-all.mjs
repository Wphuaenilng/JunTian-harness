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
  if (k.status !== 'ok') process.exit(1)
}

const out = []
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
}

const failed = out.filter((s) => s.code !== 0 && !s.parked)
const parked = out.filter((s) => s.code !== 0 && s.parked)
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
