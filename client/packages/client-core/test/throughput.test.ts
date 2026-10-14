import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokensPerSecond, formatThroughput, type ThroughputSample } from '../src/throughput.ts'

const sample = (outputTokens: number, atMs: number): ThroughputSample => ({ outputTokens, atMs })

test('the drawing\'s 42 tok/s is what a 10s poll gap carrying 420 new tokens means', () => {
  const tps = tokensPerSecond(sample(625, 1_000), sample(1045, 11_000))
  assert.equal(tps, 42)
  assert.equal(formatThroughput(tps), '42 tok/s')
})

test('the first poll of a run reports no rate — there is nothing to compare against', () => {
  assert.equal(tokensPerSecond(null, sample(1045, 11_000)), null)
  assert.equal(formatThroughput(null), null)
})

test('a non-positive interval is not a rate (two reads of the same response would divide by zero)', () => {
  assert.equal(tokensPerSecond(sample(100, 5_000), sample(200, 5_000)), null)
  assert.equal(tokensPerSecond(sample(100, 5_000), sample(200, 4_000)), null)
})

test('no new output, or a counter that went backwards after an agent rebuild, yields no rate instead of 0 tok/s', () => {
  assert.equal(tokensPerSecond(sample(1000, 5_000), sample(1000, 15_000)), null)
  assert.equal(tokensPerSecond(sample(1000, 5_000), sample(20, 15_000)), null)
})

test('a real but sub-1 rate reads `<1 tok/s`, never `0`', () => {
  assert.equal(formatThroughput(tokensPerSecond(sample(0, 0), sample(6, 10_000))), '<1 tok/s')
})

test('whole numbers are the drawing\'s format, and rounding is not allowed to invent a rate out of zero', () => {
  assert.equal(formatThroughput(41.6), '42 tok/s')
  assert.equal(formatThroughput(0), null)
  assert.equal(formatThroughput(-3), null)
})
