/**
 * probe-stream.ts — end-to-end check of client-core against a live sidecar.
 *
 * Needs no provider key: creating a session and opening /stream exercises auth,
 * REST envelopes, SSE framing, the seq=0 meta rule, the live-handoff marker and the
 * 56→5 categorization on real wire traffic. The LLM-dependent part (text_delta) is
 * M0 #3 and is gated on a configured key.
 *
 *   node scripts/launch-sidecar.mjs && node scripts/probe-stream.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, openSessionStream, PROTOCOL_VERSION } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')

/**
 * This probe **writes**: it creates a session and archives it. Pointed at the default info file it
 * therefore drives whatever sidecar the developer is currently using — which is exactly the instance
 * holding the user's real conversation store. So the isolated info file is now required, and the
 * default is opt-in: `--info=<state-dir>/.sidecar-info.json`, or `--use-default-info` when you
 * deliberately mean the live one.
 */
const infoArg = process.argv.find((a) => a.startsWith('--info='))?.slice('--info='.length)
const allowsDefault = process.argv.includes('--use-default-info')
if (infoArg === undefined && !allowsDefault) {
  console.error('✗ probe-stream 需要一个隔离的 info 文件：--info=<隔离 state-dir>/.sidecar-info.json')
  console.error('  （它建会话并归档，是写操作；默认路径指向你正在用的实例，要真打那里请显式加 --use-default-info）')
  process.exit(1)
}
const infoPath = resolve(infoArg ?? join(clientRoot, '.sidecar-info.json'))
console.log(`info file: ${infoPath}${infoArg === undefined ? '  ⚠ 显式选了默认（写进正在使用的实例）' : ''}`)
const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { baseUrl: string; token: string }

const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const health = await api.health()
console.log(`health: readiness=${health.readiness} protocolVersion=${health.protocolVersion} (mirror says ${PROTOCOL_VERSION}) capabilities=${JSON.stringify(health.capabilities)}`)
if (health.protocolVersion !== PROTOCOL_VERSION) {
  console.error('✗ protocolVersion mismatch between the mirror and the runtime — regenerate the mirror')
  process.exit(1)
}

const session = await api.createSession({
  cwd: repoRoot,
  title: 'client-core wire probe',
  approvalMode: 'manual',
})
console.log(`session: ${session.id} status=${session.status} lastSeq=${session.lastSeq} workspaceSource=${session.workspaceSource}`)

const seen: Array<{ seq: number; type: string; category: string; phase: string; gen: number }> = []
const phases: string[] = []

const close = openSessionStream({
  baseUrl: info.baseUrl,
  token: info.token,
  sessionId: session.id,
  since: 0,
  onPhase: (phase, generation) => {
    phases.push(`${phase}@g${generation}`)
  },
  onEvent: (e) => {
    seen.push({ seq: e.event.seq, type: e.event.type, category: e.category, phase: e.phase, gen: e.generation })
  },
})

// The connect burst (replay_window … approval_snapshot) lands well inside this.
await new Promise((r) => setTimeout(r, 3000))
close()

const rest = await api.interventions(session.id)
console.log(`interventions REST: approvals=${rest.approvals.length} lastSeq=${rest.lastSeq}`)

console.log(`phases: ${phases.join(' → ')}`)
console.log(`events (${seen.length}):`)
for (const s of seen) console.log(`  seq=${String(s.seq).padEnd(4)} gen=${s.gen} phase=${s.phase.padEnd(6)} ${s.category.padEnd(9)} ${s.type}`)

const metaCount = seen.filter((s) => s.seq === 0).length
const advancing = seen.filter((s) => s.seq > 0)
if (advancing.length > 0) {
  const seqs = advancing.map((s) => s.seq)
  const monotonic = seqs.every((v, i) => i === 0 || v > seqs[i - 1]!)
  console.log(`meta(seq=0)=${metaCount} timeline(seq>0)=${advancing.length} monotonic=${monotonic}`)
  if (!monotonic) {
    console.error('✗ seq order broken — dedupe logic is wrong')
    process.exit(1)
  }
} else {
  console.log(`meta(seq=0)=${metaCount} timeline(seq>0)=0 (fresh session has no events yet — expected)`)
}

if (!phases.some((p) => p.startsWith('live'))) {
  console.error('✗ never reached live — check the approval_snapshot handoff marker')
  process.exit(1)
}

/**
 * §4.3 #1 claims a specific connect sequence — `replay_window`（seq=0）→ 回放 → `approval_snapshot`
 * （seq=0）→ live. Until now the probe printed that burst and a human eyeballed it, so a runtime that
 * reordered the handoff (or a client that flipped to live early) would still print a tidy list and
 * exit 0. These are the falsifiable versions of the same claim.
 */
const TYPES = ['replay_window', 'approval_snapshot'] as const
const idxOf = (type: string): number => seen.findIndex((s) => s.type === type)
const first = idxOf(TYPES[0])
const handoff = idxOf(TYPES[1])
const lastTimeline = seen.reduce((acc, s, i) => (s.seq > 0 ? i : acc), -1)
const phaseOrder = ['connecting', 'replay', 'live'].map((p) => phases.findIndex((x) => x.startsWith(p)))
console.log(`connect sequence: first=${first < 0 ? '(none)' : seen[first]?.type} handoff=${handoff < 0 ? '(none)' : seen[handoff]?.type} `
  + `after them replayed=${seen.slice(0, handoff < 0 ? seen.length : handoff).filter((s) => s.seq > 0).length} `
  + `extras=${seen.filter((s) => s.seq === 0 && !TYPES.includes(s.type as typeof TYPES[number])).map((s) => s.type).join(',') || '(none)'}`)
if (seen.length < 2) {
  console.error(`✗ only ${seen.length} frame(s) captured — the ordering assertions below would be vacuous`)
  process.exit(1)
}
if (first !== 0) {
  console.error(`✗ §4.3 #1 says the connection opens with replay_window; got ${first < 0 ? 'no replay_window at all' : `it at index ${first}`} `
    + `(frame 0 was ${seen[0]?.type} seq=${seen[0]?.seq})`)
  process.exit(1)
}
if (seen[0]!.seq !== 0) {
  console.error(`✗ replay_window must arrive as a seq=0 meta event (got seq=${seen[0]!.seq}) — a nonzero one would move the cursor during connect`)
  process.exit(1)
}
if (handoff < 0) {
  console.error('✗ no approval_snapshot on this connection — the client would have to fall back to end-of-replay for live, so the marker claim is unverified')
  process.exit(1)
}
if (lastTimeline > handoff) {
  console.error(`✗ a timeline frame (index ${lastTimeline}, ${seen[lastTimeline]?.type} seq=${seen[lastTimeline]?.seq}) arrived after the handoff marker at ${handoff} — replay is not sealed before live`)
  process.exit(1)
}
if (!(phaseOrder[0]! >= 0 && phaseOrder[1]! > phaseOrder[0]! && phaseOrder[2]! > phaseOrder[1]!)) {
  console.error(`✗ phase order should be connecting → replay → live; got ${phases.join(' → ')}`)
  process.exit(1)
}
console.log('✓ §4.3 #1 connect sequence held on the wire: replay_window(seq=0) first, approval_snapshot(seq=0) last, no timeline frame after it, phases in order')

await api.archiveSession(session.id)
console.log(`\n✓ client-core OK against the live sidecar (probe session ${session.id} archived)`)
