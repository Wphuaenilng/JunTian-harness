import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeEntities, highlightCodeBlocks, languageOf, resetHighlightCache, highlightStats } from '../src/highlight.ts'

const fence = (lang: string, code: string): string => `<pre><code class="language-${lang}">${code}</code></pre>`

test('the five micromark entities decode back to real bytes; nothing else is guessed', () => {
  assert.equal(decodeEntities('a &lt; b &amp;&amp; c &gt; d'), 'a < b && c > d')
  assert.equal(decodeEntities('&quot;x&quot;'), '"x"')
  assert.equal(decodeEntities("it&#39;s"), "it's")
  // An unterminated form is left verbatim rather than half-decoded into a different byte.
  assert.equal(decodeEntities('a &lt b'), 'a &lt b')
})

test('only a labelled fence is a job', () => {
  assert.equal(languageOf('ts'), 'ts')
  assert.equal(languageOf('python3'), 'python3')
  for (const not of ['', '   ', 'text', 'console', 'output', 'none']) {
    assert.equal(languageOf(not), null, `${JSON.stringify(not)} is not a language`)
  }
})

test('a labelled block is replaced, an unlabelled one is not touched', async () => {
  resetHighlightCache()
  const html = `<p>lead</p>${fence('ts', 'const a = 1')}`
  const out = await highlightCodeBlocks(html, async (code, lang) => `<pre class="shiki" data-lang="${lang}">${code}</pre>`)
  assert.match(out, /^<p>lead<\/p>/, 'surrounding html survives')
  assert.match(out, /<pre class="shiki" data-lang="ts">const a = 1<\/pre>/)
  assert.ok(!out.includes('language-ts'), 'the plain block is gone, not appended to')

  const plain = '<pre><code>no info string</code></pre>'
  const before = highlightStats().renders
  assert.equal(await highlightCodeBlocks(plain, async () => '<pre class="shiki">x</pre>'), plain)
  assert.equal(highlightStats().renders, before, 'a page with no labelled fence never calls the renderer')
})

test('identical blocks render once; a failing grammar leaves the block plain', async () => {
  resetHighlightCache()
  const twice = `${fence('ts', 'same()')}<p>mid</p>${fence('ts', 'same()')}`
  const out = await highlightCodeBlocks(twice, async (code, lang) => `<PRE ${lang}>${code}</PRE>`)
  assert.equal(highlightStats().renders, 1, 'two identical blocks are one shiki render')
  assert.equal(out.split('<PRE ts>same()</PRE>').length - 1, 2, 'both blocks still get replaced')

  resetHighlightCache()
  const cachedBefore = highlightStats().cached
  const boom = fence('cobol', 'DIVISION.')
  const kept = await highlightCodeBlocks(boom, async () => { throw new Error('no such grammar') })
  assert.equal(kept, boom, 'a failure must leave the micromark html exactly as emitted')
  assert.equal(highlightStats().cached, cachedBefore, 'a failed block is not cached as a success')
})

test('dollar sequences inside shiki html are not expanded by the replacement', async () => {
  resetHighlightCache()
  // `$&` and `$1` would be replacement patterns if the substitution used the string form.
  const out = await highlightCodeBlocks(fence('ts', 'x'), async () => `<pre>$& $1 $${'{'}</pre>`)
  assert.equal(out, '<pre>$& $1 ${</pre>')
})
