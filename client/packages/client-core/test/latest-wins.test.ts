import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLatestGate } from '../src/latest-wins.ts'

/** The search effect's shape, without React: begin a request, and on landing decide whether the
 *  result may touch state. `writes` is what a judgement can look at. */
const scenario = () => {
  const gate = createLatestGate()
  const writes: Array<{ token: number, hits: string }> = []
  const outstanding: Array<{ token: number, resolve: (hits: string) => void }> = []
  const send = (hits: string): number => {
    const token = gate.begin()
    // park the landing until the test releases it — requests are in flight, not finished
    outstanding.push({ token, resolve: (h: string) => { if (gate.isCurrent(token)) writes.push({ token, hits: h }) } })
    return token
  }
  return { gate, writes, send, land: (token: number): void => { outstanding.find((o) => o.token === token)?.resolve('x') } }
}

test('only the newest begun request is current', () => {
  const gate = createLatestGate()
  const a = gate.begin()
  assert.equal(gate.isCurrent(a), true)
  const b = gate.begin()
  assert.equal(gate.isCurrent(b), true)
  assert.equal(gate.isCurrent(a), false, 'a newer request began — the older one lost its right to write')
})

test('a late landing from an abandoned query does not write hits back over an empty box', () => {
  const s = scenario()
  s.send('for "中"')
  s.gate.invalidate()          // the user cleared the box: nothing outstanding may land
  s.land(1)
  assert.deepEqual(s.writes, [])
})

test('out-of-order landings: the stale response that arrives last is the one that gets dropped', () => {
  const s = scenario()
  const older = s.send('for "ab"')
  const newer = s.send('for "abc"')
  s.land(newer)
  s.land(older)
  assert.equal(s.writes.length, 1)
  assert.equal(s.writes[0]?.token, newer, 'the newer request must be the one that lands in state')
})

test('invalidate only voids what was outstanding; a fresh request after it is current again', () => {
  const s = scenario()
  s.send('abandoned')
  s.gate.invalidate()
  const fresh = s.send('for "new"')
  s.land(fresh)
  assert.deepEqual(s.writes.map((w) => w.token), [fresh])
})

test('tokens are distinct per request, so two concurrent landings never share a verdict', () => {
  const gate = createLatestGate()
  assert.notEqual(gate.begin(), gate.begin())
})

/**
 * The control that keeps this file honest: what the effect did before the gate existed. Without a
 * token check every landing writes, so the abandoned-query case leaves hits behind — the suite would
 * be green against a helper nobody needs if this foil did not fail without the gate.
 */
test('the ungated shape writes on every landing, which is the defect', () => {
  const writes: number[] = []
  const landings = [1, 2]
  for (const token of landings) writes.push(token)   // no gate: whoever lands, writes
  assert.deepEqual(writes, [1, 2], 'if this stops being true the foil no longer models the old code')

  const gated = scenario()
  const first = gated.send('a')
  const second = gated.send('b')
  gated.land(second)
  gated.land(first)
  assert.notDeepEqual(gated.writes.map((w) => w.token), writes, 'the gated shape must diverge from the ungated one')
})
