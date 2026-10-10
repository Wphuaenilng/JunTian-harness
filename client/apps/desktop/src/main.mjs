#!/usr/bin/env node
/**
 * main.mjs — the M3 desktop shell (plan §4.4: 起 sidecar → 同源伺服 → loadURL).
 *
 * It composes the two scripts the browser path already uses, as child processes,
 * instead of reimplementing them:
 *
 *   node ../../scripts/launch-sidecar.mjs   (random port + token, isolated store,
 *                                            health-gated, writes .sidecar-info.json)
 *   node ../../scripts/serve-client.mjs --port <free>   (static app + /api reverse
 *                                            proxy that injects Authorization)
 *
 * That is the whole point: one product path, and the shell adds nothing to the
 * protocol surface. The renderer is the same `apps/web` bundle the browser loads.
 *
 * Security posture, in order of how much it matters:
 *   - `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`, and **no
 *     preload at all**. The renderer needs no Node: it talks to 127.0.0.1 over HTTP.
 *     Every shell-side privilege we do not hand out is one the tool result cannot use.
 *   - navigation is pinned to our own loopback origin; `window.open` is denied rather
 *     than routed to the system browser, because a model-authored MCP App view is the
 *     thing most likely to try both.
 *   - the sidecar child is detached by design (Windows kills children with the
 *     launcher otherwise), so quitting the shell explicitly runs
 *     `launch-sidecar.mjs --stop`, which kills the recorded pid.
 *
 *   npm start                       # window
 *   npm run smoke                   # exits after N seconds; for the CDP probe
 *   npm run icon                    # regenerate assets/tray.png (no image library needed)
 *   electron . --smoke 12 --tray-check --remote-debugging-port=9223
 *
 * The tray is the shell's only piece of product behaviour that is not the web app: closing
 * the window hides it, because the sidecar this process owns keeps running (scheduled jobs,
 * an unfinished turn). 退出天枢 in the tray menu — and only that — is a real quit.
 */
import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// src → desktop → apps → client. Three levels: getting this wrong lands the shell
// looking for client/apps/scripts/*.mjs, which is the bug this comment exists to kill.
const clientRoot = resolve(here, '../../..')
const scripts = resolve(clientRoot, 'scripts')
const trayIconPath = resolve(here, '../assets/tray.png')

const smokeSeconds = (() => {
  const i = process.argv.indexOf('--smoke')
  return i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 12) : 0
})()
// verify-desktop.mjs asks the shell to exercise the tray code paths and report on stdout.
const trayCheck = process.argv.includes('--tray-check')

/** The sidecar child is a long-lived daemon; the serve child must die with us. */
let serveChild = null
let shuttingDown = false
/** Set only by the tray's 退出 / the smoke timer: it is what separates "close to tray"
 *  from "really quit" — without it the app could never be killed. */
let quitting = false
let tray = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => res(port))
    })
  })
}

/**
 * In Electron's main process `process.execPath` is *electron.exe*, so spawning it with a
 * script path would start a second copy of the app instead of running the script.
 * `ELECTRON_RUN_AS_NODE=1` is the documented switch that makes that same binary behave
 * as plain node — which is what both child scripts need, since they are node programs.
 */
function run(scriptArgs, opts = {}) {
  const child = spawn(process.execPath, scriptArgs, {
    cwd: clientRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    ...opts,
  })
  child.stdout.on('data', (b) => process.stdout.write(`[boot] ${b}`))
  child.stderr.on('data', (b) => process.stderr.write(`[boot!] ${b}`))
  child.on('error', (err) => console.error(`spawn failed: ${err.message}`))
  return child
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await sleep(150)
  }
  return false
}

/**
 * The shell keeps its own state and store directories so it can run next to a dev
 * browser session instead of fighting it for one `.sidecar-info.json` and one StoreLock.
 * Provider config is *shared* on purpose (same machine, same user): point at the dev
 * config when it exists so the desktop build is usable out of the box.
 */
const stateDir = resolve(here, '../.runtime')
const devConfig = resolve(clientRoot, '.sidecar-data/config.json')

function bootArgs() {
  const launcher = [resolve(scripts, 'launch-sidecar.mjs'), '--state-dir', stateDir, '--desktop-dir', resolve(stateDir, 'sidecar-data')]
  if (existsSync(devConfig)) launcher.push('--config', devConfig)
  return launcher
}

async function boot() {
  // A sidecar outlives its shell by design, so a crashed previous boot can leave one
  // holding the StoreLock — and the next boot would fail on it. Reclaim the recorded pid
  // first when the state dir still answers.
  const infoPath = resolve(stateDir, '.sidecar-info.json')
  if (existsSync(infoPath)) {
    try {
      const stale = JSON.parse(readFileSync(infoPath, 'utf8'))
      const res = await fetch(`${stale.baseUrl}/health`, { headers: { Authorization: `Bearer ${stale.token}` } })
      if (res.ok) {
        console.log('reclaiming sidecar left over from a previous boot')
        await new Promise((res2) => {
          const stop = run([resolve(scripts, 'launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'])
          stop.once('exit', () => res2())
          setTimeout(res2, 5_000)
        })
      }
    } catch {
      // dead info file: nothing to reclaim
    }
  }

  // 1. sidecar. launch-sidecar.mjs exits once /health says ready and leaves the
  //    daemon detached; the token/port land in this state dir's info file.
  const launcher = run(bootArgs())
  const launcherExit = await new Promise((res) => launcher.once('exit', (code) => res(code)))
  if (launcherExit !== 0) throw new Error(`launch-sidecar exited ${launcherExit}`)
  if (!existsSync(infoPath)) throw new Error(`${infoPath} missing after launch`)
  const info = JSON.parse(readFileSync(infoPath, 'utf8'))

  // 2. same-origin layer on its own free port. The app never sees the token; this
  //    process injects it into /api (see serve-client.mjs header).
  const port = await freePort()
  serveChild = run([resolve(scripts, 'serve-client.mjs'), '--port', String(port), '--state-dir', stateDir])
  serveChild.once('exit', (code) => {
    if (!shuttingDown) console.error(`serve-client exited early (${code})`)
  })
  const url = `http://127.0.0.1:${port}/`
  if (!(await waitForHttp(url, 20_000))) throw new Error(`serve-client did not answer on ${url}`)
  console.log(`READY ${url} sidecar=${info.baseUrl} protocol=${info.protocolVersion} readiness-gated boot ok`)
  return url
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1268,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0F1115',
    title: '天枢',
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // No preload: the renderer is a pure web app over loopback HTTP. A preload is the
      // usual place a shell accidentally widens its own attack surface.
      webviewTag: false,
      spellcheck: false,
    },
  })

  const origin = new URL(url).origin
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== origin) {
      e.preventDefault()
      console.error(`blocked navigation to ${target}`)
    }
  })
  // Subframes get the same pin: a frame from elsewhere is exactly what an
  // attacker-controlled document would try to introduce.
  win.webContents.on('will-frame-navigate', (e) => {
    if (new URL(e.url).origin !== origin) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // Denied rather than opened in the OS browser: the triggering content may well be a
    // tool result or an embedded MCP view.
    console.error(`blocked window.open ${target}`)
    return { action: 'deny' }
  })
  // Anything that still escapes to the network stays explicit.
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error(`did-fail-load ${code} ${desc}`))

  // The X button hides rather than destroys, because the sidecar this shell owns keeps
  // running scheduled jobs — quitting it by accident would kill the user's running turn.
  // `quitting` is the only thing that lets a real teardown through this gate.
  win.on('close', (e) => {
    if (quitting || tray === null) return
    e.preventDefault()
    win.hide()
    console.log('TRAY window closed → hidden to tray, sidecar still running')
  })

  void win.loadURL(url)
  return win
}

const showWindow = (win) => {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * Tray labels live in the main process, which cannot see the renderer's locale (that is
 * localStorage inside a sandboxed page), so they follow the OS locale instead. The
 * renderer still switches languages freely; this only titles the menu items.
 */
function createTray(win) {
  const image = nativeImage.createFromPath(trayIconPath)
  if (image.isEmpty()) {
    // No icon means no tray; the shell must still work, so degrade instead of throwing.
    console.error(`TRAY FAILED: ${trayIconPath} decoded to nothing (run scripts/make-icon.mjs)`)
    return null
  }
  const zh = (app.getLocale() || '').toLowerCase().startsWith('zh')
  const t = new Tray(image)
  t.setToolTip('天枢')
  const menu = Menu.buildFromTemplate([
    { label: zh ? '显示主窗口' : 'Show window', click: () => showWindow(win) },
    { label: zh ? '隐藏到托盘' : 'Hide', click: () => { if (!win.isDestroyed()) win.hide() } },
    { type: 'separator' },
    { label: zh ? '退出天枢' : 'Quit', click: () => { quitting = true; void app.quit() } },
  ])
  t.setContextMenu(menu)
  // Windows: single left click. macOS gets the same handler; the menu covers right-click.
  t.on('click', () => {
    if (win.isDestroyed()) return
    if (win.isVisible() && win.isFocused()) win.hide()
    else showWindow(win)
  })
  t.on('double-click', () => showWindow(win))
  const size = image.getSize()
  console.log(`TRAY created icon=${size.width}x${size.height} bytes=${image.toPNG().length} menu=${menu.items.length} items locale=${zh ? 'zh' : 'en'}`)
  return t
}

/** Drives the two functions the mouse would drive, and logs what actually happened. */
async function traySelfTest(win) {
  win.show()
  await sleep(250)
  const visibleBefore = win.isVisible()

  win.hide()
  await sleep(250)
  const hidden = !win.isVisible()

  showWindow(win)
  await sleep(250)
  const shown = win.isVisible()

  // The close gate is the part a headless run cannot click, so call it the way the window
  // manager would: hand the listener a cancelable event and read back what it did.
  let prevented = false
  win.emit('close', { preventDefault: () => { prevented = true } })
  await sleep(120)
  const closedToTray = prevented && !win.isDestroyed() && !win.isVisible()
  win.show()

  console.log(`TRAY-SELFTEST visible=${visibleBefore} hideToTray=${hidden} showFromTray=${shown} closeGoesToTray=${closedToTray}`)
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  if (serveChild && !serveChild.killed) serveChild.kill('SIGTERM')
  // The sidecar is detached on purpose, so it needs its own recorded-pid teardown.
  await new Promise((res) => {
    const stop = run([resolve(scripts, 'launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'])
    stop.once('exit', () => res())
    setTimeout(res, 4_000)
  })
}

// A second instance should focus the first, not start a second sidecar competing for
// the same StoreLock.
let primaryWindow = null
if (!app.requestSingleInstanceLock()) {
  // Loud on purpose: from outside, a refused instance and a crashed one look identical,
  // and "the second copy quit before it could boot a sidecar" is a claim that has to be
  // observable for the verifier to mean anything.
  console.log('SINGLE-INSTANCE refused — another shell holds the lock, quitting before boot')
  app.quit()
} else {
  console.log('SINGLE-INSTANCE acquired')
  if (process.platform === 'win32') app.setAppUserModelId('works.juntian.tianshu')
  // Registered before boot(): a second launch during the seconds the sidecar takes to come
  // up must still raise the window rather than be dropped on the floor.
  app.on('second-instance', () => {
    if (primaryWindow && !primaryWindow.isDestroyed()) {
      showWindow(primaryWindow)
      console.log('SECOND-INSTANCE shown=true')
    } else {
      console.log('SECOND-INSTANCE shown=false (no window yet — still holding the only lock)')
    }
  })

  app.whenReady().then(async () => {
    try {
      const url = await boot()
      const win = createWindow(url)
      primaryWindow = win
      tray = createTray(win)

      if (trayCheck) await traySelfTest(win)

      if (smokeSeconds > 0) {
        console.log(`SMOKE window up at ${url}; auto-quitting in ${smokeSeconds}s`)
        // `quitting` first: otherwise the close gate cancels the quit and the smoke run hangs.
        setTimeout(() => { quitting = true; void app.quit() }, smokeSeconds * 1000)
      }
    } catch (e) {
      console.error(`BOOT FAILED: ${e.message}`)
      await shutdown()
      app.exit(1)
    }
  })

  app.on('window-all-closed', () => void app.quit())
  // before-quit fires before Electron closes the windows, so this is what makes a
  // programmatic quit pass the close gate above instead of being cancelled into a
  // half-dead app that only the tray can finish off.
  app.on('before-quit', () => { quitting = true; void shutdown() })
  app.on('quit', () => { void shutdown() })
}
