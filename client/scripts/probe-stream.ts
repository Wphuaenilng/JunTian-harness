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
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }

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

await api.archiveSession(session.id)
console.log(`\n✓ client-core OK against the live sidecar (probe session ${session.id} archived)`)
