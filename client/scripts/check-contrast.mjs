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
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The ramps, the var() resolver and the declared-pair table live in one shared module, because
// `check-live-geometry.mjs` reads the same table from the other direction (what the browser
// actually paints). A second copy would drift the first time either gate learns something.
import { light, dark, resolveVal, PAIRS, over, lum, ratio, toHsl, fromHsl, hexOf, parseColor } from './lib-contrast.mjs'
import { parseCssFiles, literalColor, tokenColor, stripComments } from './lib-css-rules.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')

const css = readFileSync(join(clientRoot, 'packages/ui-theme/src/tokens.css'), 'utf8')

/**
 * The minimal fix, computed rather than argued about. Every failing pair is a colour decision the
 * owner has to make, and "it fails AA" is not actionable — "same hue and saturation, lightness
 * 62 → 48 gives 4.62:1" is. We only move lightness (H and S and any alpha stay), because that is
 * the change that keeps the ramp recognisable; when no lightness reaches 4.5 we say so instead of
 * silently suggesting a different kind of edit.
 *
 * The colour math (over / lum / ratio / toHsl / fromHsl / hexOf) now lives in `lib-contrast.mjs`
 * and is imported: one home, so a probe that judges a *literal* (the `#FDECEC` error tints, the
 * `rgba(34,197,94,.10)` diff washes) runs the same arithmetic this table does. What stays here is
 * the gate-local half: which token actually owns a value, and how many faces ride on moving it.
 */

/**
 * Which token actually holds the literal. `--label-caption` is `var(--nb-400)`, so "set it to
 * #6f7780" would mean *inlining a hex and leaving the ramp* — a different (worse) edit than
 * moving the ramp value itself. Naming the owner also states the blast radius: everything else
 * referencing that ramp step moves with it.
 */
function ownerOf(name, merged) {
  let cur = name
  for (let i = 0; i < 12; i++) {
    const v = /var\((--[a-z0-9-]+)\)/.exec(String(merged[cur] ?? ''))
    if (!v) return cur
    cur = v[1]
  }
  return cur
}

/**
 * Blast radius, computed from the stylesheets rather than remembered: "move `--nb-400`" is only a
 * decision the owner can make if they know how many faces ride on it. Counts `var(--token)`
 * references across every shipped CSS file, per token, with the per-file split.
 */
const cssFiles = []
const walkCss = (dir) => {
  if (!existsSync(dir)) return
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'dist' || ent.name === 'node_modules') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) walkCss(full)
    else if (ent.name.endsWith('.css')) cssFiles.push(full)
  }
}
// Recursive on purpose: a depth-limited walk would silently undercount the moment anyone puts a
// stylesheet in a subfolder, and an undercounted blast radius is worse than none — it reads as
// "this change is cheap". Cross-checked against `grep -ro "var(--token)" --include=*.css`
// (excluding dist) for `--nb-400`: 8 = 8.
walkCss(join(clientRoot, 'packages'))
walkCss(join(clientRoot, 'apps'))
if (cssFiles.length < 10) throw new Error(`only ${cssFiles.length} stylesheets walked — the scan is missing files, blast radius would be understated`)

const BLAST = new Map()
for (const file of cssFiles) {
  const rel = file.slice(clientRoot.length + 1).replace(/\\/g, '/')
  for (const m of String(readFileSync(file, 'utf8')).matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    const hit = BLAST.get(m[1]) ?? { count: 0, files: new Map() }
    hit.count += 1
    hit.files.set(rel, (hit.files.get(rel) ?? 0) + 1)
    BLAST.set(m[1], hit)
  }
}
const blastOf = (token) => {
  const hit = BLAST.get(token)
  if (!hit) return '无 var() 引用点（只被 tokens.css 自己定义）'
  const where = [...hit.files.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}×${n}`).join(' ')
  return `牵动 ${hit.count} 处 var() 引用 / ${hit.files.size} 个文件（含 tokens.css 里的语义别名）：${where}`
}

/** @returns a suggestion string, or null when lightness alone cannot reach AA. */
function minimalFix(fg0, bg, owner, fgTok) {
  const start = toHsl(fg0)
  // Light background → darken the text; dark background → lighten it. Anything else is a
  // different kind of edit (alpha, or the surface token) and we say so rather than guess.
  const dir = lum(bg) > 0.5 ? -1 : 1
  for (let step = 1; step <= Math.ceil(dir < 0 ? start.l : 100 - start.l); step++) {
    const l = start.l + dir * step
    const rgb = fromHsl({ h: start.h, s: start.s, l })
    const cand = { ...rgb, a: fg0.a }
    const eff = cand.a < 1 ? over(cand, bg) : cand
    const r = ratio(eff, bg)
    if (r >= 4.5) {
      const where = owner === fgTok
        ? `改 ${fgTok}`
        : `改 ${owner}（${fgTok} 只是引用它）`
      return `L ${start.l.toFixed(0)} → ${l.toFixed(0)}（H/S/alpha 不动）→ ${r.toFixed(2)}:1 · ${hexOf(rgb)} · ${where}${fg0.a < 1 ? `，alpha ${fg0.a} 保持` : ''} · ${blastOf(owner)}`
    }
  }
  return null
}

// The declared pairing table is imported from `lib-contrast.mjs` so the render-face census in
// `check-live-geometry.mjs` compares against exactly this list rather than a copy of it.

const rows = []
// Self-check first: contrast has a hard physical ceiling of 21 (white on black). A gate
// that prints 664 is not measuring anything, and it is worse than no gate because it looks
// authoritative. If the ramp math ever breaks, this fails loudly before the table does.
const sanity = ratio({ r: 255, g: 255, b: 255, a: 1 }, { r: 0, g: 0, b: 0, a: 1 })
if (Math.abs(sanity - 21) > 0.02) {
  console.error(`✗ contrast math is broken: white-on-black = ${sanity.toFixed(2)}, expected 21.00`)
  process.exit(1)
}
/** 按非文字档（3:1）判的声明配对，逐条打印出来——让路要看得见才算让路。 */
const loweredTier = []
for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
  for (const [fgTok, bgTok, use, tier] of PAIRS) {
    if (tier !== undefined) {
      // 让路只有 1.4.11 那一档可以要：低于 3:1 的"豁免"不是分级，是把门关掉。写在这儿而不是
      // 默默忽略，是因为这道门今年刚从"故意红"接进 CI——豁免的口子必须看得见。
      if (!(tier.need >= 3)) {
        console.error(`✗ 声明表让路越界：${fgTok} on ${bgTok} 申请 ≥${tier.need}，低于 1.4.11 的 3:1 底线 — 拒绝判`)
        process.exit(1)
      }
      if (use.length < 12) {
        console.error(`✗ 声明表让路没有理由：${fgTok} on ${bgTok} 申请非文字档，但 use 那一栏没写清（≥12 字）`)
        process.exit(1)
      }
      loweredTier.push(`${themeName} ${fgTok} on ${bgTok} ≥${tier.need}`)
    }
    const merged = { ...light, ...theme }
    const bg = resolveVal(bgTok, merged)
    const fg0 = resolveVal(fgTok, merged)
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0
    const r = ratio(fg, bg)
    // 声明表默认按文字档 4.5 判；`tier.need` 是给"这条不是文字"的显式豁免（1.4.11 的 3:1），
    // 必须带着理由写在 `use` 里——留一个空的让路口子等于没有门。
    const need = tier?.need ?? 4.5
    const pass = r >= need
    const owner = ownerOf(fgTok, merged)
    // Floor, not round: a pair at 4.4987 is a failure, and printing "4.5 ✗" reads like the gate
    // disagreeing with itself. Rounding down keeps the displayed number on the same side as the verdict.
    rows.push({
      themeName, fgTok, bgTok, use, need, ratio: Math.floor(r * 100) / 100, pass,
      fix: pass ? null : minimalFix(fg0, bg, owner, fgTok),
    })
  }
}

/**
 * 源码侧配对普查：CSS 里**字面色与 token 色真实叠在一起**的那些组合。
 *
 * 上面那张表量的是手声明的配对，像素门量的是页面上真渲染出来的配对（它自己就报"表外 4+5 组"）。
 * 中间漏掉的一族是"没有夹具就渲染不出来"的状态：错误横幅的 `background:#FDECEC` 配
 * `color:var(--danger)`、diff 行的两条 rgba 底配 `--ok` / `--danger`。这一节把它们从源码量出来。
 * 只算**至少一侧是字面色**的组合——两侧都是 token 的归上面那张表管，不重复计数。
 */
/**
 * 阈值分级，两条都从盘上派生，不靠人判：
 *  ① 大字号豁免（WCAG 1.4.3：≥24px，或 ≥18.66px 且加粗，只要 3:1）——产品 CSS 里所有 font-size
 *     实测都在 10–14px 这一档，够不到豁免线，所以这一维**结构上不可达**：把它做成一条读数，
 *     将来有人加一枚 ≥18.66px 的字，这里就会开始按 3:1 判，而不是我们到时候才发现。
 *  ② 装饰性 / 对读屏隐藏的内容不按文字对比度判（`aria-hidden="true"` 的图形走 1.4.11 的 3:1）。
 *     这一条从组件源码里查：类名出现在哪个 JSX 元素上、那个元素自己带不带 aria-hidden。
 */
const jsxFiles = []
const walkJsx = (dir) => {
  if (!existsSync(dir)) return
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walkJsx(p)
    else if (/\.tsx$/.test(ent.name)) jsxFiles.push(p)
  }
}
walkJsx(join(clientRoot, 'packages'))
walkJsx(join(clientRoot, 'apps'))

const sizeDeclRe = /font-size:\s*([0-9.]+)(px|rem|em)/g
let maxTextPx = 0
let sizeDecls = 0
for (const f of cssFiles) {
  for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(sizeDeclRe)) {
    const px = Number(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1)
    sizeDecls += 1
    if (px > maxTextPx) maxTextPx = px
  }
}
if (sizeDecls < 20) throw new Error(`只数出 ${sizeDecls} 条 font-size 声明——字号扫描面坏了，阈值分级不作数`)
const largeTierReachable = maxTextPx >= 18.66

// 类名 → 该元素是否对读屏隐藏。做法：找到每个 className，把包住它的开标签整段取出来
// （从它前面最近的 `<` 到它后面最近的 `>`），在这个开标签里查 aria-hidden——这样属性写在
// className 前面还是后面都认得到。开标签里嵌 `>` 的表达式（箭头函数）是已知的少见形状，
// 命中不了只会让阈值保守（按 4.5 判），不会把真缺陷判成合格。
// **要求该类的每一处用法都隐藏**才算装饰：只要有一处是给人读的，就按文字阈值判。
const classUses = new Map()
for (const f of jsxFiles) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/className="([^"]*)"/g)) {
    const tag = text.slice(text.lastIndexOf('<', m.index), text.indexOf('>', m.index) + 1)
    const hidden = /aria-hidden=\{?"?true"?\}?/.test(tag)
    for (const c of String(m[1]).split(/\s+/).filter(Boolean)) {
      const hit = classUses.get(c) ?? { total: 0, hidden: 0 }
      hit.total += 1
      if (hidden) hit.hidden += 1
      classUses.set(c, hit)
    }
  }
}
const hiddenClasses = new Set([...classUses.entries()].filter(([, h]) => h.hidden > 0 && h.hidden === h.total).map(([c]) => c))
const partlyHidden = [...classUses.entries()].filter(([, h]) => h.hidden > 0 && h.hidden < h.total).map(([c]) => `${c}(${h.hidden}/${h.total})`)
if (classUses.size === 0) throw new Error('一个 className 都没查到——JSX 扫描面坏了（产品里确有装饰元素），阈值分级不作数')

/** @returns {{need:number, why:string}} WCAG 阈值与该配对的判据来源 */
function thresholdFor(selector, decls) {
  const cls = selector.replace(/^\./, '').split(/\s+/)[0]
  const size = decls.find((d) => /^font-size$/i.test(d.prop))?.value
  const px = size ? Number(/([0-9.]+)\s*(px|rem|em)/.exec(size)?.[1] ?? 0) * (/rem|em/.test(String(size)) ? 16 : 1) : null
  const weight = decls.find((d) => /^font-weight$/i.test(d.prop))?.value
  const bold = /bold/.test(String(weight)) || Number(weight) >= 600
  if (hiddenClasses.has(cls)) return { need: 3, why: '该元素在组件源码里带 aria-hidden="true"（装饰/读屏隐藏，按 1.4.11 的 3:1）' }
  if (largeTierReachable && px !== null && (px >= 24 || (px >= 18.66 && bold))) return { need: 3, why: `大字号豁免（${px}px${bold ? ' 加粗' : ''}）→ 3:1` }
  return { need: 4.5, why: px === null ? `文字对比度 4.5:1（该规则未声明字号，按保守档；产品最大字号实测 ${maxTextPx}px，够不到大字号豁免）` : `文字对比度 4.5:1（${px}px，产品最大字号 ${maxTextPx}px < 18.66 → 无豁免档）` }
}

const srcRows = []
for (const { file, selector, decls } of parseCssFiles(cssFiles)) {
  const bgDecl = decls.find((d) => /^background(-color)?$/i.test(d.prop))
  const fgDecl = decls.find((d) => /^color$/i.test(d.prop))
  if (!bgDecl || !fgDecl) continue
  for (const [themeName, theme] of [['light', light], ['dark', dark]]) {
    const merged = { ...light, ...theme }
    const side = (d) => {
      const tok = tokenColor(d.value)
      if (tok && merged[tok] !== undefined) return { kind: 'token', name: tok, c: resolveVal(tok, merged) }
      const lit = literalColor(d.value)
      if (lit) return { kind: 'literal', name: lit, c: parseColor(lit) }
      return null
    }
    const bg = side(bgDecl)
    const fg = side(fgDecl)
    if (!bg || !fg) continue
    // 2026-10-12：这一节原本要求"至少一侧是字面量"。那一族字面量今年全换成语义 token 之后，
    // 按旧形状它就成了空面——"0 组不过线"再也不是"都合格"，而是"什么都没看"。所以放开到
    // **token × token**：错误横幅、diff 行这些夹具渲不出来的状态，Coverage 不能靠运气。
    // 半透明要按 CSS 的合成方式压在实际底上：底色压在页面底上，前景文字压在合成后的底上。
    const page = resolveVal('--bg-base', merged)
    const bgEff = bg.c.a < 1 ? over(bg.c, page) : bg.c
    const fgEff = fg.c.a < 1 ? over(fg.c, bgEff) : fg.c
    const r = ratio(fgEff, bgEff)
    const { need, why } = thresholdFor(selector, decls)
    srcRows.push({
      themeName, selector,
      file: file.slice(clientRoot.length + 1).replace(/\\/g, '/'),
      pair: `${fg.name} on ${bg.name}`, ratio: Math.floor(r * 100) / 100, pass: r >= need, need, why,
    })
  }
}
// 面自证：解析塌成空集时"零失败"是假安心。这两条是**两侧都在**的真实配对（错误横幅的
// `--danger` 压 `#FDECEC`、diff 增行的 `--ok` 压那条 rgba）——第一版我在这里写了
// `.ua__card--stalled`，它只有 `background` 没有 `color`，本来就不该出现在这一节里，
// 那条红是我判据选错而不是门抓到缺陷（已换成可指认的真配对）。
const SRC_CANARIES = ['.fl__error', '.tp-diff__line--add']
const srcCanaryMissing = SRC_CANARIES.filter((s) => !srcRows.some((x) => x.selector === s))

const fails = rows.filter((r) => !r.pass)
const srcFails = srcRows.filter((x) => !x.pass)
if (!quiet) {
  console.log('theme  token pair                                    usage                      ratio  阈值  AA')
  for (const r of rows) {
    console.log(`${r.themeName.padEnd(5)} ${(r.fgTok + ' on ' + r.bgTok).padEnd(44)} ${r.use.padEnd(26)} ${String(r.ratio).padStart(5)}  ≥${String(r.need).padStart(4)}  ${r.pass ? '✓' : '✗'}`)
  }
  console.log(`声明表里按非文字档（1.4.11 的 3:1）判的配对 ${loweredTier.length} 条：${loweredTier.join(' ; ') || '无——全部按 4.5 判'}`)
  console.log(`\n源码侧配对普查（CSS 源码里真实叠在一起的前景×底色，token×token 也算；派生 ${srcRows.length} 组 / ${new Set(srcRows.map((x) => x.selector)).size} 个选择器）`)
  console.log(`  阈值面派生读数：font-size 声明 ${sizeDecls} 条，最大 ${maxTextPx}px → 大字号 3:1 豁免档${largeTierReachable ? '可达（按规则自身字号判）' : '不可达（全部按 4.5 判）'}；aria-hidden 覆盖全部用法的类名 ${hiddenClasses.size} 个（按 1.4.11 的 3:1）；只在部分用法里隐藏的 ${partlyHidden.length ? partlyHidden.join(' , ') : '无'}`)
  for (const x of srcRows) {
    console.log(`${x.themeName.padEnd(5)} ${x.selector.padEnd(32)} ${x.pair.padEnd(40)} ${String(x.ratio).padStart(5)}  ≥${x.need}  ${x.pass ? '✓' : '✗'}  ${x.file}`)
  }
}
report(fails, srcFails, srcCanaryMissing)

function report(list, srcList, canaryMissing) {
  if (list.length === 0 && srcList.length === 0 && canaryMissing.length === 0) {
    if (!quiet) console.log(`\n✓ contrast AA passes on all ${rows.length} declared pairs + ${srcRows.length} source-level pairs`)
    process.exit(0)
  }
  console.error(`\n✗ ${list.length} / ${rows.length} 条声明配对低于**它各自的适用阈值**（2026-10-12 裁定 ① 之后这道门已接进 ci-smoke 与 CI：AA 是硬门，红就挡合并。下面是可一键照做的最小改法）:`)
  for (const f of list) {
    console.error(`   ${f.themeName} ${f.fgTok} on ${f.bgTok} = ${f.ratio}  (${f.use})`)
    console.error(`      ${f.fix ? `最小改法 ${f.fix}` : '只调亮度到不了 4.5（H/S/alpha 不动时已到端点）——要动不透明度或底色，那属于换方案不是收阈值'}`)
  }
  if (canaryMissing.length > 0 || srcRows.length < 4) {
    console.error(`\n✗ 源码侧普查的扫描面本身坏了：派生 ${srcRows.length} 组，认不出这些已知站点 ${canaryMissing.join(' , ') || '（无缺失）'}——下面所有源码侧读数都不作数`)
  }
  if (srcList.length > 0) {
    console.error(`\n✗ 源码侧还有 ${srcList.length} / ${srcRows.length} 组配对低于**它自己那条规则的适用阈值**（错误横幅 / diff 行这类没有夹具渲染不出来的状态，声明表与像素门都量不到）:`)
    for (const f of srcList) console.error(`   ${f.themeName} ${f.selector} — ${f.pair} = ${f.ratio} < ${f.need}  (${f.file})\n      判据：${f.why}`)
  }
  process.exit(1)
}
