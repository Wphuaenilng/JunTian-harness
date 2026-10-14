import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_NAMESPACE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  bridgeBootstrap,
  clampHeight,
  createNonce,
  decodeInbound,
  encodeOutbound,
  injectBridge,
  looksLikeHtmlDocument,
} from '../src/app-frame.ts'

const here = dirname(fileURLToPath(import.meta.url))
const NONCE = 'aa'.repeat(16)

test('only a real HTML document is treated as an embedded view', () => {
  assert.equal(looksLikeHtmlDocument('<!DOCTYPE html><html><body>hi</body></html>'), true)
  assert.equal(looksLikeHtmlDocument('\n  <html lang="en">'), true)
  // The dangerous false positives: tool prose and diffs must keep rendering as text.
  assert.equal(looksLikeHtmlDocument('已写入 13 字节（2 行）到 <b>path</b>'), false)
  assert.equal(looksLikeHtmlDocument('--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n+x'), false)
  assert.equal(looksLikeHtmlDocument('<html'), false, 'an unterminated tag is not a document')
  assert.equal(looksLikeHtmlDocument(''), false)
})

test('the head window is a window, not a search of the whole document', () => {
  assert.equal(looksLikeHtmlDocument('report: <!doctype html> is used downstream'), true)
  assert.equal(looksLikeHtmlDocument(`${'x'.repeat(500)}<!doctype html>`), false, 'past the 400-char head window')
})

test('the nonce is CSPRNG-shaped, unique, and absent when no CSPRNG exists', () => {
  const a = createNonce()
  const b = createNonce()
  assert.match(a!, /^[0-9a-f]{32}$/)
  assert.notEqual(a, b)

  const real = globalThis.crypto
  // Deliberate degradation path: no getRandomValues → no frame, never a guessed token.
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  assert.equal(createNonce(), null)
  Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true })
  assert.match(createNonce()!, /^[0-9a-f]{32}$/)
})

test('height is clamped to a range a hostile frame cannot stretch', () => {
  assert.equal(clampHeight(240), 240)
  assert.equal(clampHeight(1), MIN_HEIGHT)
  assert.equal(clampHeight(10 ** 9), MAX_HEIGHT)
  assert.equal(clampHeight(100.6), 101, 'rounded, not floated into layout thrash')
  for (const bad of [0, -5, NaN, Infinity, '200', null, undefined, {}]) {
    assert.equal(clampHeight(bad), null, `${String(bad)} is not a height`)
  }
})

test('inbound messages are accepted only with this frame’s own nonce', () => {
  assert.deepEqual(decodeInbound({ type: APP_NAMESPACE, kind: 'ready', nonce: NONCE }, NONCE), { kind: 'ready', nonce: NONCE })
  assert.deepEqual(decodeInbound({ type: APP_NAMESPACE, kind: 'resize', nonce: NONCE, height: 320 }, NONCE), { kind: 'resize', nonce: NONCE, height: 320 })
  assert.deepEqual(
    decodeInbound({ type: APP_NAMESPACE, kind: 'link', nonce: NONCE, href: 'https://example.com/a' }, NONCE),
    { kind: 'link', nonce: NONCE, href: 'https://example.com/a' },
  )

  assert.equal(decodeInbound({ type: APP_NAMESPACE, kind: 'ready', nonce: 'other' }, NONCE), null, 'wrong nonce')
  assert.equal(decodeInbound({ type: 'something.else', kind: 'ready', nonce: NONCE }, NONCE), null, 'wrong envelope')
  assert.equal(decodeInbound({ kind: 'ready', nonce: NONCE }, NONCE), null, 'no envelope')
  assert.equal(decodeInbound({ type: APP_NAMESPACE, kind: 'eval', nonce: NONCE }, NONCE), null, 'unknown kind')
  assert.equal(decodeInbound({ type: APP_NAMESPACE, kind: 'link', nonce: NONCE, href: 'javascript:alert(1)' }, NONCE), null, 'non-http href')
  assert.equal(decodeInbound({ type: APP_NAMESPACE, kind: 'link', nonce: NONCE, href: 'file:///etc/passwd' }, NONCE), null)
  assert.equal(decodeInbound({ type: APP_NAMESPACE, kind: 'resize', nonce: NONCE, height: -1 }, NONCE), null)
  for (const junk of [null, undefined, 42, 'ready', [], () => 0]) {
    assert.equal(decodeInbound(junk, NONCE), null)
  }
})

test('the bootstrap carries the nonce and exposes only the three helpers', () => {
  const boot = bridgeBootstrap(NONCE)
  assert.ok(boot.includes(NONCE))
  assert.ok(boot.includes(`"${APP_NAMESPACE}"`))
  // The frame gets a postMessage shim and nothing that reaches back into the host.
  for (const forbidden of ['parent.document', 'localStorage', 'fetch(', 'cookies']) {
    assert.ok(!boot.includes(forbidden), `bootstrap must not touch ${forbidden}`)
  }
})

test('outbound envelope echoes the namespace the frame listens for', () => {
  const env = encodeOutbound({ kind: 'theme', nonce: NONCE, theme: 'dark' })
  assert.equal(env['type'], `${APP_NAMESPACE}-host`)
  assert.equal(env['nonce'], NONCE)
  assert.equal(env['theme'], 'dark')
})

test('the bridge is injected ahead of the document’s own scripts', () => {
  // Marker word chosen so it cannot accidentally match inside a tag name or doctype.
  const before = (doc: string): [number, number] => {
    const out = injectBridge(doc, NONCE)
    return [out.indexOf('__tianshu__'), out.indexOf('MARK')]
  }

  const withHead = '<!doctype html><html><head><title>t</title></head><body><script>MARK()</script></body></html>'
  const [bridge, mark] = before(withHead)
  assert.ok(bridge < mark, 'head document: bridge before the author script')

  const headless = '<html lang="en"><body>MARK</body></html>'
  assert.ok(before(headless)[0] < before(headless)[1], 'no head element: bridge lands after <html>')

  const bodyless = '<div>MARK</div>'
  assert.ok(before(bodyless)[0] < before(bodyless)[1], 'fragment: bridge goes first')

  const onlyBody = '<!doctype html><body>MARK</body>'
  assert.ok(before(onlyBody)[0] < before(onlyBody)[1], 'no head → right after <body>')
})

test('injection cannot be steered by dollar-sign sequences in the document', () => {
  // A `$&` in the author document would have been expanded as a replacement pattern had
  // the bridge used String.replace; slicing keeps every byte of the document literal.
  const doc = '<!doctype html><head></head><body><p>$& $` $$</p></body>'
  const out = injectBridge(doc, NONCE)
  assert.ok(out.includes('<p>$& $` $$</p>'), 'document text survives verbatim')
  assert.equal(out.split('<script>').length - 1, 1, 'the bridge is injected exactly once')
})

/**
 * The sandbox attribute is the whole security story, and it is one string in a .tsx
 * file node cannot import. Pinned here rather than trusted to a code review.
 */
test('the frame is sandboxed without same-origin privileges', () => {
  const view = readFileSync(join(here, '..', 'src', 'app-frame-view.tsx'), 'utf8')
  // Read the attribute value, not the prose: the file *explains* why allow-same-origin
  // is missing, and a substring scan would trip over its own documentation.
  const attrs = [...view.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/))
  assert.equal(attrs.length, 1, 'exactly one sandboxed iframe in this component')
  const [granted] = attrs
  assert.deepEqual(granted, ['allow-scripts'])
  for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-downloads']) {
    assert.ok(!granted!.includes(forbidden), `${forbidden} would widen the blast radius`)
  }
  assert.match(view, /referrerPolicy="no-referrer"/)
})
