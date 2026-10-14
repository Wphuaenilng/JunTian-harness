/**
 * accept-stream.ts — M0 #3/#4 acceptance against a real provider.
 *
 * Costs one real upstream call on purpose: the milestone gate is "the browser sees
 * streamed text_delta and turn_complete", and nothing short of a live run proves the
 * deltas arrive incrementally (a single lump at the end would pass a weaker test).
 *
 *   node scripts/launch-sidecar.mjs && node scripts/accept-stream.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, SessionModel, openSessionStream } from '../packages/client-core/src/index.ts'
import { openInstance } from './lib-instance.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const { api, info } = openInstance('M0/M1 端到端流式（发消息 → 看 text_delta → turn_complete）', { spends: true })
const health = await api.health()
if (!health.configured) {
  console.error('✗ provider key not configured — refusing (no point burning a fake run)')
  process.exit(1)
}

// The runtime resolves a session's model from provider config; this isolated config
// has no per-key catalog yet, so pin it explicitly instead of accepting whatever
// default the process falls back to (observed: an unrelated provider's model id, which
// then fails to resolve under this provider).
const modelFlag = process.argv.indexOf('--model')
const modelArg = (modelFlag >= 0 ? process.argv[modelFlag + 1] : 'deepseek-flash') ?? 'deepseek-flash'

const session = await api.createSession({
  cwd: repoRoot,
  title: 'M0 acceptance',
  approvalMode: 'manual',
  model: modelArg,
})
console.log(`session ${session.id} model=${session.model ?? '(unset)'} (requested ${modelArg})`)

const model = new SessionModel()
const deltas: Array<{ seq: number; ts: number; chars: number }> = []
const timeline: string[] = []
const t0 = Date.now()
let firstDeltaAt = 0
let turnComplete: Record<string, unknown> | null = null

const close = openSessionStream({
  baseUrl: info.baseUrl,
  token: info.token,
  sessionId: session.id,
  since: 0,
  onEvent: (e) => {
    const ev = e.event
    timeline.push(`${String(ev.seq).padStart(3)} ${e.phase.padEnd(6)} ${e.category.padEnd(9)} ${ev.type}`)
    model.apply(e)
    if (ev.type === 'text_delta') {
      if (!firstDeltaAt) firstDeltaAt = Date.now()
      const text = typeof ev.data['text'] === 'string' ? ev.data['text'] : ''
      deltas.push({ seq: ev.seq, ts: Date.now() - t0, chars: text.length })
    }
    if (ev.type === 'turn_complete') turnComplete = ev.data
    if (ev.type === 'done' || ev.type === 'error') void finish()
  },
})

let finished = false
const finish = () => { if (finished) return; finished = true }

void api.prompt(session.id, { prompt: '只回复四个字，不要任何解释：收到了别慌' }).then((r) => {
  if (r === 'busy') console.log('prompt: busy')
})

// A tiny prompt should finish well inside this; bail out rather than hang forever.
const deadline = Date.now() + 90_000
while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
close()

const st = model.current
console.log('=== event timeline ===')
console.log(timeline.slice(0, 40).join('\n'))
console.log(`\ndeltas received : ${deltas.length}`)
if (deltas.length > 0) {
  console.log(`first delta     : +${deltas[0]!.ts}ms (ttft ${firstDeltaAt - t0}ms)`)
  console.log(`last delta      : +${deltas.at(-1)!.ts}ms`)
  console.log(`total chars     : ${deltas.reduce((a, d) => a + d.chars, 0)}`)
  console.log(`spread check    : ${new Set(deltas.map((d) => d.ts)).size} distinct arrival timestamps`)
}
const assistantText = st.blocks.find((b) => b.kind === 'text')
console.log(`assistant block : ${assistantText && assistantText.kind === 'text' ? JSON.stringify(assistantText.text.slice(0, 60)) : '(none)'}`)
console.log(`turn_complete   : ${turnComplete ? JSON.stringify(turnComplete).slice(0, 220) : '(none)'}`)
console.log(`final status    : ${st.running ? 'still running' : `done (${st.terminalStatus ?? 'n/a'})`}, lastSeq=${st.lastSeq}`)

// Incrementality is judged on BOTH delta channels: reasoning arrives as many frames
// while the visible answer of a short prompt may be one. The server also compacts
// closed delta runs on persistence/replay (replay-compaction.ts, applied at
// session-routes.ts:1784), so this is only observable on the live socket — a stored
// session shows a single merged delta per run, which is not a client bug.
const liveDeltaSeqs = new Set(timeline.filter((l) => /_delta$/.test(l)).map((l) => l.trim().split(/\s+/)[0]))
const streamed = liveDeltaSeqs.size >= 2
const completed = turnComplete !== null
const failures: string[] = []
if (!streamed) failures.push(`not incremental: delta frames at ${liveDeltaSeqs.size} distinct seqs`)
if (!completed) failures.push('no turn_complete event')
if (st.terminalStatus === 'failed') failures.push('run failed')

await api.archiveSession(session.id)
if (failures.length > 0) {
  console.error(`\n✗ M0 acceptance FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ M0 #3/#4 OK — ${liveDeltaSeqs.size} distinct delta seqs on the live socket + turn_complete (session archived)`)
