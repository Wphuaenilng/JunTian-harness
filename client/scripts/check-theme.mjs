#!/usr/bin/env node
/**
 * check-theme.mjs — M2 明暗主题 + 嵌入式帧主题同步，作为门禁而不是记忆。
 *
 * 主题这条线有两个静默失效方式，tsc 与单测都抓不到：
 *   1. `data-theme` 是一次性盖章，不是绑定 —— mode 为 'system' 时若不订阅媒体查询，
 *      OS 切换深色后 CSS、状态文字和已挂载的 MCP 帧都停在旧主题，且没有任何报错；
 *   2. 帧的 theme 推送若只在 mount 时发生（effect 依赖漏了 prop），宿主换了主题而帧不知道。
 * 更隐蔽的是「用 state 存 mode 却希望它驱动 resolved」：同值的 setTheme('system') 被 React
 * 判等跳过渲染，下游什么都收不到 —— 所以 resolved 必须是独立的 state。
 *
 *   node scripts/check-theme.mjs            # 逐条判定
 *   node scripts/check-theme.mjs --quiet    # 只报失败（CI）
 *
 * Kinds: `static` 树内可判定；`delegated` 由点名的另一条门禁判定；`manual` 需要真人或真 OS。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')
const read = (p) => readFileSync(join(clientRoot, p), 'utf8')
const has = (p) => existsSync(join(clientRoot, p))

const results = []
const record = (group, kind, label, ok, note = '') => results.push({ group, kind, label, ok, note })

// ---------------------------------------------------------------- 单一真相：stamp 而不是媒体查询
{
  const tokens = read('packages/ui-theme/src/tokens.css')
  record('真相源', 'static', 'tokens.css 只按 [data-theme] 上色（不引入第二套 prefers-color-scheme 真相）',
    /\[data-theme='dark'\]/.test(tokens) && !/prefers-color-scheme/.test(tokens))
  const indexHtml = read('apps/web/index.html')
  record('真相源', 'static', 'index.html 内联引导脚本读同一个 key 并在首帧前盖章',
    /tianshu\.theme/.test(indexHtml) && /dataset\.theme=/.test(indexHtml))
  const theme = read('packages/ui-theme/src/index.ts')
  // 取函数体本身再判：整段的 `[\s\S]*?` 会一路吃到文件末尾的 BOOT_SCRIPT，
  // 那里合法地含有 matchMedia，于是检查会变成永远为假。
  const resolvedBody = /export function resolvedTheme\(\):[^{]*\{([^}]*)\}/.exec(theme)?.[1] ?? ''
  record('真相源', 'static', 'resolvedTheme 从属性读，而不是重新推导 matchMedia（强制 light/dark 时两者会不一致）',
    /dataset\.theme/.test(resolvedBody) && !/matchMedia/.test(resolvedBody))
}

// ---------------------------------------------------------------- system 模式必须订阅媒体变化
{
  const theme = read('packages/ui-theme/src/index.ts')
  const watch = /export function watchSystemTheme\(/.test(theme)
    && /addEventListener\('change'/.test(theme)
    && /return \(\) => mq\.removeEventListener\('change'/.test(theme)
  record('system 跟随', 'static', 'watchSystemTheme 订阅 change 并返回真正的退订', watch)
  record('system 跟随', 'static', '回调里先重新盖章再把具体值交给调用方', /applyTheme\('system'\)[\s\S]{0,80}onChange\(resolvedTheme\(\)\)/.test(theme))

  const app = read('apps/web/src/App.tsx')
  record('system 跟随', 'static', 'App 在 mode 为 system 时订阅（其余模式不订阅）',
    /if \(theme !== 'system'\) return/.test(app) && /watchSystemTheme\(setResolved\)/.test(app))
  // 这条是本类缺陷的核心：mode 留在 'system' 时同值 setTheme 不会重渲染，resolved 必须是独立 state。
  record('system 跟随', 'static', 'resolved 是独立 state，而不是渲染期现读的函数值',
    /useState<'light' \| 'dark'>\(\(\) => resolvedTheme\(\)\)/.test(app) && !/theme=\{resolvedTheme\(\)\}/.test(app))
  record('system 跟随', 'static', 'AppFrame 收到的是 resolved（换主题才会走到帧的推送 effect）',
    /theme=\{resolved\}/.test(app))
}

// ---------------------------------------------------------------- 帧的推送要跟随 prop，不止 mount
{
  const view = read('packages/ui-primitives/src/app-frame-view.tsx')
  const effects = [...view.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n\s*\}, \[([^\]]*)\]\)/g)]
  const push = effects.find((m) => m[1].includes("kind: 'theme'"))
  record('帧同步', 'static', '存在向帧推送 theme 的 effect', Boolean(push))
  const deps = (push?.[2] ?? '').split(',').map((s) => s.trim())
  for (const need of ['ready', 'nonce', 'theme', 'sessionId']) {
    record('帧同步', 'static', `推送 effect 的依赖含 ${need}（漏了就等于只推一次或推给错的帧）`, deps.includes(need), deps.join('|'))
  }
  const probe = read('apps/web/src/frame-probe.tsx')
  record('帧同步', 'static', 'frame-probe 会主动翻转宿主主题，并把收到的序列报出来',
    /setTheme\(\(t\) => \(t === 'dark' \? 'light' : 'dark'\)\)/.test(probe) && /themeRePushedOnHostChange/.test(probe))
  record('帧同步', 'manual', '浏览器里的实测值（themes 应为 ["dark","light"]）由 frame-probe 页面给出，CI 里跑不动',
    true, 'open http://127.0.0.1:5300/frame-probe.html → window.__probe__.themes')
}

// ---------------------------------------------------------------- 行为判定交给单测
{
  const t = has('packages/ui-theme/test/theme.test.ts') ? read('packages/ui-theme/test/theme.test.ts') : ''
  record('行为', 'delegated', 'watchSystemTheme 的换 stamp / 回调值 / 退订后不再回调由单测判定',
    t.length > 0 && /removeEventListener|stop\(\)/.test(t) && /watchSystemTheme/.test(t), 'packages/ui-theme/test/theme.test.ts')
  record('行为', 'delegated', '浅色 token 的可读性另有一条门禁（当前未接入 CI）',
    has('scripts/check-contrast.mjs'), 'check-contrast.mjs：浅色 9 组文本对不达 AA，属未决项 #29')
}

// ---------------------------------------------------------------- report
const fails = results.filter((r) => !r.ok)
if (!quiet) {
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} [${r.group}][${r.kind}] ${r.label}${r.note ? ` — ${r.note}` : ''}`)
  console.log(`\n静态 ${results.filter((r) => r.kind === 'static').length} 条，委托 ${results.filter((r) => r.kind === 'delegated').length} 条，人工留档 ${results.filter((r) => r.kind === 'manual').length} 条`)
}
if (fails.length > 0) {
  console.error('\nFAILED (主题链路重新漏水):')
  for (const f of fails) console.error(`  ✗ [${f.group}][${f.kind}] ${f.label}${f.note ? ` — ${f.note}` : ''}`)
  process.exit(1)
}
