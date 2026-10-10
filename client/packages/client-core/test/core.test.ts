import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyStreamEvent } from '../src/stream-accept.ts'
import { EVENT_CATEGORY, categorize } from '../src/event-category.ts'

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'protocol-manifest.json'), 'utf8')) as {
  eventTypeCount: number
  eventTypes: string[]
}

test('seq=0 synthetic meta events pass through without advancing lastSeq', () => {
  assert.equal(classifyStreamEvent(0, 41), 'meta')
  assert.equal(classifyStreamEvent(42, 41), 'next')
  assert.equal(classifyStreamEvent(41, 41), 'dup')
  assert.equal(classifyStreamEvent(40, 41), 'dup')
})

test('every event in the generated contract is categorized exactly once', () => {
  const table = Object.keys(EVENT_CATEGORY).sort()
  const contract = [...manifest.eventTypes].sort()
  assert.deepEqual(table, contract, 'EVENT_CATEGORY must cover the contract union — regenerate, then categorize new events')
  assert.equal(manifest.eventTypeCount, contract.length)
})

test('unknown wire event types fall back to custom instead of throwing', () => {
  // A newer sidecar may send events this build has never seen; ignoring is the
  // documented tolerance (protocol.ts: additive changes do not bump the version).
  assert.equal(categorize('event_invented_next_week'), 'custom')
  assert.equal(categorize('text_delta'), 'text')
})

test('approvals live in the category the UI arms its hang timeout on', () => {
  // OpenCode #16367 class of bug: a silent pending approval is a hung session.
  assert.equal(categorize('approval_required'), 'lifecycle')
  assert.equal(categorize('approval_snapshot'), 'lifecycle')
  assert.equal(categorize('unattended_halt'), 'lifecycle')
})
