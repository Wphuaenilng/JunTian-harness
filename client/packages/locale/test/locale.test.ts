import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zh, type LocaleKey } from '../src/zh.ts'
import { en } from '../src/en.ts'
import { interpolate, translate, detectLocale } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', '..', '..')

/** Recursive: a panel that grows a `src/<sub>/` must not silently drop out of the scan. */
function srcFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...srcFiles(p))
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(p)
  }
  return out.sort()
}

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/** Packages that declare `@tianshu/locale`: whoever consumes the dictionary owes the copy scan. */
const localeConsumers: string[] = ['packages', 'apps']
  .flatMap((base) => readdirSync(join(clientRoot, base)).map((p) => join(clientRoot, base, p)))
  .filter((dir) => {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj) || !statSync(pj).isFile()) return false
    const m = JSON.parse(readFileSync(pj, 'utf8')) as Manifest
    return (m.dependencies ?? {})['@tianshu/locale'] !== undefined || (m.devDependencies ?? {})['@tianshu/locale'] !== undefined
  })

/**
 * Probe pages feed the real components *fixture* text so a headless browser has something to
 * measure — that copy is deliberately not localized. The exemption is earned from the served
 * side: the file must be the module script of an html page that vite itself builds. A panel file
 * named `…-probe.tsx` that no page loads stays in the scan.
 */
const appWebRoot = join(clientRoot, 'apps', 'web')
const viteInputs = readFileSync(join(appWebRoot, 'vite.config.ts'), 'utf8')
const SERVED_PAGE_SCRIPTS = readdirSync(appWebRoot)
  .filter((n) => n.endsWith('.html') && viteInputs.includes(n))
  .flatMap((n) => [...readFileSync(join(appWebRoot, n), 'utf8').matchAll(/src="([^"]+\.tsx?)"/g)].map((m) => basename(m[1]!)))
// The whole render-process tree, not just the packages that import the dictionary: a file that
// hardcodes copy *without* importing locale is exactly the offender this rule exists to catch.
// `packages/locale` is the dictionary itself; `apps/desktop` is .mjs-only and belongs to
// native-copy.test.ts, which pins its bilingual pairs instead.
const SCANNED: string[] = [
  ...readdirSync(join(clientRoot, 'packages'))
    .filter((p) => p !== 'locale' && existsSync(join(clientRoot, 'packages', p, 'src')))
    .flatMap((p) => srcFiles(join(clientRoot, 'packages', p, 'src'))),
  ...readdirSync(join(clientRoot, 'apps'))
    .filter((a) => existsSync(join(clientRoot, 'apps', a, 'src')))
    .flatMap((a) => srcFiles(join(clientRoot, 'apps', a, 'src'))),
  // protocol-types.ts is generated from the kernel and carries the kernel's own comments.
].filter((f) => !f.endsWith('protocol-types.ts')).sort()
const PROBE_EXEMPT = SCANNED.filter((f) => /-probe\.tsx$/.test(f) && SERVED_PAGE_SCRIPTS.includes(basename(f)))

/**
 * Every source file that is allowed to carry UI text (the locale package itself excluded).
 * Derived from the tree on purpose: a hand-written list shrinks silently — a new ui-* package,
 * a file added to `apps/web/src` next to `App.tsx`, or a panel split into a subdirectory all
 * stay out of the scan, and "the scan found nothing" then reads as green.
 */
const UI_SOURCES: string[] = SCANNED.filter((f) => !PROBE_EXEMPT.includes(f))

const keys = Object.keys(zh) as LocaleKey[]
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

/**
 * Comments are written for the maintainer and may stay Chinese; only live text is UI copy.
 * Blanking them keeps newlines, so a reported line number is still the real one.
 */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  .replace(/^[ \t]*\/\/.*$/gm, '')

test('zh and en cover exactly the same keys', () => {
  const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(en, k))
  const extra = Object.keys(en).filter((k) => !Object.prototype.hasOwnProperty.call(zh, k))
  assert.deepEqual(missing, [], `keys missing from en: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `keys only in en: ${extra.join(', ')}`)
})

test('both languages interpolate the same parameters', () => {
  // A dictionary can be key-complete and still be broken: `{count}` typed as `{count}`
  // on one side and `{num}` on the other silently renders a literal brace.
  const mismatched = keys
    .filter((k) => placeholders(zh[k]).join(',') !== placeholders(en[k]).join(','))
    .map((k) => `${k}: zh{${placeholders(zh[k])}} en{${placeholders(en[k])}}`)
  assert.deepEqual(mismatched, [])
})

test('interpolation substitutes known params and leaves unknown ones visible', () => {
  assert.equal(interpolate('共 {count} 个', { count: 3 }), '共 3 个')
  assert.equal(interpolate('已等待 {seconds} 秒', {}), '已等待 {seconds} 秒')
  assert.equal(interpolate('{a} 和 {b}', { a: 'x' }), 'x 和 {b}')
  assert.equal(interpolate('无参'), '无参')
})

test('no UI source ships a hardcoded CJK string any more', () => {
  const offenders: string[] = []
  for (const file of UI_SOURCES) {
    const code = stripComments(readFileSync(file, 'utf8'))
    code.split('\n').forEach((line, i) => {
      if (/[一-鿿]/.test(line)) offenders.push(`${file.split(/[\\/]/).pop()}:${i + 1} ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [])
})

test('every locale key referenced by a UI source actually exists', () => {
  const referenced = new Set<string>()
  for (const file of UI_SOURCES) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/\b(?:t|translate)\(\s*['"]([\w.]+)['"]/g)) referenced.add(m[1]!)
    // Keys reached through a data table (`labelKey: 'git.refresh'`) rather than a call. A key is
    // `prefix.name`, so require the dot: `key: 'Enter'` is a KeyboardEvent property, not copy.
    for (const m of src.matchAll(/\b(?:nameKey|grantsKey|labelKey|key)\s*:\s*['"]([\w.]+)['"]/g)) {
      const value = m[1]!
      if (/^\w+(\.\w+)+$/.test(value)) referenced.add(value)
    }
  }
  const unknown = [...referenced].filter((k) => !keys.includes(k as LocaleKey))
  assert.deepEqual(unknown, [])
  assert.ok(referenced.size > 60, `expected the scan to find the migrated keys, saw ${referenced.size}`)
})

test('translate falls back to the requested language map', () => {
  assert.equal(translate('zh', 'approval.allowOnce'), '允许一次')
  assert.equal(translate('en', 'approval.allowOnce'), 'Allow once')
  assert.equal(translate('en', 'approval.stalled', { seconds: 42 }), 'Waiting 42s — this session is parked here; the model will not continue on its own.')
})

test('language detection honours an explicit choice over storage', () => {
  assert.equal(detectLocale('en'), 'en')
  assert.equal(detectLocale('zh'), 'zh')
  // In node there is no localStorage and no navigator: neither may throw.
  assert.ok(['zh', 'en'].includes(detectLocale()))
})

test('dictionaries are grouped by package prefix so a README can claim its keys', () => {
  const prefixes = new Set(keys.map((k) => k.split('.')[0]!))
  for (const expected of ['app', 'chat', 'approval', 'session', 'settings', 'git', 'files', 'schedule']) {
    assert.ok(prefixes.has(expected), `missing prefix ${expected}`)
  }
})

test('no key is unused by any UI source', () => {
  const all = UI_SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n')
  const unused = keys.filter((k) => !all.includes(`'${k}'`))
  assert.deepEqual(unused, [], `dead keys: ${unused.join(', ')}`)
})

test('the copy-scan face is derived from the tree, not hand-listed', () => {
  // A derived list can break by finding nothing, so the face is pinned from both ends:
  // known product files must be inside it, and every locale consumer must contribute to it.
  const shell = [join(clientRoot, 'apps', 'web', 'src', 'App.tsx'), join(clientRoot, 'apps', 'web', 'src', 'main.tsx')]
  const gone = shell.filter((f) => !UI_SOURCES.includes(f))
  assert.deepEqual(gone.map((f) => basename(f)), [], `the shell's own files fell out of the scan: ${gone.map((f) => basename(f)).join(', ')}`)
  // Two facts from independent sources (package manifests) against the walked face: a package that
  // consumes the dictionary, or that the shell renders, contributes nothing here means its copy
  // lives outside `src/` and is escaping the scan.
  const silent = localeConsumers.filter((dir) => !SCANNED.some((f) => f.startsWith(dir + sep)))
  assert.deepEqual(silent.map((d) => basename(d)), [], `locale consumers with nothing scanned: ${silent.map((d) => basename(d)).join(', ')}`)
  const webManifest = JSON.parse(readFileSync(join(appWebRoot, 'package.json'), 'utf8')) as Manifest
  // The dictionary is the one rendered package that is copy by definition, so it stays out of the
  // face; every other `@tianshu/*` the shell mounts must be walked.
  const rendered = Object.keys(webManifest.dependencies ?? {})
    .filter((n) => n.startsWith('@tianshu/') && n !== '@tianshu/locale')
    .map((n) => join(clientRoot, 'packages', n.slice('@tianshu/'.length)))
  const outside = rendered.filter((dir) => !SCANNED.some((f) => f.startsWith(dir + sep)))
  assert.deepEqual(outside.map((d) => basename(d)), [], `packages the shell renders but the scan never reads: ${outside.map((d) => basename(d)).join(', ')}`)
  assert.ok(UI_SOURCES.length >= 45, `scan face collapsed to ${UI_SOURCES.length} files — the derivation is broken`)
  assert.ok(UI_SOURCES.every((f) => existsSync(f)), 'the scan face lists a file that is not on disk')
  // The exemption is only sound while a probe page carries no dictionary-driven copy. That is an
  // independent fact about the file, not a restatement of how PROBE_EXEMPT was built: localize a
  // probe and it loses the exemption, so the CJK rule starts applying to it again.
  const localized = PROBE_EXEMPT.filter((f) => /@tianshu\/locale|useT\(/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(localized.map((f) => basename(f)), [], `probe pages that use the dictionary and skipped the scan: ${localized.map((f) => basename(f)).join(', ')}`)
  assert.ok(SERVED_PAGE_SCRIPTS.length >= 10, `expected the vite-built pages to name their scripts, saw ${SERVED_PAGE_SCRIPTS.length}`)
  assert.ok(PROBE_EXEMPT.length >= 9, `expected the probe pages in the fixture exemption, saw ${PROBE_EXEMPT.length}`)
})
