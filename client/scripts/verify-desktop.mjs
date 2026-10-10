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
 * and only /health is hit.
 *
 *   node scripts/verify-desktop.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(clientRoot, 'apps/desktop')
const scriptsDir = resolve(clientRoot, 'scripts')
const electronPkg = resolve(desktopDir, 'node_modules/electron')
const port = 9223

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** The electron package exports the binary path; pnpm's layout means we resolve it here. */
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

const child = spawn(bin, [desktopDir, '--smoke', '90', '--tray-check', `--remote-debugging-port=${port}`], {
  cwd: clientRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let log = ''
child.stdout.on('data', (b) => { log += b.toString(); process.stdout.write(`[electron] ${b}`) })
child.stderr.on('data', (b) => { log += b.toString() })

const evaluate = async (expression) => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(t.url))
  if (!page) throw new Error(`no app page target; saw ${targets.map((t) => t.url).join(', ')}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')) })
  const send = (method, params) => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e6)
    ws.addEventListener('message', function onMsg(ev) {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) { ws.removeEventListener('message', onMsg); res(msg) }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable', {})
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  ws.close()
  if (r.error) throw new Error(JSON.stringify(r.error))
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text)
  return r.result?.result?.value
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
  for (let i = 0; i < 30 && !href; i++) {
    try { href = await evaluate('location.href') } catch { await sleep(700) }
  }
  check('the window navigated to the served app', typeof href === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(href), String(href))

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

  // 4. the token is injected by the proxy, so it must not be reachable from the page —
  //    the bundle itself is where a leak would actually live.
  const token = JSON.parse(readFileSync(resolve(clientRoot, 'apps/desktop/.runtime/.sidecar-info.json'), 'utf8')).token
  const html = await (await fetch(dom.href)).text()
  const jsHref = /src="([^"]+\.js)"/.exec(html)?.[1]
  const js = jsHref ? await (await fetch(new URL(jsHref, dom.href))).text() : ''
  check('the boot token is in neither the HTML nor the JS bundle',
    js.length > 0 && !html.includes(token) && !js.includes(token), `html ${html.length}B, js ${js.length}B`)

  // 4. the privileged-surface claims in main.mjs, measured rather than asserted.
  const nodeInRenderer = await evaluate(`[typeof process, typeof require, typeof module].join('/')`)
  check('no Node in the renderer (nodeIntegration:false held)', nodeInRenderer === 'undefined/undefined/undefined', nodeInRenderer)
  const cspish = await evaluate(`typeof window.chrome?.loadTimes === 'function' ? 'electron-api-present' : 'no-extra-api'`)
  console.log(`  i renderer chrome API surface: ${cspish}`)

  // 5. navigation pinning: a cross-origin top-level navigation must not leave the shell.
  const navBlock = await evaluate(`(async () => {
    const before = location.href;
    try { window.location.assign('https://example.com/'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1200));
    return JSON.stringify({ before, after: location.href });
  })()`).then((s) => JSON.parse(s))
  const stayed = new URL(navBlock.before).origin === new URL(navBlock.after).origin
  check('cross-origin navigation did not take the window away', stayed, `${navBlock.before} → ${navBlock.after}`)

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
  check('hide-to-tray / show-from-tray / close-goes-to-tray all held',
    /hideToTray=true/.test(selftest ?? '') && /showFromTray=true/.test(selftest ?? '') && /closeGoesToTray=true/.test(selftest ?? ''),
    selftest ?? 'no TRAY-SELFTEST line')

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

  verdict = { dom, health, nodeInRenderer, stayed, trayLine, selftest }
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
