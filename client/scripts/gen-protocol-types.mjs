#!/usr/bin/env node
/**
 * gen-protocol-types.mjs — protocol type mirror + drift report (plan §2.3, §5.2 #4).
 *
 * `src/server/protocol.ts` is the only contract document that exists, and it is
 * deliberately a dependency-free leaf module (no imports at all). So the mirror is
 * a verbatim copy with a provenance header — no hand-transcription to go stale,
 * nothing to mistranslate. Codex generates TS from Rust (ts-rs) and OpenCode from
 * OpenAPI for the same reason; this is the same move on the only source available.
 *
 * Output is deterministic (source hash only, no timestamp) so `--check` compares
 * meaningfully and CI fails only on real drift, not on regeneration noise.
 *
 *   node scripts/gen-protocol-types.mjs           # write the mirror
 *   node scripts/gen-protocol-types.mjs --check    # CI: fail if mirror != source
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')

/**
 * --source/--out-dir exist so the drift gate itself can be tested against a fixture
 * copy. Proving `--check` turns red is not something to do by editing the kernel's
 * contract file.
 */
function flag(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? resolve(process.argv[i + 1]) : fallback
}

const sourcePath = flag('--source', join(repoRoot, 'src', 'server', 'protocol.ts'))
const outDir = flag('--out-dir', join(clientRoot, 'packages', 'client-core', 'src'))
const mirrorPath = join(outDir, 'protocol-types.ts')
const manifestPath = join(outDir, 'protocol-manifest.json')

/** Symbols we care about reporting on, extracted from the contract text. */
function inspect(text) {
  // Anchor on the declaration that follows the union: the union body contains
  // comment blocks, so "stop at the first blank line" would silently truncate it.
  const union = text.match(/export type SessionEventType\s*=\s*([\s\S]*?)\n\nexport interface SessionEvent\b/)
  // Union members are always `\n  | 'name'`; the block is dense with comments that
  // quote other literals ('zen' | 'full', 'steered' | 'retracted' | 'merged'), so a
  // bare quoted-string scan over-counts. Anchor on member syntax instead.
  const eventTypes = union ? [...union[1].matchAll(/^\s*\|\s*'([a-z_]+)'/gm)].map((m) => m[1]) : []
  if (!union || eventTypes.length === 0) {
    throw new Error('could not extract the SessionEventType union — the contract shape changed, update this generator')
  }
  const pick = (re) => [...text.matchAll(re)].map((m) => m[1]).sort()
  return {
    eventTypes,
    interfaces: pick(/^export interface (\w+)/gm),
    typeAliases: pick(/^export type (\w+)/gm),
    consts: pick(/^export const (\w+)/gm),
    imports: [...text.matchAll(/^import\s/gm)].length,
  }
}

function buildMirror(source, hash) {
  const s = inspect(source)
  const header = `/**
 * GENERATED — DO NOT EDIT.  node scripts/gen-protocol-types.mjs
 *
 * Mirror of ${relative(clientRoot, sourcePath).replace(/\\/g, '/')}, the single
 * definition of the sidecar wire contract. Re-run the generator after pulling
 * the kernel; \`--check\` in CI turns silent drift into a build failure.
 *
 * protocolVersion : ${s.consts.includes('PROTOCOL_VERSION') ? 'see PROTOCOL_VERSION below' : 'n/a'}
 * event types     : ${s.eventTypes.length}
 * interfaces      : ${s.interfaces.length}
 * source sha256   : ${hash}
 */

`
  // The source is a leaf (zero imports) — assert it rather than trust it, because
  // a future `import type` from an agent module would drag half the runtime into
  // this package's type graph.
  if (s.imports > 0) {
    throw new Error(`protocol.ts is no longer import-free (${s.imports} import statements) — the mirror would pull server code into the client`)
  }
  return header + source.trimEnd() + '\n'
}

function buildManifest(source, hash) {
  const s = inspect(source)
  return {
    source: relative(repoRoot, sourcePath).replace(/\\/g, '/'),
    sourceSha256: hash,
    protocolVersion: Number(source.match(/export const PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1] ?? 0),
    eventTypeCount: s.eventTypes.length,
    eventTypes: s.eventTypes,
    interfaces: s.interfaces,
    typeAliases: s.typeAliases,
    consts: s.consts,
  }
}

function diffSymbols(prev, next) {
  const delta = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) })
  const events = delta(prev?.eventTypes ?? [], next.eventTypes)
  const interfaces = delta(prev?.interfaces ?? [], next.interfaces)
  const aliases = delta(prev?.typeAliases ?? [], next.typeAliases)
  const lines = []
  const report = (label, d) => {
    if (d.added.length > 0) lines.push(`${label} +${d.added.length}: ${d.added.join(', ')}`)
    if (d.removed.length > 0) lines.push(`${label} -${d.removed.length}: ${d.removed.join(', ')}`)
  }
  report('events', events)
  report('interfaces', interfaces)
  report('typeAliases', aliases)
  if (prev && prev.protocolVersion !== next.protocolVersion) {
    lines.push(`protocolVersion: ${prev.protocolVersion} → ${next.protocolVersion} (BREAKING — clients must not ignore this)`)
  }
  return { lines, events, breaking: (prev && prev.protocolVersion !== next.protocolVersion) || events.removed.length > 0 }
}

const check = process.argv.includes('--check')
if (!existsSync(sourcePath)) throw new Error(`contract source missing: ${sourcePath}`)

const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n')
const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
const mirror = buildMirror(source, hash)
const manifest = buildManifest(source, hash)
const prevManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
const prevMirror = existsSync(mirrorPath) ? readFileSync(mirrorPath, 'utf8') : null
const drift = diffSymbols(prevManifest, manifest)

if (check) {
  const stale = prevMirror !== mirror || prevManifest === null || prevManifest.sourceSha256 !== manifest.sourceSha256
  if (!stale) {
    console.log(`✓ mirror up to date — ${manifest.eventTypeCount} events, sha256 ${manifest.sourceSha256}`)
    process.exit(0)
  }
  console.error(`✗ protocol drift detected against ${manifest.source}`)
  if (drift.lines.length > 0) for (const l of drift.lines) console.error(`  - ${l}`)
  if (drift.lines.length === 0) console.error('  - mirror text differs from the contract but symbol sets match (comments/fields changed)')
  console.error(`\n  fix: node scripts/gen-protocol-types.mjs   (then re-categorize new events in event-category.ts)`)
  console.error(`  note: events the client does not know must be ignored at runtime, but a REMOVED or renamed event that this UI still reads is a real break.`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(mirrorPath, mirror)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`✓ mirrored ${manifest.source} → packages/client-core/src/protocol-types.ts`)
console.log(`  ${manifest.eventTypeCount} event types, ${manifest.interfaces.length} interfaces, protocolVersion ${manifest.protocolVersion}, sha256 ${manifest.sourceSha256}`)
if (drift.lines.length > 0) {
  console.log(`  symbol changes vs previous manifest:\n    ${drift.lines.join('\n    ')}`)
  console.log(`  ${drift.breaking ? '⚠ breaking — update the adapter and any UI reading removed events' : 'ℹ additive — unknown events are ignored at runtime'}`)
}
