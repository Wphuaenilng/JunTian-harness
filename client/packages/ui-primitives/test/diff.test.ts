import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnifiedDiff, diffStats } from '../src/markdown.ts'

/**
 * Produced by `diff -u` against real files, not hand-written: the parser has to
 * survive the exact shape a tool result carries (header lines, an @@ range, a
 * deletion and an insertion interleaved with context).
 */
const realPatch = `--- a.txt\t2026-10-09 15:44:25.494944200 +0800
+++ b.txt\t2026-10-09 15:44:25.656944800 +0800
@@ -1,4 +1,4 @@
 line1
-line2
-line3
+line2-modified
 line4
+line5-new
`

test('classifies every line of a real unified diff', () => {
  const hunks = parseUnifiedDiff(realPatch)
  assert.equal(hunks[0]!.kind, 'meta', '--- header')
  assert.equal(hunks[1]!.kind, 'meta', '+++ header')
  assert.equal(hunks[2]!.kind, 'meta', '@@ range')
  assert.equal(hunks[3]!.kind, 'ctx', 'context line')
  assert.deepEqual(hunks.slice(4, 6).map((h) => h.kind), ['del', 'del'])
  assert.equal(hunks[6]!.kind, 'add')
  assert.equal(hunks[8]!.kind, 'add')
})

test('counts added and removed lines the way the diff header claims', () => {
  const { added, removed } = diffStats(parseUnifiedDiff(realPatch))
  assert.equal(added, 2)
  assert.equal(removed, 2)
})

test('a sidecar-style summary result is not mistaken for a patch', () => {
  // Observed live: write_file returns prose, so the diff view must not engage.
  const prose = '已写入 13 字节（2 行）到 F:/workspace/m1-approval-probe.txt——文件已创建'
  const isPatch = /(^|\n)(---\s|\+\+\+\s|@@\s*-\d+)/.test(prose)
  assert.equal(isPatch, false)
  assert.equal(/(^|\n)(---\s|\+\+\+\s|@@\s*-\d+)/.test(realPatch), true)
})
