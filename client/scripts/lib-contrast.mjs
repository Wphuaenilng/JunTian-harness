/**
 * Shared facts for the contrast face of the gates: the two theme ramps read out of `tokens.css`,
 * `var()` resolution, and the hand-declared list of foreground/background pairings that are real
 * in the UI.
 *
 * It lives here because two gates need the same table from opposite directions:
 *  - `check-contrast.mjs` scores each **declared** pair ("can `--label-x` be read on `--bg-y`");
 *  - the render-face census in `check-live-geometry.mjs` asks the question the declared list cannot
 *    answer — which pairings a rendered page **actually paints**, and which of those nobody ever
 *    declared.
 * A second copy of `PAIRS` would drift the moment one of the two learns something, which is the
 * failure this repo keeps hitting, so neither side is allowed to own it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

export const light = block(/:root\s*\{([\s\S]*?)\n\}/)
export const dark = block(/\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/)

/** Resolve var() chains (possibly cross-theme), then hex/rgb/rgba to {r,g,b,a}. */
export function resolveVal(name, theme, seen = new Set()) {
  let raw = theme[name]
  if (raw === undefined) throw new Error(`token ${name} missing from the theme block`)
  for (let i = 0; i < 12; i++) {
    const v = /var\((--[a-z0-9-]+)\)/.exec(raw)
    if (!v) break
    if (seen.has(v[1])) throw new Error(`token cycle at ${v[1]}`)
    seen.add(v[1])
    const next = light[v[1]] ?? dark[v[1]]
    if (next === undefined) throw new Error(`token ${name} → ${v[1]} is not defined in either block`)
    raw = next
  }
  return parseColor(raw, name)
}

/**
 * One literal → {r,g,b,a}. Kept next to the theme blocks it serves, and exported, because the day
 * someone wants to judge a *literal* (the `#FDECEC` error tints, the `rgba(34,197,94,.10)` diff
 * washes) rather than a token, the alternative is a second parser — a second place where the same
 * hex can quietly mean a different colour.
 */
export function parseColor(raw, name = 'literal') {
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

/** Composite a translucent foreground over an opaque backdrop the way CSS does. */
export const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})

export const lum = (c) => {
  // v must be normalised to 0..1 BEFORE the sRGB transfer function: feeding it raw 0-255
  // produces luminances in the hundreds and contrast ratios above the physical maximum (21),
  // which is exactly the nonsense the contrast gate first printed.
  const f = (v255) => { const v = v255 / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

/** WCAG contrast ratio. Its own self-check lives in `check-contrast.mjs`: white on black is 21.00. */
export const ratio = (a, b) => {
  const [L1, L2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (L1 + 0.05) / (L2 + 0.05)
}

export const toHsl = ({ r, g, b }) => {
  const [R, G, B] = [r, g, b].map((v) => v / 255)
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min
  const l = (max + min) / 2
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  const hc = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return { h: ((hc * 60) + 360) % 360, s: s * 100, l: l * 100 }
}

export const fromHsl = ({ h, s, l }) => {
  const S = s / 100, L = l / 100
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = L - c / 2
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 }
}

export const hexOf = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** fg, bg, and where that pairing is actually used in the product. */
export const PAIRS = [
  ['--label-primary', '--bg-base', '正文、输入框、面板标题'],
  ['--label-primary', '--bg-sidebar', '会话行标题'],
  ['--label-primary', '--bg-code', '工具卡片/代码块'],
  ['--label-primary', '--bg-inline-code', '行内代码'],
  ['--label-primary', '--bg-bubble', '用户气泡'],
  ['--label-primary', '--bg-selector', '选中行/悬停后的表面'],
  // 由渲染面配对普查点名后补进来的：选中态那一层在 CSS 里是 `--bg-selected`（会话行 `.us__row--sel`、
  // 设置里选中的那一档 `.set__mode--on` 都走它），而声明表里以前只有 `--bg-selector` 那一层。
  // 这条不是"给它开个洞"——把它写进表里意味着两套主题的 AA 数**从此每次都要量**，红就挡。
  ['--label-primary', '--bg-selected', '选中态表面（会话行 / 设置里选中的那一档）'],
  // 下面三条由渲染面配对普查点名后补进来（差一条都没人评过）：工作台选中行的路径文字，
  // 以及差异计数 +/− 压在头行那层 `--bg-selector` 上——计数**原本用通用的 --ok/--danger**，
  // 在这一层只有 4.19/4.31（暗色 4.37/4.27），不到 4.5，已改成差异自己的 owner token 再补进来评。
  ['--label-secondary', '--bg-selector', '工作台选中行的文件路径'],
  ['--diff-add-text', '--bg-selector', '差异计数 +（工具卡与工作台）'],
  ['--diff-del-text', '--bg-selector', '差异计数 −（同上）'],
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
  // 2026-10-12 裁定 ① 新起的「软底色 / on-accent」一族。这四对是像素门的渲染面普查**真看见**的配对
  // （组件把文字画在这些底上），所以它们必须在这儿有个名字，而不是"门没报"就当过了。
  ['--on-accent', '--ds-500', '品牌块上的字形：aria-hidden 的装饰图形，按 1.4.11 判 3:1 而非 4.5', { need: 3 }],
  ['--on-accent', '--nb-1000', '近黑主按钮与侧栏「新建」的文字'],
  ['--label-secondary', '--bg-inline-code', '行内代码与项目角标这类小标签'],
  ['--label-secondary', '--bg-selected', '选中那一档上的次级文字与默认标签'],
]
