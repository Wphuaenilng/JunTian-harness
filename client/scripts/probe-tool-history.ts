/**
 * Read-only probe: which file-mutating tool calls exist in the isolated sidecar session
 * store, and what do their `tool_use.input` shapes look like?
 *
 * This decides how the "before view + diff" pane (plan §2.3, Cline 三件套) can be
 * evidenced: a component needs a real block with a real `file_path`, otherwise the
 * render check proves nothing. Costs nothing — GET only, no run is started.
 *
 *   node scripts/probe-tool-history.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const info = JSON.parse(readFileSync(join(here, '..', '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }

const MUTATORS = new Set(['edit_file', 'write_file', 'hash_edit', 'apply_patch', 'ast_edit', 'multi_edit'])

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(`${info.baseUrl}${path}`, { headers: { Authorization: `Bearer ${info.token}` } })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json()
}

const list = await get('/sessions?includeArchived=true') as { sessions?: Array<{ id: string; title?: string; cwd?: string; status?: string }> }
const sessions = list.sessions ?? []
console.log(`${sessions.length} sessions in ${info.baseUrl}`)

const seen = new Map<string, { session: string; keys: string[]; sample: string; resultLen: number; resultUi: number }>()
let toolTotal = 0

for (const s of sessions) {
  const page = await get(`/sessions/${s.id}/events?since=0&limit=2000`) as { events?: Array<{ type: string; data?: Record<string, unknown> }> }
  for (const ev of page.events ?? []) {
    if (ev.type !== 'tool_use') continue
    toolTotal++
    const d = ev.data ?? {}
    const name = String(d.name ?? d.toolName ?? '')
    if (!MUTATORS.has(name)) continue
    const input = (d.input ?? {}) as Record<string, unknown>
    const key = `${name}·${Object.keys(input).sort().join(',')}`
    if (seen.has(key)) continue
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '(none)'
    seen.set(key, {
      session: s.id,
      keys: Object.keys(input),
      sample: `${path}`.slice(0, 90),
      resultLen: JSON.stringify(input).length,
      resultUi: 0,
    })
  }
}

console.log(`tool_use events scanned: ${toolTotal}`)
if (seen.size === 0) {
  console.log('no file-mutating tool_use found — the diff pane needs a fixture-free path (see header)')
}
for (const [shape, v] of [...seen.entries()]) {
  console.log(`\n${shape}`)
  console.log(`  input keys: ${v.keys.join(', ')}`)
  console.log(`  file: ${v.sample}`)
  console.log(`  input bytes: ${v.resultLen}`)
  console.log(`  session: ${v.session}`)
}
