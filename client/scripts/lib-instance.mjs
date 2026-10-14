/**
 * lib-instance.mjs — one read-only answer to "is a runtime of *this repo* still alive?".
 *
 * Two verifiers need it from opposite directions:
 *  - `verify-desktop` asks it **after** CDP fails to list a page, because the thing that actually
 *    breaks that probe is a `serve --port …` daemon left behind by an earlier crashed run — a process
 *    that leaves no name in any output (2026-10-12: two rounds lost to rediscovering it);
 *  - `verify-single-instance` asks it **before** booting instance A, because A can die mid-boot when
 *    the previous step is still tearing its own sidecar down (aggregate-only flake, 2026-10-12 08:51);
 *  - `check-live-geometry` asks the *lock* half (`lockCensus`): a run that crashed leaves its detached
 *    sidecar's `scheduled_tasks.lock` behind, and `cron-lock.ts` refuses to steal a lock whose owner
 *    pid is still alive — every later run in that reused dir gets `503 scheduler_not_owner`.
 *
 * It lives in one file because a PowerShell one-liner that can only fail *silently* must not have two
 * copies — the failure mode of a broken lister is "nothing alive", which every caller would read as good.
 *
 * Nothing here ever kills anything: reaping a PID is the operator's call, and `AGENTS.md` plus the
 * project's own rule say to go by PID, never by image name.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PROBE_FAILED = '(探针本身没跑成：'
export { PROBE_FAILED }

/** Lines like `pid=… name=… created=… :: <command line>`, for node/electron processes we own. */
export function listProjectRuntimes() {
  const ps = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const out = execFileSync(ps, ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*Tianshu-harness*' -and ($_.Name -like '*node*' -or $_.Name -like '*electron*') } | ForEach-Object { \"pid=$($_.ProcessId) name=$($_.Name) created=$($_.CreationDate.ToString('yyyy-MM-ddTHH:mm:ss')) :: $($_.CommandLine)\" }",
    ], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    return [`${PROBE_FAILED}${e.message})`]
  }
}

/**
 * Which of these pids still exist. `probeFailed:true` means the lister itself broke, and no caller
 * may read that as "dead" — a broken lister that reports "the lock owner is gone" is how you end up
 * declaring a poisoned run clean. Pids are coerced to positive integers before they reach the
 * command line: they come out of a lock file this process did not write.
 */
function filterAlivePids(pids) {
  const ids = [...new Set(pids.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0))]
  if (ids.length === 0) return { alive: new Set(), probeFailed: false }
  const ps = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    const out = execFileSync(ps, ['-NoProfile', '-Command',
      `$ids = @(${ids.join(',')}); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $_.ProcessId }`,
    ], { encoding: 'utf8', timeout: 8_000, stdio: ['ignore', 'pipe', 'ignore'] })
    return { alive: new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(Number)), probeFailed: false }
  } catch (e) {
    return { alive: new Set(), probeFailed: true, message: e.message }
  }
}

/**
 * Read-only census of `*.lock` in a state/desktop dir: each file names a pid (that is how
 * `src/server/cron-lock.ts` records ownership), and the only question a verifier can act on is
 * whether that pid is still running — a live one means a leaked runtime of ours is still serving the
 * lock, and stealing its file would be us breaking a running instance.
 */
export function lockCensus(storeDir) {
  let names
  try {
    names = readdirSync(storeDir).filter((n) => n.endsWith('.lock'))
  } catch (e) {
    // A dir we cannot read is NOT "a dir with no locks" — that reading would turn a broken probe
    // into a clean bill of health, which is the one mistake this file exists to prevent. ENOENT is
    // the honest exception: a dir that has never been created cannot hold a lock, and the caller
    // creates it moments later.
    if (e.code === 'ENOENT') return { dir: storeDir, entries: [], probeFailed: false, absent: true }
    return { dir: storeDir, entries: [], probeFailed: true, note: `目录读不到：${e.code || e.message}` }
  }
  const parsed = names.map((file) => {
    try {
      const j = JSON.parse(readFileSync(join(storeDir, file), 'utf8'))
      return { file, pid: Number(j.pid), acquiredAt: typeof j.acquiredAt === 'string' ? j.acquiredAt : '', hostname: j.hostname }
    } catch {
      return { file, pid: NaN }
    }
  })
  const alive = filterAlivePids(parsed.map((p) => p.pid))
  return {
    dir: storeDir,
    probeFailed: alive.probeFailed,
    entries: parsed.map((p) => ({
      ...p,
      state: Number.isInteger(p.pid) && p.pid > 0
        ? (alive.probeFailed ? 'unknown' : alive.alive.has(p.pid) ? 'alive' : 'dead')
        : 'unreadable',
    })),
  }
}

/**
 * Wait until nothing of ours is running, or the budget is spent. Reports which happened — a caller
 * must never confuse "the lister is broken" with "the machine is quiet".
 */
export async function waitForQuietRuntimes(budgetMs = 12_000, intervalMs = 500, matches = () => true) {
  const started = Date.now()
  for (;;) {
    const lines = listProjectRuntimes()
    if (lines.some((l) => l.startsWith(PROBE_FAILED))) {
      return { quiet: false, probeFailed: true, waitedMs: Date.now() - started, lines, mine: [] }
    }
    const mine = lines.filter(matches)
    if (mine.length === 0 || Date.now() - started >= budgetMs) {
      return { quiet: mine.length === 0, probeFailed: false, waitedMs: Date.now() - started, lines, mine }
    }
    // 有界等待：预算到点必返回，绝不无声挂住整道门（check:layers 的「验法等待有界」管着这类路径）。
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
