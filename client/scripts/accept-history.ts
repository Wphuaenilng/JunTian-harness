/**
 * accept-history.ts — M2 历史向上分页 against a real session's cold channel.
 *
 * Simulates a truncated cold open (start from a mid seq), then walks `before=` back
 * until the disk is exhausted, and asserts the original prompt shows up. No provider
 * call: everything is already on disk from earlier runs.
 *
 *   node scripts/accept-history.ts [sessionId]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient, SessionModel, type SessionEvent } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const sessions = await api.listSessions({ includeArchived: true })
const target = (process.argv[2] ? sessions.find((s) => s.id === process.argv[2]) : undefined)
  ?? sessions.filter((s) => s.lastSeq >= 40).sort((a, b) => b.lastSeq - a.lastSeq)[0]
if (!target) { console.error('✗ no session with enough events'); process.exit(1) }

const whole = await api.events(target.id, 0)
const timeline = whole.events.filter((e) => e.seq > 0)
console.log(`session ${target.id} title="${target.title}" lastSeq=${target.lastSeq} timeline=${timeline.length}`)

// Cold open as the plan describes it: the ring only handed us the tail.
const SPLIT = Math.max(1, Math.floor(Math.max(...timeline.map((e) => e.seq)) / 2))
const tail: SessionEvent[] = timeline.filter((e) => e.seq >= SPLIT)
const model = new SessionModel()
model.loadEvents(tail)
console.log(`truncated window: seq>=${SPLIT} (${tail.length} events), blocks=${model.current.blocks.length}`)

const firstPromptBefore = model.current.blocks.find((b) => b.kind === 'user')
console.log(`first user block before paging: ${firstPromptBefore?.kind === 'user' ? JSON.stringify(firstPromptBefore.text.slice(0, 40)) : '(none)'}`)

let cursor = SPLIT
let pages = 0
let addedTotal = 0
for (let guard = 0; guard < 50; guard++) {
  const page = await api.historyPage(target.id, cursor, 25)
  const older = page.events.filter((e) => e.seq > 0 && e.seq < cursor)
  if (older.length === 0) break
  const added = model.prependEvents(older)
  addedTotal += added
  pages += 1
  cursor = Math.min(...older.map((e) => e.seq))
  console.log(`page ${pages}: before=${cursor} got=${older.length} new=${added} blocks=${model.current.blocks.length}`)
}

const blocks = model.current.blocks
const firstUser = blocks.find((b) => b.kind === 'user')
console.log(`\npages fetched      : ${pages}`)
console.log(`events prepended   : ${addedTotal}`)
console.log(`blocks now         : ${blocks.length}`)
console.log(`first user block   : ${firstUser?.kind === 'user' ? JSON.stringify(firstUser.text.slice(0, 60)) : '(none)'}`)
console.log(`lastSeq            : ${model.current.lastSeq}`)

const earliest = Math.min(...timeline.map((e) => e.seq))
const failures: string[] = []
if (pages === 0) failures.push('cold channel never triggered — nothing was paged')
if (addedTotal < 1) failures.push('no older events were adopted')
if (firstUser?.kind !== 'user' || !firstUser.text) failures.push('no user block after paging')
// The oldest event in the session is the user prompt; after full paging it must lead.
if (earliest === 1 && firstUser.kind === 'user') {
  const original = timeline.find((e) => e.seq === earliest)
  const originalText = typeof original?.data['text'] === 'string' ? original.data['text'] as string : ''
  if (originalText && !firstUser.text.startsWith(originalText.slice(0, 12))) {
    failures.push(`leading block is not the oldest event (expected ${JSON.stringify(originalText.slice(0, 24))})`)
  }
}
if (model.current.lastSeq < Math.max(...timeline.map((e) => e.seq))) failures.push('cursor regressed')

if (failures.length > 0) {
  console.error(`\n✗ history paging FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n✓ M2 历史向上分页 — 冷通道 before= 逐页回填，最旧事件成为时间线首块')
