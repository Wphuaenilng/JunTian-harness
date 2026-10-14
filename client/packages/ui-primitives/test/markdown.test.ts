import { test } from 'node:test'
import assert from 'node:assert/strict'
import { micromark } from 'micromark'
import { renderMarkdown, markdownParseCount, markdownCacheStats } from '../src/markdown.ts'

/**
 * §8 calls incremental markdown 「the only fix for the streaming O(n²) trap」, and the fix is
 * exactly one line: sealed blocks come from the cache. Until the parse counter existed, that claim
 * was carried only by a one-off measurement script nobody re-ran — deleting the cache lookup would
 * have left every check in the tree green. These three tests are why the counter exists.
 */

test('a sealed block is parsed once and returned by identity', () => {
  const first = renderMarkdown(1001, 'hello **world**', false)
  const again = renderMarkdown(1001, 'hello **world**', false)
  assert.equal(again, first)
})

test('an open block whose fence is still arriving does not emit broken HTML', () => {
  const partial = 'look:\n\n```ts\nconst a = 1'
  const html = renderMarkdown(1002, partial, true)
  assert.ok(html.includes('<pre>'), 'unclosed fence should still render as a code block')
  assert.ok(!html.includes('<code class="language-ts">const a = 1</p>'), 'no stray paragraph inside the fence')
})

test('raw HTML from model output is escaped, not injected', () => {
  // allowDangerousHtml:false is the line that must not change: file contents and
  // tool output land here from sources the client does not control.
  const html = renderMarkdown(1003, '<img src=x onerror=alert(1)>', false)
  assert.ok(!html.includes('<img'), 'img tag must not survive')
  assert.ok(html.includes('&lt;img'), 'escaped form expected')
})

test('a sealed block is parsed exactly once, however many re-renders follow', () => {
  const before = markdownParseCount.calls
  renderMarkdown(2001, 'sealed **text**', false)
  assert.equal(markdownParseCount.calls, before + 1, 'the first render must parse')
  for (let i = 0; i < 50; i++) renderMarkdown(2001, 'sealed **text**', false)
  assert.equal(markdownParseCount.calls, before + 1, '50 re-renders of a sealed block must add zero parses — this is the whole §8 fix')
})

test('the already-sealed part of a streaming document contributes zero parsed characters', () => {
  const ids = [3001, 3002, 3003]
  for (const id of ids) renderMarkdown(id, 'x'.repeat(1000), false)
  const before = markdownParseCount.chars
  // Twenty "deltas" each re-render the whole visible timeline: three sealed 1k blocks plus one
  // open one. Naive whole-document parsing would add 20 × 3 × 1000 = 60 000 characters here.
  for (let delta = 0; delta < 20; delta++) for (const id of ids) renderMarkdown(id, 'x'.repeat(1000), false)
  assert.equal(markdownParseCount.chars, before, 'sealed neighbours must not re-enter the parser')
  const openBefore = markdownParseCount.chars
  renderMarkdown(4001, 'still arriving', true)
  renderMarkdown(4001, 'still arriving…', true)
  assert.ok(markdownParseCount.chars > openBefore, 'the open tail is the one thing that may re-parse')
})

const stabilize = (md: string): string =>
  (md.match(/^```/gm) ?? []).length % 2 === 1 ? `${md}\n\`\`\`` : md
const wholeParse = (src: string): string => micromark(stabilize(src), { allowDangerousHtml: false })

/**
 * Streaming blocks now seal finished segments inside the open block (cutPoint). That is only
 * acceptable while every frame is byte-identical to a whole-document parse of the same text —
 * otherwise the cache is quietly changing what an answer looks like halfway through.
 * The unclosed-fence entry is the case where sealing (open=false, no stabiliser) legitimately
 * differs from the last open frame, so it streams but is excluded from the seal comparison.
 */
const CORPUS: string[] = [
  'para one **bold** and `code`.\n\npara two with 中文 and a [link](http://x).\n',
  '- tight a\n- tight b\n\nnext paragraph\n\n- second list\n',
  '* loose list a\n\n* loose list b\n\nafter the list\n',
  '> quote one\n\n> quote two\n\nafter\n',
  '> q1\n\nplain after quote\n\n> q2\n',
  '```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter fence\n',
  '```ts\nconst unterminated = 1\n\nstill inside fence\n\nand more\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\nafter table\n',
  '# Heading\n\nbody text\n\n## Sub\n\nmore\n',
  '- outer\n  - inner a\n\n  - inner b\n\ntail\n',
  '1. first\n2. second\n\n- then bullets\n\nfinal para\n',
  '<img src=x onerror=alert(1)>\n\nafter html\n',
  '<!-- a comment\n\nstill comment\n\n-->\n\nafter comment\n',
  '<!-- unterminated\n\nforever\n\nmore\n',
  '<pre>\nraw\n\nmore raw\n</pre>\n\nafter pre\n',
  'line one\nline two\n\npara end\n\n    indented code\n\nfinal para\n',
  'text\n\n***\n\nmore\n\n---\n\nend\n',
  'a\n\n\n\nb\n\n\n\n\nc\n',
  '- l1\n\n- l2\n\n- l3\n\npara after three-item loose list\n',
  '# T\n\n- a\n\n- b\n\n> q\n\n> q2\n\n```\nf\n```\n\nlast\n',
]

test('every streamed frame equals a whole-document parse of the same text', () => {
  let checked = 0
  CORPUS.forEach((doc, d) => {
    const id = 500_000 + d
    for (let len = 1; len <= doc.length; len++) {
      const prefix = doc.slice(0, len)
      assert.equal(renderMarkdown(id, prefix, true), wholeParse(prefix), `doc ${d} at prefix length ${len}`)
      checked++
    }
  })
  assert.ok(checked > 800, `the corpus has to actually stream (${checked} prefixes)`)
})

test('sealing a block gives the HTML the stream already showed', () => {
  CORPUS.filter((doc) => (doc.match(/^```/gm) ?? []).length % 2 === 0).forEach((doc, d) => {
    const streamId = 600_000 + d
    for (let len = 1; len <= doc.length; len += 7) renderMarkdown(streamId, doc.slice(0, len), true)
    const streamed = renderMarkdown(streamId, doc, true)
    assert.equal(renderMarkdown(700_000 + d, doc, false), streamed, `doc ${d} seals to what it streamed`)
  })
})

test('the parser work for a streamed answer grows linearly, not with the square of its length', () => {
  const total = 16_000
  const unit = '这是一段回答里的文字，含 **加粗** 与 `code`。\n\n'
  const fence = '```ts\nconst a = 1\n```\n\n'
  let doc = ''
  while (doc.length < total) doc += doc.length % 600 < unit.length * 4 ? unit : fence
  doc = doc.slice(0, total)
  const before = markdownParseCount.chars
  for (let len = 20; len <= total; len += 20) renderMarkdown(1_100_000 + total, doc.slice(0, len), true)
  const work = markdownParseCount.chars - before
  // Without cutPoint the tail re-parses whole: total²/40 = 6.4 M characters. Measured here: ~27 k.
  assert.ok(work <= 4 * total, `streaming ${total} characters fed ${work} characters to micromark — §8 promises O(n), the ceiling is 4n`)
})

/**
 * The module comment says the view caches are bounded ("dropping the oldest on overflow keeps long
 * runs cheap"). A bound nobody counts is a hope, and the interesting half is not the number but
 * what happens to a block that got dropped: it must re-parse, never return somebody else's HTML.
 */
const CAP = 3000

test('the sealed-block cache stops at its cap, and an evicted block re-parses instead of lying', () => {
  const base = 2_000_000
  for (let i = 0; i < CAP + 100; i++) renderMarkdown(base + i, `sealed paragraph ${i}`, false)
  const size = markdownCacheStats().blocks
  assert.ok(size <= CAP, `the sealed-block cache grew to ${size} — the drop-oldest guard is not holding`)

  const before = markdownParseCount.calls
  renderMarkdown(base + CAP + 99, `sealed paragraph ${CAP + 99}`, false)
  assert.equal(markdownParseCount.calls, before, 'the newest sealed block must still be a cache hit')
  renderMarkdown(base, 'sealed paragraph 0', false)
  assert.equal(markdownParseCount.calls, before + 1, 'an evicted id must re-parse — a hit here would mean the cache returned the wrong block')
})

test('a stream that never seals still cannot grow the per-block streaming map without bound', () => {
  const base = 3_000_000
  for (let i = 0; i < CAP + 50; i++) renderMarkdown(base + i, `open block ${i}`, true)
  const size = markdownCacheStats().streams
  assert.ok(size <= CAP, `the streaming map grew to ${size} — open blocks that never seal are unbounded`)
})
