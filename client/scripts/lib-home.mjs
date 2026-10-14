/**
 * lib-home.mjs — one read-only answer to "did this run touch the operator's own 天枢 home?".
 *
 * Several verifiers boot a real sidecar. Each of them passes `--isolate-home` so transcripts and
 * caches land under a temp root instead of `~/.rivet` — but "I passed the flag" is not evidence.
 * The observable question is whether anything appeared in the operator's directory while the
 * verifier ran, so that is what gets measured: entry **names counted, never read** (reading the
 * contents would be touching someone else's session data, an entirely different line).
 *
 * A single home for this probe on purpose: `verify-desktop` had its own copy, and the whole point of
 * the number is that it must be comparable across a baseline and a re-measure. Two implementations
 * can drift apart and then the before/after comparison stops meaning anything.
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The operator's own 天枢 data root — the thing a verification run must leave alone. */
export function operatorHomePath() {
  return join(homedir(), '.rivet')
}

/**
 * How many entries the operator's home has, or -1 when the directory does not exist at all
 * (a clean machine looks like -1 before and -1 after: that IS "untouched").
 */
export function countOperatorHome() {
  try {
    return readdirSync(operatorHomePath()).length
  } catch {
    return -1
  }
}

/**
 * The before/after sentence for a `~/.rivet` containment record, in one place because the two
 * verifiers that print it must not drift into reporting the same reading differently.
 *
 * It branches on *which side moved* rather than assuming growth, and never does arithmetic through
 * `-1`: that value means "the directory was absent", so `-1 → 5` is "the dir appeared", not "6 new
 * entries". A negative delta is not this run's doing either — a sidecar only writes — so it gets
 * called out as an outside process instead of an accusation against the flag under test.
 */
export function describeHomeDelta(before, after) {
  const label = (n) => (n === -1 ? '目录本来就不存在' : `${n} 项`)
  const blame = 'RIVET_HOME 没被关进临时目录，--isolate-home 只是被传了、没真生效'
  if (after === before) {
    return before === -1 ? '两侧都是 -1：~/.rivet 本来就不存在，也就没有东西可留' : `两边条目数相等（${before} 项）`
  }
  if (after > before) {
    return before === -1
      ? `~/.rivet 本来不存在，这趟给它造出了 ${after} 项——${blame}`
      : `${label(before)} → ${label(after)}：多出 ${after - before} 项——${blame}`
  }
  if (after === -1) {
    return `${label(before)} → 目录整个不见了：sidecar 只写不删，更不会删掉自己的根——有别的进程在动 ~/.rivet，这条判定在此环境下不可信，先去看是谁在读写它`
  }
  return `${label(before)} → ${label(after)}：条目反而少了，不是这趟干的（sidecar 只写不删）——`
    + `有别的进程在动 ~/.rivet，这条判定在此环境下不可信，先去看是谁在读写它`
}
