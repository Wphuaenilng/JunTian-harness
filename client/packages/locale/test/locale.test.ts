import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zh, type LocaleKey } from '../src/zh.ts'
import { en } from '../src/en.ts'
import { interpolate, translate, detectLocale } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = join(here, '..', '..', '..')

/** Every source file that is allowed to carry UI text (the locale package itself excluded). */
const UI_SOURCES: string[] = [
  join(clientRoot, 'apps', 'web', 'src', 'App.tsx'),
  // All of ui-* except the two infrastructure packages that hold no copy of their own.
  ...['ui-session', 'ui-chat', 'ui-approval', 'ui-settings', 'ui-git', 'ui-files', 'ui-schedule']
    .flatMap((p) => srcFiles(join(clientRoot, 'packages', p, 'src'))),
  // client-core is the folding layer: if it ever formats a sentence, the view can no
  // longer re-render that text in another language. protocol-types.ts is excluded
  // because it is generated from the kernel and carries the kernel's own comments.
  ...srcFiles(join(clientRoot, 'packages', 'client-core', 'src')).filter((f) => !f.endsWith('protocol-types.ts')),
]

function srcFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')))
    .map((f) => join(dir, f))
}

const keys = Object.keys(zh) as LocaleKey[]
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

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
    // Comments may stay Chinese (they are for the maintainer); only live text matters.
    // Blanking them keeps newlines so the reported line number is the real one.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
      .replace(/^[ \t]*\/\/.*$/gm, '')
    code.split('\n').forEach((line, i) => {
      if (/[一-鿿]/.test(line)) offenders.push(`${file.split(/[\\/]/).pop()}:${i + 1} ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [])
})

test('every locale key referenced by a UI source actually exists', () => {
  const referenced = new Set<string>()
  for (const file of UI_SOURCES) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\b(?:t|translate)\(\s*['"]([\w.]+)['"]/g)) referenced.add(m[1]!)
    // Keys reached through a data table (`labelKey: 'git.refresh'`) rather than a call.
    for (const m of src.matchAll(/\b(?:nameKey|grantsKey|labelKey|key)\s*:\s*['"]([\w.]+)['"]/g)) referenced.add(m[1]!)
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

test('client root package listing stays sane for the scan', () => {
  // Guards the test itself: if a ui-* package is added, UI_SOURCES must grow with it.
  const pkgs = readdirSync(join(clientRoot, 'packages'))
    .filter((p) => p.startsWith('ui-') && statSync(join(clientRoot, 'packages', p)).isDirectory())
    .filter((p) => !p.endsWith('primitives') && !p.endsWith('theme'))
    .sort()
  assert.deepEqual(pkgs, ['ui-approval', 'ui-chat', 'ui-files', 'ui-git', 'ui-schedule', 'ui-session', 'ui-settings'])
})
