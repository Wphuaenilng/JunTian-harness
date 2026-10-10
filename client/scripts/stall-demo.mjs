#!/usr/bin/env node
/**
 * stall-demo.mjs — hands the send-stall banner to a human to look at once.
 *
 * `node scripts/ci-smoke.mjs` already proves the upstream finding (a keyless POST /prompt
 * answers 200 {status:'running'} and then emits nothing), and `client-core/test/
 * stall-watch.test.ts` proves the client's rule over that fact. What neither can prove is
 * the *view*: the banner only appears in a browser, 20 s after a send whose timeline never
 * moved. So this script builds the safest possible place to trigger it and then does
 * nothing — no prompt is ever sent from here.
 *
 * Keyless is a fact here, not an assumption: an empty config file is written for this
 * process and pointed at with RIVET_CONFIG_PATH (the runtime's fallback root is the user's
 * real config dir), and `/health` must then report `configured:false` or the script refuses
 * to serve a UI that could spend money.
 *
 *   node scripts/stall-demo.mjs          # prints the URL, Ctrl-C to tear down
 *   node scripts/stall-demo.mjs --keep   # leave the sidecar running after exit
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = resolve(clientRoot, '.stall-demo')
const stateDir = join(tmp, 'state')
const dataDir = join(tmp, 'data')
const configPath = join(dataDir, 'config.json')
const infoPath = join(stateDir, '.sidecar-info.json')
const keep = process.argv.includes('--keep')

const run = (scriptArgs) => spawn(process.execPath, scriptArgs, {
  cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

async function stopSidecar() {
  await new Promise((res) => {
    const stop = run([join(clientRoot, 'scripts/launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'])
    stop.once('exit', res)
    setTimeout(res, 8_000)
  })
}

let serve = null
async function teardown() {
  if (serve !== undefined && serve !== null && !serve.killed) serve.kill('SIGTERM')
  if (!keep) {
    await stopSidecar()
    rmSync(tmp, { recursive: true, force: true })
  }
}

const bail = async (msg) => {
  console.error(`✗ ${msg}`)
  await teardown()
  process.exit(1)
}

rmSync(tmp, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(dataDir, { recursive: true })
writeFileSync(configPath, JSON.stringify({ provider: { providers: {} } }), { mode: 0o600 })

// A previous --keep boot leaves a detached sidecar holding the StoreLock.
if (existsSync(infoPath)) await stopSidecar()

const launcher = run([
  join(clientRoot, 'scripts/launch-sidecar.mjs'),
  '--state-dir', stateDir, '--desktop-dir', dataDir, '--config', configPath,
])
const launchOut = []
launcher.stdout.on('data', (b) => launchOut.push(b.toString()))
launcher.stderr.on('data', (b) => launchOut.push(b.toString()))
const launchExit = await new Promise((res) => launcher.once('exit', res))
if (launchExit !== 0) {
  console.error(launchOut.join('').split('\n').slice(-10).join('\n'))
  await bail(`keyless sidecar did not boot (exit ${launchExit})`)
}
if (!existsSync(infoPath)) await bail(`${infoPath} missing after launch`)
const info = JSON.parse(readFileSync(infoPath, 'utf8'))

const health = await (await fetch(`${info.baseUrl}/health`, {
  headers: { authorization: `Bearer ${info.token}` },
})).json().catch(() => ({}))
if (health.configured !== false) {
  await bail(`this boot is NOT keyless (configured=${String(health.configured)}) — refusing to hand over a UI that could spend money`)
}

const port = await freePort()
serve = run([join(clientRoot, 'scripts/serve-client.mjs'), '--port', String(port), '--state-dir', stateDir])
const url = `http://127.0.0.1:${port}/`
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(url)).ok) break } catch { /* not up yet */ }
  await sleep(150)
  if (i === 99) await bail(`serve-client did not answer on ${url}`)
}

console.log(`
keyless sidecar  ${info.baseUrl}   (configured=${health.configured}, readiness=${health.readiness})
same-origin UI   ${url}

To see the send-stall banner:
  1. open ${url} in a browser and 新建会话
  2. send any prompt — the sidecar accepts it (200 running) and the kernel emits nothing
  3. after ~20 s the status bar becomes 「已发出 20 秒，内核没有任何回音（seq 未推进）…」 and counts up

Nothing was sent by this script. Ctrl-C tears the sidecar and the temp dirs down
(--keep leaves the sidecar up so you can keep poking at the UI).
`)

process.on('SIGINT', () => { void teardown().then(() => process.exit(0)) })
process.on('SIGTERM', () => { void teardown().then(() => process.exit(0)) })
await new Promise(() => undefined)
