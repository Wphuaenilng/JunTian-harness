#!/usr/bin/env node
/**
 * check-docs.mjs — a docs-truth gate, because the ledgers are the thing the user trusts.
 *
 * Two claims every README makes about the repo are mechanically checkable, and both rot
 * silently when code moves:
 *   1. "this file/script exists at this path" — a README pointing at a renamed script is a
 *      doc that teaches the next reader to run something that fails;
 *   2. "this is a table" — a row whose pipe count differs from its header is a table that
 *      stops rendering, and tsc/test suites cannot see it.
 *
 *   node scripts/check-docs.mjs            # all package + app + root READMEs
 *   node scripts/check-docs.mjs --quiet    # failures only (used by ci-smoke)
 *
 * Both checks are cheap enough to run on every CI pass, and each one has already caught a
 * real mistake in this repo's own tooling: a relative path resolved against the wrong base,
 * and a table-width flush bug that cried wolf 33 times over ui-chat.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')

const failures = []
const report = (ok, label, detail = '') => {
  if (!quiet || !ok) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * Path mentions. `.tsx` must be tried before `.ts` in the alternation — otherwise
 * `App.tsx` matches as `App.ts` + a stray `x` and the gate reports a file that is there.
 * Narrative mentions of a deliberately wrong path are listed here rather than silenced by
 * skipping code spans generally.
 */
const PATH_IGNORE = ['apps/scripts/launch-sidecar.mjs']
const PATH_RE = /(?:scripts|packages|apps)\/[A-Za-z0-9_.\/-]+\.(?:tsx|mjs|ts|css)/g

function readmeFiles() {
  const out = [join(clientRoot, 'README.md')]
  for (const dir of [...readdirSync(join(clientRoot, 'packages')).map((d) => join('packages', d)), ...readdirSync(join(clientRoot, 'apps')).map((d) => join('apps', d))]) {
    const f = join(clientRoot, dir, 'README.md')
    if (existsSync(f)) out.push(f)
  }
  return out
}

const missing = []
for (const file of readmeFiles()) {
  const base = dirname(file)
  const txt = readFileSync(file, 'utf8')
  for (const m of txt.matchAll(PATH_RE)) {
    const p = m[0]
    if (PATH_IGNORE.some((ig) => p.endsWith(ig))) continue
    // A mention may be repo-root-relative or relative to its own package: accept either.
    if (!existsSync(join(base, p)) && !existsSync(join(clientRoot, p))) {
      missing.push(`${relative(clientRoot, file)} → ${p}`)
    }
  }
}
report(missing.length === 0, 'every path mentioned in a README exists', [...new Set(missing)].slice(0, 5).join(' | '))

/** Table shape: consecutive pipe rows form a block; every row needs the header's width. */
const brokenTables = []
for (const file of readmeFiles()) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  let block = []
  const flush = () => {
    if (block.length >= 2) {
      const width = block[0].cells
      const off = block.filter((r) => r.cells !== width)
      if (off.length > 0) brokenTables.push(`${relative(clientRoot, file)}:行${block[0].line} (${width}列) 有 ${off.length} 行不符 → 例 行${off[0].line}(${off[0].cells})`)
    }
    block = []
  }
  lines.forEach((l, i) => {
    const t = l.trim()
    if (t.startsWith('|')) block.push({ line: i + 1, cells: (t.match(/\|/g) ?? []).length })
    else flush()
  })
  flush()
}
report(brokenTables.length === 0, 'every README table renders (row widths match their header)', brokenTables.slice(0, 4).join(' | '))

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
if (!quiet) console.log('docs checks passed')
