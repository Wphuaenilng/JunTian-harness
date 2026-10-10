/**
 * probe-cockpit.ts — capture the real /cockpit payload before writing its renderer.
 *
 * Costs one small upstream call on purpose: the endpoint only answers while an agent
 * exists, so there is no way to learn its keys without a run. Everything printed here
 * is what the cockpit strip will be built against; nothing is guessed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, openSessionStream } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const session = await api.createSession({ cwd: repoRoot, title: 'cockpit probe', approvalMode: 'auto-safe' })
const captured: Array<{ at: string; body: Record<string, unknown> }> = []

const close = openSessionStream({
  baseUrl: info.baseUrl, token: info.token, sessionId: session.id, since: 0,
  onEvent: (e) => {
    if (e.event.type === 'done' || e.event.type === 'error') {
      captured.push({ at: 'on-' + e.event.type, body: {} })
      finish()
    }
  },
})

let done = false
const finish = (): void => { done = true }

void api.prompt(session.id, { prompt: '只回复两个字：收到' })

const started = Date.now()
while (!done && Date.now() - started < 90_000) {
  await new Promise((r) => setTimeout(r, 2500))
  try {
    const c = await api.cockpit(session.id)
    captured.push({ at: `+${Date.now() - started}ms`, body: c })
  } catch (e) {
    console.log(`  cockpit ${Math.round((Date.now() - started) / 1000)}s → ${(e as Error).message}`)
  }
}
close()

console.log(`\n=== ${captured.length} cockpit samples ===`)
const last = captured.filter((c) => Object.keys(c.body).length > 0).at(-1)
if (!last) {
  console.error('✗ never got a cockpit body — the strip cannot be built yet')
  await api.archiveSession(session.id)
  process.exit(1)
}
console.log('key inventory:')
for (const [k, v] of Object.entries(last.body)) {
  console.log(`  ${k.padEnd(22)} ${Array.isArray(v) ? `array[${v.length}]` : typeof v} = ${JSON.stringify(v).slice(0, 90)}`)
}
console.log(`\nfull sample (${last.at}):\n${JSON.stringify(last.body, null, 1).slice(0, 2000)}`)
await api.archiveSession(session.id)
console.log(`\n(probe session ${session.id} archived)`)
