import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownBlock, highlightStats } from '@tianshu/ui-primitives'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import './styles.css'

/**
 * Render probe for §8「高亮 = shiki」。为什么值得单独开一页：`MarkdownBlock` 把着色失败
 * 用 `.catch(() => setHtml(plain))` 咽掉了——浏览器里语法数据加载失败时，屏上就是"正确但朴素"
 * 的代码，没有任何异常症状。node 侧单测能过（shiki 在 node 里能加载），所以**这一格只有真浏览器
 * 里的读数才算证据**。
 *
 * 探针只做一件事：挂**真组件**、喂一段带语言的围栏代码（`open=false`，因为着色是密封块上的
 * post-pass），然后把渲染事实读出来给 `node scripts/check-live-geometry.mjs`：
 *   · <pre> 的 class 里有没有 shiki（= 渲染器真的跑过，而不是退回纯文本）
 *   · token <span> 的数量与**互不相同的计算色**数量（= 语法着色而不是整块同色）
 *   · 切换主题后同一批 span 的计算色有没有变（= `--shiki-light/--shiki-dark` 双主题真被 CSS 消费）
 *
 * Not linked from the app; reachable at /hl-probe.html while the serve layer is running.
 * Nothing here reads tokens, endpoints or disk.
 */

const FENCE = '`'.repeat(3)
const SOURCE = [
  `${FENCE}ts`,
  'export function greet(name: string): string {',
  '  const greeting: string = `hi ${name}`',
  '  return greeting',
  '}',
  `${FENCE}`,
].join('\n')

type Readout = {
  done: boolean
  reason: string
  preClass: string
  spanCount: number
  distinctColors: number
  sampleColors: string[]
  themeChanged: boolean
  renders: number
}

const readTokens = (): { preClass: string; spanCount: number; distinct: number; sample: string[] } => {
  const pre = document.querySelector('.tp-md pre')
  if (!pre) return { preClass: '', spanCount: 0, distinct: 0, sample: [] }
  const spans = Array.from(pre.querySelectorAll('span'))
  const colors = spans.map((s) => getComputedStyle(s).color)
  const distinct = new Set(colors).size
  return { preClass: pre.className, spanCount: spans.length, distinct, sample: colors.slice(0, 4) }
}

const probe = async (): Promise<void> => {
  const deadline = Date.now() + 15_000
  let first: ReturnType<typeof readTokens> | null = null
  // 等着色这一 post-pass 真的把 html 换掉：class 里出现 shiki，或已经过 deadline
  for (;;) {
    const r = readTokens()
    if (/shiki/.test(r.preClass) || Date.now() > deadline) { first = r; break }
    await new Promise((res) => setTimeout(res, 120))
  }
  const a = first ?? readTokens()
  // 双主题宣称的直接检验：翻 data-theme，同一批 span 的计算色必须跟着变
  const before = a.sample.join('|')
  const root = document.documentElement
  const had = root.getAttribute('data-theme')
  root.setAttribute('data-theme', had === 'dark' ? 'light' : 'dark')
  await new Promise((res) => setTimeout(res, 150))
  const b = readTokens()
  const out: Readout = {
    done: true,
    reason: a.preClass ? 'ok' : '页面上没有 <pre>——组件没渲染出来',
    preClass: a.preClass,
    spanCount: a.spanCount,
    distinctColors: a.distinct,
    sampleColors: b.sample,
    themeChanged: before !== b.sample.join('|'),
    renders: highlightStats().renders,
  }
  ;(window as unknown as { __hl__: Readout }).__hl__ = out
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MarkdownBlock id={1} source={SOURCE} open={false} />
  </StrictMode>,
)

void probe()
