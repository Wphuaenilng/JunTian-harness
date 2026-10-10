/**
 * accept-reconnect.ts — MVP DoD: "断网 10 秒恢复后事件不丢不重" (plan §9).
 *
 * Costs no provider call: it exercises the reconnect contract on a session that
 * already holds real events (seq 1..N from earlier runs). The sidecar replays from
 * `?since=`, and client-core must drop duplicates and never let a seq=0 synthetic
 * event move the cursor.
 *
 *   node scripts/launch-sidecar.mjs && node scripts/accept-reconnect.ts [sessionId]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, openSessionStream } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const sessions = await api.listSessions({ includeArchived: true })
// Any session with events works; prefer one that is not this script's own leftovers.
let target = process.argv[2]
  ? sessions.find((s) => s.id === process.argv[2])
  : sessions.filter((s) => s.lastSeq > 2).sort((a, b) => b.lastSeq - a.lastSeq)[0]

if (!target) {
  console.error('✗ no session with events to replay — nothing to test')
  process.exit(1)
}
console.log(`session ${target.id} title="${target.title}" lastSeq=${target.lastSeq}`)

const authoritative = await api.events(target.id, 0)
const expected = authoritative.events.filter((e) => e.seq > 0).map((e) => e.seq)
console.log(`server says ${expected.length} timeline events, seq ${Math.min(...expected)}..${Math.max(...expected)}`)

// Phase 1: connect and cut the socket in the MIDDLE of the replay window — dropping
// after the window already completed would prove nothing about resumption.
const received: number[] = []
const metaSeen: number[] = []
const CUT_AT = 3

await new Promise<void>((rs) => {
  const close = openSessionStream({
    baseUrl: info.baseUrl,
    token: info.token,
    sessionId: target!.id,
    since: 0,
    onEvent: (e) => {
      if (e.event.seq === 0) metaSeen.push(0)
      else received.push(e.event.seq)
      if (received.length >= CUT_AT) {
        close()
        rs()
      }
    },
  })
  setTimeout(() => { close(); rs() }, 5000)
})
const beforeDrop = [...received]
let generations = 1
console.log(`phase 1 (cut after ${beforeDrop.length} events): seq [${beforeDrop.join(',')}]`)
if (beforeDrop.length < CUT_AT) {
  console.error(`\n✗ fixture too small — only ${beforeDrop.length} events available before the cut`)
  process.exit(1)
}

// Phase 2: "network back" — reconnect from the recorded cursor, like the real client does.
const lastSeq = Math.max(0, ...beforeDrop)
await new Promise<void>((rs) => {
  const close = openSessionStream({
    baseUrl: info.baseUrl,
    token: info.token,
    sessionId: target.id,
    since: lastSeq,
    onEvent: (e) => { if (e.event.seq > 0) received.push(e.event.seq) },
  })
  generations += 1
  setTimeout(() => { close(); rs() }, 2500)
})
console.log(`phase 2 (resumed at since=${lastSeq}): total seq [${received.join(',')}]`)

const sorted = [...received].sort((a, b) => a - b)
const dupes = received.filter((s, i) => received.indexOf(s) !== i)
const missing = expected.filter((s) => !received.includes(s))

console.log(`\nsynthetics(seq=0) seen : ${metaSeen.length}`)
console.log(`duplicates             : ${dupes.length ? `[${dupes.join(',')}]` : 'none'}`)
console.log(`missing                : ${missing.length ? `[${missing.join(',')}]` : 'none'}`)

const failures: string[] = []
if (expected.length < 3) failures.push(`fixture too small (${expected.length} events) to prove anything`)
if (dupes.length > 0) failures.push(`duplicate delivery after reconnect: ${dupes.join(',')}`)
if (missing.length > 0) failures.push(`lost events after reconnect: ${missing.join(',')}`)
if (sorted.at(-1)! < lastSeq) failures.push(`cursor advanced past received events`)

if (failures.length > 0) {
  console.error(`\n✗ reconnect check FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ 断线重连不丢不重 — ${received.length} events, ${generations} generations, 0 dupes, 0 missing`)
