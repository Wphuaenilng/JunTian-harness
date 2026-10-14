#!/usr/bin/env node
/**
 * check-scale.mjs — the eleventh gate: the drawing's size scale now has ONE fact source.
 *
 * Root cause this closes: the mockup carries its geometry as hardcoded literals, and our CSS carried
 * them as its own literals. `check:geometry` could only compare numbers someone thought to pick, and
 * any value not in that list was free to drift. Here every scale token in `ui-theme/tokens.css` is
 * compared against the declaration parsed out of the approved HTML — and each token must actually be
 * consumed by a `var()` somewhere, because a token nobody reads is a fact source in name only.
 *
 *   node scripts/check-scale.mjs            # 逐条
 *   node scripts/check-scale.mjs --quiet    # 只报失败（CI）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMockup, declOf, pxOf } from './lib-mockup-css.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const quiet = process.argv.includes('--quiet')
const mockupPath = join(repoRoot, 'analysis-reports', '定稿-天枢客户端方案', 'design', 'desktop-mockup-dsh-style.html')
const tokensPath = join(clientRoot, 'packages', 'ui-theme', 'src', 'tokens.css')

/** token → where the drawing states it. `idx` selects one value out of a shorthand. */
const SCALE = [
  ['--scale-titlebar', '.titlebar', 'height'],
  ['--scale-brand-row', '.logoRow', 'height'],
  ['--scale-brand-mark', '.logoRow .mark', 'width'],
  ['--scale-mark-radius', '.logoRow .mark', 'border-radius'],
  ['--scale-project-row', '.prow', 'height'],
  ['--scale-project-mark', '.picon', 'width'],
  ['--scale-session-row', '.srow', 'height'],
  ['--scale-rail-open', '.frame', 'grid-template-columns', 2],
  ['--scale-rail-collapsed', 'body.details-collapsed .frame', 'grid-template-columns', 2],
  // 收起态细条里的两枚数（图上 .rail-btn 与它那颗 .mini；.rail-expand 与 .rail-btn 同尺寸，共用一个 token）
  ['--scale-rail-btn', '.rail-btn', 'width'],
  ['--scale-rail-mini', '.rail-btn .mini', 'width'],
  ['--scale-statusbar', '.statusbar', 'height'],
  ['--scale-composer-radius', '.composer', 'border-radius'],
  // 2026-10-12 按图回改几何那两条：源稿各自写着 22px / 34px 的字面量，各自成为一枚 token，
  // 所以每一枚都能对回**它自己那条声明**——不是把同一个数抄两遍。
  ['--scale-bubble-radius', '.ububble', 'border-radius'],
  ['--scale-send-size', '.cm-send', 'width'],
  ['--scale-card-radius', '.sec', 'border-radius'],
  ['--scale-group-head', '.sec-head', 'height'],
  ['--measure', '.conv-col', 'max-width'],
  ['--scale-dock-width', '.dock-col', 'max-width'],
]

/** Deliberately not consumed: the drawing's 40px title bar was ruled out on 2026-10-12 — the shell
 *  keeps the native window frame, since drawing its own would need `frame:false` plus a narrow
 *  preload (a privilege-surface change). The token records the drawing's number and nothing reads it. */
const UNCONSUMED_OK = new Set(['--scale-titlebar'])

const say = (...a) => { if (!quiet) console.log(...a) }

if (!existsSync(mockupPath)) {
  console.log('SKIP 定稿 mockup 不在这台机器上（analysis-reports 未入库）— 不是通过，是没测')
  process.exit(0)
}

const rules = readMockup(mockupPath)
const tokensSrc = readFileSync(tokensPath, 'utf8')

/** Every shipped CSS file, so "is this token read?" is answered by the tree, not by intent. */
function collectCss(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectCss(p, out)
    else if (entry.name.endsWith('.css')) out.push(p)
  }
  return out
}

const cssFiles = collectCss(join(clientRoot, 'packages')).concat(collectCss(join(clientRoot, 'apps')))
const tokenValue = (name) => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensSrc)
  return m ? m[1].trim() : undefined
}

const rows = []
for (const [token, sel, prop, idx] of SCALE) {
  const declared = tokenValue(token)
  const fromDrawing = declOf(rules, sel, prop)
  const want = pxOf(fromDrawing, idx)
  const got = pxOf(declared)
  const consumers = declared !== undefined
    ? cssFiles.filter((f) => readFileSync(f, 'utf8').includes(`var(${token})`))
    : []
  const consumed = consumers.length > 0 || UNCONSUMED_OK.has(token)
  rows.push({
    name: token,
    ok: declared !== undefined && Number.isFinite(want) && want === got && consumed,
    detail: `图上 ${fromDrawing ?? '(取不到)'} → token ${declared ?? '(未定义)'}`
      + ` · 消费 ${consumers.length > 0 ? consumers.map((f) => relative(clientRoot, f).replace(/\\/g, '/')).join(' ') : UNCONSUMED_OK.has(token) ? '故意留白（见脚本注释）' : '⚠ 无'}`,
  })
}

for (const r of rows) say(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(24)} ${r.detail}`)
const bad = rows.filter((r) => !r.ok)
if (!quiet) console.log(`\n静态 ${rows.length} 条刻度，偏差/未消费 ${bad.length} 条`)
if (bad.length > 0) {
  console.error('FAILED (图的刻度不再有单一事实源):')
  for (const r of bad) console.error(`  ✗ ${r.name} — ${r.detail}`)
  process.exit(1)
}
