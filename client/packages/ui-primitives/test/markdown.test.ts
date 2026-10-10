import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../src/markdown.ts'

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
