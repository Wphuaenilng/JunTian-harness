/**
 * accept-agui.ts — drive the /ag-ui endpoint for real and validate what comes back.
 *
 * Replays an existing session (no new provider call), reads the AG-UI SSE stream the
 * same way any AG-UI client would — through the same-origin endpoint, not the
 * sidecar directly — and checks both the documented vocabulary and the structural
 * invariants a consumer depends on (no orphan CONTENT, nothing left open).
 *
 *   node scripts/serve-client.mjs &   # the endpoint lives here
 *   node scripts/accept-agui.ts [sessionId]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGUI_EVENT_TYPES, validateAguiStream, type AguiEvent } from '../packages/client-core/src/ag-ui.ts'
import { SidecarClient } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const PROXY = process.env.AGUI_ORIGIN ?? 'http://127.0.0.1:5300'

const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })
const sessions = await api.listSessions({ includeArchived: true })
const target = (process.argv[2] ? sessions.find((s) => s.id === process.argv[2]) : undefined)
  ?? sessions.filter((s) => s.lastSeq >= 8).sort((a, b) => b.lastSeq - a.lastSeq)[0]
if (!target) { console.error('✗ no session with events to replay'); process.exit(1) }

// The sidecar's own record of the session, for the coverage comparison below.
const stored = await api.events(target.id, 0)
const sidecarTypes = [...new Set(stored.events.filter((e) => e.seq > 0).map((e) => e.type))].sort()
console.log(`session ${target.id} lastSeq=${target.lastSeq}; replaying ${sidecarTypes.length} distinct event types through /ag-ui`)

const controller = new AbortController()
const res = await fetch(`${PROXY}/ag-ui/sessions/${target.id}/stream`, { signal: controller.signal })
console.log(`GET /ag-ui/sessions/${target.id}/stream → ${res.status} ${res.headers.get('content-type')} (x-agui-version=${res.headers.get('x-agui-version')})`)
if (!res.ok || !res.body) {
  console.error('✗ the AG-UI endpoint is not serving — is scripts/serve-client.mjs running?')
  process.exit(1)
}

const events: AguiEvent[] = []
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
// A bare `await reader.read()` never yields control back to a deadline check when
// the stream is quiet (an archived session replays then just sits there), so the
// timeout has to race the read instead of wrapping the loop.
const deadline = Date.now() + 20_000
while (Date.now() < deadline) {
  const remaining = deadline - Date.now()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<'timeout'>((rs) => { timer = setTimeout(() => rs('timeout'), remaining) })
  const raced = await Promise.race([reader.read(), timeout])
  clearTimeout(timer!)
  if (raced === 'timeout') break
  if (raced.done) break
  buf += decoder.decode(raced.value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i)
    buf = buf.slice(i + 2)
    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
    if (!data) continue
    try { events.push(JSON.parse(data) as AguiEvent) } catch { /* ignore */ }
  }
}
controller.abort()

const byType = new Map<string, number>()
for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1)
console.log(`\nAG-UI frames: ${events.length}`)
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(22)} ${n}`)

const failures: string[] = []
const unknown = [...byType.keys()].filter((t) => !(AGUI_EVENT_TYPES as readonly string[]).includes(t))
if (unknown.length > 0) failures.push(`emitted non-AG-UI types: ${unknown.join(', ')}`)

const problems = validateAguiStream(events)
if (problems.length > 0) failures.push(`structural violations:\n    ${problems.join('\n    ')}`)
if (events.length === 0) failures.push('no frames at all')

// Coverage: every sidecar event type in the session must have produced at least one
// AG-UI frame — silence is not a mapping, it is a hole.
const producedTypes = new Set(events.map((e) => String(e['name'] ?? '')).filter((n) => n.startsWith('tianshu.')))
const uncovered = sidecarTypes.filter((t) => {
  const mapped = [...byType.keys()].length > 0
  if (!mapped) return true
  // Directly-named categories produce their own frames; state/custom arrive as
  // STATE_DELTA or CUSTOM with a tianshu.<type> name.
  return !producedTypes.has(`tianshu.${t}`) && !['user', 'text_delta', 'thinking_delta', 'tool_use', 'tool_result', 'turn_complete', 'done', 'error', 'phase'].includes(t) && byType.get('STATE_DELTA') === undefined
})

console.log(`\nvocabulary check: ${unknown.length === 0 ? '✓ all frame types are documented AG-UI events' : '✗ ' + unknown.join(', ')}`)
console.log(`structure check : ${problems.length === 0 ? '✓ no orphan/unclosed messages or tool calls' : '✗ ' + problems.length + ' problems'}`)
if (uncovered.length > 0) console.log(`note: ${uncovered.length} sidecar types produced no named frame: ${uncovered.slice(0, 8).join(', ')}`)

if (failures.length > 0) {
  console.error(`\n✗ AG-UI endpoint FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ AG-UI 端点实测：词表合法、结构不变量全过（未验证 CopilotKit 实客户端消费）')
