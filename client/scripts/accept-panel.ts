/**
 * accept-panel.ts — the checkpoint/file panels' data path through client-core.
 *
 * No provider call and no mutation: it reads rewind points, the directory tree, a
 * ranked file search and one file's content from a real session, asserting the client
 * surfaces exactly what the wire says. Rewind itself is deliberately never invoked —
 * it truncates the conversation and can roll back the working tree.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const failures: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const sessions = await api.listSessions({ includeArchived: true })
const target = sessions.find((s) => s.title === 'M1 approval probe') ?? sessions[0]
console.log(`session ${target.id} "${target.title}" cwd=${target.cwd}`)

const points = await api.rewindPoints(target.id)
console.log(`rewind points: ${points.length}`)
for (const p of points) console.log(`  #${p.index} seq=${p.seq} ts=${p.timestamp} ${JSON.stringify(p.content.slice(0, 40))}`)
check('rewindPoints returns index/seq/content/timestamp',
  points.length > 0 && points.every((p) => Number.isInteger(p.index) && Number.isInteger(p.seq) && typeof p.content === 'string' && Number.isFinite(p.timestamp)))

const listing = await api.listDir(target.id, 'src/server')
console.log(`list-dir src/server: ${listing.entries.length} entries, path=${JSON.stringify(listing.path)}`)
const dirs = listing.entries.filter((e) => e.isDirectory).map((e) => e.name)
check('listDir distinguishes directories', dirs.includes('__tests__'), `dirs=${dirs.join(',')}`)
check('listDir entries carry no metadata we would have to invent',
  Object.keys(listing.entries[0] ?? {}).sort().join(',') === 'isDirectory,name')

const files = await api.listFiles(target.id, 'protocol')
console.log(`files q=protocol: ${files.length} → ${files.slice(0, 4).join(', ')}`)
check('listFiles returns ranked paths', files.length > 0 && files.every((f) => typeof f === 'string'))

const content = await api.fileContent(target.id, 'package.json')
console.log(`file-content package.json: ${content.content.length} bytes, path=${content.path}`)
check('fileContent echoes the requested path and body',
  content.path === 'package.json' && content.content.includes('"tianshu-harness"'))
console.log(`  note: line endings preserved as stored (CRLF present = ${content.content.includes('\r\n')})`)

const artifacts = await api.artifacts(target.id)
console.log(`artifacts: ${artifacts.length}`)

const preview = await api.rollbackPreview(target.id)
console.log(`rollback preview: available=${preview.available}${preview.confirmationToken ? ' (token present)' : ''}`)
check('rollback preview answers without mutating anything', typeof preview.available === 'boolean')

if (failures.length > 0) {
  console.error(`\n✗ panel data path FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\n✓ 检查点/文件面板的数据路径实测通过（未触发任何回滚）')
