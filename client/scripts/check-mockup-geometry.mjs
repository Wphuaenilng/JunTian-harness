#!/usr/bin/env node
/**
 * check-mockup-geometry.mjs — 把「UI 为什么不像设计图」变成一张带数字的差集表。
 * **故意留一条红，未接入 ci-smoke**：剩下的那条红是**已裁定不做**的自绘标题栏，它现在的作用是记录一个
 * 决定，不是等人定方向（曾与 `check-contrast.mjs` 同列「等你定方向」，2026-10-12 夜裁定之后：配色那条
 * 已经做完并升级为 CI 硬门，这条的语义改成了「决定的记录」）。把一条红的门接进绿管道只会掩盖真问题，
 * 所以它仍由 `verify:all` 跑、打印，但不决定退出码。`check:liverender` 是它的实证 counterpart：那条量
 * 浏览器里真正算出来的盒子，这条量声明本身，所以两边不一致的地方会分别暴露。
 *
 * 三条门各管一段，别混：
 *   `check:mockup`  —— 色板：mockup 的 token 与我们 `:root` 的**值**是否一致；
 *   `check:scale`   —— 刻度：图上那些数是否各有唯一 token、且 token 相等、且真被消费（几个数由它自己打印）；
 *   这条            —— 剩下的、还没进刻度的几何数字与图上差多少（以及图上有什么我们根本没有）。
 *
 * 三条教训写在这里，因为它们都真发生过：
 *  - 解析 mockup 的 style 必须剥掉横幅注释、必须行首锚定、必须取同名规则的**最后一条**——这三件事
 *    现在统一由 `lib-mockup-css.mjs` 负责，本文件不再自带解析器（自带过一次，报了两个假偏差）；
 *  - 我们的值如果是 `var(--scale-*)`，必须先解析 token 再比，否则 "var(--scale-rail-open)" 会被
 *    当成数值报成偏差——工具的漏检变成产品的假漂移，是最坏的一种；
 *  - 锚点必须指对元素：② 项目行一度指到 `.us__row`（那是会话行），于是"改对了"也被报成没改。
 *
 *   node scripts/check-mockup-geometry.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMockup, declOf } from './lib-mockup-css.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mockupPath = join(clientRoot, '..', 'analysis-reports', '定稿-天枢客户端方案', 'design', 'desktop-mockup-dsh-style.html')

const OURS = [
  'apps/web/src/styles.css',
  'packages/ui-session/src/styles.css',
  'packages/ui-chat/src/styles.css',
  'packages/ui-primitives/src/styles.css',
  'packages/ui-git/src/styles.css',
]

if (!existsSync(mockupPath)) {
  console.log('SKIP 定稿 mockup 不在这台机器上（analysis-reports 未入库）— 不是通过，是没测')
  process.exit(0)
}

const mockRules = readMockup(mockupPath)

/** Our own CSS, parsed with the same rules the browser's cascade approximates: last wins. */
const ourRules = OURS.flatMap((f) => readMockup(join(clientRoot, f)))
const tokensSrc = readFileSync(join(clientRoot, 'packages', 'ui-theme', 'src', 'tokens.css'), 'utf8')
const tokenRules = readMockup(join(clientRoot, 'packages', 'ui-theme', 'src', 'tokens.css'))
const customProps = tokenRules.filter((r) => r.sel === ':root' || r.sel === "[data-theme='dark']").map((r) => r.decls)

const decl = (rules, sel, prop) => {
  const raw = declOf(rules, sel, prop)
  if (raw === undefined) return undefined
  const varName = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw)?.[1]
  if (!varName) return raw
  for (const props of customProps) {
    if (props[varName] !== undefined) return `${props[varName]} /* ${varName} */`
  }
  return `${raw} /* 未解析：${varName} 不在 :root */`
}

/** grid 多值里取第 n 轨（从 1 开始）。 */
const track = (value, n) => (value ?? '').split(/\s+/)[n - 1]

// [标签, 图上选择器, 图上属性, 图上的取值, 我们的来源, 我们的选择器/属性, 我们的取值]
const PROBES = [
  ['① 自绘标题栏高', '.titlebar', 'height', null, 'sel', '.app__titlebar', 'height', null],
  ['② 项目行高', '.prow', 'height', null, 'sel', '.us__proj', 'height', null],
  ['② 项目行圆角', '.prow', 'border-radius', null, 'sel', '.us__proj', 'border-radius', null],
  ['② 项目标记边长', '.picon', 'width', null, 'sel', '.us__proj-mark', 'width', null],
  ['② 新建会话钮圆角', '.newSession', 'border-radius', null, 'sel', '.us__new', 'border-radius', null],
  ['③ 最近对话行高', '.srow', 'height', null, 'sel', '.us__row', 'height', null],
  ['③ 状态点边长', '.srow .sd', 'width', null, 'sel', '.us__dot', 'width', null],
  ['侧栏品牌行高', '.logoRow', 'height', null, 'sel', '.us__brand', 'min-height', null],
  ['品牌 mark 边长', '.logoRow .mark', 'width', null, 'sel', '.us__mark', 'width', null],
  ['三栏框架 左栏宽', '.frame', 'grid-template-columns', 1, 'sel', ':root', '--sidebar-width', null],
  ['三栏框架 右栏宽', '.frame', 'grid-template-columns', 3, 'sel', '.app__rail--open', 'width', null],
  ['收起态 右栏细条宽', 'body.details-collapsed .frame', 'grid-template-columns', 3, 'sel', '.app__rail', 'width', null],
  ['⑤ 状态条高', '.statusbar', 'height', null, 'sel', '.app__status', 'height', null],
  ['④ 折叠组卡片圆角', '.sec', 'border-radius', null, 'sel', '.tp-sec', 'border-radius', null],
  ['④ 折叠组头高', '.sec-head', 'height', null, 'sel', '.tp-sec__head', 'height', null],
  ['④ 中栏窄栏宽', '.conv-col', 'max-width', null, 'sel', ':root', '--measure', null],
  ['④ 底部停靠区宽', '.dock-col', 'max-width', null, 'sel', ':root', '--scale-dock-width', null],
  ['④ 用户气泡圆角', '.ububble', 'border-radius', null, 'sel', '.uc__bubble', 'border-radius', null],
  ['④ 发送钮边长', '.cm-send', 'width', null, 'sel', '.app__send', 'width', null],
  ['正文基准字号', 'body', 'font-size', null, 'sel', 'body', 'font-size', null],
]

const rows = []
for (const [name, mSel, mProp, mTrack, , oSel, oProp] of PROBES) {
  const mRaw = declOf(mockRules, mSel, mProp)
  const want = mTrack === null || mTrack === undefined ? mRaw : track(mRaw, mTrack)
  const got = oSel === ':root'
    ? (customProps.find((p) => p[oProp] !== undefined)?.[oProp])
    : decl(ourRules, oSel, oProp)
  let ok, verdict
  if (mRaw === undefined) { ok = true; verdict = '图上没有该声明（该条作废，不算差）' }
  else if (got === undefined) { ok = false; verdict = `我们根本没有（图上 ${want}；声明在 ${oSel}{${oProp}}）` }
  else if (parseFloat(want) === parseFloat(got)) { ok = true; verdict = `一致 ${parseFloat(got)}px` }
  else { ok = false; verdict = `偏差 图上 ${want} / 我们 ${got}` }
  rows.push({ name, ok, verdict })
}

const drift = rows.filter((r) => !r.ok)
for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(18)} ${r.verdict}`)
console.log(`\n${rows.length} 条锚点：${rows.length - drift.length} 条一致、${drift.length} 条有偏差或缺声明`)
console.log('\n这三条当初都写成"等你定方向"，2026-10-12 已按裁定办掉两条，剩下一条记成决定：')
console.log('  ① 40px 自绘标题栏：**裁定不做，按现实现**（原生窗口框，桌面壳不设 frame:false）。要它得新增一条')
console.log('     窄 preload 走 IPC 才能最小化/最大化，那是特权面改动、与 E4 同一档。这条锚点因此继续报红——')
console.log('     它是**一条决定的记录**，不是欠账；红它不等于要修它。')
console.log('  ② 34px 圆形发送钮：**已照图做**（34×34 圆形图形钮，数由 `--scale-send-size` 钉住；字形取源稿那个 ➤，')
console.log('     可访问名走 title/aria-label 的 locale 文案）。主按钮仍是近黑——那条来自定稿要点，不因换形状而改色。')
console.log('  ③ 用户气泡：**整组照图改完**（右对齐 + 无边框 + 圆角 22），且由 check:liverender 的 /bubble-probe.html')
console.log('     挂真组件量出来，不再只是对声明。')
console.log('\n已办的两条，留在这里免得被再问一次：窄栏 748 与停靠区 780 **是图上两个不同的数**，已拆成')
console.log('--measure 与 --scale-dock-width 两个 token 各自钉住；整套刻度也早已 token 化并由 check:scale 对回源稿。')
process.exit(drift.length > 0 ? 1 : 0)
