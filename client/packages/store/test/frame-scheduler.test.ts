import test from 'node:test'
import assert from 'node:assert/strict'
import { createFrameScheduler } from '../src/index.ts'

/**
 * Plan §4.3 #3 names three notification cadences and §4.2's store row says "rAF 合帧" — that
 * coalescer is `createFrameScheduler`, and until now nothing in the tree exercised it: the only
 * trace was a docstring line in `client-core/test/cadence.test.ts`. A scheduler whose whole job is
 * "run once per frame, but never never" is easy to break silently (drop the `queued` reset and the
 * status counters freeze after the first frame; drop the timeout and they freeze on any hidden tab),
 * and both failures look identical from the outside: a number that stops moving.
 *
 * The stubbed `requestAnimationFrame` is not a shortcut — the starve path *is* the behaviour the
 * project measured in its own embedded browser (a counter batched on rAF alone stayed at zero
 * forever on a hidden page), so tests need to be able to withhold frames on purpose.
 */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Installs a controllable rAF; `fire()` runs the callbacks registered so far, exactly once each. */
function fakeRaf(): { install: () => void; restore: () => void; fire: () => void; registered: () => number } {
  const real = globalThis.requestAnimationFrame
  let cbs: Array<() => void> = []
  let seen = 0
  return {
    install() {
      cbs = []
      globalThis.requestAnimationFrame = ((cb: () => void) => { cbs.push(cb); return ++seen }) as typeof requestAnimationFrame
    },
    restore() { globalThis.requestAnimationFrame = real },
    fire() { const pending = cbs; cbs = []; for (const cb of pending) cb() },
    registered: () => seen,
  }
}

test('many requests inside one frame produce exactly one repaint', async () => {
  const raf = fakeRaf()
  let runs = 0
  raf.install()
  try {
    const schedule = createFrameScheduler(() => { runs += 1 }, 10)
    for (let i = 0; i < 20; i++) schedule()
    assert.equal(runs, 0, 'nothing may run before the frame')
    assert.equal(raf.registered(), 1, '20 requests must register one frame callback, not 20')
    raf.fire()
    assert.equal(runs, 1)
    await wait(40)   // starveMs is 10: the racing timeout must have been cancelled, not queued up
    assert.equal(runs, 1, 'the starve timer is cleared on flush — a second repaint here would be the double-render this exists to prevent')
  } finally {
    raf.restore()
  }
})

test('when frames never come, the starve timeout still repaints (a hidden page must not freeze)', async () => {
  const raf = fakeRaf()
  let runs = 0
  raf.install()
  try {
    const schedule = createFrameScheduler(() => { runs += 1 }, 10)
    schedule()
    assert.equal(runs, 0)
    await wait(60)              // deliberately never call raf.fire(): this is the background tab
    assert.equal(runs, 1, 'rAF alone is the bug the docstring names — the timeout is what makes the update arrive late instead of never')
  } finally {
    raf.restore()
  }
})

test('no requestAnimationFrame at all (node, older webviews) still works via the timeout', async () => {
  const real = globalThis.requestAnimationFrame
  let runs = 0
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  try {
    const schedule = createFrameScheduler(() => { runs += 1 }, 10)
    schedule()
    schedule()
    await wait(60)
    assert.equal(runs, 1, 'the typeof guard must fall back, not throw or drop the update')
  } finally {
    globalThis.requestAnimationFrame = real
  }
})

test('the scheduler re-arms after a flush instead of running only once ever', async () => {
  const raf = fakeRaf()
  const seen: number[] = []
  let n = 0
  raf.install()
  try {
    const schedule = createFrameScheduler(() => { seen.push((n += 1)) }, 10)
    schedule(); raf.fire()
    schedule(); raf.fire()
    schedule(); raf.fire()
    await wait(40)
    assert.deepEqual(seen, [1, 2, 3], 'streaming deltas keep arriving; a stuck counter at 1 is the classic regression')
    assert.equal(raf.registered(), 3, 'one frame callback per repaint cycle')
  } finally {
    raf.restore()
  }
})
