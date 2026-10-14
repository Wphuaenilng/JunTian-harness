#!/usr/bin/env node
/**
 * verify-desktop.mjs — proves the Electron shell actually renders the client, headlessly.
 *
 * Launches `apps/desktop` with `--remote-debugging-port`, then speaks CDP over the DevTools
 * HTTP + WebSocket endpoints and asks the live renderer the questions that matter:
 *
 *   1. is the app DOM there (session rows, composer) — a white window is a failed shell;
 *   2. does `/api/health` answer from inside the window — that is the same-origin proxy
 *      injecting Authorization, which is the shell's whole networking story;
 *   3. is `process`/`require` undefined in the page — i.e. the sandbox posture in
 *      main.mjs is real and not just written down.
 *
 * Nothing here costs an upstream call: the sidecar is spawned against the isolated store
 * **and** (since 2026-10-11) the isolated home, and only /health is hit. The docstring used
 * to say "isolated store" only — that was half true: `--desktop-dir` moved the session store,
 * but `RIVET_HOME` (transcripts / cache logs) still pointed at the operator's real `~/.rivet`,
 * so every verification run was touching the developer's own data root. The shell now takes
 * `--isolate-home` (product default unchanged) and this file asserts, by counting entries
 * before and after, that the operator's home really did not move.
 *
 *   node scripts/verify-desktop.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { bundleFreshness } from './lib-freshness.mjs'
import { listProjectRuntimes, PROBE_FAILED } from './lib-instance.mjs'
import { countOperatorHome, describeHomeDelta } from './lib-home.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(clientRoot, 'apps/desktop')
const scriptsDir = resolve(clientRoot, 'scripts')
const electronPkg = resolve(desktopDir, 'node_modules/electron')
const port = 9223

const failures = []
let checksRun = 0
const check = (label, ok, detail = '') => {
  checksRun += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** The electron package exports the binary path; pnpm's layout means we resolve it here. */
// 本验法读的是被伺服的 dist（壳 loadURL 打开的就是那台同源伺服）。产物比源码新才算数——
// 今天就是这样被抓到的：`ui-approval` 改完之后 dist 还是旧的，那一行"在当前产物上重跑"当下不真。
{ const f = bundleFreshness(clientRoot); check('产物不早于源码（本验法读的是被伺服的 dist）', f.ok, f.message) }

function electronBinary() {
  const marker = resolve(electronPkg, 'path.txt')
  if (!existsSync(marker)) return null
  const rel = readFileSync(marker, 'utf8').trim()
  const p = resolve(electronPkg, 'dist', rel)
  return existsSync(p) ? p : null
}

const bin = electronBinary()
if (!bin) {
  console.error('electron binary not found under apps/desktop/node_modules/electron/dist —')
  console.error('install it with the mirror this machine can reach:')
  console.error('  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ corepack pnpm install')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fail fast if the debugging port is already spoken for. Two verifiers on one machine share
// port 9223, and the second one's shell never binds it — its CDP calls then talk to the *other*
// run's renderer, which vanishes mid-probe, and the run dies as an unexplained stall instead of
// a one-line reason. (This is exactly how the run before this guard lost 7 minutes.)
try {
  const occupied = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_200) })
  console.error(`CDP port ${port} is already serving ${occupied.status} — another 天枢 shell/verifier owns it.`)
  console.error('find it by PID (Get-Process electron / node) and stop that PID, then re-run.')
  process.exit(1)
} catch { /* free, as expected */ }

// 进程探针的家在 `lib-instance.mjs`（`verify-single-instance` 预飞用的是同一条命令）。
// 这里曾留着一整份私有副本：两份拷贝的漂移方式是坏掉的那份读起来像"机器上什么都没有"，
// 而这条判据的存在理由恰恰是发现残留——所以 `check:layers` 现在钉"只许有一个家"。

/** 把"CDP 连不上"从一句 fetch failed 变成一条能顺着走线索的打印。 */
function reportStrayRuntimes(lastProbeError, lines) {
  console.error(`\nCDP 列不出页面（探针错误：${lastProbeError || '无'}）；端口没被占，所以不是第二个 verifier 抢 9223。`)
  if (lines.length === 1 && lines[0].startsWith(PROBE_FAILED)) {
    // 探针自己坏了：这**不是**"没有残留"，不许把它读成排除法结论（同一条纪律在 lib-instance 的返回形状里）。
    console.error(`进程探针没跑成：${lines[0]}——所以"上一趟留下的 daemon"这条嫌疑**未被排除也未被证实**，先修探针再看进程。`)
    return
  }
  // 一列进程里大部分是本趟自己的 helper；只有**比本趟还早**的那些才可能是上一趟留下的。
  const suspects = []
  for (const line of lines) {
    const created = /created=(\S+)/.exec(line)?.[1]
    const before = created ? new Date(created).getTime() < runStartedMs - 2_000 : false
    if (before) suspects.push(line)
    console.error(`  ${before ? '⚠ 早于本次验证启动' : '  本趟之内'}  ${line.slice(0, 220)}`)
  }
  console.error(`本仓进程 ${lines.length} 台，其中 **早于本次启动** 的 ${suspects.length} 台。`
    + (suspects.length > 0
      ? '上一趟崩溃留下的游离 `serve --port …` daemon 就在这些带 ⚠ 的里——确认是自己的之后按它的 PID 收掉再重跑（别按镜像名 taskkill）。'
      : '这个数为 0 就说明成因不是残留进程，别去杀进程：往 CDP 与启动时序那一侧查。'))
}

/**
 * 只**数条目名**，不读任何内容：这条判据要回答的是"这次验证有没有动操作者自己的 `~/.rivet`"，
 * 回答它不需要知道里面写了什么（去读内容就是访问别人的会话数据，另一条线）。
 * 计数住在 `lib-home.mjs` 那一处——`verify-dev-proxy` 也问同一个问题，两份实现一旦漂移，
 * "前后条目数相等"这句话就各说各话。
 */
const homeBefore = countOperatorHome()
const runStartedMs = Date.now()

const child = spawn(bin, [desktopDir, '--smoke', '200', '--tray-check', '--isolate-home', `--remote-debugging-port=${port}`], {
  cwd: clientRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let log = ''
child.stdout.on('data', (b) => { log += b.toString(); process.stdout.write(`[electron] ${b}`) })
child.stderr.on('data', (b) => { log += b.toString() })

/**
 * One CDP round trip, and *every* await has a deadline.
 *
 * The first version of this helper had none: if the page target vanished (a navigation that
 * was not pinned) or the socket closed before replying, the promise simply never settled and
 * the verifier hung forever — meanwhile the Electron it spawned kept holding the
 * single-instance lock, so every later run reported "shell never reported READY" for a reason
 * that had nothing to do with the shell. A verifier that can hang is worse than one that goes
 * red, so each phase is named and bounded.
 */
let cdpSeq = 0
const deadline = (ms, label) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error(`cdp ${label} timed out after ${ms}ms`)), ms))
const bounded = (p, ms, label) => Promise.race([p, deadline(ms, label)])

const evaluate = async (expression, budgetMs = 5_000) => {
  const t0 = Date.now()
  const left = () => Math.max(200, budgetMs - (Date.now() - t0))
  const targets = await bounded(fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()), left(), '/json/list')
  const page = targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(t.url))
  if (!page) {
    throw new Error(`no app page target; saw ${targets.map((t) => `${t.type} ${t.url}`).join(' | ') || 'no targets'}`)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const opened = new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error(`cdp connect failed for ${page.webSocketDebuggerUrl}`))
  })
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++cdpSeq
    const onMsg = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id !== id) return
      ws.removeEventListener('message', onMsg)
      res(msg)
    }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('close', () => rej(new Error(`cdp ${method}: socket closed with no reply`)))
    ws.send(JSON.stringify({ id, method, params }))
  })
  try {
    await bounded(opened, left(), 'open')
    await bounded(send('Runtime.enable', {}), left(), 'Runtime.enable')
    const r = await bounded(send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), left(), 'Runtime.evaluate')
    if (r.error) throw new Error(JSON.stringify(r.error))
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
    return r.result?.result?.value
  } finally {
    try { ws.close() } catch { /* already gone */ }
  }
}

let verdict = null
try {
  // 1. wait for the shell to print its READY line and for CDP to expose the page.
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = log.includes('READY ')
    if (!ready) await sleep(500)
  }
  const readyDetail = log.split('\n').find((l) => l.includes('READY'))
    ?? (/SINGLE-INSTANCE refused/.test(log)
      ? 'this copy was refused by the single-instance lock: another 天枢 shell is still running — find it with `Get-Process electron` and stop it by PID'
      : 'no READY line')
  check('shell booted the sidecar + same-origin layer and logged READY', ready, readyDetail)
  if (!ready) throw new Error('shell never reported READY')

  let href = null
  let lastProbeError = ''
  for (let i = 0; i < 14 && !href; i++) {
    try { href = await evaluate('location.href') } catch (e) { lastProbeError = e.message; await sleep(500) }
  }
  const strays = href === null ? listProjectRuntimes() : []
  if (href === null) reportStrayRuntimes(lastProbeError, strays)
  check('the window navigated to the served app', typeof href === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(href),
    String(href ?? `no page target: ${lastProbeError}（本仓进程 ${strays.length} 台，逐条列在上面）`))

  // 2. the renderer really is the client, not a blank page. This one has to be a *wait*,
  //    not a single sample: the shell's tray self-test hides the window for ~1.5 s while it
  //    runs, and a hidden Electron window throttles timers, which is enough to make a
  //    mount check that only looks once report a false white screen.
  const domProbe = `JSON.stringify({
    href: location.href,
    title: document.title,
    root: document.getElementById('root')?.children.length ?? 0,
    sidebar: !!document.querySelector('.us'),
    rows: document.querySelectorAll('.us__row').length,
    empty: document.querySelector('.us__empty')?.textContent ?? null,
    brand: document.querySelector('.us__brand b')?.textContent ?? null,
    statusbar: !!document.querySelector('.app__status'),
    lang: document.documentElement.lang,
  })`
  let dom = null
  for (let i = 0; i < 25; i++) {
    try {
      dom = JSON.parse(await evaluate(domProbe))
      if (dom.root > 0 && dom.sidebar) break
    } catch { /* page target not ready yet */ }
    await sleep(700)
  }
  check('React mounted inside Electron', dom !== null && dom.root > 0, `title=${dom?.title} brand=${JSON.stringify(dom?.brand)} lang=${dom?.lang}`)
  // The shell's store is isolated and may be brand new — an empty sidebar is the correct
  // first-boot answer, so assert the list mounted, not that it has rows.
  check('sidebar + status bar mounted over the proxied /api', Boolean(dom?.sidebar && dom?.statusbar),
    `rows=${dom?.rows} empty=${JSON.stringify(dom?.empty)}`)

  // 3. same-origin token injection, measured from inside the page.
  const health = await evaluate(`(async () => {
    const r = await fetch('/api/health'); const j = await r.json();
    return JSON.stringify({ status: r.status, protocolVersion: j.protocolVersion, readiness: j.readiness, configured: j.configured });
  })()`).then((s) => JSON.parse(s))
  check('/api/health answers from the renderer (proxy injects Authorization)',
    health.status === 200 && health.protocolVersion === 1 && health.readiness === 'ready',
    JSON.stringify(health))

  // 4. the token is injected by the proxy, so it must not be reachable from the page.
  //    Scope of the scan: the first version read only the single <script src> in index.html, which
  //    is the entry chunk — but the build emits ~40 lazy chunks (app-frame view, shiki languages)
  //    that the renderer can pull at runtime, and a leak into any of those would have passed a check
  //    named "the token is not in the JS bundle". So scan the served tree, not one file.
  const token = JSON.parse(readFileSync(resolve(clientRoot, 'apps/desktop/.runtime/.sidecar-info.json'), 'utf8')).token
  const html = await (await fetch(dom.href)).text()
  const distAssets = resolve(clientRoot, 'apps/web/dist/assets')
  const assetFiles = existsSync(distAssets)
    ? readdirSync(distAssets).filter((f) => /\.(js|css|html)$/.test(f))
    : []
  const sizes = assetFiles.map((f) => statSync(join(distAssets, f)).size)
  const leaked = assetFiles.filter((f) => readFileSync(join(distAssets, f), 'utf8').includes(token))
  const leakedHtml = html.includes(token)
  const totalBytes = sizes.reduce((a, b) => a + b, html.length)
  const largest = assetFiles.length > 0 ? assetFiles[sizes.indexOf(Math.max(...sizes))] : 'no assets'
  check('the boot token is in neither the HTML nor ANY shipped asset (entry + lazy chunks)',
    assetFiles.length > 0 && !leakedHtml && leaked.length === 0,
    `${assetFiles.length + 1} files / ${totalBytes}B scanned (largest: ${largest})`
    + (leaked.length ? ` — LEAK in ${leaked.join(', ')}` : leakedHtml ? ' — LEAK in index.html' : ', none carries the token'))
  // Positive control. "No file contains the token" is a green that also prints when the scan reads
  // nothing at all — a wrong directory, a filter that excludes every file. So run the SAME predicate
  // against a string that must exist (the head of the largest chunk's own bytes): if that finds no
  // file, the negative result above is not evidence and the check says so.
  const canary = largest === 'no assets' ? '' : readFileSync(join(distAssets, largest), 'utf8').slice(120, 180)
  const canaryHits = canary.length > 0 ? assetFiles.filter((f) => readFileSync(join(distAssets, f), 'utf8').includes(canary)) : []
  check('the asset scan is not vacuous (positive control: a string that must be present is found)',
    canaryHits.length > 0, `canary from ${largest} matched ${canaryHits.length} file(s)`)

  // 4. the privileged-surface claims in main.mjs, measured rather than asserted.
  const nodeInRenderer = await evaluate(`[typeof process, typeof require, typeof module].join('/')`)
  check('no Node in the renderer (nodeIntegration:false held)', nodeInRenderer === 'undefined/undefined/undefined', nodeInRenderer)
  const cspish = await evaluate(`typeof window.chrome?.loadTimes === 'function' ? 'electron-api-present' : 'no-extra-api'`)
  console.log(`  i renderer chrome API surface: ${cspish}`)

  // 5. the shell's own source, read once and used by two checks below. Comments are stripped
  //    first: this file *documents* "No preload: …", and a raw scan for `preload:` would match
  //    the prose that explains its absence and report the guard as broken.
  const shellSrc = readFileSync(resolve(desktopDir, 'src/main.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  // 壳确实把这个开关**透传给启动器**（光看本文件传了参数不够——壳若忽略它，sidecar 仍然跑在
  // 操作者的 home 上）。两条一起才算数：解析开关 + 把它推进 launcher 参数。
  check('壳把 --isolate-home 透传给 launch-sidecar（不是只接收不转发）',
    /isolateHome/.test(shellSrc) && /push\('--isolate-home'\)/.test(shellSrc),
    `解析=${/isolateHome/.test(shellSrc)} 透传=${/push\('--isolate-home'\)/.test(shellSrc)}`)
  // 结果侧的可观察量：这次验证跑完，操作者 `~/.rivet` 的顶层条目数必须一格没动。
  // 反面同一体：**临时 home 必须真的被建出来**——不然"数了个不存在的目录，两侧都是 -1"
  // 会假装成"没动过"（第一版就是这样空转的：`~/.rivet/sessions` 在这台机器上根本不存在）。
  const homeAfter = countOperatorHome()
  const isolatedHome = resolve(desktopDir, '.runtime/sidecar-data/rivet-home')
  // "目录存在"不算证据——上一次跑留下的空壳也算存在。要的是**这一次**写到那儿了：
  // sidecar 在自己的 home 里落 `server-info.json`，它的 mtime 落在本次运行窗口内才算隔离真生效。
  const marker = join(isolatedHome, 'server-info.json')
  let wroteThisRun = false
  try { wroteThisRun = statSync(marker).mtimeMs >= runStartedMs - 2_000 } catch { wroteThisRun = false }
  check(`这次验证没在操作者的 ~/.rivet 里留下东西（前后条目数 ${homeBefore} → ${homeAfter}），且本次确实写进了临时 home`,
    homeAfter === homeBefore && wroteThisRun,
    homeAfter !== homeBefore ? describeHomeDelta(homeBefore, homeAfter)
      : !wroteThisRun ? `${marker} 的 mtime 不在本次运行窗口内：开关透传了却没生效，"没动过"就不成立`
        : `只数名字、未读任何内容；写入证据是本次跑出的 ${marker}`)

  // 5b. the window-open pin, measured by counting page targets.
  //     This check is a rewrite of two versions that could not go red:
  //     (a) it navigated to `https://example.com/` — this machine has no route to the public
  //         internet, so "the shell pinned it" and "the network is down" looked identical;
  //     (b) it navigated to the sidecar's own origin. A mutation that deleted the pin's
  //         `preventDefault()` still passed, and the probe says why: from a CDP-initiated
  //         cross-origin top-level navigation, `will-navigate` never fires *at all* — no
  //         `did-fail-load` either, and the same `location.assign` to a same-origin URL does
  //         navigate (`?probe=1` landed), so the harness works and the handler is simply not
  //         the thing holding that door. Claiming the pin was verified would have been a fake
  //         green, so the behaviour is measured on the surface that really does reach the
  //         shell: `window.open` / `<a target="_blank">`, which is how an attacker-controlled
  //         document (tool output, an embedded MCP view) would try to get a second window.
  //         Evidence is a target count, not a log line — a mutation returning `allow` makes
  //         the count grow.
  const sidecarOrigin = /sidecar=(http:\/\/127\.0\.0\.1:\d+)/.exec(readyDetail ?? '')?.[1] ?? null
  const pageTargets = async () => {
    const list = await bounded(fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()), 4_000, '/json/list')
    return list.filter((t) => t.type === 'page').length
  }
  let navOutcome = null
  if (!sidecarOrigin) {
    check('renderer window.open to another origin opened no second window', false,
      'could not parse the sidecar origin out of the READY line — not tested, not passed')
  } else {
    const before = await pageTargets()
    let handle = null
    try {
      handle = await evaluate(`(function(){ const w = window.open(${JSON.stringify(`${sidecarOrigin}/`)}); return w === null ? 'null-handle' : 'got-handle' })()`, 6_000)
    } catch (e) { handle = `threw (${e.message})` }
    // Read the target list three times instead of once. A single post-open read can catch a
    // transient target that the shell never keeps, and then "the pin failed" and "the machine was
    // slow" look identical — which is what this check did on an aggregate run once. The pin's
    // claim is about the *settled* state, so judge on the last read and report the peak.
    const reads = []
    for (const ms of [400, 800, 1_200]) { await sleep(ms); reads.push(await pageTargets()) }
    const after = reads.at(-1)
    const peak = Math.max(before, ...reads.filter((n) => Number.isFinite(n)))
    // A CDP timeout is "evidence not obtained", not "the pin is broken" — keep them apart so a
    // loaded machine can never be read as a security failure (and still goes red).
    const cdpTimedOut = typeof handle === 'string' && handle.startsWith('threw (')
    const blocked = (log.split('\n').find((l) => l.includes('blocked window.open')) ?? '').trim()
    navOutcome = { sidecarOrigin, before, after, reads, peak, handle, blocked }
    check('renderer window.open to another origin opened no second window',
      after === before && handle === 'null-handle',
      cdpTimedOut
        ? `未取到证据：CDP 6 秒没回答（${handle}）——慢机器不等于挡不住，但这条仍然红`
        : `targets ${before}→${after} (reads ${reads.join('/')}, peak ${peak}), window.open returned ${handle}${blocked ? ` | shell logged "${blocked}"` : ' | shell logged no deny'}`)
  }

  // 5c. the posture itself. "typeof process === undefined in the renderer" is an *outcome*, and
  //     it holds via `sandbox` alone — flipping nodeIntegration to true changes nothing
  //     observable, which a mutation test proved. So assert the config facts the shell claims,
  //     straight off its source: they are the reason the outcome holds. Same reasoning for the
  //     top-level navigation pin, which 5b cannot measure behaviourally: here it is registered as
  //     a code fact, and labelled as such.
  check('the shell keeps its declared posture in code (no nodeIntegration, sandbox on, contextIsolation on, no preload, no webview)',
    /nodeIntegration:\s*false/.test(shellSrc) && /contextIsolation:\s*true/.test(shellSrc)
    && /sandbox:\s*true/.test(shellSrc) && !/preload\s*:/.test(shellSrc) && /webviewTag:\s*false/.test(shellSrc),
    `nodeIntegration:false=${/nodeIntegration:\s*false/.test(shellSrc)} sandbox:true=${/sandbox:\s*true/.test(shellSrc)} contextIsolation:true=${/contextIsolation:\s*true/.test(shellSrc)} preload-free=${!/preload\s*:/.test(shellSrc)} webviewTag:false=${/webviewTag:\s*false/.test(shellSrc)}`)
  const navStart = shellSrc.indexOf("on('will-navigate'")
  const frameStart = shellSrc.indexOf("on('will-frame-navigate'")
  const openStart = shellSrc.indexOf('setWindowOpenHandler')
  const navPinOk = navStart >= 0 && frameStart > navStart && /preventDefault\(\)/.test(shellSrc.slice(navStart, frameStart))
  const framePinOk = frameStart >= 0 && openStart > frameStart && /preventDefault\(\)/.test(shellSrc.slice(frameStart, openStart))
  const pinsRegistered = navPinOk && framePinOk
  check('a top-level and subframe navigation pin are registered in the shell source (code fact — see 5b for why it is not measured)',
    pinsRegistered, `will-navigate preventDefault=${navPinOk} will-frame-navigate preventDefault=${framePinOk}`)

  // 6. the tray. Its icon is a checked-in PNG generated by apps/desktop/scripts/make-icon.mjs,
  //    so the first question is whether Electron can actually decode it — an empty nativeImage
  //    means no tray at all, which the shell logs as `TRAY FAILED`.
  let trayLine = null
  for (let i = 0; i < 20 && !trayLine; i++) {
    trayLine = log.split('\n').find((l) => l.startsWith('TRAY created')) ?? null
    if (!trayLine) await sleep(500)
  }
  check('tray icon decodes and the tray is created', trayLine !== null && !/TRAY FAILED/.test(log), trayLine ?? 'no TRAY line')
  const icon = /icon=(\d+)x(\d+)/.exec(trayLine ?? '')
  check('the tray bitmap is the 32x32 asset, not a 1x1 fallback', icon?.[1] === '32' && icon?.[2] === '32', trayLine ?? '')

  // 7. the three tray behaviours a user would click, driven by the shell's own self-test.
  //    Headless CDP cannot reach the taskbar, so the shell calls hide()/showWindow() and the
  //    *real* `close` gate with a cancelable event, and reports the observed booleans.
  let selftest = null
  for (let i = 0; i < 20 && !selftest; i++) {
    selftest = log.split('\n').find((l) => l.startsWith('TRAY-SELFTEST')) ?? null
    if (!selftest) await sleep(500)
  }
  check('hide-to-tray / show-from-tray / close-goes-to-tray all held, and the window was visible first',
    /visible=true/.test(selftest ?? '') && /hideToTray=true/.test(selftest ?? '') && /showFromTray=true/.test(selftest ?? '') && /closeGoesToTray=true/.test(selftest ?? ''),
    selftest ?? 'no TRAY-SELFTEST line')

  // 9. anti-flash, the half that actually works. The window used to be a hardcoded dark grey,
  //    so a light-theme user saw dark first. `show:false` + `ready-to-show` was tried and
  //    measured false — a hidden window never commits a first frame here (fallback at 4159ms,
  //    and the self-test read isVisible()===false) — so the shipped fix is only the colour.
  const winLine = log.split('\n').find((l) => l.startsWith('WINDOW shown')) ?? ''
  check('the window colour follows the OS theme (no hardcoded dark, no hidden-4s experiment)',
    (/bg=#FFFFFF osDark=false/.test(winLine) || /bg=#0F1115 osDark=true/.test(winLine)) && !/revealed via/.test(log),
    winLine.trim().slice(0, 72) || 'no WINDOW line')

  // 8. the daemon's runtime — the check that was missing when the shell looked healthy.
  //    main.mjs has to spawn its child scripts as `electron.exe ELECTRON_RUN_AS_NODE=1`
  //    (inside Electron process.execPath is the app binary), and that hand-off used to be
  //    inherited by the *daemon* too, which then loaded better-sqlite3 against Electron's
  //    ABI: `Session registry schema failed … NODE_MODULE_VERSION 137 vs 149` in the sidecar
  //    log, while /health kept answering readiness=ready and every check above stayed green.
  const daemonLine = log.split('\n').find((l) => l.includes('[boot] daemon:')) ?? ''
  check('the sidecar daemon runs on a real node binary, not electron-as-node',
    /daemon: .*node(\.exe)? \(/.test(daemonLine) && !/electron\.exe/i.test(daemonLine),
    daemonLine.replace('[boot] ', '').trim() || 'no daemon runtime line reported')
  const sidecarLogPath = resolve(clientRoot, 'apps/desktop/.runtime/.sidecar.log')
  const sidecarLog = existsSync(sidecarLogPath) ? readFileSync(sidecarLogPath, 'utf8') : ''
  const abi = ['ERR_DLOPEN_FAILED', 'Session registry schema failed', 'NODE_MODULE_VERSION'].filter((s) => sidecarLog.includes(s))
  check('the sidecar log is free of native-module / session-registry failures',
    sidecarLog.length > 0 && abi.length === 0, abi.join(' + ') || `${sidecarLog.length}B, clean`)

  verdict = { dom, health, nodeInRenderer, nav: navOutcome, trayLine, selftest, checksRun }
} catch (e) {
  check('desktop verification completed', false, e.message)
} finally {
  // Electron on Windows spawns a wrapper, and `child.kill()` has been observed to leave the
  // real app running — which then holds the single-instance lock and makes the *next* run
  // fail as "shell never reported READY" for a reason that has nothing to do with the shell.
  // taskkill /T /F is the same teardown launch-sidecar.mjs uses for the daemon itself.
  try {
    execFileSync(resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    if (!child.killed) child.kill('SIGKILL')
  }
  await sleep(400)
  // The sidecar is detached on purpose, so a killed verifier can strand it holding the
  // StoreLock; reclaim it here so the next run starts from a clean state dir.
  const stop = spawn(process.execPath, [resolve(scriptsDir, 'launch-sidecar.mjs'), '--state-dir', resolve(clientRoot, 'apps/desktop/.runtime'), '--stop'], { cwd: clientRoot, stdio: 'ignore' })
  await new Promise((r) => { stop.once('exit', r); setTimeout(r, 8_000) })
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  console.error('--- last electron log lines ---')
  console.error(log.split('\n').slice(-12).join('\n'))
  process.exit(1)
}
console.log('\nall desktop checks passed')
console.log(JSON.stringify(verdict, null, 2))
