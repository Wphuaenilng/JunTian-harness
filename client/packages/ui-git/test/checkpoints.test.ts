import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { checkpointTitle, newestIndex, TITLE_MAX } from '../src/checkpoints.ts'

const styles = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'styles.css'), 'utf8')

test('a row title is one collapsed line, capped, and never empty', () => {
  assert.equal(checkpointTitle('  refactored\n  the parser \n twice ', 'fallback'), 'refactored the parser twice')
  assert.equal(checkpointTitle('   ', 'fallback'), 'fallback')
  assert.equal(checkpointTitle('', 'fallback'), 'fallback')
  const long = 'x'.repeat(400)
  const got = checkpointTitle(long, 'fallback')
  assert.equal(got.length, TITLE_MAX)
  assert.ok(got.endsWith('…'))
})

test('the newest checkpoint is the highest index, not the last row received', () => {
  assert.equal(newestIndex([{ index: 3 }, { index: 9 }, { index: 4 }]), 9)
  assert.equal(newestIndex([{ index: 0 }]), 0)
  assert.equal(newestIndex([]), null)
})

/** The winning declaration for a selector is the last rule written for it (CSS cascade). */
function lastRule(sel: string): string {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Anchor at the start of a line: `.ckp__item + .ckp__item { …}` contains the same selector text,
  // so without the anchor a composite selector's tail would be read as the rule for `.ckp__item`.
  const hits = [...styles.matchAll(new RegExp('(?:^|\\n)[ \\t]*' + escaped + '[ \\t]*\\{[^}]*\\}', 'gm'))]
  assert.ok(hits.length > 0, `no rule found for ${sel}`)
  return hits[hits.length - 1]![0]
}

test('the checkpoint row transcribes the drawing’s numbers', () => {
  const item = lastRule('.ckp__item')
  assert.match(item, /padding: 6px 0/)
  assert.match(item, /gap: 8px/)
  const dot = lastRule('.ckp__dot')
  assert.match(dot, /width: 7px/)
  assert.match(dot, /height: 7px/)
  assert.match(dot, /border: 1\.5px solid var\(--nb-400\)/)
  assert.match(dot, /background: var\(--nb-00\)/)
  const title = lastRule('.ckp__title')
  assert.match(title, /font-size: 13px/)
  assert.match(title, /line-height: 20px/)
  assert.match(title, /text-overflow: ellipsis/)
  const meta = lastRule('.ckp__meta')
  assert.match(meta, /font-size: 12px/)
  assert.match(meta, /line-height: 17px/)
  const rb = lastRule('.ckp__rb')
  assert.match(rb, /border-radius: 999px/)
  assert.match(rb, /padding: 2px 8px/)
  assert.match(rb, /font-size: 11px/)
  const head = lastRule('.ckp__item--newest .ckp__dot')
  assert.match(head, /var\(--ds-500\)/)
})
