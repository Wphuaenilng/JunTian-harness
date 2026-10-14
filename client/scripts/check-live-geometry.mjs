#!/usr/bin/env node
/**
 * check-live-geometry.mjs — the tenth gate, and the only one that looks at PIXELS.
 *
 * Why this exists: every other gate reads the *source text* (`check:geometry` compares our CSS
 * against the mockup's CSS), so a value that is written correctly but rendered differently — the
 * exact class of bug that put three columns in the wrong grid tracks — passes. This gate boots an
 * isolated sidecar + serve layer (keyless: nothing here costs an upstream call), loads the built
 * client in a real Chromium (system Edge via playwright-core, 1600×1000 @2x, the mockup's own
 * viewport), and measures what the browser actually computed.
 *
 * The mockup stays the fact source: expectations are parsed out of
 * `analysis-reports/定稿-天枢客户端方案/design/desktop-mockup-dsh-style.html` at run time, never
 * hardcoded here. Anchors we have not mapped yet are listed as unmapped instead of silently
 * dropping out of the table.
 *
 * A second page (`/ctx-probe.html`) measures the 上下文占用 gauge on the same browser: a rendered
 * gauge is two readouts of one number, and only the browser can say whether they still agree.
 *
 *   node scripts/check-live-geometry.mjs            # 全表
 *   node scripts/check-live-geometry.mjs --tol=2     # 允许的像素误差（默认 1）
 *   node scripts/check-live-geometry.mjs --keep       # 跑完不拆，便于人眼看那张 PNG
 *
 * It is deliberately NOT wired into ci-smoke: it still reports the one geometry drift that was
 * ruled out (the 40px self-drawn titlebar), and a red stage in a green pipeline hides that signal.
 * 这段只说它自己的接线状态，不替别的门作保——别的门接没接进 ci-smoke 的事实只住在 `# gates:`
 * 名单里（由 check:docs 逐名对齐）。这里以前写着"和 check:geometry、AA 配色门一样未接"，那句
 * 2026-10-13 查到已过期：AA 门跑绿并接进 ci-smoke 之后，这行注释还在替它作"未接"的假安心。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { bundleFreshness } from './lib-freshness.mjs'
// 同一张声明表 + 同一份 ramp 解析：配对普查要问的是"页面上真的是这两枚叠在一起吗"，
// 与 check-contrast 的"这两枚摆在一起读得清吗"共用一份事实，两边都不许手抄。
import { light, dark, resolveVal, PAIRS } from './lib-contrast.mjs'
import { NON_DARK_ADAPTED_ENTRIES } from './lib-dark-exceptions.mjs'
import { lockCensus } from './lib-instance.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const mockupPath = join(repoRoot, 'analysis-reports', '定稿-天枢客户端方案', 'design', 'desktop-mockup-dsh-style.html')
const workDir = join(clientRoot, '.live-geometry')
const quiet = process.argv.includes('--quiet')
const keep = process.argv.includes('--keep')
const tol = Number((process.argv.find((a) => a.startsWith('--tol=')) ?? '--tol=1').split('=')[1])
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const say = (...a) => { if (!quiet) console.log(...a) }

/** 环境里造几条会话、分别落在哪两个 cwd——分组读数与"组头数"的期望值都从这里来，不另写一遍。 */
const SESSION_NAMES = ['alpha', 'beta']

/** selector → the property we can compare against the drawing. */
const ANCHORS = [
  { name: '左栏宽（图 .frame 第一轨）', mock: ['.frame', 'grid-template-columns', 0], live: { how: 'track', index: 0 } },
  { name: '右栏展开宽（图 .frame 第三轨）', mock: ['.frame', 'grid-template-columns', 2], live: { how: 'track', index: 2 } },
  { name: '项目行高（图 .prow）', mock: ['.prow', 'height'], live: { sel: '.us__proj', prop: 'height' } },
  { name: '会话行（图 .srow）', mock: ['.srow', 'height'], live: { sel: '.us__row', prop: 'height' } },
  { name: '品牌行高（图 .logoRow）', mock: ['.logoRow', 'height'], live: { sel: '.us__brand', prop: 'height' } },
  { name: '窄栏最大宽（图 .conv-col）', mock: ['.conv-col', 'max-width'], live: { sel: '.uc__col', prop: 'maxWidth' } },
  { name: '底部停靠区宽（图 .dock-col）', mock: ['.dock-col', 'max-width'], live: { sel: '.app__composer-col', prop: 'maxWidth' } },
  { name: '状态条高（图 .statusbar）', mock: ['.statusbar', 'height'], live: { sel: '.app__status', prop: 'height' } },
  { name: '用户气泡圆角（图 .ububble）', mock: ['.ububble', 'border-radius'], live: { sel: '.uc__bubble', prop: 'border-radius' } },
  { name: 'composer 圆角（图 .composer 是那张卡片）', mock: ['.composer', 'border-radius'], live: { sel: '.app__input-row textarea', prop: 'border-radius' } },
  { name: '发送钮边长（图 .cm-send）', mock: ['.cm-send', 'width'], live: { sel: '.app__send', prop: 'width' } },
  { name: '自绘标题栏高（图 .titlebar）', mock: ['.titlebar', 'height'], live: { sel: '.app__titlebar', prop: 'height' } },
]

/**
 * "无横向溢出"必须按**看得见**的溢出算。第一版判据是 `scrollWidth > clientWidth`，于是省略号文本
 * （检查点标题 429 vs 148）全被报成溢出——那是 ellipsis 的正常状态、不是缺陷；被 hidden/clip 裁掉的
 * 与本来就能滚的容器同理。真缺陷只在 `overflow-x: visible` 而内容探出盒子时发生。
 */
const OVERFLOW_SCOPES = ['.us', '.app > main', '.app__rail']
// 同一个谓词只有一份：探针页各面（检查点时间轴在另一个页面上量）要用同一条"看得见才算溢出"的尺子，
// 所以把源码做成函数，主页面那三个 scope 只是它的一次调用。
const overflowProbeFor = (scopes) => `(() => {
  const out = {}
  for (const scope of ${JSON.stringify(scopes)}) {
    const root = document.querySelector(scope)
    if (!root) { out[scope] = null; continue }
    const bad = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (getComputedStyle(el).overflowX !== 'visible') continue
      if (el.scrollWidth <= el.clientWidth + 1) continue
      const cls = String(el.className || '').split(' ').filter(Boolean).join('.')
      bad.push(el.tagName.toLowerCase() + (cls ? '.' + cls : ''))
    }
    out[scope] = bad.slice(0, 4)
  }
  return JSON.stringify(out)
})()`
const OVERFLOW_PROBE = overflowProbeFor(OVERFLOW_SCOPES)

/**
 * 「上下文占用」那组仪表是**一个读数、两处呈现**（占比环 + 图例行），而这两处各算各的：
 * 图例一度把 `outputReserve`/`safetyMargin` 也当使用量分解，于是行合计 48% 而环说 42%——同一屏
 * 自相矛盾，纯函数测试查不到（它测的是渲染出来的字符串）。`/ctx-probe.html` 喂的是图上那组数
 * （210k 用于 500k 窗口），所以这里能拿**内核自己的字段**反算期望，再和屏幕上渲染出来的数字对。
 */
const GAUGE_PROBE = `(() => {
  const q = (s) => document.querySelector(s)
  const pct = (s) => { const m = /^(\\d+)%/.exec(s || ''); return m ? Number(m[1]) : 0 }
  const f = window.__ctx__ && window.__ctx__.fixture
  const rows = [...document.querySelectorAll('.ucx__lrow')].map((el) => ({
    name: (el.querySelector('.ucx__lk') || {}).textContent || '',
    value: (el.querySelector('.ucx__lv') || {}).textContent || '',
  }))
  const segs = [...document.querySelectorAll('.ucx__seg')]
  const bar = q('.ucx__bar')
  const ucx = q('.ucx')
  const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null)
  const keyOf = (el) => { const m = /ucx__seg--([a-z]+)/.exec(el.className); return m ? m[1] : '' }
  const colors = segs.map((el) => {
    const k = keyOf(el)
    return { k, seg: bg(el), sw: bg(q('.ucx__sw--' + k)) }
  })
  return JSON.stringify({
    hasFixture: !!f,
    expectRing: f ? Math.round(((f.inputTokens + f.toolTokens + f.reasoningTokens + f.imageTokens) / f.windowTokens) * 100) : null,
    expectReservePct: f ? Math.round(((f.outputReserve + f.safetyMargin) / f.windowTokens) * 100) : null,
    gauge: !!q('.ucx__gauge'),
    ring: pct((q('.ucx__rv') || {}).textContent),
    rows,
    rowSum: rows.reduce((n, r) => n + pct(r.value), 0),
    segCount: segs.length,
    segSum: Number(segs.reduce((n, e) => n + e.getBoundingClientRect().width, 0).toFixed(1)),
    barWidth: bar ? Number(bar.getBoundingClientRect().width.toFixed(1)) : null,
    gap: bar ? (Number.parseFloat(getComputedStyle(bar).columnGap || '0') || 0) : 0,
    colors,
    zeroRows: rows.filter((r) => /^0%\\b/.test(r.value.trim())).length,
    overflow: ucx ? ucx.scrollWidth - ucx.clientWidth : null,
  })
})()`

/**
 * 第二张定稿图（收起态）的细条：44px 里竖排 « 展开钮 + **每组一枚**图标钮，点一枚跳进那一组。
 * 收 → 量条宽/钮数/钮方 → 点「上下文」那枚 → 栏回到展开宽且**那一组真的开着** → 收回原状。
 * 判据读的是行为与盒尺寸，不是 CSS 声明；跨语言用按钮自己的 `aria-label` 对组标题，不写死中文。
 */
const RAIL_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rail = document.querySelector('.app__rail')
  if (!rail) return JSON.stringify({ present: false })
  const width = () => Math.round(rail.getBoundingClientRect().width)
  const secs = () => [...document.querySelectorAll('.tp-sec')].map((s) => ({
    title: (s.querySelector('.tp-sec__t') || { textContent: '' }).textContent.trim(),
    open: s.classList.contains('tp-sec--open'),
  }))
  const closeBtn = () => document.querySelector('.app__panel-head .app__railclose')
  if (!closeBtn()) return JSON.stringify({ present: false, reason: '右栏没开着，收起钮不在 DOM 里' })
  const before = width()
  const secTotal = document.querySelectorAll('.tp-sec').length
  closeBtn().click()
  await sleep(400)
  const stripWidth = width()
  const btns = [...document.querySelectorAll('.app__railbtn')].map((b) => ({
    glyph: b.textContent.trim(),
    label: b.getAttribute('aria-label'),
    title: b.getAttribute('title'),
    box: Math.round(b.getBoundingClientRect().width),
    dot: !!b.querySelector('.app__railmini'),
  }))
  const hasExpand = !!document.querySelector('.app__railexpand')
  const target = btns.findIndex((b) => /上下文|Context/.test(b.label || ''))
  let jump = null
  if (target >= 0) {
    document.querySelectorAll('.app__railbtn')[target].click()
    await sleep(400)
    const found = secs().find((s) => s.title === btns[target].label)
    jump = { label: btns[target].label, width: Math.round(rail.getBoundingClientRect().width), secFound: !!found, secOpen: found ? found.open : null, openCount: secs().filter((s) => s.open).length }
  }
  // 把页面恢复成进来时的样子（栏开着），后面别的读数不受这次点击影响。
  const reopen = document.querySelector('.app__railexpand')
  if (reopen) { reopen.click(); await sleep(300) }
  return JSON.stringify({ present: true, before, secTotal, stripWidth, btnCount: btns.length, btns, hasExpand, jump })
})()`

/**
 * 两级侧栏的**行为**（不只是尺寸）：点组头 → 那一组的行从 DOM 里消失、`aria-expanded` 转 false、
 * caret 真的被 transform 转了向 → 再点回来行数恢复。以前这一格只有台账里一句人工实测记录。
 */
const COLLAPSE_PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rowsNow = () => document.querySelectorAll('.us__group .us__row').length
  const snap = () => {
    const head = document.querySelector('.us__proj')
    if (!head) return null
    const caret = head.querySelector('.us__proj-caret')
    return { rows: rowsNow(), expanded: head.getAttribute('aria-expanded'), caret: caret ? getComputedStyle(caret).transform : null }
  }
  const before = snap()
  if (!before) return JSON.stringify({ present: false })
  document.querySelector('.us__proj').click()
  await sleep(350)
  const after = snap()
  document.querySelector('.us__proj').click()
  await sleep(350)
  const restored = snap()
  return JSON.stringify({ present: true, before, after, restored })
})()`

/**
 * 状态条那串「分类计数」（§4.2 的 `状态条分类计数`）的实测面。用五个类名精确匹配而不是"任意 `x N`"，
 * 因为同一条状态条上还有 `gen 1` / `seq 0` 两个读数——它们形状一样但不是计数。
 * keyless 隔离环境里没人跑过 agent，所以五个类应当全是 0；一旦连接期的 seq=0 元事件又被算进
 * `tally`，这里就会看见 `tool 2 · lifecycle 2`（本轮修掉的那个缺陷的原始症状）。
 */
const STATUS_PROBE = `(() => {
  const bar = document.querySelector('.app__status')
  if (!bar) return JSON.stringify({ present: false })
  const text = bar.textContent || ''
  const found = {}
  for (const m of text.matchAll(/(lifecycle|text|tool|state|custom)\\s+(\\d+)/g)) found[m[1]] = Number(m[2])
  return JSON.stringify({ present: true, found, raw: text.replace(/\\s+/g, ' ').trim().slice(0, 160) })
})()`

function parseMockup(html) {
  const style = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    // The drawing separates its sections with `/* ② 项目行 */` banners. Left in, the comment
    // becomes part of the selector text ("*/ .prow") and every anchored rule after a banner
    // silently disappears from the map — which the report would then blame on the mockup.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules = new Map()
  for (const m of style.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ')
    const decls = {}
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i < 0) continue
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    rules.set(sel, decls)
  }
  return rules
}

/**
 * 探针串是拿到页面里执行的代码：语法坏了要等到 `page.evaluate` 才报，而那时 sidecar 和浏览器都
 * 已经起来了——一次红要等几分钟才拿到一句 SyntaxError。这里只编译不执行（`new Function` 求值的是
 * 外层函数体，里面那个 IIFE 不会被跑），坏语法在启动任何进程之前就把门拦下。
 */
for (const [name, src] of Object.entries({ OVERFLOW_PROBE, GAUGE_PROBE, RAIL_PROBE, COLLAPSE_PROBE, STATUS_PROBE })) {
  try { new Function(`return ${src}`) } catch (e) {
    console.error(`✗ 探针 ${name} 语法坏了：${e.message}`)
    process.exit(1)
  }
}

const px = (v) => {
  if (v === undefined) return NaN
  const m = /(-?[\d.]+)px/.exec(v)
  return m ? Number(m[1]) : NaN
}

async function freePort() {
  const s = createServer()
  // 两个静默失效的洞都在这里：① 没有 `error` 监听器时，`listen` 失败会以**未捕获异常**收场
  //（就是刚结案的"无 ✗ 只有崩溃横幅"那一族）；② 回调不来就永远挂着。两处都上界，并把失败
  // 变成一条可读的抛出——上层 catch 会把它报成红判定，而不是让整门消失。
  const boom = (msg) => { throw new Error(msg) }
  await Promise.race([
    new Promise((r) => s.listen(0, '127.0.0.1', r)),
    new Promise((_, rej) => s.once('error', (e) => rej(new Error(`绑探空闲端口失败：${String((e && e.code) ?? e)}`)))),
    sleep(5_000).then(() => boom('绑探空闲端口 5 秒无响应')),
  ])
  const p = s.address().port
  await Promise.race([new Promise((r) => s.close(r)), sleep(5_000).then(() => boom('释放探针端口 5 秒没关'))])
  return p
}

const node = process.execPath
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let serve = null
let stateDir = ''

async function teardown() {
  if (serve) {
    try {
      execFileSync(resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(serve.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { if (!serve.killed) serve.kill('SIGKILL') }
    await sleep(400)
  }
  if (stateDir) {
    await new Promise((r) => {
      const s = spawn(node, [join(clientRoot, 'scripts', 'launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'], { cwd: clientRoot, stdio: 'ignore' })
      s.once('exit', r)
      setTimeout(r, 8_000)
    })
  }
  if (!keep) { /* dirs stay: they are gitignored and cheap to reuse */ }
}

if (!existsSync(mockupPath)) {
  console.log('SKIP 定稿 mockup 不在这台机器上（analysis-reports 未入库），无法比对 — 不是通过，是没测')
  process.exit(0)
}
const mock = parseMockup(readFileSync(mockupPath, 'utf8'))

const rows = []

/**
 * 产物新鲜度。唯一实现在 `scripts/lib-freshness.mjs`——桌面验法 `verify-desktop.mjs` 用的是同一条，
 * 两扇门各写一份就会各自漂移（今天这个错就出在"改了源码没重打，桌面那三条读的仍是旧包"）。
 */
{
  const f = bundleFreshness(clientRoot)
  rows.push({
    name: '产物不早于源码（本门读的是被伺服的 dist；源码更新而没重打，读数就是上一轮的）',
    want: 'dist 最新 mtime ≥ 源码最新 mtime',
    got: f.distNewest.ms < 0 ? '没有 apps/web/dist' : f.ok
      ? `dist 最新：${f.distNewest.file.slice(clientRoot.length + 1)}`
      : `源码更新：${f.srcNewest.file.slice(clientRoot.length + 1)}`,
    ok: f.ok,
    note: f.ok ? '正控：dist 里确实有东西在被扫' : f.message,
  })
}

/**
 * 起手自查：隔离目录里 `*.lock` 记的那个"锁主 pid"还活着吗。
 * 内核只在锁主已死时回收陈旧锁（`src/server/cron-lock.ts:217` → `if (!isPidAlive(owner.pid)) {`），
 * 而**一次抢锁失败就从此不再重试**（`src/server/cron-lock.ts:223` → `this.state = { status: 'contended', owner }`，
 * 那条分支不启动 health check）——所以上一轮崩在半路留下的游离 sidecar（launcher 用 `detached:true` 起的，
 * 父进程死了它照跑，见 launch-sidecar.mjs:188-190）会把这一整跑的调度写入全闸成 `503 scheduler_not_owner`。
 * 2026-10-13 实测：「后台运行」那一格就是这么变红的，而报错只说"由锁主进程受理"，没人知道锁主是自己上一轮的进程。
 * 这里只读不删不杀：pid 还在跑就把它交回给人收（本仓规矩——按 PID 收，不由门代劳）。
 */
{
  const c = lockCensus(join(workDir, 'store'))
  const live = c.entries.filter((e) => e.state === 'alive')
  rows.push({
    name: '起手自查：隔离目录里的锁没有指向还活着的进程',
    want: '0 把（有就是上一轮崩在半路留下的游离 sidecar 还占着调度器锁，本跑所有调度写入都会被闸住）',
    got: c.probeFailed
      ? `没测到：${c.note || '进程探针本身没跑成'}——锁主死活无从判断，不许读成"没有活的锁主"`
      : c.absent
        ? '隔离目录还不存在（这一跑的头一次启动），目录里不可能有锁'
        : `${c.entries.length} 把锁：${c.entries.map((e) => `${e.file}→pid ${e.pid} ${e.state}`).join(' · ') || '(目录里还没有锁文件)'}`,
    ok: !c.probeFailed && live.length === 0,
    note: live.length > 0
      ? `下一步由你决定：taskkill //PID ${live[0].pid}（本门不杀进程，也不替别人放锁）`
      : '锁主 pid 已死是常态（崩掉的那一轮就是它），那一支由内核在 acquire 时回收；这一行只负责在回收**不会发生**（锁主还活着）时提前说出来',
  })
}

try {
  for (const d of [workDir, join(workDir, 'store'), join(workDir, 'data'), join(workDir, 'ws')]) mkdirSync(d, { recursive: true })
  stateDir = join(workDir, 'data')
  // 1. keyless isolated sidecar: an empty config dir means setup mode, no upstream reachable path.
  const launched = execFileSync(node, [join(clientRoot, 'scripts', 'launch-sidecar.mjs'),
    '--state-dir', stateDir, '--desktop-dir', join(workDir, 'store'), '--config', join(workDir, 'store', 'config.json'), '--isolate-home'],
  { cwd: clientRoot, encoding: 'utf8' })
  say(launched.trim().split('\n').slice(-3).join('\n'))
  const info = JSON.parse(readFileSync(join(stateDir, '.sidecar-info.json'), 'utf8'))
  const H = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }

  // 2. two sessions in two different cwds, so the project level and the rows both have content —
  //    plus one with **no cwd at all**: that third one is what turns the synthetic bucket
  //    (「未指定目录」) from a code path into something a browser can be asked about.
  const cwds = []
  let longTitleId = null
  for (const name of SESSION_NAMES) {
    mkdirSync(join(workDir, 'ws', name), { recursive: true })
    const cwd = join(workDir, 'ws', name).replace(/\\/g, '/')
    cwds.push(cwd)
    const r = await fetch(`http://127.0.0.1:${info.port}/sessions`, {
      method: 'POST', headers: H, body: JSON.stringify({ cwd, approvalMode: 'manual' }),
    })
    if (!r.ok) throw new Error(`POST /sessions → ${r.status}`)
    if (longTitleId === null) longTitleId = (await r.json()).id
  }
  // 一条**长到会截断**的会话名：省略号那条判据以前只在台账里写"人眼看过"，现在它是量出来的。
  {
    const r = await fetch(`http://127.0.0.1:${info.port}/sessions/${longTitleId}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ title: '修复登录页样式回归 · 这条会话名故意写得长到侧栏放不下，用来验证它是省略号而不是把行顶宽' }),
    })
    if (!r.ok) throw new Error(`PATCH /sessions/:id（长标题）→ ${r.status}`)
  }
  {
    const r = await fetch(`http://127.0.0.1:${info.port}/sessions`, {
      method: 'POST', headers: H, body: JSON.stringify({ approvalMode: 'manual' }),
    })
    if (!r.ok) throw new Error(`POST /sessions（不带 cwd）→ ${r.status}`)
  }
  // 一条**真 worktree** 的会话：分支名由内核生成（`rivet/<会话 id>` 这种长名），这样 `.us__branch`
  // 的 74px 上限 + 省略号 + "整行不被顶宽"第一次在真数据里被量到。零花费：只是本地 git 建一个临时仓，
  // 内核的 worktree  machinery 不碰上游。仓库目录名与 worktree 目录名都要进 `cwds`，否则分组那两条
  // 判据会把这个新增的组当成漂移。
  {
    const repo = join(workDir, 'ws', 'wtrepo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'README.md'), 'probe repo\n')
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const hasHead = (() => { try { git(['rev-parse', '-q', '--verify', 'HEAD']); return true } catch { return false } })()
    git(['init', '-q'])
    // 这个探针目录**故意跨次复用**（重建一次 sidecar 库要花钱花时间），所以建仓必须是幂等的：
    // 第二次起 `git commit` 会因为"nothing to commit"退 1，把整道门当成产品缺陷报红。
    if (!hasHead) {
      git(['add', 'README.md'])
      git(['-c', 'user.email=probe@example.invalid', '-c', 'user.name=probe', 'commit', '-q', '-m', 'probe'])
    }
    const r = await fetch(`http://127.0.0.1:${info.port}/sessions`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ cwd: repo.replace(/\\/g, '/'), approvalMode: 'manual', isolatedWorktree: true }),
    })
    if (!r.ok) throw new Error(`POST /sessions（isolatedWorktree）→ ${r.status}`)
    const created = await r.json()
    if (typeof created.cwd === 'string') cwds.push(created.cwd)
  }
  // 「后台运行」那一行以前只有夹具量过（真组件 + 假记录）。内核是**先落记录再去执行**
  // （`src/server/cron-wiring.ts:71-89`），所以一台无 key 实例用 `run-now` 就能当场造出真 job 记录
  // （零上游花费；那个形状已经由 `scripts/accept-tasks.ts` 钉成常驻验收），这里要量的是另一半：
  // 真字段能不能在浏览器里落成读得懂的一行。**期望值全部从这台 sidecar 现读**——`.live-geometry`
  // 目录故意跨次复用，而 `/tasks` 没有删除端点，记录只会往上涨，照"本轮造了几条"去数就是把门自己复利当成漂移。
  const jobProbe = { keyless: false, made: false, why: '', rowsWant: 0, total: 0, mine: [], defIds: [], sessionIds: [] }
  // 调度写入被闸住只有一种值得当场摊开的解释：锁主是谁、还在不在跑（机理见上面起手自查那段注释）。
  // 只有报错真提到 scheduler_not_owner 才附这一段——别把"字段写错被 400"那一类失败也染成锁的故事。
  const lockWhy = (err) => {
    if (typeof err !== 'string' || !err.includes('scheduler_not_owner')) return ''
    const c = lockCensus(join(workDir, 'store'))
    return `｜锁主自查 ${c.entries.map((e) => `${e.file}→pid ${e.pid} ${e.state}`).join(' · ') || '(目录里没有锁文件)'}`
      + (c.probeFailed ? `——但这一条本身没测到：${c.note || '进程探针没跑成'}` : '')
  }
  // 协议里的 `error` 事件在时间线上到底长什么样——台账今天写了「`error` 事件带着可读原文，用户看得见」，
  // 而那句此前只是我在推断：没有任何浏览器读过它。无 key 的 prompt 必定留下一条 `error`（`ci-smoke`
  // 冒烟量的就是这条），所以这个现场零花费。造完**立刻归档**：归档位不在默认列表里，分组/条数那几条
  // 期望值不会被我自己改写（上一轮就是被这条排序咬过一次）。
  const errProbe = { title: '', made: false, why: '', serverError: '', userText: '', id: '' }
  {
    const healthRes = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: H })
    const hb = await healthRes.json().catch(() => ({}))
    jobProbe.keyless = hb.configured === false
    if (!jobProbe.keyless) {
      jobProbe.why = `/health 没报 configured:false（实读 ${JSON.stringify(hb.configured)}）——造记录要发一次 run，这种机器上可能真打上游，所以整段跳过`
    } else {
      const jf = async (method, path, body) => {
        const r = await fetch(`http://127.0.0.1:${info.port}${path}`, {
          method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: r.status, json: await r.json().catch(() => null) }
      }
      const defs = []
      for (const tag of ['甲·取消它', '乙·放着让它自己失败']) {
        const created = await jf('POST', '/schedule', {
          prompt: `像素门现场（${tag}）：定义钉在 2 月 29 日 04:00，永不自动触发，记录只由这一次 run-now 产生`,
          trigger: { type: 'cron', spec: '0 4 29 2 *' },
          allowedTools: [],
        })
        const id = created.json && typeof created.json.id === 'string' ? created.json.id : ''
        if (created.status !== 201 || id === '') {
          jobProbe.why = `POST /schedule → ${created.status} ${JSON.stringify(created.json).slice(0, 140)}${lockWhy(created.json && created.json.error)}`
          break
        }
        defs.push({ id, prompt: created.json.prompt })
      }
      if (defs.length === 2) {
        const fired = []
        for (const d of defs) fired.push(await jf('POST', `/schedule/${encodeURIComponent(d.id)}/run-now`, {}))
        if (!fired.every((f) => f.status === 200 && f.json && f.json.triggered === true)) {
          jobProbe.why = `run-now → ${fired.map((f) => `${f.status} ${JSON.stringify(f.json).slice(0, 60)}`).join(' · ')}${lockWhy(fired.map((f) => JSON.stringify(f.json)).join(' '))}`
        } else {
          const rowsOf = async () => {
            const l = await jf('GET', '/tasks')
            return Array.isArray(l.json?.tasks) ? l.json.tasks : []
          }
          let mine = []
          for (let i = 0; i < 30 && mine.length < 2; i++) {
            await sleep(500)
            const all = await rowsOf()
            mine = all.filter((t) => t.scheduledTaskId === defs[0].id || t.scheduledTaskId === defs[1].id)
          }
          if (mine.length < 2) {
            jobProbe.why = `等了 15s 只造出 ${mine.length}/2 条记录`
          } else {
            // 一条拿来当 cancelled，一条放着看它自己走到 failed——两个终态同屏，徽章与 --ok 那条判据才有对照。
            const toCancel = mine.find((t) => t.scheduledTaskId === defs[0].id)
            const cancelled = await jf('POST', `/tasks/${encodeURIComponent(toCancel.id)}/cancel`, {})
            if (cancelled.status !== 200) jobProbe.why = `cancel → ${cancelled.status} ${JSON.stringify(cancelled.json).slice(0, 80)}`
            let settled = mine.map((t) => t.id)
            for (let i = 0; i < 30; i++) {
              await sleep(500)
              const all = await rowsOf()
              const mineNow = all.filter((t) => settled.includes(t.id))
              if (mineNow.length === settled.length && mineNow.every((t) => t.status !== 'running' && t.status !== 'pending')) break
            }
            const all = await rowsOf()
            const mineNow = all.filter((t) => settled.includes(t.id))
            jobProbe.defIds = defs.map((d) => d.id)
            jobProbe.sessionIds = mineNow.map((t) => t.sessionId).filter((s) => typeof s === 'string' && s.length > 0)
            jobProbe.mine = mineNow.map((t) => ({ id: t.id, prompt: t.prompt, status: t.status, sched: t.scheduledTaskId }))
            jobProbe.total = all.length
            jobProbe.rowsWant = Math.min(50, all.length)
            jobProbe.made = jobProbe.why === ''
          }
        }
      }
    }
  }

  // 协议里的 `error` 事件能不能被看见——先在线上拿到那条原文，再让浏览器去读它。
  if (jobProbe.keyless) {
    const P = `http://127.0.0.1:${info.port}`
    const userText = '像素门现场：这条 prompt 注定失败（这台没有凭据）'
    errProbe.title = `像素门现场·错误可见性 ${Date.now()}`
    const made = await (await fetch(`${P}/sessions`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ cwd: (cwds[0] ?? join(workDir, 'ws')).replace(/\\/g, '/'), approvalMode: 'manual', title: errProbe.title }),
    })).json().catch(() => null)
    const sid = typeof made?.id === 'string' ? made.id : ''
    if (sid === '') {
      errProbe.why = `POST /sessions 没给回 id：${JSON.stringify(made).slice(0, 120)}`
    } else {
      const sent = await fetch(`${P}/sessions/${encodeURIComponent(sid)}/prompt`, {
        method: 'POST', headers: H, body: JSON.stringify({ prompt: userText }),
      })
      if (sent.status !== 200) errProbe.why = `POST /prompt → ${sent.status}（这台本该是 configured:false 的无 key 实例）`
      for (let i = 0; i < 30 && errProbe.serverError === ''; i++) {
        await sleep(700)
        const ev = await (await fetch(`${P}/sessions/${encodeURIComponent(sid)}/events`, { headers: H })).json().catch(() => ({}))
        const list = ev?.events ?? []
        const err = list.find((e) => e.type === 'error')
        const usr = list.find((e) => e.type === 'user')
        if (err) {
          errProbe.serverError = String(err.data?.error ?? '')
          errProbe.userText = String(usr?.data?.text ?? '')
        }
      }
      if (errProbe.serverError === '') errProbe.why = errProbe.why || `等了 21s 没有 error 事件（run 停在 ${JSON.stringify(errProbe.why)}）`
      await fetch(`${P}/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE', headers: H })
      errProbe.made = errProbe.serverError !== ''
      errProbe.id = sid
    }
  }

  // 现场收尾：定义删掉（永不会触发的定义留在调度器里就是垃圾）；两次 run 开出的会话归档，
  // 这样下一次复用同一个探针目录时，分组那几条判据不会把我留下的会话当成产品漂移。
  if (jobProbe.defIds.length > 0 || jobProbe.sessionIds.length > 0) {
    try {
      for (const id of jobProbe.defIds) {
        await fetch(`http://127.0.0.1:${info.port}/schedule/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H })
      }
      for (const sid of jobProbe.sessionIds) {
        await fetch(`http://127.0.0.1:${info.port}/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE', headers: H })
      }
    } catch { /* 收尾失败不改判据：探针目录本来就跨次复用 */ }
  }

  // 分组判据的期望值**从 sidecar 现读**，不是"本轮建了几条"：这个探针库跨次复用（重造 sidecar 库要花时间），
  // 而每次运行都会留下一条新的 worktree 目录（`rivet-wt-<日期>-…` 是唯一的），照"本轮 cwd 数"去数组头
  // 会把工具自己的复用报成产品漂移——这条教训在这道门上已经是第二次了。
  const expect = await (async () => {
    const r = await fetch(`http://127.0.0.1:${info.port}/sessions`, { headers: H })
    if (!r.ok) throw new Error(`GET /sessions → ${r.status}`)
    const recs = ((await r.json()).sessions ?? [])
    const isSynth = (s) => s.workspaceSource === 'scratch' || s.workspaceSource === 'runtime-default'
      || typeof s.cwd !== 'string' || s.cwd.length === 0
    const projects = [...new Set(recs.filter((s) => !isSynth(s)).map((s) => s.cwd))]
    const synthGroups = recs.some(isSynth) ? 1 : 0
    return { rows: recs.length, projects, headers: projects.length + synthGroups, synthGroups }
  })()

  // 3. same-origin serve layer, then the real browser.
  const port = await freePort()
  serve = spawn(node, [join(clientRoot, 'scripts', 'serve-client.mjs'), '--port', String(port), '--state-dir', stateDir],
    { cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let serveLog = ''
  serve.stdout.on('data', (b) => { serveLog += b })
  serve.stderr.on('data', (b) => { serveLog += b })
  for (let i = 0; i < 40 && !/client\s+http/.test(serveLog); i++) await sleep(200)
  if (!/client\s+http/.test(serveLog)) throw new Error(`serve layer never came up:\n${serveLog.slice(-400)}`)

  const pw = await import(pathToFileURL(join(repoRoot, 'node_modules', 'playwright-core', 'index.js')).href)
  const { chromium } = pw.default ?? pw
  if (!existsSync(EDGE)) throw new Error(`no Edge at ${EDGE} — this gate needs a real browser`)
  const browser = await chromium.launch({ executablePath: EDGE, headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForSelector('.us__row', { timeout: 20_000 })
  await page.click('.us__row')
  await page.waitForSelector('.app__input-row textarea', { timeout: 20_000 })
  await sleep(400)

  const shot = join(workDir, 'render-1600.png')
  await page.screenshot({ path: shot })

  const live = await page.evaluate(() => {
    const track = () => getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ')
    const one = (sel, prop) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      const direct = cs[prop] ?? cs.getPropertyValue(prop)
      const boxed = el.getBoundingClientRect()[prop]
      return { computed: direct, rect: typeof boxed === 'number' ? `${Math.round(boxed)}px` : null }
    }
    return {
      tracks: track(),
      proj: one('.us__proj', 'height'),
      row: one('.us__row', 'height'),
      brand: one('.us__brand', 'height'),
      col: one('.uc__col', 'maxWidth'),
      dock: one('.app__composer-col', 'maxWidth'),
      status: one('.app__status', 'height'),
      bubble: one('.uc__bubble', 'border-radius'),
      composer: one('.app__input-row textarea', 'border-radius'),
      titlebar: one('.app__titlebar', 'height'),
      send: one('.app__send', 'width'),
      // 发送钮换成图形钮之后，"它还能不能被认出是什么"就从"文字自带"变成了一件需要单独量的事。
      sendBox: (() => {
        const el = document.querySelector('.app__send')
        if (!el) return null
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          radius: Number.parseFloat(cs.borderTopLeftRadius) || 0,
          glyph: (el.textContent || '').trim(),
          name: el.getAttribute('aria-label') || el.getAttribute('title') || '',
        }
      })(),
      // 居中对称与层级缩进：这两条以前只有"人拿探针量一次"的记录，没有常驻判定。
      // 图上 `.conv-col`/`.dock-col` 都是 `margin: 0 auto`，所以左右留白必须等宽——
      // 轨道放错列（当年三列错位那次）不会让宽度读数变化，但一定让对称破掉。
      center: (() => {
        const sym = (wrapSel, colSel) => {
          const w = document.querySelector(wrapSel), c = document.querySelector(colSel)
          if (!w || !c) return null
          const wr = w.getBoundingClientRect(), cr = c.getBoundingClientRect()
          return { left: Math.round(cr.left - wr.left), right: Math.round(wr.right - cr.right) }
        }
        return { conv: sym('.app > main', '.uc__col'), dock: sym('.app__composer', '.app__composer-col') }
      })(),
      indent: (() => {
        const name = document.querySelector('.us__proj-name')
        const title = document.querySelector('.us__group .us__row .us__title')
        if (!name || !title) return null
        return Math.round(title.getBoundingClientRect().left - name.getBoundingClientRect().left)
      })(),
      ellipsis: (() => {
        const hit = [...document.querySelectorAll('.us__group .us__row .us__title')]
          .find((el) => el.scrollWidth > el.clientWidth + 1)
        if (!hit) return null
        const cs = getComputedStyle(hit)
        const row = hit.closest('.us__row')
        return {
          chars: hit.textContent.length,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
          clipped: cs.overflowX === 'hidden' || cs.overflowX === 'clip',
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
          rowFits: row ? row.scrollWidth <= row.clientWidth + 1 : false,
        }
      })(),
      branch: (() => {
        const all = [...document.querySelectorAll('.us__branch')]
        if (all.length === 0) return null
        const el = all.find((b) => b.scrollWidth > b.clientWidth + 1) ?? all[0]
        const cs = getComputedStyle(el)
        const row = el.closest('.us__row')
        return {
          count: all.length,
          chars: el.textContent.trim().length,
          box: Math.round(el.getBoundingClientRect().width),
          cap: parseFloat(cs.maxWidth) || null,
          textOverflow: cs.textOverflow,
          truncated: el.scrollWidth > el.clientWidth + 1,
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
          rowFits: row ? row.scrollWidth <= row.clientWidth + 1 : false,
        }
      })(),
      grouping: (() => {
        const groups = [...document.querySelectorAll('.us__group')]
        return {
          headers: document.querySelectorAll('.us__proj').length,
          rowsTotal: document.querySelectorAll('.us__row').length,
          rowsInGroups: document.querySelectorAll('.us__group .us__row').length,
          expanded: document.querySelectorAll('.us__proj[aria-expanded="true"]').length,
          // 组头那颗计数胶囊必须等于该组真渲染出来的行数——这是"两级"这件事的可核对面。
          pills: groups.map((g) => ({
            pill: Number((g.querySelector('.us__proj-count') || { textContent: '' }).textContent),
            rows: g.querySelectorAll('.us__row').length,
          })),
          heads: [...document.querySelectorAll('.us__proj')].map((h) => ({
            name: (h.querySelector('.us__proj-name') || { textContent: '' }).textContent,
            title: h.getAttribute('title'),
          })),
        }
      })(),
    }
  })
  // 折叠行为要在量完静态读数之后点，否则上面 `grouping` 读到的就是折叠后的 DOM。
  const collapse = JSON.parse(await page.evaluate(COLLAPSE_PROBE))
  const status = JSON.parse(await page.evaluate(STATUS_PROBE))
  // Measured while the page is still open, and as a string expression (playwright evaluates it in
  // the page), because the helper `evaluate()` is the CDP path used by other gates, not this one.
  const overflowJson = JSON.parse(await page.evaluate(OVERFLOW_PROBE))
  // 收起态细条要放在上面所有读数之后：它会把右栏收起来再点开，早跑会污染别的测量。
  const railProbe = JSON.parse(await page.evaluate(RAIL_PROBE))
  // 渲染面配对普查：**必须在页面还活着的时候抓**（本门的尾部只是把早先取到的数据映射成判定）。
  // 它问的是 check-contrast 答不出的那一半：浏览器实际把哪组「前景 on 底色」叠在了一起、这组配对
  // 在不在手声明的表里。代码块/工具卡/shiki 不在面内——那里的颜色归语法主题，另有三条锚点量过。
  // 两套主题各抓一次：主题链门把暗色当成产品能力宣称，而「页面真的叠了什么」此前只在浅色下问过一遍。
  const censusScanFor = (rootExpr) => `() => {
    const skip = (el) => !!el.closest('pre, code, .shiki, .uc__tool')
    const rgbOf = (s) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(s)
      if (!m) return null
      const p = m[1].split(',').map((x) => parseFloat(x))
      if (p.length >= 4 && p[3] < 0.05) return null
      return p.slice(0, 3).map(Math.round).join(',')
    }
    const effBg = (el) => {
      let n = el
      while (n) {
        const b = /rgba?\\(([^)]+)\\)/.exec(getComputedStyle(n).backgroundColor)
        if (b) {
          const p = b[1].split(',').map((x) => parseFloat(x))
          if (p.length < 4 || p[3] > 0.92) return p.slice(0, 3).map(Math.round).join(',')
        }
        n = n.parentElement
      }
      return '255,255,255'
    }
    const out = {}
    const scope = ${rootExpr}
    if (!scope) return '{}'
    for (const el of scope.querySelectorAll('*')) {
      if (skip(el)) continue
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue
      const fg = rgbOf(getComputedStyle(el).color)
      if (!fg) continue
      const key = fg + '|' + effBg(el)
      if (!out[key]) out[key] = { n: 0, where: String(el.className || el.tagName.toLowerCase()).split(/\\s+/)[0] }
      out[key].n += 1
    }
    return JSON.stringify(out)
  }`
  const CENSUS_SCAN = censusScanFor('document.body')
  const baseLight = JSON.parse(await page.evaluate(`(${CENSUS_SCAN})()`))
  // 翻的是 `documentElement.dataset.theme`——与 hl-probe 验过的是同一根链，翻完立刻还原，免得污染后续读数。
  const themeFlipFor = (scan) => `(() => {
    const root = document.documentElement
    const had = root.dataset.theme
    root.dataset.theme = 'dark'
    try { return (${scan})() } finally { root.dataset.theme = had }
  })()`
  const themeFlip = themeFlipFor(CENSUS_SCAN)
  const baseDark = JSON.parse(await page.evaluate(themeFlip))
  // 第三遍：**选中态**。`--ds-100` 那一族底色只有**被选中的那一行**（`.us__row--sel`）才会画出来，
  // 而夹具里没有任何一行是选中的——于是"近白字压 ds-100"这种配对从来不在普查面上（静态扫 CSS 才发现，
  // 暗色下算出来约 1.05:1）。点一行，两种主题各再抓一次，并到同一个集里，另配一条"真抓到了"的正控。
  const selNote = await page.evaluate(`(() => {
    const row = document.querySelector('.us__row')
    if (!row) return '页面上没有 .us__row，没得点'
    row.click()
    return '已点 .us__row'
  })()`)
  await page.waitForTimeout(300)
  // 点了不等于选中：正控要绑**真的出现 `.us__row--sel`**，不是绑"页面上出现过这族底色"
  // （设置面板那个默认标签用的就是同一枚 `--ds-100`，绑底色会假绿）。
  const selDom = await page.evaluate(`(() => {
    const sel = document.querySelector('.us__row--sel')
    return sel ? '有 ' + sel.className : '没有 .us__row--sel'
  })()`)
  const selLight = JSON.parse(await page.evaluate(`(${CENSUS_SCAN})()`))
  const selDark = JSON.parse(await page.evaluate(themeFlip))
  const mergeCensus = (a, b) => {
    const out = { ...a }
    for (const [k, v] of Object.entries(b)) {
      if (out[k]) out[k] = { ...out[k], n: out[k].n + v.n }
      else out[k] = v
    }
    return out
  }
  // `let` 而不是 `const`：设置面板那一节（第十个探针页）在它自己页面还活着时再抓两遍并进来。
  // 判据不复制——扩的只有采样面。
  let censusLight = mergeCensus(baseLight, selLight)
  let censusDark = mergeCensus(baseDark, selDark)

  // 搜索的两格判据读的是**外部可观察量**（请求数与 URL），不是组件自述：短查询必须根本不出网
  // （sidecar 对 `q=a` 回 400，以前用户看到的是一句「搜索失败」横幅），而无匹配的空态必须把
  // "读的是哪一份库、这次扫了几份"说出来——那句话曾经写反过（说不覆盖会话库）。
  const searchUrls = []
  page.on('request', (r) => { if (r.url().includes('/sessions/search')) searchUrls.push(r.url()) })
  await page.fill('.us__search', 'a')
  await sleep(700)
  const tooShortText = ((await page.textContent('.us__empty')) ?? '').trim()
  const requestsAfterShort = searchUrls.length
  await page.fill('.us__search', 'zzqqxnohit')
  // 等空态**落定**，不是睡固定时长：这个探针库跨次复用、会话越攒越多，搜索回来的时间随之变长，
  // 睡 1200ms 时快时慢——读到「搜索中…」就被判成"文案不对"，那是判据自己的 race，不是产品漂移
  // （本轮连续三次跑里它就红了两次）。等到的文本、等了多久，都进读数。
  const searchPendingText = ((/'session\.searchPending':\s*'([^']+)'/.exec(
    readFileSync(join(clientRoot, 'packages', 'locale', 'src', 'zh.ts'), 'utf8')) ?? [, ''])[1])
  let noMatchText = ''
  const searchWaitT0 = Date.now()
  for (let i = 0; i < 50; i++) {
    noMatchText = ((await page.textContent('.us__empty')) ?? '').trim()
    if (noMatchText !== '' && noMatchText !== searchPendingText) break
    await sleep(200)
  }
  const searchSettled = noMatchText !== '' && noMatchText !== searchPendingText
  const searchWaitMs = Date.now() - searchWaitT0
  await page.fill('.us__search', '')
  await sleep(400)
  const searchProbe = {
    tooShortText,
    noMatchText,
    searchSettled,
    searchWaitMs,
    shortRequests: requestsAfterShort,
    allRequests: searchUrls.length,
    querySent: (searchUrls[0] ?? '').split('q=')[1] ?? '',
  }

  // 同一台同源伺服、同一个浏览器，换开发页 `/ctx-probe.html` 量仪表（内核字段反算的期望 vs 屏上渲染的读数）。
  const gpage = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  await gpage.goto(`http://127.0.0.1:${port}/ctx-probe.html`, { waitUntil: 'load' })
  await gpage.waitForSelector('.ucx__gauge', { timeout: 20_000 })
  const gauge = JSON.parse(await gpage.evaluate(GAUGE_PROBE))
  // 同一页上的排队面：`/queue` 是零花费的（排队本身不发上游），所以"界面上有没有撤回的入口"
  // 不需要等一次真 run 就能量。期望的 laneId 名单来自探针页自己的夹具（__queueProbe__），不写死。
  const retract = JSON.parse(await gpage.evaluate(`(() => {
    const p = window.__queueProbe__
    if (!p) return JSON.stringify({ present: false })
    const panels = [...document.querySelectorAll('.ucx')]
    const of = (needle) => panels.find((el) => (el.textContent || '').includes(needle)) ?? null
    const waiting = of(p.waitingLane)
    const taken = of(p.takenLane)
    const btns = waiting ? [...waiting.querySelectorAll('.ucx__retract')] : []
    p.retracts.length = 0
    if (btns.length === 1) btns[0].click()
    return JSON.stringify({
      present: true,
      panelCount: panels.length,
      waitingFound: waiting !== null,
      takenFound: taken !== null,
      waitingBtns: btns.length,
      takenBtns: taken ? taken.querySelectorAll('.ucx__retract').length : -1,
      takenLines: taken ? taken.querySelectorAll('.ucx__line').length : -1,
      btnText: btns.length === 1 ? (btns[0].textContent || '').trim() : '',
      btnTitle: btns.length === 1 ? btns[0].getAttribute('title') || '' : '',
      btnBox: btns.length === 1 ? Math.round(btns[0].getBoundingClientRect().width) : 0,
      retracts: p.retracts,
      waitingLane: p.waitingLane,
      takenLane: p.takenLane,
    })
  })()`))
  await gpage.close()

  // 第六个开发页 `/hl-probe.html`：§8「高亮 = shiki」在**浏览器里**真的着色了吗。这一格非做不可的理由是
  // MarkdownBlock 用 `.catch(() => setHtml(plain))` 把着色失败咽掉了——语法数据加载不成时屏上是"正确但朴素"
  // 的代码，没有任何异常症状；node 侧单测跑得过只说明 shiki 在 node 里能加载。
  const hpage = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
  await hpage.goto(`http://127.0.0.1:${port}/hl-probe.html`, { waitUntil: 'load' })
  await hpage.waitForFunction('window.__hl__ && window.__hl__.done === true', { timeout: 30_000 }).catch(() => {})
  const hlRaw = await hpage.evaluate('window.__hl__ ? JSON.stringify(window.__hl__) : null')
  await hpage.close()
  if (!hlRaw) {
    rows.push({ name: '代码着色 探针回报', want: 'done', got: 'null', ok: false, note: '30 秒内页面没报出 window.__hl__.done — 没测（不是通过）' })
  } else {
    const h = JSON.parse(hlRaw)
    rows.push({ name: '代码着色 渲染器真跑过（<pre> 的 class 含 shiki）', want: 'class 含 shiki', got: h.preClass || '(页面上没有 <pre>)',
      ok: /shiki/.test(h.preClass), note: `shiki render 调用 ${h.renders} 次 · ${h.reason}` })
    rows.push({ name: '代码着色 token 真的多色（不是整块一个颜色）', want: 'span ≥3 且计算色 ≥2', got: `${h.distinctColors} 种 / ${h.spanCount} 个 span`,
      ok: h.spanCount >= 3 && h.distinctColors >= 2, note: h.sampleColors.join(' · ') })
    rows.push({ name: '代码着色随主题换色（--shiki-light / --shiki-dark 真被 CSS 消费）', want: '翻 data-theme 后计算色变', got: h.themeChanged ? '变了' : '没变',
      ok: h.themeChanged === true, note: '双主题 defaultColor:false 那句设计宣称的直接检验' })
  }

  // 第四个开发页 `/bubble-probe.html`：图上 `.ububble` 是**用户自己那条消息**的气泡，产品页里没有 run
  // 就没有消息可量（这条锚点以前只能报"页面上没有这个元素"）。探针页挂的是真 <ChatStream> + 夹具块，
  // 量的就是产品组件的渲染结果——与仪表那页同一标准。
  const bpage = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
  await bpage.goto(`http://127.0.0.1:${port}/bubble-probe.html`, { waitUntil: 'load' })
  await bpage.waitForSelector('.uc__bubble', { timeout: 20_000 })
  const bubble = JSON.parse(await bpage.evaluate(`(() => {
    const el = document.querySelector('.uc__bubble')
    if (!el) return JSON.stringify({ present: false })
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const row = el.closest('.uc__row')
    const rr = row ? row.getBoundingClientRect() : null
    const other = [...document.querySelectorAll('.uc__row')].find((x) => !String(x.className).includes('uc__row--me'))
    return JSON.stringify({
      present: true,
      radius: cs.borderRadius,
      width: Math.round(r.width),
      rowWidth: rr ? Math.round(rr.width) : null,
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
      justify: row ? getComputedStyle(row).justifyContent : null,
      gapRight: rr ? Math.round(rr.right - r.right) : null,
      gapLeft: rr ? Math.round(r.left - rr.left) : null,
      otherJustify: other ? getComputedStyle(other).justifyContent : null,
      text: (el.textContent || '').slice(0, 10),
    })
  })()`))
  // 同一页的第二半：流式的渲染面。60 个已封口块 + 1 个每帧变长的开块，数 `BlockView` 的函数体真跑了
  // 多少次。<ChatStream> 里的注释宣称 memo() 挡掉了没动的块——那是关于一个整数的宣称，就用整数检验它。
  let stream = null
  try {
    await bpage.waitForFunction(
      () => (document.getElementById('stream-result') === null ? '' : document.getElementById('stream-result').dataset.done) === '1',
      { timeout: 20_000 },
    )
    stream = JSON.parse(await bpage.evaluate(`(() => {
      const d = document.getElementById('stream-result').dataset
      return JSON.stringify({ frames: +d.frames, sealed: +d.sealed, renders: +d.renders, rows: +d.rows })
    })()`))
  } catch {
    stream = null
  }
  await bpage.close()
  if (bubble.present) live.bubble = { computed: bubble.radius, rect: `${bubble.width}px` }

  // 第五个开发页 `/row-probe.html`：真 <SessionList> + 夹具记录，把最坏的一行一次画全——
  // 长标题（会截断）+ 超长分支名（有 74px 上限）+ 待授权徽标（flex:none，挤了就会顶出栏）。
  // 真徽标要有 run（花钱），这一页量的不是"会不会有待授权"，而是**三种读数同时出现时这一行还成不成立**。
  const rpage = await browser.newPage({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 2 })
  await rpage.goto(`http://127.0.0.1:${port}/row-probe.html`, { waitUntil: 'load' })
  await rpage.waitForSelector('.us__badge', { timeout: 20_000 })
  const badgeRow = JSON.parse(await rpage.evaluate(`(() => {
    const badge = document.querySelector('.us__badge')
    if (!badge) return JSON.stringify({ present: false })
    const row = badge.closest('.us__row')
    if (!row) return JSON.stringify({ present: true, row: false })
    const bcs = getComputedStyle(badge)
    const title = row.querySelector('.us__title')
    const branch = row.querySelector('.us__branch')
    const rr = row.getBoundingClientRect(), br = badge.getBoundingClientRect()
    const tcs = title ? getComputedStyle(title) : null
    return JSON.stringify({
      present: true,
      text: (badge.textContent || '').trim(),
      badgeWidth: Math.round(br.width),
      shrink: bcs.flexShrink, grow: bcs.flexGrow,
      insideRow: br.right <= rr.right + 0.5 && br.left >= rr.left - 0.5,
      rowHeight: Math.round(rr.height),
      rowFits: row.scrollWidth <= row.clientWidth + 1,
      rowWidth: Math.round(rr.width),
      titleEllipsis: !!title && title.scrollWidth > title.clientWidth + 1 && tcs ? tcs.textOverflow === 'ellipsis' : false,
      branchBox: branch ? Math.round(branch.getBoundingClientRect().width) : null,
      branchCap: branch ? parseFloat(getComputedStyle(branch).maxWidth) || null : null,
      branchEllipsis: !!branch && branch.scrollWidth > branch.clientWidth + 1,
    })
  })()`))
  // 夹具里那行归档的：以前"取消归档"只有 REST 路由被验过，界面上 0 个调用点。这一页把那行画出来，
  // 门自己点下去看回调收到的是哪一支、带的是哪个 id — 期望值（archivedIds）来自探针页的同一份夹具，不写死个数。
  const archProbe = JSON.parse(await rpage.evaluate(`(() => {
    const p = window.__rowProbe__
    if (!p) return JSON.stringify({ present: false })
    const rowEls = [...document.querySelectorAll('.us__row')]
    const perRow = rowEls.map((r) => r.querySelectorAll('.us__archive').length)
    const all = [...document.querySelectorAll('.us__row .us__archive')]
    const glyph = all.map((b) => (b.textContent || '').trim())
    const undo = all.filter((b, i) => glyph[i] === '↩')
    const cross = all.filter((b, i) => glyph[i] === '✕')
    const other = [...new Set(glyph.filter((g) => g !== '↩' && g !== '✕'))]
    p.clicks.length = 0
    for (const b of undo) b.click()
    const undoClicks = p.clicks.map((c) => c[0] + ':' + c[1])
    p.clicks.length = 0
    for (const b of cross) b.click()
    const crossClicks = p.clicks.map((c) => c[0] + ':' + c[1])
    return JSON.stringify({
      present: true,
      rowCount: rowEls.length,
      perRowMin: perRow.length === 0 ? 0 : Math.min.apply(null, perRow),
      perRowMax: perRow.length === 0 ? 0 : Math.max.apply(null, perRow),
      total: all.length,
      undoCount: undo.length,
      crossCount: cross.length,
      other,
      undoClicks,
      crossClicks,
      undoIds: [...new Set(undoClicks.map((c) => c.split(':')[1]))].sort(),
      archivedIds: [...p.archivedIds].sort(),
      undoTitle: [...new Set(undo.map((b) => b.getAttribute('title')))].join('/'),
      crossTitle: [...new Set(cross.map((b) => b.getAttribute('title')))].join('/'),
    })
  })()`))
  await rpage.close()

  // 同一台伺服上的第三个开发页：`<AppFrame>` 的沙箱判定由页面自己算（`window.__probe__.checks`），
  // 以前只有"人打开这页去读"这一条路——`check:theme` 里它记的是 manual，而它其实机器可测。
  const fpage = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  await fpage.goto(`http://127.0.0.1:${port}/frame-probe.html`, { waitUntil: 'load' })
  let probeJson = null
  for (let i = 0; i < 60 && probeJson === null; i++) {
    probeJson = await fpage.evaluate('window.__probe__ && window.__probe__.done ? JSON.stringify(window.__probe__) : null')
    if (probeJson === null) await sleep(250)
  }
  await fpage.close()
  const probe = probeJson === null ? null : JSON.parse(probeJson)
  if (probe === null) {
    rows.push({ name: '帧沙箱 探针回报', want: 'done', got: 'null', ok: false, note: '15s 内页面没有报出 window.__probe__.done — 没测（不是通过）' })
  } else {
    const evidence = `高度 ${JSON.stringify(probe.heights)} · 主题 ${JSON.stringify(probe.themes)} · 链接 ${JSON.stringify(probe.links)}`
    const keys = Object.keys(probe.checks)
    // 正控：`checks` 空掉时这个循环一条都不产生，门会"全绿"而什么都没判——空回报必须是红的。
    if (keys.length === 0) rows.push({ name: '帧沙箱 探针有判定', want: '>0 条', got: '0 条', ok: false, note: '页面报了 done 却没有 checks 对象' })
    for (const k of keys) {
      rows.push({ name: `帧沙箱 ${k}`, want: 'true', got: String(probe.checks[k]), ok: probe.checks[k] === true, note: probe.checks[k] === true ? '对抗文档自报' : evidence })
    }
    rows.push({ name: '帧沙箱 汇总 pass', want: 'true', got: String(probe.pass), ok: probe.pass === true, note: '页面自己按同一份 checks 算的合取' })
  }
  // §5.2-5 的报警样式此前从未被任何判据**看见**：门禁只能写"要验就得晾着一个真闸不放"，
  // 那说的是一次真 run 的钱，不是渲染的钱。`/stall-probe.html` 用同一份产品组件与 CSS、
  // 只改 `stallAfterMs` 这一个 prop，把"响了"与"没响"并排画出来，再由这四条判定去看。
  const spage = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
  await spage.goto(`http://127.0.0.1:${port}/stall-probe.html`, { waitUntil: 'load' })
  // 面板自己是 1 秒一跳才判超时的，所以这里必须真等过一跳；读不到就红，不许记成通过。
  let stallRaw = null
  for (let i = 0; i < 24 && stallRaw === null; i++) {
    await sleep(250)
    stallRaw = await spage.evaluate(`(() => {
      const col = (id) => {
        const root = document.getElementById(id)
        const card = root ? root.querySelector('.ua__card') : null
        const warn = root ? root.querySelector('.ua__warn') : null
        const box = warn ? warn.getBoundingClientRect() : null
        return {
          cards: root ? root.querySelectorAll('.ua__card').length : -1,
          marked: !!(card && card.classList.contains('ua__card--stalled')),
          text: warn ? (warn.textContent || '').trim() : '',
          visible: !!(warn && box && box.height > 0 && getComputedStyle(warn).display !== 'none'),
          border: card ? getComputedStyle(card).borderColor : '',
          bg: card ? getComputedStyle(card).backgroundColor : '',
        }
      }
      const a = col('probe-stalled'), b = col('probe-quiet')
      return a.cards === 1 && a.text !== '' ? JSON.stringify({ a, b }) : null
    })()`)
  }
  const clauseFail = (clauses) => clauses.filter((c) => !c[1]).map((c) => c[0]).join('、')
  if (stallRaw === null) {
    rows.push({ name: '审批报警 探针回报', want: '两栏都渲染出卡片且响的那栏有文字', got: 'null', ok: false, note: '6s 内没读到读数 —— 没测到（不是通过）' })
  } else {
    const s = JSON.parse(stallRaw)
    const a = s.a
    const b = s.b
    const loud = [['卡片画出来了', a.cards === 1], ['章上带 --stalled', a.marked === true], ['报警元素可见', a.visible === true], ['报警有文字', a.text !== '']]
    rows.push({ name: '审批报警 真的被渲染过（缩短阈值那一侧）', want: '四条子句全真', got: clauseFail(loud) || `「${a.text}」`, ok: clauseFail(loud) === '', note: `边框 ${a.border} · 底 ${a.bg}` })
    const quiet = [['对照组卡片也画出来了', b.cards === 1], ['对照组不被标成超时', b.marked === false], ['对照组没有报警文字', b.text === '']]
    rows.push({ name: '审批报警 对照组（阈值够不到）保持安静', want: '三条子句全真', got: clauseFail(quiet) || '无 .ua__warn', ok: clauseFail(quiet) === '', note: '配对判据：少了它，"永远显示报警"的实现也能把上一行判绿' })
    rows.push({ name: '审批报警 文字来自 locale 且带秒数', want: '含数字', got: a.text, ok: /\d/.test(a.text), note: '读的是 t("approval.stalled") 的输出，不是硬编码串' })
    const differs = a.border !== b.border || a.bg !== b.bg
    rows.push({ name: '审批报警 不止换 class（卡片计算样式真的不同）', want: '边框或底色与对照组不同', got: differs ? `响 ${a.border}/${a.bg} · 静 ${b.border}/${b.bg}` : '两面都与对照组相同', ok: differs, note: 'class 在而样式没落地 = 用户还是看不出来' })
  }
  await spage.close()

  // IME 提交规则（2026-10-13 的真缺陷）：`submitsOnEnter` 的真值表有单测、宿主那一处调用点有
  // `check:layers` 钉着，但两条都是**源码级**的——没人量过"真浏览器 + 真 React 事件路径里，输入法
  // 上屏那一下的 Enter 带不带 `isComposing`、谓词收不收得到"。`/ime-probe.html` 挂一个与 composer
  // 同形状的 controlled textarea（判定走同一个谓词），页面自己把每次按下的 key/shiftKey/isComposing
  // （React 合成事件与原生事件各读一遍）和"这一次有没有发送"记下来。
  // 这一格**不**证明的：真实操作系统输入法产生的事件序列（无人值守造不出那一级），以及真产品页上那个
  // composer（它要一台有会话的实例）。少了这两条锚点，"守卫生效"就只是一句源码里的话。
  const ipage = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
  await ipage.goto(`http://127.0.0.1:${port}/ime-probe.html`, { waitUntil: 'load' })
  await ipage.click('#ime-box')
  const TEXT = '中文写到一半'
  await ipage.keyboard.type(TEXT)
  await ipage.keyboard.press('Enter')          // 真按键：isComposing 必为 false ⇒ 该发送
  await ipage.keyboard.type(TEXT)
  await ipage.keyboard.press('Shift+Enter')    // 真按键：换行 ⇒ 不该发送
  // 合成那一发：输入法上屏候选词时浏览器给的就是这个形状（key='Enter' + isComposing=true）。
  const composed = await ipage.evaluate(`(() => {
    const el = document.getElementById('ime-box')
    if (!el) return null
    el.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    el.dispatchEvent(ev)
    return { defaultPrevented: ev.defaultPrevented, value: el.value }
  })()`)
  let imeRaw = null
  for (let i = 0; i < 24 && imeRaw === null; i++) {
    await sleep(250)
    imeRaw = await ipage.evaluate(`(() => {
      const p = window.__imeProbe__
      const el = document.getElementById('ime-box')
      if (!p || !Array.isArray(p.presses)) return null
      const enters = p.presses.filter((x) => x.key === 'Enter')
      // 最后一发（合成的那一发）落地之后才回报，否则读到的是一条半途的账
      if (enters.length < 3) return null
      return JSON.stringify({ total: p.presses.length, enters, value: el ? el.value : null })
    })()`)
  }
  if (imeRaw === null || composed === null) {
    rows.push({ name: 'IME 探针 页面回报', want: '挂上 textarea 且三次 Enter 都被记录', got: imeRaw === null ? 'null' : '页面上没有 #ime-box', ok: false, note: '没测到（不是通过）——探针页没建出来或 React 事件没进来' })
  } else {
    const s = JSON.parse(imeRaw)
    const [plain, shift, imCommit] = s.enters
    rows.push({ name: 'IME 真按键 Enter 发送（守卫没把正常按键一起挡掉）', want: `sent=true 且按下时缓冲=「${TEXT}」`, got: `sent=${plain?.sent} 缓冲=「${plain?.bufferAtPress}」`, ok: plain?.sent === true && plain?.bufferAtPress === TEXT, note: `合成事件之外，真键盘那发读到的 composing=${plain?.composing}` })
    rows.push({ name: 'IME Shift+Enter 不换行发送（对照：另一条不该发的路径）', want: 'sent=false', got: `sent=${shift?.sent}`, ok: shift?.sent === false, note: '少了这条，"把所有 Enter 都挡掉"的实现也能把上一行与下一行判绿' })
    const flagSeen = imCommit?.nativeComposing === true && imCommit?.composing === null && imCommit?.sent === false
    rows.push({
      name: 'IME 上屏那一发：原生标志可达谓词、判定为不发（而合成事件确实不带这标志）',
      want: 'nativeComposing=true、合成侧读到的=undefined（记为 null）、sent=false',
      got: `原生=${imCommit?.nativeComposing} 合成=${imCommit?.composing === null ? 'undefined→null' : imCommit?.composing} sent=${imCommit?.sent}`,
      ok: flagSeen,
      note: '这一条就是 2026-10-13 那个缺陷的反面，而且它先抓住了修复本身：React 18.3.1 的合成键盘事件不带 isComposing，`submitsOnEnter(e)` 照收不误——守卫必须读 `e.nativeEvent.isComposing`。哪天 React 把标志补上，这条会红，那时再回来改调用形状。',
    })
    // Shift+Enter 会真的往 textarea 里换一个行，所以这里的期望值不是最初那句，而是**那一发按下时**
    // 缓冲里的内容：发送会清空它（第一行那条走的就是这条路），不发送必须原样留着。
    const stillThere = typeof imCommit?.bufferAtPress === 'string' && imCommit.bufferAtPress.length > 0
      && s.value === imCommit.bufferAtPress && composed.value === imCommit.bufferAtPress
    rows.push({ name: 'IME 上屏之后缓冲还在原地（"没发送"是行为而不是记账）', want: '读回的 textarea 等于那一发按下时的缓冲，且非空', got: `按下时=${JSON.stringify(imCommit?.bufferAtPress)} · 派发时=${JSON.stringify(composed.value)} · 现在=${JSON.stringify(s.value)}`, ok: stillThere, note: '发送那发把缓冲清了（第一条），不该发的这两发都留着' })
    rows.push({ name: 'IME 探针 只统计真到达的按键', want: '至少 3 发 Enter', got: `Enter ${s.enters.length} 发 / 全部按键 ${s.total} 次`, ok: s.enters.length >= 3, note: '字符键也走同一个处理器，所以计数里含它们——这条问的是 Enter 那几发都到齐了' })
  }
  await ipage.close()

  // Git 工作台的取数时序（2026-10-13，第九个探针页 `/git-probe.html`：挂**真的** <GitPanel>，
  // 喂一个只实现这几个读方法的桩 client，把调用次数记在 window.__gitProbe__ 上）。
  // 两格都是源码级判据量不到的：
  //  ① `scope` 曾是渲染期新建的对象字面量，进了 reload 的依赖、reload 又进 useEffect 的依赖，
  //     于是"渲染→取数→setState→再渲染"闭成一个环。这里**两次采样数请求**——外部可观察量，
  //     不数锚点也不读源码形状。
  //  ② 连点两个文件时，慢的那个后落地会不会盖掉用户当前选中的那个。stub 让 slow.txt 晚 260ms
  //     回包，点击顺序是"先慢后快"，屏上留下的必须是快的那个。
  const wbpage = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 })
  await wbpage.goto(`http://127.0.0.1:${port}/git-probe.html`, { waitUntil: 'load' })
  const gitCounts = async () => await wbpage.evaluate(`(() => {
    const p = window.__gitProbe__
    return p && p.counts ? JSON.stringify(p.counts) : null
  })()`)
  await sleep(900)
  const gitFirstRaw = await gitCounts()
  await sleep(2200)
  const gitSecondRaw = await gitCounts()
  if (gitFirstRaw === null || gitSecondRaw === null) {
    rows.push({ name: 'Git 面板 探针回报', want: 'window.__gitProbe__.counts 读得到', got: 'null', ok: false, note: '没测到（不是通过）——探针页没建出来或桩没被调到' })
  } else {
    const g1 = JSON.parse(gitFirstRaw)
    const g2 = JSON.parse(gitSecondRaw)
    const grew = (g2.snapshot - g1.snapshot) + (g2.history - g1.history) + (g2.branches - g1.branches)
    rows.push({ name: 'Git 面板 挂载后取数会自己转起来吗', want: '再等 2.2s 之后请求数零增长（render→fetch→setState 环一断就该停）', got: `首采 snapshot=${g1.snapshot} · 2.2s 后又发了 ${grew} 次`, ok: grew === 0, note: `判据读的是请求次数这个外部可观察量（快照 ${g2.snapshot} / 历史 ${g2.history} / 分支 ${g2.branches}），不是"代码里有没有 useMemo"` })
    rows.push({ name: 'Git 面板 取数确实发生过（面不自空）', want: '至少一轮三份读', got: `snapshot=${g2.snapshot} history=${g2.history} branches=${g2.branches}`, ok: g2.snapshot >= 1 && g2.history >= 1 && g2.branches >= 1, note: '少了这条，"整页一个请求都没发"也能把上一行判绿' })
    // 第二格：先点慢的，再点快的；两者都落地之后屏上该留快的那个。
    const btns = await wbpage.$$('.wb__change')
    if (btns.length < 2) {
      rows.push({ name: 'Git 面板 迟到 diff 不盖当前选择', want: '两行改动可点', got: `${btns.length} 行`, ok: false, note: '夹具没画出两行改动，这一格没测到（不是通过）' })
    } else {
      await btns[0].click()   // slow.txt（回包晚 260ms）
      await sleep(30)
      await btns[1].click()   // fast.txt（立刻回包）
      await sleep(900)
      const diffText = String(await wbpage.evaluate(`(() => {
        const el = document.querySelector('.wb__diff')
        return el ? (el.textContent || '') : ''
      })()`) ?? '')
      const chosenRight = diffText.includes('fast.txt') && !diffText.includes('slow.txt')
      rows.push({ name: 'Git 面板 迟到 diff 不盖当前选择', want: '屏上留的是最后点的 fast.txt，不是先点的 slow.txt', got: `diff 区文本含 fast=${diffText.includes('fast.txt')} 含 slow=${diffText.includes('slow.txt')}`, ok: chosenRight, note: '顺序是"先慢后快"，落地顺序与点击顺序相反；盖回去就是用户看到的不是他选中的文件' })
      const paths = await wbpage.evaluate(`(() => JSON.stringify((window.__gitProbe__ && window.__gitProbe__.seenPaths) || []))()`)
      rows.push({ name: 'Git 面板 两次点击都真发出去了（对照：不是只点了一次）', want: 'seenPaths = slow.txt, fast.txt', got: String(paths), ok: paths === '["slow.txt","fast.txt"]', note: '配对判据：少了它，"第二下没点到"也能把上一行判绿' })
    }
  }
  // 检查点时间轴（宿主挂在右栏 `g.id === 'checkpoints'` 那一组，而所有验法都不点它）——本轮才接进浏览器面。
  // 夹具三条的顺序**故意打乱**（index 2 / 3 / 1），于是"最新那一格"必须由组件自己算，而不是数组末尾。
  const ckp = JSON.parse(await wbpage.evaluate(`(() => JSON.stringify({
    items: document.querySelectorAll('#probe-checkpoints .ckp__item').length,
    dots: document.querySelectorAll('#probe-checkpoints .ckp__dot').length,
    titles: [...document.querySelectorAll('#probe-checkpoints .ckp__title')].map((e) => (e.textContent || '').trim()),
    newest: document.querySelectorAll('#probe-checkpoints .ckp__item--newest').length,
    newestMeta: ((document.querySelector('#probe-checkpoints .ckp__item--newest .ckp__meta') || {}).textContent || '').trim(),
    newestIsLast: (() => {
      const all = [...document.querySelectorAll('#probe-checkpoints .ckp__item')]
      return all.length > 0 && all[all.length - 1] === document.querySelector('#probe-checkpoints .ckp__item--newest')
    })(),
  }))()`))
  rows.push({ name: '检查点时间轴 三行都真渲染出来（面不自空）', want: '3 行、3 枚圆点、三条标题都非空（空 content 那条走兜底）', got: `items=${ckp.items} dots=${ckp.dots} titles=[${ckp.titles.map((x) => (x === '' ? '空' : x.slice(0, 8) + '…')).join(' | ')}]`, ok: ckp.items === 3 && ckp.dots === 3 && ckp.titles.length === 3 && ckp.titles.every((x) => x !== ''), note: '这一格补的是覆盖面本身：`ckp*` 这一族 CSS 此前在任何浏览器里都没被渲染过（清点见台账本轮那条）' })
  rows.push({ name: '检查点时间轴 最新那一格由 index 算出来', want: '恰好一格 --newest，且它不是数组末尾、其 meta 含 seq 57', got: `newest=${ckp.newest} meta="${ckp.newestMeta}" 末尾那格=${ckp.newestIsLast}`, ok: ckp.newest === 1 && ckp.newestMeta.includes('57') && ckp.newestIsLast === false, note: '夹具顺序是 2/3/1：若实现把"最后一行"当最新，这一条当场红（配对：`newestIsLast` 必须为 false，否则"永远标末尾"也能蒙过前一半）' })
  // 长标题那一条：省略号是正常状态，**探出盒子**才是缺陷——用的是主页面同一把尺子（一个谓词，一份）。
  const ckpOverflow = JSON.parse(await wbpage.evaluate(overflowProbeFor(['#probe-checkpoints'])))['#probe-checkpoints']
  rows.push({ name: '检查点时间轴 长标题不探出盒子', want: '可见横向溢出 0 个元素', got: ckpOverflow === null ? '页面上没有 #probe-checkpoints' : (ckpOverflow.length === 0 ? '无' : ckpOverflow.join(', ')), ok: Array.isArray(ckpOverflow) && ckpOverflow.length === 0, note: '判据读的是计算样式 `overflowX` + `scrollWidth-clientWidth`，与主页面那三个 scope 同一份实现' })
  // 确认回卷那一串：点回卷 → 出现确认区 → 勾"回滚文件" → 点危险钮 → 真发一次 `api.rewind`。
  const ckpBefore = await wbpage.$eval('#probe-checkpoints', (el) => el.querySelectorAll('.ckp__confirm').length).catch(() => null)
  const rbBtn = await wbpage.$('#probe-checkpoints .ckp__rb')
  if (rbBtn === null || ckpBefore === null) {
    rows.push({ name: '检查点时间轴 回卷按钮在场', want: '每行一枚回卷钮', got: `rb=${rbBtn === null ? 'null' : 'ok'} 容器=${ckpBefore === null ? '读不到' : ckpBefore}`, ok: false, note: '没测到（不是通过）——下面几格不作数' })
  } else {
    try {
      await rbBtn.click({ timeout: 5000 })
      const pend = await wbpage.$$eval('#probe-checkpoints .ckp__item--pending', (els) => els.length)
      const box = await wbpage.$('#probe-checkpoints .ckp__confirm input[type=checkbox]')
      const danger = await wbpage.$('#probe-checkpoints .ckp__btn--danger')
      if (box === null || danger === null) {
        rows.push({ name: '检查点时间轴 点回卷之后出现确认区', want: '复选框与确认钮都在', got: `checkbox=${box === null ? 'null' : 'ok'} danger=${danger === null ? 'null' : 'ok'}`, ok: false, note: 'pending 那一行没长出确认区——交互链断在这里' })
      } else {
        const pendOk = pend === 1
        await box.click({ timeout: 5000 })
        await danger.click({ timeout: 5000 })
        await sleep(500)
        const sent = await wbpage.evaluate(`(() => JSON.stringify((window.__gitProbe__ && window.__gitProbe__.sentRewinds) || []))()`)
        const c = JSON.parse(await wbpage.evaluate(`(() => JSON.stringify(window.__gitProbe__.counts))()`))
        rows.push({ name: '检查点时间轴 确认回卷真的把请求发出去（带勾选态）', want: '恰好一发，且带 files=true', got: String(sent), ok: sent === '["2:files"]' && c.rewinds === 1, note: '配对判据：点第一行（夹具 index 2）与勾"回滚文件"两件事都要真发生，否则"没点成"也能把这一格判绿' })
        rows.push({ name: '检查点时间轴 pending 态只落在被点那一行', want: '恰有一行 .ckp__item--pending', got: `pending=${pend}`, ok: pendOk, note: `回卷完成后面板自己重读一轮（points 读到 ${c.points} 发），但那一格的门是 pending 态的 DOM 证据` })
      }
    } catch (e) {
      rows.push({ name: '检查点时间轴 确认链各步都点下去了', want: '没有一次点击超时', got: String((e && e.message) ? e.message : e).slice(0, 60), ok: false, note: '没测到（不是通过）——一次挂起不许替整条门作保' })
    }
  }
  // 采样面扩到**整页**（判据不复制，只扩面）。上一轮这里只敢取检查点那一棵子树，因为整页采样一跑就
  // 浮出三条不属于当轮授权的红（工作台差异计数压 `--bg-selector` 只有 4.19/4.31、借来的 ✕ 按钮与
  // 原生 `<option>` 读的是 UA 色）。那三条本轮逐一处理掉了，所以这里放开，放开之后必须全绿。
  const ckpLight = JSON.parse(await wbpage.evaluate(`(${CENSUS_SCAN})()`))
  const ckpDark = JSON.parse(await wbpage.evaluate(themeFlip))
  const ckpNew = Object.keys(ckpLight).filter((k) => !(k in censusLight))
  rows.push({ name: '检查点时间轴 往配对普查面上加了读数', want: '浅色与暗色都至少采到一组', got: `本页浅色 ${Object.keys(ckpLight).length} 组（其中此前没有的 ${ckpNew.length} 组）· 暗色 ${Object.keys(ckpDark).length} 组`, ok: Object.keys(ckpLight).length >= 1 && Object.keys(ckpDark).length >= 1, note: '这里**不要求**"必须有新组"：检查点这一族用的色对多半已在表里——要求的是这一面真被采进普查，别把"配色早已评过"读成"这一页没人看过"' })
  censusLight = mergeCensus(censusLight, ckpLight)
  censusDark = mergeCensus(censusDark, ckpDark)
  // 圆点这一格此前只有 CSS 源码侧的一句登记，连它的理由都是**推断**（"暗色下读作实心白点，可见但
  // 风格可议 → 等 #29"，而 #29 早就裁定完了）。面板现在真渲染了，就把能读的读出来：尺寸/描边等图、
  // newest 那格与其余格确实可区分、暗色下填充不等于所在底色（可见性下界——点是 `aria-hidden` 的装饰，
  // 不在文字 AA 射程里，所以判"看得见"而不冒充 AA 判定）。
  const DOT_PROBE = `(() => {
    const trip = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s); return m ? m[1].split(',').slice(0, 3).map((x) => Math.round(parseFloat(x))).join(',') : '' }
    const on = (el) => { let n = el; while (n) { const b = trip(getComputedStyle(n).backgroundColor); if (b && b !== '0,0,0') { const cs = getComputedStyle(n); const a = /rgba\\([^,]+,[^,]+,[^,]+,\\s*([0-9.]+)\\)/.exec(cs.backgroundColor); if (!a || parseFloat(a[1]) > 0.92) return b } n = n.parentElement } return '255,255,255' }
    const one = (el) => { const cs = getComputedStyle(el); return { w: cs.width, h: cs.height, ringW: cs.borderTopWidth, radius: cs.borderTopLeftRadius, fill: trip(cs.backgroundColor), ring: trip(cs.borderTopColor), on: on(el.parentElement) } }
    const nb400 = (() => { const raw = getComputedStyle(document.documentElement).getPropertyValue('--nb-400').trim(); const h = /^#([0-9a-f]{6})$/i.exec(raw); if (!h) return raw; const n = parseInt(h[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',') })()
    const plain = [...document.querySelectorAll('#probe-checkpoints .ckp__item:not(.ckp__item--newest) .ckp__dot')].map(one)
    const newest = document.querySelector('#probe-checkpoints .ckp__item--newest .ckp__dot')
    return JSON.stringify({ plain, newest: newest ? one(newest) : null, nb400 })
  })()`
  const dotsLight = JSON.parse(await wbpage.evaluate(DOT_PROBE))
  const dotsDark = JSON.parse(await wbpage.evaluate(`(() => {
    const root = document.documentElement
    const had = root.dataset.theme
    root.dataset.theme = 'dark'
    try { return ${DOT_PROBE} } finally { root.dataset.theme = had }
  })()`))
  const d0 = dotsLight.plain[0]
  const round = (r) => { const p = parseFloat(r); return String(r).endsWith('%') ? p >= 50 : p >= 3.5 }
  rows.push({ name: '检查点圆点 几何落地（7px 见方、成圆、有环）', want: 'w/h=7px、border-radius 成圆（50% 或 ≥3.5px）、环宽 > 0', got: d0 ? `w=${d0.w} h=${d0.h} radius=${d0.radius} ringW=${d0.ringW}` : '读不到', ok: !!d0 && d0.w === '7px' && d0.h === '7px' && round(d0.radius) && parseFloat(d0.ringW) > 0, note: `图上声明的是 1.5px 描边，**浏览器 computed 给的是 ${d0?.ringW ?? '?'}**（引擎把亚像素边框取整）——"按图声明 1.5px"归 CSS 源码侧那道判定管，这一格只钉渲染层自己拥有的东西：有环、成圆、7px。取整这件事记在这里，不当成缺陷也不当成通过` })
  rows.push({ name: '检查点圆点 描边取自 nb-400（不是硬编码）', want: '两主题的环色都等于该主题 `--nb-400` 的解析值', got: `浅 ${d0?.ring} = ${dotsLight.nb400} ｜ 暗 ${dotsDark.plain[0]?.ring} = ${dotsDark.nb400}`, ok: !!d0 && d0.ring === dotsLight.nb400 && dotsDark.plain[0]?.ring === dotsDark.nb400, note: '**两面取值相同是设计事实，不是漏翻**：`--nb-*` 中性阶在这套系统里不随主题翻转（正因为如此，"中性灰阶用在暗色面上"才需要逐处登记理由）。我第一版把"两面必须不同"写成判据——那是假红，被自己的读数打回' })
  rows.push({ name: '检查点圆点 最新那一格与其余格真可区分', want: 'newest 的填充与描边同色（品牌蓝）且与普通格填充不同', got: dotsLight.newest ? `newest fill=${dotsLight.newest.fill} ring=${dotsLight.newest.ring} · 普通 fill=${d0?.fill}` : '读不到', ok: !!dotsLight.newest && dotsLight.newest.fill !== '' && dotsLight.newest.fill === dotsLight.newest.ring && dotsLight.newest.fill !== d0?.fill, note: '判据读计算值相等/不等，不读"看起来不同"' })
  const darkPlain = dotsDark.plain[0]
  const darkNew = dotsDark.newest
  rows.push({ name: '检查点圆点 暗色下看得见（填充不等于所在底色）', want: '两格都不同底色', got: darkPlain && darkNew ? `普通 ${darkPlain.fill} on ${darkPlain.on} · newest ${darkNew.fill} on ${darkNew.on}` : '读不到', ok: !!darkPlain && !!darkNew && darkPlain.fill !== darkPlain.on && darkNew.fill !== darkNew.on, note: '这是可见性下界，不是 AA 判定：圆点是 `aria-hidden` 的装饰，文字对比度另有普查管' })
  await wbpage.close()

  // 设置面板（2026-10-13，第十个探针页 `/settings-probe.html`）。这一格先补的是一条**覆盖面**事实：
  // 面板由宿主挂上，但要**点「设置」才挂得起来**，所以本门（以及配对普查、暗色跟随）历史上没有一条
  // 判定在它身上跑过——本轮刚给它接上的那道 latest-wins 闸门（`reloadGate`）因此一条浏览器证据都没有。
  // 面板里会重读一轮的是**存密钥**与**设默认提供商**两处（改审批档不重读——第一版探针按"点审批档会
  // 重读"设计，被下面那条配对判据当场打回：approvalReads 只涨 1）。桩让第二发读晚 300ms 且带回旧档名，
  // 页面连着存两次密钥：快那一发先落地、迟的那一发后落地，屏上必须留下快那一发的读数。
  const setpage = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 })
  await setpage.goto(`http://127.0.0.1:${port}/settings-probe.html`, { waitUntil: 'load' })
  await sleep(600)
  const setOnId = async () => String(await setpage.evaluate(`(() => {
    const el = document.querySelector('.set__mode--on .set__mode-id')
    return el ? (el.textContent || '') : ''
  })()`) ?? '')
  const setPresence = await setpage.evaluate(`(() => JSON.stringify({
    blocks: document.querySelectorAll('.set__block').length,
    providers: document.querySelectorAll('.set__prov').length,
    radios: document.querySelectorAll('.set__mode input[type=radio]').length,
    counts: window.__setProbe__ && window.__setProbe__.approvalReads !== undefined
      ? window.__setProbe__ : null,
  }))()`)
  const pres = JSON.parse(setPresence)
  if (pres.counts === null || pres.radios < 4) {
    rows.push({ name: '设置面板 探针页真挂载了', want: '四档审批控件与 window.__setProbe__ 都在', got: `radios=${pres.radios} counts=${pres.counts === null ? 'null' : 'ok'}`, ok: false, note: '没测到（不是通过）——探针页没建出来，后面几格不作数' })
  } else {
    // 在场判据：四份配置都真渲染出来了，否则量到的是一具空壳。
    rows.push({ name: '设置面板 四份配置都渲染出来了（面不自空）', want: '区块 ≥4、提供商行 ≥1、审批档 4 枚', got: `blocks=${pres.blocks} providers=${pres.providers} radios=${pres.radios}`, ok: pres.blocks >= 4 && pres.providers >= 1 && pres.radios === 4, note: '这一格是覆盖面本身：设置面板此前没有任何看浏览器的判定在它身上跑过' })
    // 采样面扩到这一页（**判据不复制**，扩的只有采样面）：两种主题各抓一次，并进 census 那两张表。
    // 边界照旧：`pre / code / .shiki / .uc__tool` 里的颜色归语法主题、另有三条锚点管——所以这一页上
    // 那些 `<code class="set__mode-id">` 的档名不进这张表。别把"没加新组"读成"设置页没被读"。
    const setLight = JSON.parse(await setpage.evaluate(`(${CENSUS_SCAN})()`))
    const setDark = JSON.parse(await setpage.evaluate(themeFlip))
    const newPairs = Object.keys(setLight).filter((k) => !(k in censusLight))
    rows.push({ name: '设置面板 往配对普查面上加了新读数', want: '至少一组此前普查没有的 fg|bg 配对，且暗色那一趟真采到东西', got: `本页浅色 ${Object.keys(setLight).length} 组（其中新 ${newPairs.length} 组）· 暗色 ${Object.keys(setDark).length} 组`, ok: newPairs.length >= 1 && Object.keys(setDark).length >= 1, note: '少了这条，"接进 census 却一个样本都没加"也算扩面成功——扩没扩要用读数判；暗色那一趟顺手确认 flip 在这一页也真落地' })
    censusLight = mergeCensus(censusLight, setLight)
    censusDark = mergeCensus(censusDark, setDark)
    // 密钥槽住在 `<details>` 里，默认是**折起来的**——直接对里面的 input 敲字会撞 30s 的
    // "element is not visible"（第一版就是这么把整条门撞崩的，只跑出 33 条锚点）。先按产品自己的
    // 方式把它展开，再点；点不动就红一条并点名原因，不许让一次挂起替整条门作保。
    await setpage.evaluate('(() => { document.querySelectorAll(".set__key").forEach((d) => { d.open = true }) })()')
    const keyInputs = await setpage.$$('.set__keyform input[type=password]')
    const keyButtons = await setpage.$$('.set__keyform button')
    if (keyInputs.length === 0 || keyButtons.length === 0) {
      rows.push({ name: '设置面板 存密钥那一行可点', want: '至少一枚密钥槽与它的保存钮', got: `inputs=${keyInputs.length} buttons=${keyButtons.length}`, ok: false, note: '没测到（不是通过）——夹具没画出密钥槽，后面两格不作数' })
    } else {
      try {
        await keyInputs[0].type('sk-probe-first', { timeout: 5000 })
        await keyButtons[0].click({ timeout: 5000 })   // 第一发 reload：桩让它晚 300ms 且带回旧档名
        await sleep(40)
        await keyInputs[0].type('sk-probe-second', { timeout: 5000 })
        await keyButtons[0].click({ timeout: 5000 })   // 第二发 reload：快，先落地，读数是 manual
      } catch (e) {
        rows.push({ name: '设置面板 两次存密钥都点下去了', want: '没有一次输入或点击超时', got: String((e && e.message) ? e.message : e).slice(0, 60), ok: false, note: '这一格没测到（不是通过）——展开 details 之后仍然点不动，说明选择器或渲染面变了' })
      }
      await sleep(900)
      await sleep(900)
      const after = await setOnId()
      const late = await setpage.evaluate(`(() => JSON.stringify(window.__setProbe__))()`)
      const c = JSON.parse(late)
      rows.push({ name: '设置面板 迟到的配置读回不盖掉屏上现有的读数', want: '屏上留的是快那一发的 manual', got: after === '' ? '(没有选中态)' : after, ok: after === 'manual', note: '桩让第二发 getApprovalConfig 晚 300ms 并带回 auto-safe；没有 reloadGate 时那一发后落地，屏上自己跳回上一档——用户什么都没做' })
      rows.push({ name: '设置面板 那两轮 reload 确实并发过（对照）', want: 'approvalReads = 3（挂载一发 + 两次存密钥各一发）且 keyWrites = 2', got: `approvalReads=${c.approvalReads} keyWrites=${c.keyWrites}`, ok: c.approvalReads === 3 && c.keyWrites === 2, note: '配对判据：少了它，"第二下没点成"或"根本没有并发"也能把上一行判绿——上一版探针就是被这条打回的（它点的是审批档，那一处根本不重读）' })
    }
  }
  await setpage.close()

  // —— 登记表 × 浏览器 computed 的对齐 ——
  // CSS 侧那条判定只证明"源码里这一处写的是这个 token"；级联里真正生效的可能是另一条规则，
  // 而"登记说用的是 nb-400、屏上其实画的别的东西"这种谎，只有拿 computed 读才拆得穿。
  // 表从共用件来（与 check:nongoals 同一份）；页面清单从 vite 的 input 面派生，不在这抄第二份。
  const rosterKeys = NON_DARK_ADAPTED_ENTRIES.map(([k]) => k)
  const selOf = (k) => k.slice(0, k.lastIndexOf(' '))
  const tokOf = (k) => k.slice(k.lastIndexOf(' ') + 1)
  // 伪类那一族此前被当成"结构上读不到"，其实是**没人去驱动它**：`:focus` 在页面里真 focus 一下就有，
  // `:hover` 让真鼠标移上去就有——而那五条登记的规则改的恰好是 `border-color`（+ 一处 `color`），
  // 全都在七个颜色属性里。所以这一轮把它们请回射程。
  const pseudoKind = (sel) => (/:(focus|hover)$/.exec(sel) ?? [, ''])[1]
  const baseSel = (sel) => sel.replace(/:(focus|hover)$/, '')
  // 期望值从哪来：token 在该主题块里有定义就取那一份，暗色块**根本没有这一名**时退回浅色那一份——
  // 这个退回不是将就，它正是登记表在说的那件事（全表用到的那几名 `--nb-* / --ds-*` 成员在
  // `[data-theme='dark']` 块里一条都没覆写，所以暗色下画的就是浅色那枚；名数由下面的读数打印，不在注释里抄）。
  // 解析不出（两个块都没有这一名 / var 链断）不许再把整道门带崩：那一格进"读不出"名单如实报告。
  const rgbNode = (c) => [c.r, c.g, c.b].map((x) => Math.round(x)).join(',')
  const want = { light: {}, dark: {} }
  const noDarkOverride = new Set()
  const unresolvable = []
  const comparable = []
  for (const k of rosterKeys) {
    const tok = tokOf(k)
    let base
    try {
      if (light[tok] === undefined) throw new Error(`${tok} 不在 :root 块里`)
      base = rgbNode(resolveVal(tok, light))
    } catch (e) { unresolvable.push(`${k} — ${e.message}`); continue }
    want.light[k] = base
    try {
      if (dark[tok] === undefined) { want.dark[k] = base; noDarkOverride.add(tok) }
      else want.dark[k] = rgbNode(resolveVal(tok, dark))
    } catch (e) { unresolvable.push(`${k} — 暗色 ${e.message}`); continue }
    comparable.push(k)
  }
  // 扫描条目：`sel` 是拿去 querySelectorAll 的**基选择器**，`label` 是登记里那一整条（带伪类），
  // 两者分开记才不会把"基规则的读数"和"`:focus` 状态的读数"混成一份。
  const allItems = [...new Set(comparable.map(selOf))].map((sel) => ({
    sel: baseSel(sel), label: sel, focus: pseudoKind(sel) === 'focus', hover: pseudoKind(sel) === 'hover',
  }))
  const sweepItems = allItems.filter((i) => !i.hover)
  const hoverItems = allItems.filter((i) => i.hover)
  // 取样每个选择器最多读 12 个元素，不截在前 3 个：登记说的常常是**基规则**（侧栏那枚状态点的默认灰
  // 只在 idle / aborted 上生效，其余状态各有覆写规则），而一页里同名元素多的是——只看头三个就等于
  // "只看第一组的颜色"，那种读法会把"基规则今天没人画"报成登记表在说谎。
  const rosterSweep = (list) => `(() => {
    const trip = (s) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(s)
      return m ? m[1].split(',').slice(0, 3).map((x) => Math.round(parseFloat(x))).join(',') : ''
    }
    const read7 = (el) => {
      const cs = getComputedStyle(el)
      return [cs.color, cs.backgroundColor, cs.borderTopColor, cs.borderRightColor,
        cs.borderBottomColor, cs.borderLeftColor, cs.outlineColor].map(trip).filter(Boolean).join('|')
    }
    const out = {}
    const push = (label, v) => { out[label] = (out[label] || []).concat([v]) }
    for (const it of ${JSON.stringify(list)}) {
      let els
      try { els = Array.from(document.querySelectorAll(it.sel)) } catch { continue }
      if (els.length === 0) continue
      for (const el of els.slice(0, 12)) {
        if (it.focus) {
          // 同一枚元素**驱动前后各读一次**：前后一样说明 focus 没落到那一行 CSS 上。
          // 那时候"对得上"那条会红，而这多出来的一组读数用来分辨"根本没聚焦"与"聚焦了但画的是别的色"。
          push(it.label + ' (未驱动)', read7(el))
          try { el.focus() } catch (e) {}
          push(it.label, read7(el))
          try { el.blur() } catch (e) {}
        } else {
          push(it.label, read7(el))
        }
      }
    }
    return JSON.stringify(out)
  })()`
  const darkFlipSweep = (list) => `(() => {
    const root = document.documentElement
    const had = root.dataset.theme
    root.dataset.theme = 'dark'
    try { return ${rosterSweep(list)} } finally { root.dataset.theme = had }
  })()`
  const painted = { light: {}, dark: {} }
  const absorb = (theme, got) => {
    for (const [label, vals] of Object.entries(got)) {
      painted[theme][label] = [...new Set([...(painted[theme][label] ?? []), ...vals])]
    }
  }
  // 一页问三趟：基规则 + `:focus`（页面里自己驱动）一趟，暗色翻转再来一趟，`:hover` 那一族要真鼠标。
  const alignPass = async (page) => {
    absorb('light', JSON.parse(await page.evaluate(rosterSweep(sweepItems))))
    absorb('dark', JSON.parse(await page.evaluate(darkFlipSweep(sweepItems))))
    for (const it of hoverItems) {
      const there = await page.evaluate(`(() => document.querySelectorAll(${JSON.stringify(it.sel)}).length)()`)
      if (Number(there) === 0) continue
      // 悬停挂了不许把整道门带崩：读不到就留在"没渲染 / 没读到"那一格如实报。
      try { await page.hover(it.sel, { timeout: 5_000 }) } catch { continue }
      absorb('light', JSON.parse(await page.evaluate(rosterSweep([it]))))
      absorb('dark', JSON.parse(await page.evaluate(darkFlipSweep([it]))))
      await page.mouse.move(4, 4)
    }
  }
  const viteInputs = readFileSync(join(clientRoot, 'apps/web/vite.config.ts'), 'utf8')
  const pages = [...new Set([...viteInputs.matchAll(/'([a-z0-9-]+\.html)'/g)].map((m) => m[1]))]
  const xpage = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  for (const p of pages) {
    await xpage.goto(`http://127.0.0.1:${port}/${p}`, { waitUntil: 'load' })
    await xpage.waitForTimeout(650)
    await alignPass(xpage)
  }
  await xpage.close()
  // 定义列那一族（`.sc__dot`）住在右栏「自动化」小节里，十页 input 没有一个会自己点开它——沿用看板那三条
  // 点击把这一面也纳进同一套扫描。导航失败要红：那条红的意思是"这一格今天没人看过"，不是"实现坏了"。
  // 定义列那一族（`.sc__dot`）与文件面板那一格（`.fl__search:focus`）都不在十页 input 里：前者住在右栏
  // 「自动化」小节，而且**必须真有一条定义**才画得出点（门在前面造的现场那两条，读回记录之后就删了——
  // 留在调度器里就是垃圾），后者要点开 Files 那一格才挂载。所以这一面自带现场：现造一条永不会触发的
  // 定义（2 月 29 日），扫完删掉。导航或造现场失败要红——那条红的意思是"这一格今天没人看过"。
  let boardPassNote = ''
  let replayTry = ''
  {
    const bpage = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    let tempDef = ''
    try {
      const made = await fetch(`http://127.0.0.1:${info.port}/schedule`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ prompt: '对齐扫描面专用定义（钉在 2 月 29 日，永不会触发）', trigger: { type: 'cron', spec: '0 4 29 2 *' }, allowedTools: [] }),
      })
      const mj = await made.json().catch(() => null)
      tempDef = made.status === 201 && mj && typeof mj.id === 'string' ? mj.id : ''
      if (tempDef === '') boardPassNote = `现造定义没成（${made.status} ${JSON.stringify(mj).slice(0, 80)}）`
      await bpage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
      await bpage.waitForSelector('.us__row', { timeout: 20_000 })
      // 「连接态走到 replay」是一瞬，正常网络下 4 条事件的回放不到一帧就完了——所以这一面先把网络降速
      // （CDP 的 latency，不改产品也不改判据），再等那枚点出现；等不到就如实记下"等过、没等到"，
      // 而不是把这一格判成缺陷或当成验过。
      let cdp = null
      try {
        cdp = await bpage.context().newCDPSession(bpage)
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 320, downloadThroughput: -1, uploadThroughput: -1 })
      } catch (e) {
        replayTry = `降速没开成（${String((e && e.message) ? e.message : e).slice(0, 44)}），瞬态照原样去等`
      }
      await bpage.click('.us__row')
      let sawReplay = false
      try { await bpage.waitForSelector('.app__dot--replay', { timeout: 8_000 }); sawReplay = true } catch { /* 没赶上，下面照实说 */ }
      replayTry = sawReplay
        ? '采到了：降速 320ms 下「app__dot--replay」在 8s 内出现，那一遍扫描就是趁它还在时跑的'
        : (replayTry ? replayTry + ' ｜ 8s 内没等到「app__dot--replay」' : '没采到：降速 320ms、等 8s，「app__dot--replay」一次都没进 DOM（连接态没经过 replay 这一档）')
      await alignPass(bpage)
      if (cdp) {
        try { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }) } catch { /* 复位失败不影响后面的面 */ }
      }
      await bpage.waitForSelector('[data-sec="automations"] .tp-sec__head', { timeout: 20_000 })
      await bpage.click('[data-sec="automations"] .tp-sec__head')
      await bpage.waitForSelector('.sc__list .sc__dot', { timeout: 20_000 })
      // Files 那一格：`data-sec` 在**小节根**上（`packages/ui-primitives/src/section.tsx:24`），要点的是里面的
      // `.tp-sec__head` 才会挂载正文（宿主那边是 `mountedGroups.has('files')` 条件渲染，`apps/web/src/App.tsx:548`）——
      // 点小节根等于什么都没点，`.fl__search` 那一族就永远不在 DOM 里。
      const filesHead = await bpage.evaluate(`(() => !!document.querySelector('[data-sec="files"] .tp-sec__head'))()`)
      if (filesHead) {
        await bpage.click('[data-sec="files"] .tp-sec__head')
        await bpage.waitForSelector('.fl__search', { timeout: 15_000 })
      } else {
        boardPassNote = (boardPassNote ? boardPassNote + ' ｜ ' : '') + '右栏没有 files 这个小节头（.fl__search 那一族仍没人看过）'
      }
      await alignPass(bpage)
    } catch (e) {
      boardPassNote = (boardPassNote ? boardPassNote + ' ｜ ' : '') + String((e && e.message) ? e.message : e).slice(0, 120)
    }
    if (tempDef !== '') {
      await fetch(`http://127.0.0.1:${info.port}/schedule/${encodeURIComponent(tempDef)}`, { method: 'DELETE', headers: H }).catch(() => undefined)
    }
    await bpage.close()
  }
  rows.push({ name: '看板 + Files 那一面（定义列与文件搜索框）也进了对齐扫描面', want: '现造一条定义、`.sc__list .sc__dot` 在页上、Files 那格点开、同一套扫描跑过一遍', got: boardPassNote === '' ? '扫过（十页 input 之外的第十一面）' : `没扫成：${boardPassNote}`, ok: boardPassNote === '', note: '这一面自带现场（扫完即删）：门在前面造的调度现场读回记录后就删了定义，定义列于是空的、那几枚点根本不画。少了这一面，定义列与文件搜索框那两族就仍只有静态一眼；这一条不是新的颜色判据，是**扫描面自证**' })
  // 最后这一面是**造出来的流**：真侧栏不会给无 key 会话发 `context_budget`（收起态细条上那枚 mini 因此从不
  // 渲染），也不会把连接停在 replay 那一档。做法是在页面里换掉 fetch：命中流请求就先压两秒——那两秒 phase 是
  // connecting（`packages/client-core/src/session-stream.ts:103`），再交回一条**读了不结束**的流：只吐一帧 state
  // 快照（`session-model.ts:325` 把它按类型写进 snapshots，contextPercentOf 于是有数），既不吐交接帧也不关 body，
  // phase 就停在 replay（session-stream.ts:116 之后那两条改回 live 的路径一条都不发生）。
  let streamNote = ''
  let sawConnecting = false
  let sawReplay = false
  let sawMini = false
  let streamHits = 0
  {
    const frame = `data: ${JSON.stringify({
      seq: 1, type: 'context_budget', ts: Date.now(),
      data: { windowTokens: 500000, inputTokens: 40000, toolTokens: 5000, reasoningTokens: 2000, imageTokens: 0 },
    })}\n\n`
    const spage = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
    await spage.addInitScript(`(() => {
      const orig = window.fetch
      const FRAME = ${JSON.stringify(frame)}
      window.__fabricated = { hits: 0 }
      window.fetch = function (input) {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (!/\\/sessions\\/[^/]+\\/stream/.test(url)) return orig.apply(window, arguments)
        window.__fabricated.hits += 1
        return new Promise((resolve) => {
          setTimeout(() => {
            const enc = new TextEncoder()
            const body = new ReadableStream({
              start(controller) { controller.enqueue(enc.encode(FRAME)) }
            })
            resolve(new Response(body, {
              status: 200,
              headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
            }))
          }, 2000)
        })
      }
    })()`)
    try {
      await spage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
      await spage.waitForSelector('.us__row', { timeout: 20_000 })
      await spage.click('.us__row')
      const READ_DOT = `(() => { const d = document.querySelector('.app__status .app__dot'); return d ? d.className : '' })()`
      // 状态条那枚点的类名**跟着连接阶段变**（`apps/web/src/App.tsx:586` 写的是 `app__dot--${connection}`），
      // 所以登记表里"只在某一阶段存在"的格子必须趁那一阶段扫。这里不写死阶段名：每次采样见到新的
      // `app__dot--*` 类名，就把登记表里以它为基选择器的那几条当场扫一遍（浅色 + 暗色翻面各一趟）。
      const sweptPhase = []
      for (let i = 0; i < 120 && !(sawConnecting && sawReplay); i++) {
        const cls = String(await spage.evaluate(READ_DOT))
        for (const tok of cls.split(/\s+/)) {
          if (!/^app__dot--/.test(tok) || sweptPhase.includes(tok)) continue
          sweptPhase.push(tok)
          const items = sweepItems.filter((it) => it.sel === `.${tok}`)
          if (items.length === 0) continue
          absorb('light', JSON.parse(await spage.evaluate(rosterSweep(items))))
          absorb('dark', JSON.parse(await spage.evaluate(darkFlipSweep(items))))
        }
        if (/connecting/.test(cls)) sawConnecting = true
        if (/replay/.test(cls)) sawReplay = true
        if (sawConnecting && sawReplay) break
        await spage.waitForTimeout(50)
      }
      streamHits = Number(await spage.evaluate(`(() => (window.__fabricated && window.__fabricated.hits) || 0)()`))
      // replay 还压在流上时就扫这一遍：登记表的头一条 `.app__dot--replay` 今天才有 computed 读数可采。
      await alignPass(spage)
      // mini 那枚住在**收起态**的细条里（`apps/web/src/App.tsx:569-580` 的那段 markup 在 `rightOpen === false`
      // 那一支），默认是展开的右栏——所以要点一下收起（面板头那颗 ✕，同文件 :508），否则快照写得再对也读不到它。
      const collapse = await spage.evaluate(`(() => !!document.querySelector('.app__panel-head button'))()`)
      if (collapse) await spage.click('.app__panel-head button')
      for (let i = 0; i < 40 && !sawMini; i++) {
        sawMini = Boolean(await spage.evaluate(`(() => !!document.querySelector('.app__railmini'))()`))
        if (!sawMini) await spage.waitForTimeout(100)
      }
      if (sawMini) await alignPass(spage)
      // 诊断摊开：拦到几次、状态条那一行的读数（`tally.record` 只对 seq>0 记，所以这行能分辨
      // "帧没到"与"帧到了但快照没写成"——两种红的下一步完全不同）
      const statusText = String(await spage.evaluate(`(() => { const s = document.querySelector('.app__status'); return s ? s.textContent : '' })()`)).replace(/\s+/g, ' ').slice(0, 90)
      streamNote = `拦到 ${streamHits} 次流请求 ｜ connecting ${sawConnecting ? '采到' : '没采到'} ｜ replay ${sawReplay ? '采到' : '没采到'} ｜ mini ${sawMini ? '真渲染了' : '没渲染'} ｜ 阶段扫过 ${sweptPhase.join(' ') || '(没扫到任何 app__dot--*)'} ｜ 状态条「${statusText}」`
    } catch (e) {
      streamNote = `这一面没跑成：${String((e && e.message) ? e.message : e).slice(0, 120)}`
    }
    await spage.close()
  }
  rows.push({
    name: '造流那一面：connecting、replay 两档与收起态 mini 点真被浏览器画过',
    want: '压住的窗口里采到 connecting，不结束的流上采到 replay，且 `.app__railmini` 因为那帧快照而真渲染',
    got: streamNote,
    ok: sawConnecting && sawReplay && sawMini,
    note: 'replay 那一档是**读了不结束的响应体**压出来的：session-stream.ts:116 之后只有两条路改回 live——交接帧（:140）或 body 读完（:151-156），这条流两条都不给。上一版用 route.fulfill 压不住，因为 fulfill 本身就是一次性投递（那条路今天仍在覆盖分列里报「回放那一瞬」的旧尝试）',
  })

  const mismatches = []
  const unread = []
  for (const k of comparable) {
    const sel = selOf(k)
    const seenLight = painted.light[sel] ?? []
    const seenDark = painted.dark[sel] ?? []
    if (seenLight.length === 0 && seenDark.length === 0) { unread.push(sel); continue }
    const hit = (vals, wantRgb) => vals.some((v) => v.split('|').includes(wantRgb))
    // 报错要把读到的**前几组**都列出来，不只第一组：基规则那一枚常常排在同名的后面几个元素上，
    // 只打印第一组会让人以为门在说谎，其实是我没把量到的东西摊开。
    const show = (vals) => vals.slice(0, 4).join(' / ')
    if (seenLight.length > 0 && !hit(seenLight, want.light[k])) mismatches.push(`${k}（浅：期望 ${want.light[k]} 不在读到里 ${show(seenLight)}）`)
    if (seenDark.length > 0 && !hit(seenDark, want.dark[k])) mismatches.push(`${k}（暗：期望 ${want.dark[k]} 不在读到里 ${show(seenDark)}）`)
  }
  const read = comparable.length - unread.length
  rows.push({ name: '暗色登记表与浏览器 computed 对得上', want: '读到的每一条，其 token 在该主题的解析值确实出现在元素的颜色属性里', got: mismatches.length > 0 ? mismatches.join(' ; ') : `对上了（读到 ${read}/${comparable.length} 条，其中 ${noDarkOverride.size} 名 token 的暗色期望值就取自浅色块）`, ok: mismatches.length === 0 && read >= 1, note: '读到 0 条就是这条判定空转，所以合取里带了下界。对不上有两种读法：登记表写错了，或级联里生效的根本是另一条规则——后者是 CSS 那侧看不见的话；`:focus`/`:hover` 那两条也有两种（没驱动成 / 驱动成但画的别色），下面那条配对判据专门分这两种' })
  // 配对判据：伪类那一族读到了，不等于鼠标与键盘真去过——"聚焦前后读数一样"就是根本没聚焦，
  // 那种绿是蒙来的。所以每一条在场又该被驱动的 :focus，都必须**前后不同**才算被驱动过。
  const focusKeys = sweepItems.filter((i) => i.focus)
  const setOf = (vals) => JSON.stringify([...new Set(vals)].sort())
  const drove = []
  const sameBeforeAfter = []
  const absentFocus = []
  for (const i of focusKeys) {
    const a = painted.light[i.label] ?? []
    const b = painted.light[`${i.label} (未驱动)`] ?? []
    if (a.length === 0 || b.length === 0) { absentFocus.push(i.label); continue }
    if (setOf(a) === setOf(b)) sameBeforeAfter.push(i.label)
    else drove.push(i.label)
  }
  rows.push({ name: '`:focus` 那一族是被真聚焦驱动的（同一枚元素聚焦前后读数不同）', want: '在场又该驱动的每条都要不同；相同=focus 没落到那行 CSS 上，那种绿是蒙的', got: `${drove.length} 条前后不同${sameBeforeAfter.length ? ' ｜ 前后一样（没驱动成）：' + sameBeforeAfter.join(' ') : ''}${absentFocus.length ? ' ｜ 这一面没这些元素：' + absentFocus.join(' ') : ''}`, ok: sameBeforeAfter.length === 0 && drove.length >= 1, note: '下界同样是 1 条：整族一条都没在场，这条也判红（不许用"表里没 focus"糊过去）。hover 那一族用真鼠标（page.hover 成功才读），它没有"前后"对照，读没读到全看下面那行覆盖分列' })
  rows.push({ name: '暗色登记表的覆盖分列（读到 / 没渲染 / 解析不出）', want: '三段之和等于表的全长', got: `读到 ${read} · 未渲染 ${unread.length}${unread.length ? '（' + [...new Set(unread)].join(' ') + '）' : ''} · 解析不出 ${unresolvable.length}${unresolvable.length ? '（' + unresolvable.join(' ') + '）' : ''}${replayTry ? ` · 回放那一瞬：${replayTry}` : ''}`, ok: read + unread.length + unresolvable.length === rosterKeys.length, note: '报告项，不判"未渲染"是不是缺陷——它说的是"这一格今天只有 CSS 那一眼"，别读成已经验过' })
  // 上面那一行只把"没渲染"**报出来**；报出来不等于有人负责。今天整表都画得到了，就把它升成判据：
  // 以后往表里加一格，必须同时给出"这一格在浏览器里怎么被画出来"的造法，不许再拿"未渲染"当免费挡箭牌。
  rows.push({ name: '暗色登记表的每一格都在浏览器里画过（未渲染必须 0）', want: '未渲染 0 格', got: unread.length === 0 ? `全表 ${rosterKeys.length} 格都有 computed 读数` : `未渲染 ${unread.length} 格：${[...new Set(unread)].join(' ')}`, ok: unread.length === 0, note: '这一格是从报告项升上来的，代价是它从此会咬：登记表的头一条 app__dot--replay 长期只能报"没渲染"，缺的从来不是颜色而是现场——两条造法（收起态那枚要一帧 context_budget 快照、replay 那一档要一条读了不结束的流）现在都跑在门里。往表里加新登记时配套造法要一起加，否则这条红就是它的去处' })
  // 反方向的谎：登记在说"这一处不随暗色走"，而 tokens.css 的暗色块其实覆写了那个 token——
  // 那就是条目本身陈旧（CSS 侧那条判定只扫组件 CSS，从不问 tokens.css，所以它抓不到这一族）。
  const overridden = comparable.filter((k) => dark[tokOf(k)] !== undefined)
  rows.push({ name: '登记的"不跟随"里，没有一条其实会被暗色覆写', want: '0 条', got: overridden.length > 0 ? overridden.map((k) => `${k}（暗色块写的是 ${dark[tokOf(k)]}）`).join(' ; ') : `0 条（比对的 ${comparable.length} 条里，${noDarkOverride.size} 名 token 在暗色块确实没有定义）`, ok: overridden.length === 0 && comparable.length >= 1, note: '变异证据：往 `[data-theme=\'dark\']` 加一条 `--ds-500` 覆写，这一行必须变红（而它同时会让"对得上"那一行的暗色期望值换来源）' })

  // 主题链最后一格此前只能"人去翻一次 Windows 设置看一眼"：mode 为 'system' 时 OS 换了深色，界面跟不跟。
  // 机制在真浏览器里其实量得到——可以改 `prefers-color-scheme`，而**改完不重载页面**，只有 matchMedia 的
  // 监听器真在工作时 `data-theme` 才会跟着变（那个缺陷的原始面貌正是"一次性盖章"）。OS 自己发不发这个事件
  // 不是我们能造的，那一半如实留在人眼名单里。
  const tpage = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
  const READ_THEME = 'JSON.stringify({t: document.documentElement.dataset.theme || "", bg: getComputedStyle(document.body).backgroundColor, mode: localStorage.getItem("tianshu.theme") || "(unset)"})'
  await tpage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  const readTheme = async () => JSON.parse(await tpage.evaluate(READ_THEME))
  const boot = await readTheme()
  // 正控：起手就没有主题章（或 mode 不是 system）时，下面三条全都没有读数，不许报成通过。
  if (boot.t === '' || boot.bg === '') {
    rows.push({ name: '系统深色 起手有章', want: 'data-theme 与 body 底色都读得到', got: `${boot.t || '(无)'} / ${boot.bg || '(无)'}`, ok: false, note: '页面没盖章或样式没落地——后面三条不作数' })
  } else if (boot.mode !== null && boot.mode !== 'system' && boot.mode !== '(unset)') {
    rows.push({ name: '系统深色 起手有章', want: "存的 mode 是 'system'（或没存过，默认走 system）", got: boot.mode, ok: false, note: '这台浏览器里存过显式档，跟随这条没在测的东西上' })
  } else {
    rows.push({ name: '系统深色 起手按 OS 盖章', want: 'light（这台默认浅色）', got: boot.t, ok: boot.t === 'light', note: `底色 ${boot.bg} · 存的 mode ${boot.mode}` })
    await tpage.emulateMedia({ colorScheme: 'dark' })
    let dark = boot
    for (let i = 0; i < 20 && dark.t !== 'dark'; i++) { await sleep(250); dark = await readTheme() }
    rows.push({ name: '系统深色 OS 换深色后**不重载**就跟随', want: 'dark', got: dark.t, ok: dark.t === 'dark', note: '只有 matchMedia 的监听器在工作才会变——这就是那条缺陷的反面' })
    rows.push({ name: '系统深色 翻的不止属性名（底色真变）', want: `与起手不同（起手 ${boot.bg}）`, got: dark.bg, ok: dark.bg !== boot.bg && dark.bg !== '', note: `章 ${boot.t} → ${dark.t}` })
    await tpage.emulateMedia({ colorScheme: 'light' })
    let back = dark
    for (let i = 0; i < 20 && back.t !== 'light'; i++) { await sleep(250); back = await readTheme() }
    // 这条不许单向：监听器坏掉时页面从未离开 light，"回到 light"就成了一句空话。
    // 所以它同时要求**那趟深色确实发生过**（底色真去过另一个值），否则算没测到。
    const wentDark = dark.bg !== boot.bg && dark.bg !== ''
    rows.push({ name: '系统深色 换回浅色也跟随（不许一次性盖章）', want: 'light，且那趟深色确实发生过', got: `${back.t} · 底色 ${back.bg}`, ok: back.t === 'light' && back.bg === boot.bg && wentDark, note: wentDark ? `深色时 ${dark.bg} → 回到 ${back.bg}` : '没测到：页面从未真去过深色，"回到浅色"不作数' })
  }
  await tpage.close()

  // 「后台运行」那一节的真数据渲染。以前这一格只有代码与类型层的保证（台账记在 M2 看板那行），
  // 现在拿上面造出来的两条真记录在同一个浏览器里量：DOM 里到底落了什么，只有浏览器说得出。
  const JPROBE = `() => {
    const sec = document.querySelector('.sc__jobs')
    if (!sec) return JSON.stringify({ present: false })
    const host = sec.getBoundingClientRect()
    const over = []
    const items = Array.from(sec.querySelectorAll('.sc__item'))
    const rows = items.map((li) => {
      const pill = li.querySelector('.sc__pill')
      const prompt = li.querySelector('.sc__prompt')
      const meta = li.querySelector('.sc__meta')
      for (const el of li.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (r.right > host.right + 1.5 || r.left < host.left - 1.5) {
          over.push(String(el.className || el.tagName.toLowerCase()) + ' 右缘 ' + Math.round(r.right) + ' > 容器 ' + Math.round(host.right))
        }
      }
      return {
        status: pill ? pill.textContent.trim() : '',
        cls: pill ? String(pill.className) : '',
        prompt: prompt ? prompt.textContent.trim() : '',
        meta: meta ? meta.textContent.replace(/\\s+/g, ' ').trim() : '',
        h: Math.round(li.getBoundingClientRect().height),
      }
    })
    const head = document.querySelector('.sc__jobhead')
    return JSON.stringify({
      present: true,
      rows,
      over,
      head: head ? head.textContent.trim() : '',
      railW: Math.round((document.querySelector('.sc') || sec).getBoundingClientRect().width),
    })
  }`
  let jobs = { present: false, rows: [], over: [], head: '', railW: 0 }
  let jobsWhy = ''
  try {
    const jpage = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    await jpage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
    await jpage.waitForSelector('.us__row', { timeout: 20_000 })
    await jpage.click('.us__row')
    await jpage.waitForSelector('[data-sec="automations"] .tp-sec__head', { timeout: 20_000 })
    await jpage.click('[data-sec="automations"] .tp-sec__head')
    await jpage.waitForSelector('.sc__jobs', { timeout: 20_000 })
    await sleep(1_200)
    jobs = JSON.parse(await jpage.evaluate(`(${JPROBE})()`))
    await jpage.close()
  } catch (e) {
    jobsWhy = String(e).slice(0, 160)
  }
  {
    // wire 状态集从 client-core 的镜像里派生，不在这里再手抄一份（抄了就是一份会过期的第二事实源）。
    const mirror = readFileSync(join(clientRoot, 'packages', 'client-core', 'src', 'task-types.ts'), 'utf8')
    const wireStatuses = ((/export type TaskStatus = ([^;]+)/.exec(mirror) ?? [, ''])[1].match(/'[a-z_]+'/g) ?? [])
      .map((s) => s.replace(/'/g, ''))
    if (wireStatuses.length < 6) {
      rows.push({ name: '后台运行 状态集能从镜像派生', want: '至少 6 个 wire 值', got: `只派生出 ${wireStatuses.length} 个`, ok: false, note: 'task-types.ts 里 TaskStatus 的形状变了——下面"没被翻译"那条判据不作数' })
    }
    const localeJobs = ['zh', 'en'].map((l) => {
      const src = readFileSync(join(clientRoot, 'packages', 'locale', 'src', `${l}.ts`), 'utf8')
      const m = /'schedule\.jobsTitle':\s*'([^']+)'/.exec(src)
      return m ? m[1] : null
    }).filter((x) => x !== null)
    const mine = jobProbe.mine
    const wantRow = (id) => jobs.rows.find((r) => r.prompt === (mine.find((m) => m.id === id) ?? {}).prompt)
    if (!jobProbe.made) {
      rows.push({
        name: '后台运行 那一行用真 job 记录渲染',
        want: '两条真记录（一条 cancelled、一条 failed）在浏览器里各落一行',
        got: jobsWhy !== '' ? `打开面板就失败：${jobsWhy}` : `没造出现场：${jobProbe.why || '这台不是无 key（configured 不为 false）'}`,
        ok: false,
        note: `这条是**没测到**，不是通过。keyless=${jobProbe.keyless} · 造记录成功=${jobProbe.made}`,
      })
    } else {
      rows.push({
        name: '后台运行 面板真打开、节真存在（不是折叠着蒙过去）',
        want: '.sc__jobs 在 DOM 里读得到',
        got: jobs.present ? `读到 ${jobs.rows.length} 行 · 本节宽 ${jobs.railW}px` : jobsWhy !== '' ? `打开失败：${jobsWhy}` : '页面上没有 .sc__jobs',
        ok: jobs.present === true,
        note: `标题实读「${jobs.head}」；locale 里 schedule.jobsTitle = ${JSON.stringify(localeJobs)}`,
      })
      rows.push({
        name: '后台运行 行数 = 这一页该有的条数（min(50, 服务端条数)，不是本轮造了几条）',
        want: String(jobProbe.rowsWant),
        got: String(jobs.rows.length),
        ok: jobs.present && jobs.rows.length === jobProbe.rowsWant && jobProbe.rowsWant >= 2,
        note: `服务端共 ${jobProbe.total} 条（这个探针目录跨次复用，/tasks 又没有删除端点，条数只会涨）· 面板按 limit=50 要`,
      })
      rows.push({
        name: '后台运行 两条真记录的 prompt 逐字段落进 DOM（不是夹具串）',
        want: mine.map((m) => m.prompt.slice(0, 26) + '…').join(' ｜ '),
        got: mine.map((m) => {
          const r = wantRow(m.id)
          return r ? (r.prompt === m.prompt ? '对得上' : `不符：${r.prompt.slice(0, 30)}`) : 'DOM 里没有这行'
        }).join(' ｜ '),
        ok: mine.length === 2 && mine.every((m) => {
          const r = wantRow(m.id)
          return r !== undefined && r.prompt === m.prompt
        }),
        note: '读的是 GET /tasks 回来的原文与页面上 .sc__prompt 的 textContent 是否逐字相等',
      })
      const statusPairs = mine.map((m) => {
        const r = wantRow(m.id)
        return `${m.id.slice(-8)}：服务端 ${m.status} / 页面 ${r ? r.status || '(空)' : '(无行)'}`
      })
      rows.push({
        name: '后台运行 状态徽章是 wire 原值（DOM 文本 === 服务端文本，且没被翻译）',
        want: mine.map((m) => m.status).join(' + ') + '（原样）',
        got: statusPairs.join(' ｜ '),
        ok: mine.length === 2 && mine.every((m) => {
          const r = wantRow(m.id)
          return r !== undefined && r.status === m.status && wireStatuses.includes(r.status)
        }),
        note: '协议值译成中文会让一条 timed_out 看起来像正常行——所以这条判的是"页面上那串字与服务端那一串完全相同"',
      })
      const greenOnTerminal = jobs.rows.filter((r) => r.cls.indexOf('sc__pill--ok') >= 0 && r.status !== 'running' && r.status !== 'pending')
      rows.push({
        name: '后台运行 「进行中才绿」这条规则在真数据上成立（终态行不许带 --ok）',
        want: '绿点数 = running/pending 行数',
        got: `绿 ${greenOnTerminal.length} 枚贴在终态上 · 本节 ${jobs.rows.length} 行`,
        ok: jobs.present && greenOnTerminal.length === 0,
        note: '少了这条，"永远加 --ok"的实现也能把上一行判绿（配对判据）',
      })
      const metaBad = jobs.rows.filter((r) => r.meta.indexOf('Invalid Date') >= 0)
      const mineMeta = mine.map((m) => wantRow(m.id)).filter((r) => r !== undefined)
      rows.push({
        name: '后台运行 时间读得出来（记录用 ISO 字符串而定义用 epoch 数字——同屏两种格式那条老陷阱）',
        want: '没有 Invalid Date，且每一行都读得到数字',
        got: metaBad.length > 0 ? `${metaBad.length} 行印出 Invalid Date` : (mineMeta.every((r) => /\d/.test(r.meta)) ? `两条 meta：${mineMeta.map((r) => r.meta.slice(0, 60)).join(' ／ ')}` : '有行的 meta 里没有数字'),
        ok: jobs.present && metaBad.length === 0 && mineMeta.length === mine.length && mineMeta.every((r) => /\d/.test(r.meta)),
        note: '这一条第一次拿真记录量：TaskRecord.createdAt 是 ISO 串、ScheduledTask 是 epoch 数，混着读就有一半行显示 Invalid Date',
      })
      const idShort = mineMeta.filter((r) => r.meta.indexOf('sched:') >= 0 && r.meta.indexOf('sess:') >= 0)
      rows.push({
        name: '后台运行 cron 记录带 sched:/sess: 短 id（看板靠它跳回那条会话线程）',
        want: '两条都有两个前缀',
        got: `${idShort.length}/2 条齐 · 实读「${(mineMeta[0] ?? { meta: '' }).meta.slice(0, 70)}」`,
        ok: mine.length === 2 && idShort.length === 2,
        note: 'sessionId 是内核在 runtime 池建会话后回填的（accept-tasks.ts 判据 ⑤），所以这一格量的正是"回填有没有一路走到界面"',
      })
      rows.push({
        name: '后台运行 这一节里没有元素探出容器（右栏 319px 那一族溢出的第 N 次）',
        want: '应无',
        got: jobs.over.length === 0 ? '没有元素探出 .sc__jobs 的盒子' : jobs.over.slice(0, 3).join(' ｜ '),
        ok: jobs.present && jobs.over.length === 0,
        note: '与顶部三条 OVERFLOW_SCOPES 同一族，但那条按"元素探出栏"判，看不到"徽标被顶出行外"这种形状',
      })
    }
  }
  // 「协议里的 `error` 事件 → 时间线上那一条」到底看不看得见。台账今天写了「`error` 事件带着可读原文，
  // 用户看得见」，而那句话在此之前只是推断——没有任何浏览器读过它。上面已经拿真事件把原文取到手，
  // 这里让浏览器去回答同一件事：错误块在不在、正文是不是服务端那串原文、标题走不走 locale、
  // 用户自己那句还在不在、长错误串会不会破版。会话是归档状态，所以顺带把「显示归档」这个开关也量了一次。
  const EPROBE = `() => {
    const host = document.querySelector('.uc__col')
    const hb = host ? host.getBoundingClientRect() : null
    const blocks = Array.from(document.querySelectorAll('.uc__error'))
    const over = []
    for (const el of blocks) {
      const box = el.getBoundingClientRect()
      for (const kid of el.querySelectorAll('*')) {
        const r = kid.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        if (hb && (r.right > hb.right + 1.5 || r.left < hb.left - 1.5)) {
          over.push(String(kid.className || kid.tagName.toLowerCase()) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' vs 栏 ' + Math.round(hb.left) + '..' + Math.round(hb.right))
        }
      }
    }
    const one = (sel) => {
      const el = blocks.length ? blocks[0].querySelector(sel) : null
      return el ? el.textContent.trim() : ''
    }
    return JSON.stringify({
      blocks: blocks.length,
      title: one('.uc__error-title'),
      body: one('.uc__error-body'),
      guide: one('.uc__error-guide'),
      me: Array.from(document.querySelectorAll('.uc__row--me .uc__bubble')).map((b) => b.textContent.trim()),
      over,
    })
  }`
  let errs = { blocks: 0, title: '', body: '', guide: '', me: [], over: [] }
  let errsWhy = ''
  let rowBefore = -1
  let rowAfter = -1
  if (!errProbe.made) {
    rows.push({
      name: '协议 error 事件在时间线里可见（浏览器读数）',
      want: '一条真 error 事件渲染成一个错误块',
      got: `没造出现场：${errProbe.why || '未知原因'}`,
      ok: false,
      note: '这条是**没测到**，不是通过。造现场要发一次 prompt，只在 /health 报 configured:false 的这台机器上做（零上游花费）',
    })
  } else {
    try {
      const epage = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
      await epage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
      await epage.waitForSelector('.us__row', { timeout: 20_000 })
      rowBefore = await epage.locator('.us__row', { hasText: errProbe.title }).count()
      await epage.check('.us__filter input')
      // 勾上开关之后列表要重新取一次会话（`refreshSessions` 是异步的），所以这里等它出现而不是睡固定时长——
      // 上一版睡 600ms，结果 `count()` 读在重绘之前，报成"勾了也找不到"，而真正的 click 却在等待后成功了。
      const row = epage.locator('.us__row', { hasText: errProbe.title }).first()
      try { await row.waitFor({ state: 'visible', timeout: 10_000 }) } catch { /* 交给下面的判定去报 */ }
      rowAfter = await epage.locator('.us__row', { hasText: errProbe.title }).count()
      await row.click()
      await epage.waitForSelector('.uc__error', { timeout: 20_000 }).catch(() => {})
      await sleep(1_200)
      errs = JSON.parse(await epage.evaluate(`(${EPROBE})()`))
      await epage.close()
    } catch (e) {
      errsWhy = String(e).slice(0, 170)
    }
    const localeErr = ['zh', 'en'].map((l) => {
      const src = readFileSync(join(clientRoot, 'packages', 'locale', 'src', `${l}.ts`), 'utf8')
      const m = /'chat\.error':\s*'([^']+)'/.exec(src)
      return m ? m[1] : null
    }).filter((x) => x !== null)
    rows.push({
      name: '协议 error 事件落成一个错误块（不是只有日志里看得见）',
      want: '≥1 块',
      got: errsWhy !== '' ? `打开失败：${errsWhy}` : `${errs.blocks} 块 · 标题「${errs.title}」`,
      ok: errs.blocks >= 1,
      note: '现场是一条真 run：无 key 的 prompt 自己失败并写下 error 事件，零上游花费',
    })
    rows.push({
      name: '错误块正文 == 服务端事件里的原文（界面不自己编一句）',
      want: errProbe.serverError.slice(0, 90),
      got: errs.body.slice(0, 90),
      ok: errs.body !== '' && errs.body === errProbe.serverError,
      note: `逐字比对 GET /sessions/:id/events 里那条 error 的 data.error；附引导语「${errs.guide.slice(0, 60)}」`,
    })
    rows.push({
      name: '错误块标题来自 locale（不是硬编码串）',
      want: localeErr.join(' / '),
      got: errs.title,
      ok: localeErr.includes(errs.title.replace(/^[^·]*·\s*/, '')) || localeErr.some((v) => errs.title.includes(v)),
      note: '标题格式是「errorKind · 本地化标题」，所以去掉前缀后要求本地化那半逐字相等',
    })
    rows.push({
      name: '同一发的用户消息也在时间线里（先看见自己说了什么，再看见为什么失败）',
      want: errProbe.userText.slice(0, 60),
      got: errs.me.join(' ｜ ').slice(0, 90) || '(没有 .uc__row--me)',
      ok: errs.me.some((t) => t === errProbe.userText),
      note: '用户那句走的是 user 事件 → `uc__row--me` 气泡，与 error 块是两条独立路径',
    })
    rows.push({
      name: '长错误串不破会话栏（不横向溢出）',
      want: '应无',
      got: errs.over.length === 0 ? '错误块及其子元素都在栏内' : errs.over.slice(0, 3).join(' ｜ '),
      ok: errs.blocks >= 1 && errs.over.length === 0,
      note: `实读原文长度 ${errProbe.serverError.length} 字符`,
    })
    rows.push({
      name: '归档会话默认不列出，勾了「显示归档」才找得回来',
      want: '勾前 0 行 · 勾后 1 行',
      got: `勾前 ${rowBefore} · 勾后 ${rowAfter}`,
      ok: rowBefore === 0 && rowAfter === 1,
      note: '这条同时是本节的前置：探针会话是归档态，读不到它就说明开关或列表口径有问题（不是产品漂移）',
    })
  }

  await browser.close()

  const LIVE_BY_NAME = {
    '.us__proj': live.proj, '.us__row': live.row, '.us__brand': live.brand, '.uc__col': live.col,
    '.app__composer-col': live.dock,
    '.app__status': live.status, '.uc__bubble': live.bubble, '.app__input-row textarea': live.composer, '.app__titlebar': live.titlebar,
    '.app__send': live.send,
  }

  for (const a of ANCHORS) {
    const [sel, prop, idx] = a.mock
    const decl = mock.get(sel)?.[prop]
    if (decl === undefined) {
      rows.push({ name: a.name, want: null, got: null, ok: false, note: `图上没有 ${sel}{${prop}} — 期望值取不到，没测` })
      continue
    }
    const want = idx !== undefined ? px((decl.split(/\s+/))[idx]) : px(decl)
    // Height/width are compared as the RENDERED BOX (getBoundingClientRect), because that is what
    // a designer measures off the screenshot. getComputedStyle('height') is the content box, which
    // under-reports any padding — comparing that to the mockup's declared height would invent drift.
    const entry = a.live.how === 'track' ? null : LIVE_BY_NAME[a.live.sel]
    const isBox = a.live.how !== 'track' && /^(height|width)$/.test(a.live.prop)
    const gotRaw = a.live.how === 'track'
      ? live.tracks[a.live.index]
      : (isBox ? (entry?.rect ?? entry?.computed) : (entry?.computed ?? entry?.rect))
    const got = px(typeof gotRaw === 'string' ? gotRaw : undefined)
    rows.push({
      name: a.name, want, got,
      ok: Number.isFinite(want) && Number.isFinite(got) && Math.abs(want - got) <= tol,
      note: gotRaw === null || gotRaw === undefined
        ? (/标题栏/.test(a.name)
          ? '页面上没有这个元素 — 2026-10-12 裁定**不做自绘标题栏**（要桌面壳 `frame:false` + 一条窄 preload 走 IPC，特权面改动，与 E4 同一档）。这条红从此是**决定的记录**，不是待修的欠账'
          : '页面上没有这个元素')
        : `${decl} → ${gotRaw}`,
    })
  }
  const sb = live.sendBox
  rows.push({
    name: '发送钮是图形钮且仍叫得出名字（图 .cm-send 34×34 圆）',
    want: '34×34 · 圆角≥半径 · 字形不超过一个字符 · 有可读的可访问名',
    got: sb === null ? '页面上没有 .app__send — 没测（不是通过）'
      : `${sb.w}×${sb.h}px · 圆角 ${sb.radius}px · 内容「${sb.glyph}」· 可访问名「${sb.name}」`,
    ok: sb !== null && sb.w === 34 && sb.h === 34 && sb.radius * 2 >= sb.w
      && [...sb.glyph].length <= 1 && sb.name.trim() !== '',
    note: '换成 34px 圆形图形钮之后，"这是什么按钮"不再由文字自带——所以判据必须同时盯住**形状真的成了圆**（圆角≥半径）与**还能被读出来**（aria-label/title 非空、内容只剩一枚字形）。少掉后半条，图标化就会把可访问名一起图标掉。',
  })
  say(`\n视口 1600×1000 @2x（与定稿图同尺寸），容差 ${tol}px；截图 ${shot}`)
  say('')
  const ov = overflowJson
  for (const scope of OVERFLOW_SCOPES) {
    const list = ov[scope]
    rows.push({
      name: `可见横向溢出 ${scope}`,
      want: '应无',
      got: list === null || list === undefined ? '无该栏' : String(list.length),
      ok: Array.isArray(list) && list.length === 0,
      note: list === null || list === undefined ? '页面上没有这一栏，没测' : list.length === 0 ? '没有元素探出盒子' : list.join(' '),
    })
  }
  rows.push({
    name: '状态条 分类计数全为 0',
    want: '五个类都 0',
    got: status.present === false ? '无状态条' : (Object.entries(status.found).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ') || '全 0'),
    ok: status.present === true && Object.values(status.found).every((v) => v === 0),
    note: `这套环境里没人跑过 agent，任何非零读数都来自连接期 seq=0 元事件（本轮修的那个）；状态条实读「${String(status.raw).slice(0, 90)}」`,
  })

  const sym = (label, pair) => rows.push({
    name: `居中对称 ${label}`,
    want: '左右等宽',
    got: pair === null || pair === undefined ? '无该元素' : `${pair.left} / ${pair.right}`,
    ok: !!pair && Math.abs(pair.left - pair.right) <= 1,
    note: pair === null || pair === undefined ? '页面上没有这一列，没测' : `图上 .${label} 是 margin: 0 auto —— 放错轨道不会改宽度，但一定会破对称`,
  })
  sym('窄栏', live.center.conv)
  sym('停靠区', live.center.dock)
  rows.push({
    name: '层级缩进 会话行文字',
    want: '-8px', got: live.indent === null ? '无组或无行' : `${live.indent}px`,
    ok: live.indent !== null && Math.abs(live.indent + 8) <= 1,
    note: '图上的 −8 层级关系（算式 8+8+16+4=36 对 8+8+20+8=44），量的是**屏上文字左缘之差**，不是 CSS 声明',
  })
  {
    // 省略号不该算横向溢出（那条判据故意排除它），所以"名字长到会截断"这件事单独判一次。
    const e = live.ellipsis
    const firstRowHeight = px(live.row?.rect ?? live.row?.computed)
    rows.push({
      name: '长会话名省略',
      want: '有一行真被截断，且它仍是单行、走省略号、行自己不溢出',
      got: e === null ? '没有任何一行被截断 — 没测到（不是通过）'
        : `${e.chars} 字 · text-overflow=${e.textOverflow} · white-space=${e.whiteSpace} · 裁切=${e.clipped} · 行高 ${e.rowHeight}px（对照 ${firstRowHeight}px）· 行不溢出=${e.rowFits}`,
      ok: e !== null && e.textOverflow === 'ellipsis' && e.whiteSpace === 'nowrap' && e.clipped === true
        && e.rowFits === true && e.rowHeight !== null && Math.abs(e.rowHeight - firstRowHeight) <= 1,
      note: '夹具里 `PATCH /sessions/:id` 给一条会话写了一句长到会截断的名字（零花费，标题是客户端自己写的）。图上 `.srow .t` 是 overflow:hidden + text-overflow:ellipsis + white-space:nowrap；这里读的是**截断真发生在这一行**、行高没变成两行（当年两行 58px 就是这个缺陷的样子）、以及行本身没被顶宽',
    })
  }
  {
    // 分支名是无界的（内核给 isolatedWorktree 生成的名字就带整个会话 id）。这一格以前只在 CSS 注释里
    // 写着"74px 上限"，从没在真数据里量过——现在那条会话是真建出来的，量的是屏上盒宽。
    const b = live.branch
    const firstRowHeight = px(live.row?.rect ?? live.row?.computed)
    rows.push({
      name: '长分支名不顶宽行',
      want: '分支名有上限（74px）、超出走省略号、那一行仍是单行且不溢出',
      got: b === null ? '没有任何一行带分支名 — 没测到（不是通过）'
        : `${b.count} 行带分支 · 最长 ${b.chars} 字 · 盒宽 ${b.box}px（上限 ${b.cap}px）· 截断=${b.truncated} · text-overflow=${b.textOverflow} · 行高 ${b.rowHeight}px（对照 ${firstRowHeight}px）· 行不溢出=${b.rowFits}`,
      ok: b !== null && b.cap !== null && b.box <= b.cap + 1 && b.rowFits === true
        && b.rowHeight !== null && Math.abs(b.rowHeight - firstRowHeight) <= 1
        && (!b.truncated || b.textOverflow === 'ellipsis'),
      note: '夹具用 `isolatedWorktree: true` 让内核真建一个 worktree（本地 git，零上游花费），分支名由内核生成。判据读的是**盒宽对上限**与"整行没被顶宽"，不是 CSS 声明——`max-width` 写了但被 flex 挤开是这类缺陷最常见的样子',
    })
  }
  rows.push({
    name: '两级侧栏 分组渲染',
    want: `${expect.headers} 组（${expect.projects.length} 个项目 + ${expect.synthGroups} 个合成桶）/ ${expect.rows} 行都在组内 / 计数胶囊=组内行数`,
    got: `${live.grouping.headers} 组 / 组外行 ${live.grouping.rowsTotal - live.grouping.rowsInGroups} / 共 ${live.grouping.rowsTotal} 行 / 胶囊 ${live.grouping.pills.map((p) => `${p.pill}vs${p.rows}`).join(' ')}`,
    // 判据是**结构**：组头数对 sidecar 现读的分组数、渲染行数对会话数、每组胶囊对该组真行数。
    // 以前写死"本轮建了几条会话"，被复用库攒下的 worktree 目录报过一次假漂移。
    ok: live.grouping.headers === expect.headers
      && live.grouping.rowsTotal === expect.rows
      && live.grouping.rowsTotal === live.grouping.rowsInGroups
      && live.grouping.expanded === live.grouping.headers
      && live.grouping.pills.length === live.grouping.headers
      && live.grouping.pills.reduce((n, p) => n + p.rows, 0) === expect.rows
      && live.grouping.pills.every((p) => p.pill === p.rows && p.rows > 0),
    note: `期望值现读自 GET /sessions（${expect.rows} 条未归档会话 → ${expect.projects.length} 个不同 cwd + ${expect.synthGroups} 个合成桶）；展开数 ${live.grouping.expanded}`,
  })
  {
    const titled = live.grouping.heads.filter((h) => typeof h.title === 'string' && h.title !== '')
    const untitled = live.grouping.heads.filter((h) => !(typeof h.title === 'string' && h.title !== ''))
    const norm = (p) => String(p).replace(/\\/g, '/')
    const expectedTitles = expect.projects.map(norm)
    const stray = titled.filter((h) => !expectedTitles.includes(norm(h.title))).map((h) => `${h.name}<${norm(h.title)}>`)
    rows.push({
      name: '合成桶与项目 tooltip',
      want: `${expect.projects.length} 组 tooltip=完整路径且名字是末段 / ${expect.synthGroups} 组不带 tooltip`,
      got: `带 ${titled.length} / 不带 ${untitled.length}${stray.length > 0 ? ` · 屏上有而现读没有的：${stray.join(' ; ')}` : ''}`,
      ok: titled.length === expect.projects.length && untitled.length === expect.synthGroups
        && stray.length === 0
        && titled.every((h) => norm(h.title).endsWith('/' + h.name))
        && untitled.every((h) => h.name !== ''),
      note: '没有 cwd 的会话必须挤进一个合成桶而不是各占一个 header；它的 `title=` 应当**不存在**（没有路径可给），有路径的那组 tooltip 必须是完整路径而不是截断名',
    })
  }
  rows.push({
    name: '组头折叠行为',
    want: '行消失→expanded=false→caret 转向→再点恢复',
    got: collapse.present ? `${collapse.after.rows < collapse.before.rows ? '行消失✓' : '行没消失'} / ${collapse.after.expanded === 'false' ? 'expanded=false✓' : `expanded=${collapse.after.expanded}`} / ${collapse.after.caret !== collapse.before.caret ? 'caret 转✓' : 'caret 没变'} / ${collapse.restored.rows === collapse.before.rows && collapse.restored.expanded === 'true' ? '恢复✓' : '没恢复'}` : '无组头',
    ok: collapse.present
      && collapse.after.rows < collapse.before.rows
      && collapse.after.expanded === 'false'
      && collapse.after.caret !== collapse.before.caret
      && collapse.restored.rows === collapse.before.rows
      && collapse.restored.expanded === 'true',
    note: `实测 ${collapse.before.rows} → ${collapse.after.rows} → ${collapse.restored.rows}，caret ${collapse.before.caret} → ${collapse.after.caret}`,
  })
  {
    // 第二张定稿图（收起态）的四条：宽 44、逐组一枚图标钮、钮 36 方、点一枚跳进那一组。
    const collapsedDecl = mock.get('body.details-collapsed .frame')?.['grid-template-columns']
    const wantRail = collapsedDecl === undefined ? null : px(collapsedDecl.split(/\s+/)[2])
    const btnDecl = mock.get('.rail-btn')?.['width']
    const wantBtn = btnDecl === undefined ? null : px(btnDecl)
    const dots = railProbe.present ? railProbe.btns.filter((b) => b.dot).length : 0
    rows.push({
      name: '收起细条宽（图 body.details-collapsed 第三轨）',
      want: wantRail === null ? '图上取不到，没测' : `${wantRail}px`,
      got: railProbe.present ? `${railProbe.stripWidth}px` : railProbe.reason ?? '右栏没开着，没测',
      ok: railProbe.present && wantRail !== null && Math.abs(railProbe.stripWidth - wantRail) <= 1,
      note: `展开 ${railProbe.present ? railProbe.before : '?'}px → 收起 ${railProbe.present ? railProbe.stripWidth : '?'}px；点的是头上的 ✕，读的是盒宽而不是 CSS 声明`,
    })
    rows.push({
      name: '收起细条 逐组图标的钮',
      want: '钮数==展开态的组数 且 >0，« 展开钮在',
      got: railProbe.present ? `${railProbe.btnCount} 钮 / ${railProbe.secTotal} 组 / « ${railProbe.hasExpand ? '在' : '缺'}` : '没测',
      ok: railProbe.present && railProbe.btnCount === railProbe.secTotal && railProbe.btnCount > 0 && railProbe.hasExpand,
      note: '图上这一条给每个折叠组一枚图标（源稿 .d-rail > .rail-btn），收起态也留着"按组跳入"那层 IA；我们以前只有一个整栏展开钮',
    })
    rows.push({
      name: '图标钮方（图 .rail-btn）',
      want: wantBtn === null ? '图上取不到，没测' : `每枚 ${wantBtn}px`,
      got: railProbe.present ? railProbe.btns.map((b) => `${b.glyph}${b.box}`).join(' ') : '没测',
      ok: railProbe.present && wantBtn !== null && railProbe.btns.length > 0 && railProbe.btns.every((b) => Math.abs(b.box - wantBtn) <= 1),
      note: '六枚逐枚量，任何一枚尺寸漂了就红（token 走 --scale-rail-btn，check:scale 已经把它对回源稿）',
    })
    rows.push({
      name: '点图标跳进那一组',
      want: '栏回到展开宽 且 那一组真的开着',
      got: railProbe.jump
        ? `${railProbe.jump.width}px / ${railProbe.jump.secFound ? (railProbe.jump.secOpen ? '开着' : '没开') : '找不到那一组'} / 共开 ${railProbe.jump.openCount}`
        : '没找到上下文那枚钮',
      ok: !!railProbe.jump && railProbe.jump.secFound === true && railProbe.jump.secOpen === true
        && Math.abs(railProbe.jump.width - railProbe.before) <= 1,
      note: `钮的 aria-label 与组标题逐字对上才算（中英文都成立）。角点数 ${dots}：只有本机真握得住那一组读数时才画——这套无 key 环境不产 context_budget，所以是 0，而不是凭空点一颗`,
    })
  }

  {
    // 侧栏搜索的两格：短查询根本不出网；无匹配时把"读了哪份库、扫了几份"说出来。
    const shortOk = searchProbe.shortRequests === 0 && /至少[要得]{0,2}\s*2|at least 2/i.test(searchProbe.tooShortText)
    const noHitOk = searchProbe.searchSettled
      && searchProbe.allRequests === 1
      && searchProbe.querySent.startsWith('zzqqxnohit')
      && /\.rivet\/sessions\/<slug>\/<id>\.jsonl/.test(searchProbe.noMatchText)
      && /(查了\s*\d+\s*个会话的转录位|transcript paths were checked)/i.test(searchProbe.noMatchText)
      && /events\.jsonl/.test(searchProbe.noMatchText)
    rows.push({
      name: '搜索太短不出网',
      want: '一个字符时 0 个请求，且空态说明至少要 2 个字符',
      got: `请求 ${searchProbe.shortRequests} 个 · 空态「${searchProbe.tooShortText.slice(0, 46)}」`,
      ok: shortOk,
      note: '判据数的是**网络请求**，不是文案：实测内核 `q=a` 回 400（Query must be at least 2 characters），客户端出网就等于把一句「搜索失败」横幅甩给用户',
    })
    rows.push({
      name: '搜索空态说出读了哪份库',
      want: '恰好 1 个请求（q 已编码），空态含转录路径形状与扫描份数',
      got: `请求 ${searchProbe.allRequests} 个 · q=${searchProbe.querySent.slice(0, 20)} · 空态「${searchProbe.noMatchText.slice(0, 72)}」· 等落定 ${searchProbe.searchWaitMs}ms`,
      ok: noHitOk,
      note: '本轮实测把这个功能判死了：搜索读 `<slug>/<id>.jsonl`，而写入侧把每个会话存成 `<id>/` 目录（正文在 `<id>/events.jsonl`）——隔离 sidecar 里发一条无 key prompt 后 `GET /events` 读得到那句用户正文，`GET /sessions/search` 对三个子串都回 `hits=0`。空态因此不能只说"无匹配"，它现在把这条不一致读到的路径讲给用户（内核侧缺陷，客户端不改它、也不假装搜到）',
    })
  }

  rows.push({
    name: '用户气泡对齐（图 .ububble 右对齐 + 无边框）',
    want: '用户那行靠右（行内右留白≤1、气泡不铺满整行）且没有描边；助手那行仍不靠右',
    got: bubble.present
      ? `圆角 ${bubble.radius} · 上边框 ${bubble.border} · 用户行 justify=${bubble.justify} · 行内右留白 ${bubble.gapRight} 左留白 ${bubble.gapLeft} · 气泡 ${bubble.width}/${bubble.rowWidth}px · 助手行 justify=${bubble.otherJustify}`
      : '探针页没渲染出 .uc__bubble — 没测',
    ok: bubble.present && bubble.justify === 'flex-end'
      && typeof bubble.gapRight === 'number' && bubble.gapRight <= 1
      && typeof bubble.gapLeft === 'number' && bubble.gapLeft > 0
      && typeof bubble.rowWidth === 'number' && bubble.width < bubble.rowWidth
      && /^0px( |$)/.test(bubble.border)
      && bubble.otherJustify !== null && bubble.otherJustify !== 'flex-end',
    note: '图上 `.ububble` 是右对齐无边框，我们原先左对齐带 1px 边——这一条以前是"等方向的红"，2026-10-12 裁定照图改，现已按实现量。**参考系换过**：上一版拿滚动容器 `.uc` 当右边界，而阅读栏 `--measure:748` 是在 900 视口里居中的，所以左右各 80px 留白——那种算法下"靠右"永远到 0 不了，实现对了也照红。现在比的是**它自己那一行**（行内右留白 + 气泡宽 < 行宽），并带上助手行作对照：助手那条仍必须是通栏左对齐，否则 modifier 打到了所有人身上。',
  })

  rows.push({
    name: '流式每帧只重渲染在变的那一块',
    want: '重渲染次数 ≤ 帧数×2（而不是帧数×块数）',
    got: stream
      ? `${stream.frames} 帧共跑 ${stream.renders} 次 BlockView（时间线里已封口 ${stream.sealed} 块；memo 失效时该是 ${stream.frames}×${stream.sealed + 1}≈${stream.frames * (stream.sealed + 1)} 次）`
      : '探针页的流式循环没跑完 — 没测到（不是通过）',
    ok: stream !== null && stream.renders <= stream.frames * 2,
    note: '计划 §4.2「不可变块 + memo」那条链的最后一环：数据层早有单测钉住"没动过的块保持同一引用"，但"UI 真的因此少渲染"此前只有注释在说。这里数的是整数，不是时间。',
  })
  rows.push({
    name: '正控：流式探针真的画满了那 61 行',
    want: 'DOM 行数 = 已封口块数 + 1，帧数跑满，且计数器确实随帧走',
    got: stream ? `行数 ${stream.rows} · 帧数 ${stream.frames} · 重渲染 ${stream.renders}` : '没读数 — 没测到（不是通过）',
    ok: stream !== null && stream.rows === stream.sealed + 1 && stream.frames >= 20 && stream.renders >= stream.frames,
    note: '上一条判据是"次数少"，这一条保证它不是因为压根没渲染才少（同一屏里的正控）。',
  })

  rows.push({
    name: '徽标 + 长分支名 + 长标题同屏',
    want: '一行 32px 装下三样读数：徽标不被挤出去、分支名 74px 内截断、标题省略号、行自己不溢出',
    got: !badgeRow.present || badgeRow.row === false
      ? '探针页没画出带徽标的那一行 — 没测（不是通过）'
      : `徽标「${badgeRow.text}」宽 ${badgeRow.badgeWidth}px flex:${badgeRow.grow}/${badgeRow.shrink} 在行内=${badgeRow.insideRow} · 行高 ${badgeRow.rowHeight}px 宽 ${badgeRow.rowWidth} 不溢出=${badgeRow.rowFits} · 标题省略=${badgeRow.titleEllipsis} · 分支 ${badgeRow.branchBox}px/上限 ${badgeRow.branchCap} 截断=${badgeRow.branchEllipsis}`,
    ok: badgeRow.present && badgeRow.row !== false
      && badgeRow.badgeWidth > 0 && badgeRow.insideRow === true
      && badgeRow.shrink === '0' && badgeRow.grow === '0'
      && badgeRow.rowHeight === 32 && badgeRow.rowFits === true
      && badgeRow.titleEllipsis === true
      && badgeRow.branchCap !== null && badgeRow.branchBox !== null && badgeRow.branchBox <= badgeRow.branchCap + 1
      && badgeRow.branchEllipsis === true
      && /\d/.test(badgeRow.text),
    note: '图上 `.srow` 一行只有"点 + 标题 + 时间"，我们把**待授权数**与分支名也放进了同一行（安全信号不能丢），所以这一行的最坏情况必须量：徽标 `flex:none` 遇到不封顶的分支名就会被顶出栏——那正是它加了 74px 上限的理由。真徽标要有 run（花钱），这一页量的是**三种读数同时出现时的排版**，不是"会不会有待授权"。',
  })

  // 归档行那把 ↩ 的两条判定：A 钉"入口在、且点下去走的是取消归档"，B 是同一屏里的正控，
  // 钉"未归档行仍是 ✕、且点它不会误走到取消归档"。期望的 id 名单来自探针页的夹具（archivedIds），
  // 这一侧一个数字都没抄——加一行归档夹具，两边一起动。
  const A = archProbe
  const clausesA = A.present === false ? [] : [
    ['行画出来了', A.rowCount > 0],
    ['每行恰好一把动作键', A.perRowMin === 1 && A.perRowMax === 1 && A.total === A.rowCount],
    ['键上只有 ↩/✕ 两种字形', A.other.length === 0],
    ['↩ 只出现在归档行（数目逐名对齐夹具）', A.undoCount === A.archivedIds.length && A.archivedIds.length >= 1],
    ['点 ↩ 每行回传一次 unarchive', A.undoClicks.length === A.archivedIds.length && A.undoClicks.every((c) => c.startsWith('unarchive:'))],
    ['回传的 id 就是那一行的 id', A.undoIds.join(',') === A.archivedIds.join(',')],
    ['点 ↩ 不会顺带把整行点开', !A.undoClicks.some((c) => c.startsWith('open:'))],
    ['标题随归档状态分叉（没写死成一个键）', A.undoTitle !== '' && A.crossTitle !== '' && A.undoTitle !== A.crossTitle],
  ]
  const clausesB = A.present === false ? [] : [
    ['未归档的行仍在', A.crossCount >= 1],
    ['点 ✕ 每行回传一次 archive', A.crossClicks.length === A.crossCount && A.crossClicks.every((c) => c.startsWith('archive:'))],
    ['点 ✕ 不会误走到取消归档', !A.crossClicks.some((c) => c.startsWith('unarchive:'))],
    ['点 ✕ 不会顺带把整行点开', !A.crossClicks.some((c) => c.startsWith('open:'))],
  ]
  const badA = clausesA.filter(([, ok]) => !ok).map(([n]) => n)
  const badB = clausesB.filter(([, ok]) => !ok).map(([n]) => n)
  const archEvidence = A.present === false
    ? '探针页没有 window.__rowProbe__ — 没测（不是通过）'
    : `行 ${A.rowCount} · 动作键 ${A.total}（每行 ${A.perRowMin}~${A.perRowMax}）· ↩ ${A.undoCount}（夹具归档行 ${A.archivedIds.length}）· ✕ ${A.crossCount} · ↩ 回传 ${JSON.stringify(A.undoClicks)} · ✕ 回传 ${JSON.stringify(A.crossClicks)} · 标题「${A.undoTitle}」vs「${A.crossTitle}」`
  rows.push({
    name: '归档行的取消归档入口',
    want: `${clausesA.length} 条子句全过`,
    got: A.present === false ? archEvidence : `${badA.length === 0 ? '全过' : `不合格：${badA.join('、')}`}｜${archEvidence}`,
    ok: A.present === true && clausesA.length > 0 && badA.length === 0,
    note: '取消归档这条路以前只有 REST 路由被活验过（`verify-rest-surface`），界面侧 0 个调用点——归档是个单向门，"显示已归档"里那些行一旦显示出来就是死路。这一条把"界面上真点得到、且点的确实是这一行"钉成常驻判定：夹具里的归档行 id 就是期望名单，字形/回调/stopPropagation 各自一条子句。',
  })
  rows.push({
    name: '正控：未归档行仍是归档键',
    want: `${clausesB.length} 条子句全过`,
    got: A.present === false ? archEvidence : `${badB.length === 0 ? '全过' : `不合格：${badB.join('、')}`}｜↩ ${A.undoCount} / ✕ ${A.crossCount} 共 ${A.total}`,
    ok: A.present === true && clausesB.length > 0 && badB.length === 0,
    note: '上一条数的是 ↩，这一条保证 ✕ 那一支没被换掉、也没跟着一起走 onUnarchive（同一屏里的正控：若两行都渲染 ↩，上面按夹具逐名对齐的那条会红，但"归档键还在"这件事得有正面的读数）。',
  })

  const R = retract
  const clausesR = R.present === false ? [] : [
    ['等待中的那条 lane 渲出来了', R.waitingFound],
    ['它旁边有一把撤回键', R.waitingBtns === 1],
    ['键看得见、不是零宽', R.btnBox > 0],
    ['键有字面标签与解释标题', R.btnText !== '' && R.btnTitle !== ''],
    ['点它回传的正是这一条 lane', JSON.stringify(R.retracts) === JSON.stringify([R.waitingLane])],
  ]
  const clausesT = R.present === false ? [] : [
    ['已被归并的那条 lane 也渲出来了', R.takenFound],
    ['那一行仍在（不是整段没画）', R.takenLines >= 1],
    ['它不再给撤回键', R.takenBtns === 0],
  ]
  const badR = clausesR.filter(([, ok]) => !ok).map(([n]) => n)
  const badT = clausesT.filter(([, ok]) => !ok).map(([n]) => n)
  const retractEvidence = R.present === false
    ? '探针页没有 window.__queueProbe__ — 没测（不是通过）'
    : `面板 ${R.panelCount} 个 · 等待「${R.waitingLane}」键 ${R.waitingBtns} 把（宽 ${R.btnBox}px，标签「${R.btnText}」/标题「${R.btnTitle}」）点击回传 ${JSON.stringify(R.retracts)} · 已归并「${R.takenLane}」行数 ${R.takenLines} 键 ${R.takenBtns} 把`
  rows.push({
    name: '排队 lane 的撤回入口',
    want: `${clausesR.length} 条子句全过`,
    got: R.present === false ? retractEvidence : `${badR.length === 0 ? '全过' : `不合格：${badR.join('、')}`}｜${retractEvidence}`,
    ok: R.present === true && clausesR.length > 0 && badR.length === 0,
    note: '和"取消归档"同一类缺口：`/queue/retract` 的传输层早有常驻实测（`accept-queue`，零花费），界面上却是 0 个调用点——排出去的话就收不回来。这一条钉的是"排队那行旁边真有一把点得到的键，且点的确实是这一条 lane"。',
  })
  rows.push({
    name: '正控：已归并的 lane 不再给撤回键',
    want: `${clausesT.length} 条子句全过`,
    got: R.present === false ? retractEvidence : `${badT.length === 0 ? '全过' : `不合格：${badT.join('、')}`}｜已归并那行：行数 ${R.takenLines} · 撤回键 ${R.takenBtns}`,
    ok: R.present === true && clausesT.length > 0 && badT.length === 0,
    note: '内核每条 queue_status 都点名 lane（steered/retracted/merged 三种都一样），所以"这条还等着"只由 laneId 决定。第二条子句是这条判据不空转的关键：先证明那一行确实画出来了，"没有键"才是**收了键**而不是**没渲**。',
  })

  const rowList = gauge.rows.map((r) => `${String(r.name).trim()}=${r.value.trim()}`).join(' ')
  // 每行最多因四舍五入偏 0.5 个百分点，所以容差按行数折半给；写死 ±行数 会松到放过真偏差。
  const roundingTol = gauge.rows.length * 0.5
  rows.push(
    {
      name: '仪表 环=内核字段反算',
      want: `${gauge.expectRing}%`, got: `${gauge.ring}%`,
      ok: gauge.hasFixture && gauge.gauge && gauge.ring === gauge.expectRing,
      note: gauge.hasFixture ? 'used=input+tool+reasoning+image 除以 window' : '页面上没有 __ctx__ 夹具，没测',
    },
    {
      name: '仪表 图例合计=环',
      want: `${gauge.ring}% ± ${roundingTol}`, got: `${gauge.rowSum}%`,
      ok: gauge.rowSum >= gauge.ring - roundingTol && gauge.rowSum <= gauge.ring + roundingTol,
      note: `图例把预留/余量也算进「已用」时这里会红（该夹具下合计 ${gauge.ring + (gauge.expectReservePct ?? 0)}%）：${rowList}`,
    },
    {
      name: '仪表 分段数=图例行数',
      want: String(gauge.rows.length), got: String(gauge.segCount),
      ok: gauge.segCount === gauge.rows.length,
      note: '条与例必须来自同一份分段',
    },
    {
      name: '仪表 分段宽度+缝=整条',
      want: `${gauge.barWidth}px`, got: `${Number((gauge.segSum + (gauge.segCount - 1) * gauge.gap).toFixed(1))}px`,
      ok: gauge.barWidth !== null && Math.abs(gauge.segSum + (gauge.segCount - 1) * gauge.gap - gauge.barWidth) <= 1,
      note: `分段是 share 的可视化，合起来（含 ${(gauge.segCount - 1) * gauge.gap}px 的 ${gauge.gap}px 缝）应等于整条`,
    },
    {
      name: '仪表 图例色块不是透明的',
      want: '每块有颜色', got: gauge.colors.filter((c) => !c.sw || c.sw === 'rgba(0, 0, 0, 0)').length === 0 ? '全有' : `${gauge.colors.filter((c) => !c.sw || c.sw === 'rgba(0, 0, 0, 0)').length} 块透明`,
      ok: gauge.colors.length > 0 && gauge.colors.every((c) => c.sw && c.sw !== 'rgba(0, 0, 0, 0)'),
      note: '图例是条子的键；键没有颜色，条上的四段就没法解读（这条以前只在源码里，从没量过渲染）',
    },
    {
      name: '仪表 图例色块=对应分段的色',
      want: '逐类相同', got: gauge.colors.filter((c) => c.sw !== c.seg).map((c) => c.k).join(',') || '四致',
      ok: gauge.colors.length > 0 && gauge.colors.every((c) => c.sw === c.seg),
      note: '色值分两处写就会各漂各的；这里比的是计算后的实际色值',
    },
    {
      name: '仪表 非零分段不显示成 0%',
      want: '0 行', got: `${gauge.zeroRows} 行`,
      ok: gauge.zeroRows === 0,
      note: '大窗口下 28 token 会四舍五入成 0%，读起来像「这里没有」——真数据上出现过',
    },
    {
      name: '仪表 面板不横向溢出',
      want: '应无', got: String(gauge.overflow),
      ok: gauge.overflow !== null && gauge.overflow <= 1,
      note: `${288}px 栏宽（图上 --scale-rail-open）里放整组仪表`,
    },
  )

  // —— 渲染面配对普查 ——
  // check-contrast 只能回答"这两枚 token 摆在一起读得清吗"，答不出"页面上真的是这两枚叠在一起吗"
  // （它自己的文档就写着这句）。所以这里反过来问：浏览器实际画出来的每一组「前景 on 底色」是什么？
  // 能不能在 ramp 里找到出处？找得到出处的那些，配对在不在声明表里？
  // 代码块/工具卡/shiki 着色不在面内：那里的颜色归语法主题管，另有三条锚点逐条量过。
  // 配对普查的数据在页面还活着时抓（censusLight / censusDark，见上面 railProbe 之后）；这里只做映射与判定。
  const declared = new Set(PAIRS.map(([fg, bg]) => `${fg}|${bg}`))
  const censusDump = []
  for (const [label, census, merged] of [['浅色', censusLight, light], ['暗色', censusDark, { ...light, ...dark }]]) {
    // rgb → 哪枚 token 会算出这个值：**按主题各建一张**。变异验过这条分叉是承重的——拿暗色那张表去映射
    // 浅色普查，两个主题的「正文那组」都报「不在」、表外配对从 4/9 涨成 11/11，错的是映射而不是页面。
    // 合一张更松：暗色 `--bg-sidebar`(#0F1115) 与浅色 `--nb-1000` 同值，一个名字会替两套主题说话。
    const byRgb = new Map()
    for (const name of Object.keys(merged)) {
      // 任何一枚能解析成颜色的 token 都算出处（`--ds-*` 色族、`--nb-*` 灰阶都是合法的底色来源；
      // 只挑 --label/--bg 会把 `var(--ds-100)` 这类正当用法误判成硬编码）。非颜色的值解析会抛，跳过。
      if (!name.startsWith('--')) continue
      let v
      try { v = resolveVal(name, merged) } catch { continue }
      const rgb = [v.r, v.g, v.b].map((x) => Math.round(x)).join(',')
      const cur = byRgb.get(rgb) ?? new Set()
      cur.add(name)
      byRgb.set(rgb, cur)
    }
    const untraced = []
    const undeclared = []
    for (const [key, meta] of Object.entries(census)) {
      const [fg, bg] = key.split('|')
      const fgTok = byRgb.get(fg)
      const bgTok = byRgb.get(bg)
      if (!fgTok || !bgTok) {
        // 说清是哪一侧没出处：一条"配对找不到 token"的废话不如"这个底色是硬编码"有用。
        untraced.push(`${!fgTok ? `前景 ${fg}` : `底色 ${bg}`} 不在${label} ramp 里（.${meta.where} ×${meta.n}）`)
        continue
      }
      const hit = [...fgTok].some((f) => [...bgTok].some((b) => declared.has(`${f}|${b}`)))
      if (!hit) undeclared.push(`${[...fgTok].join('/')} on ${[...bgTok].join('/')}（.${meta.where} ×${meta.n}）`)
    }
    const censusPairs = Object.keys(census).length
    // 正控：普查必须真的看到**该主题自己的**正文那组（`--label-primary` on `--bg-base`），否则"0 条未声明"
    // 只是扫描面空了。暗色这一条还兼任"主题真翻了"的证据：翻 theme 失败时暗色普查原样装着浅色的数，
    // 而那两枚 rgb 在暗色映射里落到别的名字上，正控当场红——不会把浅色列成暗色蒙过去。
    const canary = Object.entries(census).find(([k]) => {
      const [fg, bg] = k.split('|')
      return (byRgb.get(fg)?.has('--label-primary')) && (byRgb.get(bg)?.has('--bg-base'))
    })

    rows.push({
      name: `渲染面配对(${label}) 普查真看到了文本`,
      want: '>5 组且含该主题正文那组', got: `${censusPairs} 组，正文那组${canary ? '在' : '不在'}`,
      ok: censusPairs > 5 && canary !== undefined,
      note: `下一条判据是"未声明=0"，这一条保证 0 不是因为没数到东西、也不是因为${label}根本没渲出来（同一屏里的正控）`,
    })
    rows.push({
      name: `渲染面配对(${label}) 前景都来自 ramp`,
      want: '0 组', got: untraced.length === 0 ? '全有出处' : `${untraced.length} 组：${untraced.slice(0, 3).join(' ; ')}`,
      ok: untraced.length === 0,
      note: '页面上出现的每个文字前景色都得能在该主题 ramp 里找到出处；找不到就是硬编码色（代码块/shiki 另有三条锚点管）',
    })
    rows.push({
      name: `渲染面配对(${label}) 都在声明表里`,
      want: '0 组', got: undeclared.length === 0 ? '全在表里' : `${undeclared.length} 组：${undeclared.slice(0, 4).join(' ; ')}`,
      ok: undeclared.length === 0,
      note: `check-contrast 那份声明表是手写的（现 ${PAIRS.length} 对，条数从同一份 PAIRS 派生，不在这里抄数）；这条问的是页面真的把哪些前景/底色叠在了一起，多出表外的配对就在此现形（AA 之外还有一类"没人评过"的配对）`,
    })
    // 正控：这一族底色只有被选中的那一行才画得出来。判据**绑 DOM 上真的出现 `.us__row--sel`**，
    // 不绑"页面上出现过这族底色"——设置面板那个默认标签用的就是同一枚 `--ds-100`，绑底色会假绿。
    const sawPair = Object.entries(census).some(([k]) => byRgb.get(k.split('|')[1])?.has('--ds-100'))
    rows.push({
      name: `渲染面配对(${label}) 选中态真在面上`,
      want: 'DOM 里有 .us__row--sel', got: `${selDom}；这族底色${sawPair ? '在面上' : '不在面上'}`,
      ok: selDom.startsWith('有'),
      note: `普查把默认态与选中态并成一份面（点行：${selNote}）；没有选中行时"没报这一族"只说明没画出来，不能当覆盖过`,
    })
    // 行里那串是**截断过**的（四组为止），只够看出"有这事"。要让人照着改，得有一份不截断的清单：
    // 下面按主题整份打出来，并**把条数打在表头**——表头数与行数对不上就是又被截断了。
    censusDump.push({ label, undeclared, untraced })
  }

  for (const r of rows) {
    say(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(30)} 期望 ${String(r.want).padStart(6)}  实渲 ${String(r.got).padStart(6)}  ${r.note}`)
  }
  for (const d of censusDump) {
    for (const [kind, list] of [['表外配对', d.undeclared], ['没有出处', d.untraced]]) {
      if (list.length === 0) continue
      say(`      ${d.label} · ${kind}完整清单 ${list.length} 组：`)
      for (const g of list) say(`        - ${g}`)
    }
  }
} catch (e) {
  rows.push({ name: 'harness', want: null, got: null, ok: false, note: e.message })
  console.error(`✗ harness — ${e.message}`)
} finally {
  await teardown()
}

const bad = rows.filter((r) => !r.ok)
if (!quiet) {
  console.log(`\n实渲 ${rows.length} 条锚点，偏差/未测 ${bad.length} 条`)
  if (bad.length > 0) console.log('FAILED (实渲或页面自报与判据不符):')
}
if (bad.length > 0) {
  for (const r of bad) console.error(`  ✗ ${r.name} — ${r.note}`)
  process.exit(1)
}
