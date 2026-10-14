#!/usr/bin/env node
/**
 * check-mockup-tokens.mjs — is `ui-theme`'s claim of coming from the approved mockup true,
 * token by token?
 *
 * Plan §2.3 commits to 「渲染美学是差异化竞争力 / 自研原语 + CSS token，视觉不凑合」and §4.2
 * names `ui-theme` as the package that carries it. `design/desktop-mockup-dsh-style.html` is
 * the only visual source of truth in this repo, so the README sentence "values lifted verbatim
 * from the approved mockup" needs to be a measurement, not a claim.
 *
 * The first version of this file compared raw strings and reported four "mismatches" that were
 * all whitespace (`rgba(0,0,0,.04)` vs `rgba(0, 0, 0, .04)`) plus one token we deliberately
 * renamed (`--hover` → `--bg-hover`). **A gate that cries wolf is worse than no gate** — it
 * teaches everyone to ignore it. So comparison is normalized and names are resolved through an
 * explicit alias rule, and the report separates four different things that used to be lumped
 * together as "different":
 *
 *   真值差 / 仅写法差 / 改名后值一致 / 我们自定的（mockup 从未声明）
 *
 * It also states plainly what the mockup does NOT decide — geometry — because those numbers are
 * ours, and "it matches the mockup" can never be an argument for them.
 *
 *   node scripts/check-mockup-tokens.mjs            # human report
 *   node scripts/check-mockup-tokens.mjs --quiet     # failures only
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './lib-css-rules.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')

const mockupPath = join(clientRoot, '..', 'analysis-reports', '定稿-天枢客户端方案', 'design', 'desktop-mockup-dsh-style.html')
const tokensPath = join(clientRoot, 'packages/ui-theme/src/tokens.css')
if (!existsSync(mockupPath)) { console.error(`mockup not found: ${mockupPath}`); process.exit(1) }

/** Compare by meaning: no whitespace, lowercase, `0.5` and `.5` are the same number. */
function normalize(value) {
  return value.toLowerCase().replace(/\s+/g, '').replace(/(^|[,(:])(0+\.)/g, '$1.')
}

/**
 * `--name: value` pairs across **every** block matching `selector`, later blocks winning —
 * taking only the first would silently under-cover the day the mockup adds a second `:root`
 * (it has one today; that is an observation, not a promise).
 *
 * Comments are stripped first, and that is not cosmetic: this parser used to scan the raw text,
 * so a comment that merely *mentions* `:root` opened a second pseudo-block running to the next
 * `}` — which made the dark block's values land in `lightVars` (last wins). A product comment
 * saying "`:root` 只定义一次" was enough to misread the theme. One home for the stripping rule:
 * `lib-css-rules`, the same one `check-contrast` parses with.
 */
function varsOf(rawText, selector) {
  const text = stripComments(rawText)
  const out = new Map()
  let from = -1
  let blocks = 0
  while ((from = text.indexOf(selector, from + 1)) >= 0) {
    const end = text.indexOf('}', from)
    const body = text.slice(from, end < 0 ? text.length : end)
    blocks += 1
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      out.set(m[1].toLowerCase(), m[2].trim())
    }
  }
  out.blockCount = blocks
  return out
}

const mockup = readFileSync(mockupPath, 'utf8')
const ours = readFileSync(tokensPath, 'utf8')
const mockVars = varsOf(mockup, ':root')
const lightVars = varsOf(ours, ':root')
const darkVars = varsOf(ours, "[data-theme='dark']")

/**
 * Naming rule we actually applied: the mockup's bare surface names became `--bg-*` aliases here
 * (`--hover` → `--bg-hover`, `--code-block` → `--bg-code`, …). Kept as data so the mapping is
 * reviewable rather than a heuristic that might silently start matching the wrong thing.
 */
const ALIASES = {
  '--hover': '--bg-hover',
  '--bubble': '--bg-bubble',
  '--selector': '--bg-selector',
  '--sidebar-fill': '--bg-sidebar',
  '--code-block': '--bg-code',
  '--inline-code': '--bg-inline-code',
}

const isVisual = (name, value) => /^#|^rgba?\(|^hsla?\(|^var\(/.test(value)
  || /label|border|shadow|accent|ds-|nb-|amber|red-|green|blue|bg-|fill|hover|bubble|selector|code/.test(name)

const realDiff = []
const formatOnly = []
const renamed = []
const notHere = []
/**
 * 2026-10-12 裁定 ①：AA 是硬门，而**图上那两枚值本身就过不了 4.5:1**（`--label-tertiary: var(--nb-600)`
 * 在 `--bg-base` 上 3.7:1、`--label-caption: var(--nb-400)` 2.13:1）。所以这两枚语义 token 故意不
 * 等于图上写的值——这是"照图"与"读得出来"之间的一次真实取舍，必须逐名登记，而不是让比对笼统让路。
 * 登记是双向的：这里列了而今天不再偏离，同样红（免得白名单变成永久豁免）。
 */
const AA_DEVIATIONS = new Map([
  ['--label-tertiary', '图上 var(--nb-600) 压 --bg-base 只有 3.7:1，AA 要 4.5 → 本仓把它定在 ramp 之外'],
  ['--label-caption', '图上 var(--nb-400) 压 --bg-base 只有 2.13:1，是全表最差的一枚 → 同上'],
])
const aaDeviated = []

for (const [name, want] of mockVars) {
  if (!isVisual(name, want)) continue
  const ourName = lightVars.has(name) ? name : ALIASES[name]
  if (ourName === undefined || !lightVars.has(ourName)) { notHere.push(`${name}（mockup ${want}）`); continue }
  const got = lightVars.get(ourName)
  if (normalize(got) === normalize(want)) {
    if (ourName !== name) renamed.push(`${name} → ${ourName}`)
    else if (got.trim() !== want.trim() && normalize(got) === normalize(want)) formatOnly.push(name)
  } else if (AA_DEVIATIONS.has(name)) {
    aaDeviated.push(name)
  } else {
    realDiff.push(`${name}: mockup ${want} / tokens.css ${got}`)
  }
}
const staleAa = [...AA_DEVIATIONS.keys()].filter((n) => !aaDeviated.includes(n))

const invented = [...lightVars.keys()].filter((n) => !mockVars.has(n) && !Object.values(ALIASES).includes(n))

const failures = []
const check = (label, ok, detail = '') => {
  if (!quiet || !ok) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const compared = mockVars.size
check(`mockup 声明的视觉 token 与 tokens.css :root **真值一致**（比的是归一化后的值）`,
  realDiff.length === 0, realDiff.slice(0, 4).join(' ; ') || `${compared} 条 mockup 变量里，可比对的全部相等`)
check('mockup 里没有一条 token 在我们这儿既无同名也无别名', notHere.length === 0,
  notHere.slice(0, 6).join(' ; ') || '零条遗漏')
check('对图上值的每一次偏离都必须逐名登记，且登记的今天确实还偏离（双向）',
  staleAa.length === 0 && aaDeviated.length === AA_DEVIATIONS.size,
  `${aaDeviated.length} 条偏离${aaDeviated.length ? `：${aaDeviated.join(' ; ')}` : ''}`
  + (staleAa.length ? ` ｜ 登记了但今天已不再偏离（该删）：${staleAa.join(' ; ')}` : ''))
check('tokens.css 的两块主题各自只被认出一块，且读到的变量数不为零（面自证）',
  lightVars.blockCount === 1 && darkVars.blockCount === 1 && lightVars.size > 20 && darkVars.size > 10,
  `实测 :root ${lightVars.blockCount} 块 / ${lightVars.size} 条变量，暗色 ${darkVars.blockCount} 块 / ${darkVars.size} 条`
  + '；块数一旦多于 1 就说明解析器把别处的文本当成了第二块 :root（这一次正是注释里写了 `:root` 三个字，暗色值因此漏进浅色）')

if (!quiet) {
  console.log(`  i 仅写法差（空格/前导零）${formatOnly.length} 条${formatOnly.length ? `：${formatOnly.slice(0, 8).join(' ')}` : ''}`)
  console.log(`  i 改名后值一致 ${renamed.length} 条：${renamed.join(' ; ') || '无'}`)
  console.log(`  i 我们自定、mockup 从未声明的 ${invented.length} 条：${invented.join(' ')}`)
  console.log(`  i mockup 是**浅色 only**：深色 ramp ${darkVars.size} 条全部由本仓推导，尚未设计评审（台账已记）`)
  const geometry = [...mockVars.keys()].filter((n) => /radius|gap|pad|margin|width|height|size/.test(n))
  console.log(`  i mockup 里没有几何 token（${geometry.length ? geometry.join(' ') : '零条'}）：间距/圆角/字号这些数字**没有 mockup 事实源**，是我们定的，「与定稿一致」这句话不能覆盖它们`)
}

if (failures.length > 0) {
  console.error(`\nFAILED (色板与定稿 mockup 的真值开始分叉):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
if (!quiet) console.log(`\nmockup token 对账通过（mockup ${compared} 条 / 我们 :root ${lightVars.size} 条 / dark ${darkVars.size} 条）`)
