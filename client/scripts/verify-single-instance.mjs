#!/usr/bin/env node
/**
 * verify-single-instance.mjs — the M3 单实例锁, measured rather than read off.
 *
 * The lock is the shell's defence against the one failure the plan calls 高（必踩）: two
 * writers on the same session store. `main.mjs` asked for the lock before booting, which
 * looked right — but "looked right" is exactly how the tray icon nearly shipped undecoded.
 * So this starts a real second copy and watches what happens:
 *
 *   1. instance A boots, prints READY, and records its sidecar in .sidecar-info.json;
 *   2. instance B must refuse *before* booting — no second spawn, no rewrite of the info
 *      file (same token, same port, same sidecar pid, same mtime);
 *   3. A must log that it received the second-instance event and raised its window;
 *   4. A must still be alive afterwards, still the only owner.
 *
 * Nothing here costs an upstream call: the shell boots its sidecar keyless-safe against
 * the desktop state dir and no prompt is ever sent.
 *
 *   node scripts/verify-single-instance.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(clientRoot, 'apps/desktop')
const scriptsDir = resolve(clientRoot, 'scripts')
const electronPkg = resolve(desktopDir, 'node_modules/electron')
const infoFile = resolve(desktopDir, '.runtime/.sidecar-info.json')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronBinary() {
  const marker = resolve(electronPkg, 'path.txt')
  if (!existsSync(marker)) return null
  const p = resolve(electronPkg, 'dist', readFileSync(marker, 'utf8').trim())
  return existsSync(p) ? p : null
}

const bin = electronBinary()
if (!bin) {
  console.error('electron binary not found under apps/desktop/node_modules/electron/dist —')
  console.error('  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ corepack pnpm install')
  process.exit(1)
}

/** Both copies get the same arguments on purpose: same app, same userData, same lock. */
function launch(tag, smokeSeconds) {
  const child = spawn(bin, [desktopDir, '--smoke', String(smokeSeconds)], {
    cwd: clientRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let log = ''
  let exitCode = null
  child.stdout.on('data', (b) => { log += b.toString(); process.stdout.write(`[${tag}] ${b}`) })
  child.stderr.on('data', (b) => { log += b.toString() })
  child.once('exit', (code) => { exitCode = code })
  return {
    child,
    get log() { return log },
    get exitCode() { return exitCode },
    get alive() { return exitCode === null },
  }
}
const readInfo = () => {
  const j = JSON.parse(readFileSync(infoFile, 'utf8'))
  return { token: j.token, port: j.port, pid: j.pid, baseUrl: j.baseUrl, mtime: statSync(infoFile).mtimeMs }
}

let first = null
let second = null
try {
  first = launch('A', 120)

  let ready = false
  for (let i = 0; i < 80 && !ready && first.alive; i++) {
    if (/READY /.test(first.log)) ready = true
    else if (/SINGLE-INSTANCE refused/.test(first.log)) break
    else await sleep(500)
  }
  if (!ready) {
    check('instance A booted', false, /refused/.test(first.log)
      ? 'another shell already holds the lock — close the running 天枢 window and rerun'
      : 'no READY line in 40s')
    throw new Error('instance A never became ready')
  }
  check('instance A holds the lock and booted', /SINGLE-INSTANCE acquired/.test(first.log),
    first.log.split('\n').find((l) => l.startsWith('READY'))?.slice(0, 78) ?? '')

  const before = readInfo()
  check('the sidecar of record is A’s own', Boolean(before.token && before.pid),
    `port=${before.port} pid=${before.pid}`)

  second = launch('B', 120)

  let gone = false
  for (let i = 0; i < 60 && !gone; i++) {
    gone = !second.alive
    if (!gone) await sleep(500)
  }
  check('instance B exited on its own', gone, gone ? `exit=${second.exitCode}` : 'still running after 30s')
  check('instance B refused before booting (no second sidecar, no second window)',
    /SINGLE-INSTANCE refused/.test(second.log) && !/READY /.test(second.log) && !/SINGLE-INSTANCE acquired/.test(second.log),
    second.log.split('\n').find((l) => l.startsWith('SINGLE-INSTANCE'))?.trim() ?? 'no SINGLE-INSTANCE line')
  check('instance B quit with a clean code, not a crash', second.exitCode === 0, `exit=${second.exitCode}`)
  check('instance A was told about it and raised its window', /SECOND-INSTANCE shown=true/.test(first.log),
    first.log.split('\n').find((l) => l.startsWith('SECOND-INSTANCE'))?.trim() ?? 'no SECOND-INSTANCE line')

  const after = readInfo()
  check('the info file is byte-for-byte the same record (nobody rewrote the port/token)',
    before.token === after.token && before.port === after.port && before.pid === after.pid && before.mtime === after.mtime,
    `pid ${before.pid} → ${after.pid}, port ${before.port} → ${after.port}`)
  check('instance A is still the only owner afterwards', first.alive, first.alive ? 'alive' : `exit=${first.exitCode}`)
} catch (e) {
  if (e.message !== 'instance A never became ready') check('verification completed', false, e.message)
} finally {
  for (const inst of [second, first]) {
    if (inst?.alive) inst.child.kill('SIGTERM')
  }
  await sleep(500)
  if (first?.alive) first.child.kill('SIGKILL')
  // SIGTERM does not run Electron's quit handlers, so the detached sidecar would be
  // stranded holding the StoreLock. Reclaim it exactly like verify-desktop.mjs does.
  const stop = spawn(process.execPath, [resolve(scriptsDir, 'launch-sidecar.mjs'), '--state-dir', resolve(desktopDir, '.runtime'), '--stop'], { cwd: clientRoot, stdio: 'ignore' })
  await new Promise((r) => { stop.once('exit', r); setTimeout(r, 8_000) })
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\nsingle-instance lock verified: second copy refused, first copy stayed owner')
