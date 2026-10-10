#!/usr/bin/env node
/**
 * launch-sidecar.mjs — M0 #1: frozen sidecar launch recipe.
 *
 * Encodes the three pitfalls from the plan (§5.2) that bite every first run:
 *   1. StoreLock is single-writer — an isolated RIVET_DESKTOP_DIR keeps this
 *      client's session library away from the official desktop's (~/.rivet/desktop),
 *      otherwise startup rehydrate marks the desktop's live sessions aborted and
 *      both processes fight over sidecar.lock.
 *   2. CORS reflect-only-allowlist — dev origins must be explicit (--cors-origin).
 *   3. token must not leak to the webview — random per boot, handed to the
 *      same-origin proxy only, never baked into a client bundle.
 *
 * Writes .sidecar-info.json (gitignored) for serve-client.mjs to pick up.
 * Run with --follow to stay resident; otherwise it detaches and exits 0.
 */
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, rmSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform } from 'node:os'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')

/**
 * One `--state-dir` moves both bookkeeping files together. Defaults to `client/`, i.e.
 * byte-identical to every existing caller. The desktop shell needs its own because two
 * sidecars cannot share one `.sidecar-info.json` (last writer wins, and `--stop` would
 * kill the wrong pid) nor one log the other process is still holding open.
 */
function statePaths(stateDir) {
  const dir = stateDir ? resolve(stateDir) : clientRoot
  return { infoPath: join(dir, '.sidecar-info.json'), logPath: join(dir, '.sidecar.log') }
}

function parseArgs(argv) {
  const out = { port: 0, desktopDir: '', config: '', corsOrigins: [], stop: false, timeoutMs: 30_000, stateDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--desktop-dir') out.desktopDir = resolve(argv[++i])
    else if (a === '--state-dir') out.stateDir = argv[++i]
    else if (a === '--config') out.config = resolve(argv[++i])
    else if (a === '--cors-origin') out.corsOrigins.push(argv[++i])
    else if (a === '--stop') out.stop = true
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i])
    else throw new Error(`unknown flag: ${a}`)
  }
  return out
}

/** Default isolation lives next to the client, not in the user's home dir. */
function defaultDesktopDir() {
  return join(clientRoot, '.sidecar-data')
}

/**
 * The daemon is a **Node** program, and this launcher is not always one.
 *
 * `apps/desktop/src/main.mjs` spawns its child scripts as `electron.exe` with
 * `ELECTRON_RUN_AS_NODE=1`, because inside Electron `process.execPath` is the app binary.
 * That is right for two pure-JS scripts and wrong for the hand-off: if the daemon inherits
 * that binary it runs on Electron's ABI, and the kernel's native better-sqlite3 build then
 * refuses to load — observed 2026-10-10 as `Session registry schema failed: …
 * NODE_MODULE_VERSION 137 vs 149` (ERR_DLOPEN_FAILED) in the sidecar log, while `/health`
 * kept answering `readiness=ready`. Nothing above the log line looks broken.
 *
 * So: when we are electron-as-node, go find a real node, insist on the kernel's engines
 * floor, and say out loud which runtime the daemon got.
 */
function daemonRuntime() {
  if (!process.env.ELECTRON_RUN_AS_NODE) {
    return { bin: process.execPath, version: `v${process.versions.node}`, why: 'inherited' }
  }
  const exe = platform() === 'win32' ? 'node.exe' : 'node'
  const candidates = [process.env.RIVET_NODE_BIN, ...(process.env.PATH || '').split(delimiter).filter(Boolean).map((d) => join(d, exe))]
    .filter((p) => p && existsSync(p))
  const seen = []
  for (const bin of candidates) {
    let version = ''
    try { version = execFileSync(bin, ['-v'], { encoding: 'utf8' }).trim() } catch { continue }
    seen.push(`${bin}=${version}`)
    if (Number(/v(\d+)/.exec(version)?.[1] ?? '0') >= 24) return { bin, version, why: 'electron-as-node' }
  }
  throw new Error(
    `the sidecar needs a real Node >= 24 and this launcher is running as electron-as-node. `
    + `Set RIVET_NODE_BIN to a node 24 binary (candidates seen: ${seen.join(', ') || 'none'})`,
  )
}

function pickFreePort() {
  return new Promise((rs, rj) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      s.close(() => (port > 0 ? rs(port) : rj(new Error('failed to allocate port'))))
    })
    s.on('error', rj)
  })
}

async function waitHealthy(baseUrl, token, child, spawnErrRef, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (spawnErrRef.err) throw spawnErrRef.err
    if (child.exitCode !== null) throw new Error(`sidecar exited early (code ${child.exitCode}) — see ${logPath}`)
    let probe
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      })
      probe = await res.json().catch(() => undefined)
      if (res.ok && probe?.readiness === 'ready') return probe
    } catch {
      // not up yet
    }
    // A process that is up but self-reports failed readiness will never recover
    // by waiting, so classify it now instead of burning the whole timeout.
    if (probe?.readiness === 'failed') {
      const holder = probe.storeLockHolder
      const holderText = holder?.pid ? ` — holder pid ${holder.pid}${holder.hostname ? ` @ ${holder.hostname}` : ''}` : ''
      throw new Error(`sidecar initialization failed (${probe.initializationError ?? 'unknown'}${holderText})`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`health timeout after ${timeoutMs}ms — see ${logPath}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const { infoPath, logPath } = statePaths(opts.stateDir)
  if (opts.stop) return stopRecorded(infoPath)
  const port = opts.port > 0 ? opts.port : await pickFreePort()
  const token = randomBytes(24).toString('hex')
  const baseUrl = `http://127.0.0.1:${port}`
  const desktopDir = opts.desktopDir || defaultDesktopDir()
  mkdirSync(desktopDir, { recursive: true })

  const entry = join(repoRoot, 'dist', 'cli', 'entry.js')
  if (!existsSync(entry)) throw new Error(`built CLI not found at ${entry} — run npm run build in ${repoRoot}`)

  const env = {
    ...process.env,
    RIVET_SERVER_TOKEN: token,
    RIVET_DESKTOP_DIR: desktopDir,
  }
  // Provider credentials belong to a config file OUTSIDE the repo: the runtime's own
  // root is %LOCALAPPDATA%\.rivet, and a repo-local config.json is not gitignored, so
  // "just put config.json next to the app" is how keys end up in a public projection.
  // RIVET_CONFIG_PATH wins over that default (src/config/paths.ts:38), so the isolated
  // data dir can hold it. Never log the path's contents.
  const configPath = opts.config || join(desktopDir, 'config.json')
  if (existsSync(configPath)) {
    env.RIVET_CONFIG_PATH = configPath
    console.log(`config: ${configPath}`)
  } else {
    console.log(`config: none at ${configPath} — sidecar starts in setup mode (no key)`)
  }
  // Dev-origin switch is additive to the server's tauri-only reflect list.
  const origins = [...opts.corsOrigins]
  if (origins.length > 0) env.RIVET_DEV_CORS_ORIGINS = origins.join(',')

  // detached:true — without it the sidecar belongs to this launcher's console
  // group and dies when the launcher exits (observed on Windows: log stops dead
  // at "listening", no crash). File fds rather than pipes for the same reason.
  // Never hand the daemon to electron.exe — see daemonRuntime(). This also means a desktop
  // boot on a machine without a Node >= 24 on PATH fails here, loudly, with the fix in the
  // message, instead of booting a kernel whose session registry silently cannot build tables.
  const runtime = daemonRuntime()
  delete env.ELECTRON_RUN_AS_NODE
  console.log(`daemon: ${runtime.bin} (${runtime.version}, ${runtime.why})`)
  const logFd = openSync(logPath, 'w')
  const child = spawn(runtime.bin, [entry, 'serve', '--port', String(port)], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', logFd, logFd],
    shell: false,
    windowsHide: true,
    detached: true,
  })
  closeSync(logFd)
  const spawnErrRef = { err: undefined }
  child.on('error', (err) => {
    spawnErrRef.err = err.code === 'ENOENT' ? new Error(`cannot spawn node: ${err.message}`) : err
  })

  const health = await waitHealthy(baseUrl, token, child, spawnErrRef, opts.timeoutMs)

  const info = {
    port,
    token,
    baseUrl,
    pid: child.pid,
    desktopDir,
    startedAt: new Date().toISOString(),
    protocolVersion: health.protocolVersion,
    capabilities: health.capabilities,
    version: health.version,
    configured: health.configured,
    logPath,
  }
  writeFileSync(infoPath, JSON.stringify(info, null, 2))
  console.log(`sidecar ready  ${baseUrl}  (pid ${child.pid}, protocolVersion ${health.protocolVersion}, desktopDir ${desktopDir})`)
  if (health.configured === false) {
    console.log('note: no provider API key configured — sessions will 4xx on /prompt until one is set.')
  }
  console.log(`info written   ${infoPath}`)

  // The sidecar outlives this launcher by design: whoever needs it reads
  // .sidecar-info.json (serve-client.mjs, the health probe, the UI dev server).
  child.unref()
  console.log(`logs: ${logPath}\nstop: node scripts/launch-sidecar.mjs --stop`)
}

/** Stop the sidecar recorded in the state dir's info file — kills by PID only, never by image name. */
async function stopRecorded(infoPath) {
  if (!existsSync(infoPath)) {
    console.log('no .sidecar-info.json — nothing to stop')
    return
  }
  const info = JSON.parse(readFileSync(infoPath, 'utf8'))
  await killTree(info.pid)
  // A stale file pointing at a recycled pid is worse than no file at all.
  rmSync(infoPath, { force: true })
  console.log(`stopped sidecar pid ${info.pid}`)
}

/** Windows spawns a wrapper process; /T kills the whole tree, /F is the only reliable signal. */
function killTree(pid) {
  return new Promise((rs) => {
    if (!pid) return rs()
    if (platform() === 'win32') {
      try {
        execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch { /* already gone */ }
      return rs()
    }
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    return rs()
  })
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
