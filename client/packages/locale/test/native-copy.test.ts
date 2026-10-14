import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 桌面壳的原生文案（托盘 tooltip、菜单项、窗口标题）活在**主进程**里，看不见渲染进程的
 * localStorage，所以它不走 `@tianshu/locale` 的字典，而是就地写 `zh ? '中' : 'en'` 的手写双语对。
 *
 * 这本身有道理（原生菜单拿不到页面语言，见 main.mjs 的注释），但它落在所有判定之外：
 * `locale.test.ts` 的 `UI_SOURCES` 不含 `apps/desktop`，字典对账也管不到它。于是"加一个只有中文的
 * 菜单项"这件事，此前**没有任何东西会红**。这个文件补的就是那一格。
 *
 * 判据是"配对"而不是"不许出现中文"：中文系统本地化时本来就该念中文。
 */

const here = dirname(fileURLToPath(import.meta.url))
const shellPath = join(here, '..', '..', '..', 'apps', 'desktop', 'src', 'main.mjs')
// 注释是写给维护者的，可以中文；只有会显示出来的字符串才算文案。抹掉注释但保留换行，
// 这样报出来的行号还是真的。
const code = readFileSync(shellPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '')
const lines = code.split(/\r?\n/)

const CJK = /[㐀-鿿]/
const QUOTED = /'((?:[^'\\]|\\.)*)'/g

/** 一行里的字符串字面量是否构成 `zh ? '中' : 'en'` 那种两侧都在的配对。 */
function isPaired(line: string): boolean {
  const strings = [...line.matchAll(QUOTED)].map((m) => m[1] ?? '')
  const chinese = strings.filter((s) => CJK.test(s))
  const latin = strings.filter((s) => !CJK.test(s) && /[A-Za-z]{2,}/.test(s))
  return chinese.length > 0 && latin.length > 0 && /\bzh\s*\?/.test(line)
}

const hasCjkString = (line: string): boolean => [...line.matchAll(QUOTED)].some((m) => CJK.test(m[1] ?? ''))

/**
 * 品牌专名在两种语言里是同一个写法，不该要求它配对——但豁免必须是**写下来的白名单**，
 * 不是一句"看起来像专名就放过"。加了只有中文的新菜单项照样会红。
 */
const BRAND = '天枢'
const isBrandOnly = (line: string): boolean => {
  const chinese = [...line.matchAll(QUOTED)].map((m) => m[1] ?? '').filter((s) => CJK.test(s))
  return chinese.length > 0 && chinese.every((s) => s === BRAND)
}

test('the shell native copy is bilingual by pair, not by luck', () => {
  const unpaired: string[] = []
  let pairs = 0
  let brands = 0
  lines.forEach((line, i) => {
    if (!hasCjkString(line)) return
    if (isPaired(line)) { pairs += 1; return }
    if (isBrandOnly(line)) { brands += 1; return }
    unpaired.push(`main.mjs:${i + 1} ${line.trim().slice(0, 90)}`)
  })
  // 正控：扫描必须真找到配对项，否则"0 条未配对"可能只是因为正则或文件路径坏了。
  assert.ok(pairs >= 3, `期望至少 3 处手写双语对，实扫到 ${pairs} —— 扫描面或写法变了，这条绿没有意义`)
  assert.deepEqual(unpaired, [], `这些中文字符串没有配对的英文侧，英文系统下会直接念中文：\n  ${unpaired.join('\n  ')}`)
  assert.equal(brands, 2, `品牌名应当只出现在窗口标题与托盘 tooltip 两处，实扫到 ${brands}`)
})

test('the tray tooltip and window title carry the brand, and nothing else does', () => {
  // 定稿要点：品牌只在侧栏头部一处。窗口标题与托盘 tooltip 属于操作系统 chrome，不是界面品牌位
  // （与 `<title>` 同一条口径），所以它们**可以**写品牌名——但只能有这两处，上一条判定已经数过。
  const brandLines = lines.filter((l) => l.includes(`'${BRAND}'`))
  assert.equal(brandLines.length, 2, `期望正好 2 行用到「${BRAND}」，实扫到 ${brandLines.length}`)
})

test('the shell reads the OS locale and never reaches for the renderer storage', () => {
  assert.match(code, /app\.getLocale\(\)/)
  // localStorage 在主进程里根本不存在，真去读它会静默退回默认语言——那才是要防的坏法。
  assert.doesNotMatch(code, /localStorage/)
})
