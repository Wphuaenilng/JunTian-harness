#!/usr/bin/env node
/**
 * verify-desktop-store.mjs — does the desktop shell's sidecar actually have a working session store?
 *
 * Why this exists: the shell runs its child scripts as `electron.exe` with
 * `ELECTRON_RUN_AS_NODE=1` (documented in main.mjs — inside Electron `process.execPath` is
 * the app binary, not node). That is fine for two pure-JS scripts. It is NOT fine for the
 * daemon the launcher hands off to, because the kernel loads a native better-sqlite3 build
 * compiled for Node's ABI. Observed on 2026-10-10 in the desktop sidecar log:
 *
 *   Session registry schema failed: ... NODE_MODULE_VERSION 137 vs 149  (ERR_DLOPEN_FAILED)
 *
 * and `/health` kept answering 200 with `readiness=ready` anyway — so READY, the tray, the
 * single-instance lock and the same-origin proxy all stayed green while the thing that
 * remembers sessions could not create its own tables. A smoke test that stops at "the API
 * answered" cannot see that. So this asks the question a user would feel:
 *
 *   1. which runtime did the daemon actually get, and is the log free of ABI/schema failures;
 *   2. create a session through the shell's own sidecar, list it back, read it back.
 *
 * The probe session is archived afterwards so the desktop store does not keep a test row.
 *
 *   node scripts/verify-desktop-store.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(clientRoot, 'apps/desktop')
const scriptsDir = resolve(clientRoot, 'scripts')
const stateDir = resolve(desktopDir, '.runtime')
const infoPath = resolve(stateDir, '.sidecar-info.json')
const logPath = resolve(stateDir, '.sidecar.log')
const electronBin = (() => {
  const marker = resolve(desktopDir, 'node_modules/electron', 'path.txt')
  if (!existsSync(marker)) return null
  const p = resolve(desktopDir, 'node_modules/electron', 'dist', readFileSync(marker, 'utf8').trim())
  return existsSync(p) ? p : null
})()

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')

if (!electronBin) {
  console.error('electron binary missing — see apps/desktop/README.md (mirror install notes)')
  process.exit(1)
}
// Start from an empty daemon log so nothing from a previous boot can be mistaken for this one.
if (existsSync(logPath)) execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "")', logPath])

const shell = spawn(electronBin, [desktopDir, '--smoke', '90', '--isolate-home'], {
  cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let shellLog = ''
shell.stdout.on('data', (b) => { shellLog += b.toString(); process.stdout.write(`[shell] ${b}`) })
shell.stderr.on('data', (b) => { shellLog += b.toString() })

let info = null
let probeId = null
try {
  let ready = false
  for (let i = 0; i < 80 && !ready; i++) {
    ready = /READY /.test(shellLog)
    if (!ready) await sleep(500)
  }
  check('shell booted (READY)', ready, shellLog.split('\n').find((l) => l.startsWith('READY'))?.slice(0, 70) ?? 'no READY line')
  if (!ready) throw new Error('shell never became ready')

  info = JSON.parse(readFileSync(infoPath, 'utf8'))
  const daemonLine = shellLog.split('\n').find((l) => /\[boot\] daemon:/.test(l)) ?? ''
  check('launcher says which runtime the daemon got', /daemon: .*node/i.test(daemonLine) && !/electron\.exe/i.test(daemonLine),
    daemonLine.replace('[boot] ', '').trim() || 'no daemon runtime line reported')

  const sidecarLog = readLog()
  const broken = ['Session registry schema failed', 'ERR_DLOPEN_FAILED', 'NODE_MODULE_VERSION'].filter((s) => sidecarLog.includes(s))
  check('sidecar log is free of native-module / schema failures', broken.length === 0,
    broken.join(' + ') || `log ${sidecarLog.length}B, clean`)

  const auth = { authorization: `Bearer ${info.token}` }
  const created = await fetch(`${info.baseUrl}/sessions`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: clientRoot, title: 'client-store-probe' }),
  })
  const createdBody = await created.json().catch(() => ({}))
  probeId = createdBody.id ?? null
  check('POST /sessions → 201 with an id', created.status === 201 && Boolean(probeId), `${created.status} ${probeId ?? JSON.stringify(createdBody).slice(0, 80)}`)

  const list = await fetch(`${info.baseUrl}/sessions?includeArchived=true`, { headers: auth })
  const listBody = await list.json().catch(() => ({}))
  const ids = (listBody.sessions ?? []).map((s) => s.id)
  check('the new session comes back from GET /sessions (registry works)', list.status === 200 && ids.includes(probeId),
    `listed ${ids.length}`)

  const one = await fetch(`${info.baseUrl}/sessions/${probeId}`, { headers: auth })
  const oneBody = await one.json().catch(() => ({}))
  check('GET /sessions/:id reads it back with its title', one.status === 200 && (oneBody.session?.title ?? oneBody.title) === 'client-store-probe',
    `${one.status} title=${JSON.stringify(oneBody.session?.title ?? oneBody.title ?? null)}`)

  // 归档就是 DELETE /sessions/:id（软关闭，`sidecar-client.ts:167` 的 archiveSession）。
  // 我先猜了 POST …/archive，打出 404 —— 路由要以客户端已有的方法为准，不是以我的印象为准。
  const archived = await fetch(`${info.baseUrl}/sessions/${probeId}`, { method: 'DELETE', headers: auth })
  check('probe session archived (desktop store stays clean)', archived.status >= 200 && archived.status < 300, `${archived.status}`)
} catch (e) {
  check('desktop store verification completed', false, e.message)
} finally {
  // Windows: Electron spawns a wrapper, so SIGTERM can leave the app running. taskkill /T
  // is the same teardown launch-sidecar.mjs uses for the sidecar itself.
  try { execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(shell.pid), '/T', '/F']) } catch { /* already gone */ }
  await sleep(600)
  const stop = spawn(process.execPath, [resolve(scriptsDir, 'launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'], { cwd: clientRoot, stdio: 'ignore' })
  await new Promise((r) => { stop.once('exit', r); setTimeout(r, 8_000) })
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  const l = readLog()
  if (l) console.error(`--- sidecar log head ---\n${l.split('\n').slice(0, 12).join('\n')}`)
  process.exit(1)
}
console.log('\ndesktop session store verified end to end')
