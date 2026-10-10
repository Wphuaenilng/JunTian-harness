import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCockpit, type CockpitSnapshot } from '../src/cockpit-types.ts'

/** Numbers shaped like what the live probe actually returned (see scripts/probe-cockpit.ts). */
const snapshot = (over: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({
  model: {
    name: 'deepseek-flash',
    cacheHitRate: 0.9534,
    inputTokens: 28755,
    outputTokens: 625,
    cacheReadTokens: 27400,
    cacheWriteTokens: 1355,
    cost: 0.0134,
    reasoningEffort: 'medium',
    starDomain: '启明',
  },
  context: { estimatedTokens: 28755, maxTokens: 128000, rounds: 3, compactionState: 'ready' },
  verification: { filesRead: 2, filesModified: 1, deliveryStatus: 'verified', impactedFiles: 1 },
  mcp: { servers: [], totalTools: 0, connectedServers: 0 },
  ...over,
})

test('cockpit readout renders context, cache and cost the way the status bar wants them', () => {
  const r = formatCockpit(snapshot())
  assert.equal(r.model, 'deepseek-flash')
  assert.equal(r.contextPct, 22)
  assert.equal(r.contextLabel, '28.8k/128.0k · 22%')
  assert.equal(r.cachePct, 95)
  assert.equal(r.costLabel, '$0.0134')
  // kfmt only abbreviates ≥1000, so a short reply reads as an exact count.
  assert.equal(r.tokensLabel, '28.8k↑ 625↓')
  assert.equal(r.compactionState, 'ready')
})

test('a session with no context block still renders instead of throwing', () => {
  const r = formatCockpit(snapshot({ context: null }))
  assert.equal(r.contextPct, null)
  assert.equal(r.contextLabel, '—')
  assert.equal(r.compactionState, null)
  // Cost and cache come from model, which is always present.
  assert.equal(r.costLabel, '$0.0134')
})

test('a zero maxTokens cannot produce a divide-by-zero percentage', () => {
  const r = formatCockpit(snapshot({ context: { estimatedTokens: 10, maxTokens: 0, rounds: 0, compactionState: 'idle' } }))
  assert.equal(r.contextPct, null)
})

test('percentages stay inside 0..100 even if the runtime over-reports', () => {
  const r = formatCockpit(snapshot({ context: { estimatedTokens: 200000, maxTokens: 128000, rounds: 9, compactionState: 'compacting' } }))
  assert.equal(r.contextPct, 100)
  assert.equal(r.compactionState, 'compacting')
})
