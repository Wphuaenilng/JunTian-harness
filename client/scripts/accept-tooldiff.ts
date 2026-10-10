/**
 * accept-tooldiff.ts — the tool card's "before view + diff" (plan §2.3, Cline 三件套),
 * end to end through client-core against the real sidecar.
 *
 * No provider call: it folds a historical session's events into a SessionModel, takes
 * the real `write_file` block, and asks the same two endpoints the UI asks
 * (`git/diff`, `git/file-base`) with the same relative path the UI computes.
 *
 * Side effect, bounded and self-cleaning: the file that historical run wrote was
 * deleted after its own acceptance, so there would be nothing to diff. The script
 * recreates exactly the recorded bytes, measures, then removes the file it created and
 * proves it is gone. It never writes where a file already exists.
 *
 *   node scripts/accept-tooldiff.ts
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { looksLikePatch, parseUnifiedDiff, diffStats } from '../packages/ui-primitives/src/markdown.ts'
import { relativeToCwd, SessionModel, SidecarClient, type Block } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(resolve(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const failures: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

type ToolBlock = Extract<Block, { kind: 'tool' }>

// 1. Find a real file-mutating tool block by folding stored events — the same fold the
//    browser does, so this proves the block carries what the card needs.
let found: { sessionId: string; cwd: string; block: ToolBlock } | null = null
for (const s of await api.listSessions({ includeArchived: true })) {
  const page = await api.events(s.id, 0)
  const model = new SessionModel()
  model.loadEvents(page.events)
  const b = model.current.blocks.find((x): x is ToolBlock => x.kind === 'tool' && x.filePath !== undefined)
  if (b) { found = { sessionId: s.id, cwd: s.cwd, block: b }; break }
}
if (!found) {
  console.error('no file-mutating tool block in the store — run the M1 approval acceptance first')
  process.exit(1)
}
const { sessionId, cwd, block } = found
console.log(`session ${sessionId} cwd=${cwd}`)
console.log(`tool=${block.name} filePath=${block.filePath}`)
console.log(`uiContent=${JSON.stringify((block.uiContent ?? '').slice(0, 80))} truncated=${block.truncated === true}`)

check('block carries the kernel uiContent patch (result is prose, uiContent is the diff)',
  block.uiContent !== undefined && looksLikePatch(block.uiContent),
  `result="${(block.result ?? '').slice(0, 40)}…"`)
check('block.filePath came from input.file_path', typeof block.filePath === 'string' && block.filePath.length > 0)

const rel = relativeToCwd(block.filePath!, cwd)
check('file_path resolves to a session-relative path', rel !== null && rel !== '', `rel=${rel}`)

// 2. Recreate the recorded bytes so there is a real change to diff.
const abs = resolve(cwd, rel!)
const intended = typeof block.input.content === 'string' ? block.input.content : null
const created = intended !== null && !existsSync(abs)
if (created) {
  writeFileSync(abs, intended, 'utf8')
  console.log(`created ${abs} (${intended!.length} bytes, recorded content)`)
} else if (!created && intended !== null) {
  console.log(`${abs} already exists — measuring it as-is`)
}

let exitCode = 0
try {
  // 3. The two endpoints the before-view uses.
  const base = await api.sessionFileBase(sessionId, rel!)
  console.log(`file-base → exists=${base.exists} contentBytes=${base.content.length}`)
  check('a file created after the baseline reports exists:false (the "new file" branch)', base.exists === false)

  const diff = await api.sessionFileDiff(sessionId, rel!)
  const hunks = parseUnifiedDiff(diff.diff)
  const stats = diffStats(hunks)
  const independentAdd = diff.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
  console.log(`git/diff → ${diff.diff.length} chars, +${stats.added}/−${stats.removed}, class=${[...new Set(hunks.map((h) => h.kind))].join(',')}`)
  check('the endpoint returns a parseable unified diff for an untracked new file', looksLikePatch(diff.diff) || diff.diff.trim() === '')
  check('diffStats agrees with an independent line count', stats.added === independentAdd, `${stats.added} vs ${independentAdd}`)
  check('the changed line is the content the model asked to write',
    intended === null || diff.diff.includes(`+${intended.replace(/\n+$/, '')}`.slice(0, 40)))

  // 4. A file that does exist at the baseline — the normal before-view.
  const tracked = await api.sessionFileBase(sessionId, 'AGENTS.md')
  console.log(`file-base AGENTS.md → exists=${tracked.exists} contentBytes=${tracked.content.length}`)
  check('an existing baseline file comes back with real content', tracked.exists === true && tracked.content.length > 100)

  // 5. Path escape must not silently look like "no changes".
  const raw = await fetch(`${info.baseUrl}/sessions/${sessionId}/git/diff?path=${encodeURIComponent('../../etc/passwd')}`, {
    headers: { Authorization: `Bearer ${info.token}` },
  })
  console.log(`escaping path → HTTP ${raw.status} ${JSON.stringify((await raw.text()).slice(0, 80))}`)
  check('an escaping path is refused, not returned as an empty diff', raw.status !== 200, `status=${raw.status}`)
} catch (e) {
  check('acceptance ran without throwing', false, (e as Error).message)
  exitCode = 1
} finally {
  // 6. Clean up exactly what this run created.
  if (created) {
    rmSync(abs)
    check('probe file removed again', !existsSync(abs))
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  exitCode = 1
} else {
  console.log('\nall checks passed')
}
process.exit(exitCode)
