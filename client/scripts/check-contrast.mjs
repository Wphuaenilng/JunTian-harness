#!/usr/bin/env node
/**
 * check-contrast.mjs — WCAG AA on the theme tokens, computed from `tokens.css`.
 *
 * Why a static gate instead of reading computed styles in a live browser: a browser probe
 * tells you what one page looked like at one moment; the ramp is the contract every panel
 * paints from, and it is checkable from the file. The plan's §4.2 ui-theme cell ships a
 * dark ramp that was **derived, not signed off** (the 定稿 mockup is light-only) — that is
 * precisely the situation where numbers beat opinion.
 *
 * Scope, stated plainly: this audits **token pairs**, i.e. "can `--label-x` be read on
 * `--bg-y`". It cannot say whether a given component actually pairs them that way — a
 * component that paints `--label-caption` on a saturated accent would still need a live
 * check. Pairs are declared below with where each one is used, so adding a pair is a
 * deliberate act rather than a guess about the whole ramp.
 *
 *   node scripts/check-contrast.mjs            # table + verdict
 *   node scripts/check-contrast.mjs --quiet    # failures only (CI)
 *
 * Thresholds are WCAG 2.1 AA for normal text (4.5:1) because every pair below carries text
 * at 11-14px. The 3:1 large-text allowance is deliberately not used to excuse anything here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')

const css = readFileSync(join(clientRoot, 'packages/ui-theme/src/tokens.css'), 'utf8')

function block(re) {
  const m = re.exec(css)
  if (!m) throw new Error(`tokens.css: block not found for ${re}`)
  const out = {}
  for (const line of m[1].split('\n')) {
    const d = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line)
    if (d) out[d[1]] = d[2].trim()
  }
  return out
}
const light = block(/:root\s*\{([\s\S]*?)\n\}/)
const dark = block(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)

/** Resolve var() chains (possibly cross-theme), then hex/rgb/rgba to {r,g,b,a}. */
function resolveVal(name, theme, seen = new Set()) {
  let raw = theme[name]
  if (raw === undefined) throw new Error(`token ${name} missing from the theme block`)
  for (let i = 0; i < 12; i++) {
    const v = /var\((--[a-z0-9-]+)\)/.exec(raw)
    if (!v) break
    if (seen.has(v[1])) throw new Error(`token cycle at ${v[1]}`)
    seen.add(v[1])
    const next = light[v[1]] ?? dark[v[1]]
    if (next === undefined) throw new Error(`token ${v[1]} is not defined in either block`)
    raw = next
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(raw)
  if (rgb) {
    const p = rgb[1].split(',').map((x) => parseFloat(x.trim()))
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  throw new Error(`cannot parse value ${raw} for ${name}`)
}

/**
 * Composite a translucent foreground over an opaque backdrop the way CSS does, so
 * `rgba(38,49,72,.06)`-style tokens are judged on what actually reaches the eye.
 */
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})

const lum = (c) => {
  // v must be normalised to 0..1 BEFORE the sRGB transfer function: feeding it raw 0-255
  // produces luminances in the hundreds and contrast ratios above the physical maximum (21),
  // which is exactly the nonsense this gate first printed.
  const f = (v255) => { const v = v255 / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
const ratio = (a, b) => {
  const [L1, L2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (L1 + 0.05) / (L2 + 0.05)
}

// fg, bg, where the pairing is real
const PAIRS = [
  ['--label-primary', '--bg-base', '正文、输入框、面板标题'],
  ['--label-primary', '--bg-sidebar', '会话行标题'],
  ['--label-primary', '--bg-code', '工具卡片/代码块'],
  ['--label-primary', '--bg-inline-code', '行内代码'],
  ['--label-primary', '--bg-bubble', '用户气泡'],
  ['--label-primary', '--bg-selector', '选中行/悬停后的表面'],
  ['--label-secondary', '--bg-base', '次级说明、状态条'],
  ['--label-secondary', '--bg-sidebar', '侧栏次级文本'],
  ['--label-secondary', '--bg-code', '工具参数块'],
  ['--label-tertiary', '--bg-base', '三级文本（时间戳等）'],
  ['--label-tertiary', '--bg-sidebar', '侧栏占位与次要标签'],
  ['--label-caption', '--bg-base', '小字标签/caption'],
  ['--label-caption', '--bg-sidebar', '侧栏 caption'],
  ['--accent', '--bg-base', '链接、主按钮文字'],
  ['--accent', '--bg-sidebar', '侧栏强调（当前会话）'],
  ['--ok', '--bg-base', '健康 pill 文字'],
  ['--danger', '--bg-base', '错误条/危险按钮文字'],
  ['--warn', '--bg-base', '警示 pill 文字'],
]

const rows = []
// Self-check first: contrast has a hard physical ceiling of 21 (white on black). A gate
// that prints 664 is not measuring anything, and it is worse than no gate because it looks
// authoritative. If the ramp math ever breaks, this fails loudly before the table does.
const sanity = ratio({ r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 })
if (Math.abs(sanity - 21) > 0.02) {
  console.error(`✗ contrast math is broken: white-on-black = ${sanity.toFixed(2)}, expected 21.00`)
  process.exit(1)
}
for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  for (const [fgTok, bgTok, use] of PAIRS) {
    const merged = { ...light, ...theme }
    const bg = resolveVal(bgTok, merged)
    const fg0 = resolveVal(fgTok, merged)
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0
    const r = ratio(fg, bg)
    rows.push({ themeName, fgTok, bgTok, use, ratio: Math.round(r * 100) / 100, pass: r >= 4.5 })
  }
}

const fails = rows.filter((r) => !r.pass)
if (!quiet) {
  console.log('theme  token pair                                    usage                      ratio  AA')
  for (const r of rows) {
    console.log(`${r.themeName.padEnd(5)} ${(r.fgTok + ' on ' + r.bgTok).padEnd(44)} ${r.use.padEnd(26)} ${String(r.ratio).padStart(5)}  ${r.pass ? '✓' : '✗'}`)
  }
}
report(fails)

function report(list) {
  if (list.length === 0) { if (!quiet) console.log(`\n✓ contrast AA passes on all ${rows.length} declared pairs`); process.exit(0) }
  console.error(`\n✗ ${list.length} / ${rows.length} declared pairs below 4.5:1:`)
  for (const f of list) console.error(`   ${f.themeName} ${f.fgTok} on ${f.bgTok} = ${f.ratio}  (${f.use})`)
  process.exit(1)
}
