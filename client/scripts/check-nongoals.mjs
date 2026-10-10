#!/usr/bin/env node
/**
 * check-nongoals.mjs — the plan's 铁律 (§1/§6), measured instead of asserted.
 *
 * "只当 sidecar 的前端" is easy to keep saying and easy to break quietly: one helper that
 * reads a session file from disk because the HTTP route was inconvenient, one `git add`
 * that swept a kernel fix in with a client change. So this checks the non-goals the same
 * way the protocol drift is checked — from the tree, on every CI run.
 *
 *   node scripts/check-nongoals.mjs          # human output
 *   node scripts/check-nongoals.mjs --quiet  # only failures (used by ci-smoke)
 *
 * Four checks:
 *   1. nothing outside `client/` was touched — the kernel, docs and scripts of the host
 *      repo are byte-identical to what we synced;
 *   2. no SQLite driver anywhere in the client — the session library belongs to the
 *      sidecar, and a second reader would fight its single-writer StoreLock;
 *   3. the protocol/UI layers never import node builtins that reach the disk or spawn
 *      processes; only `apps/desktop` (a shell by definition) and `scripts/` may;
 *   4. no path is constructed into the user's own runtime root (`~/.rivet`,
 *      `%LOCALAPPDATA%\.rivet`, `homedir()`), which is where the official desktop keeps
 *      its store — in *code*, comments excluded.
 *
 * A fifth check is a *decision* rather than a prohibition, and it earns its place because
 * the failure mode is silent: E4 client tool delegation was ruled **not adopted** on
 * 2026-10-10, so the client must not register delegate capabilities. Half-wiring one of the
 * two routes — without the preload and the path validation the feature needs — would make
 * the sidecar start hanging tools for a client that cannot land them, and the contract's
 * own `resolve(null)` fallback would paper over it five minutes later.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const quiet = process.argv.includes('--quiet')

const failures = []
const check = (label, ok, detail = '') => {
  if (!quiet || !ok) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

function sources(dir, re = /\.(ts|tsx|mjs|js)$/) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (re.test(e.name)) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

// 1. the host repo is untouched. What counts as a violation is a *tracked* file outside
//    client/ being modified or deleted — `git status` also reports untracked things, and
//    those are a different category: the runtime seeds `.rivet/skills/**` into any session
//    cwd, `analysis-reports/` was never in this synced projection, and the user's own
//    launcher predates the client. Silently passing on those would be wrong too, so they
//    are printed as an inventory rather than asserted away.
const tracked = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', '.', ':(exclude)client'],
  { cwd: repoRoot, encoding: 'utf8' })
const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude)client'],
  { cwd: repoRoot, encoding: 'utf8' })
if (tracked.status !== 0) {
  check('git can diff the host repo', false, (tracked.stderr || tracked.stdout).trim().slice(0, 120))
} else {
  const changed = (tracked.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  check('no tracked file outside client/ is modified or deleted', changed.length === 0,
    changed.slice(0, 4).join(' '))
}
const strangers = (untracked.stdout ?? '').split('\0').filter(Boolean)
  // Deep trees are reported once at the top, not file by file: `.rivet/skills/**` is a
  // couple of hundred runtime-seeded files and would bury everything else.
  .map((p) => p.split('/')[0] + (p.includes('/') ? '/' : ''))
if (!quiet && strangers.length > 0) {
  console.log(`  i untracked outside client/ (not a violation, listed for the record): ${[...new Set(strangers)].join(' ')}`)
}

// 2. no second reader of the session library.
const shipped = [...sources(join(clientRoot, 'packages')), ...sources(join(clientRoot, 'apps'))]
const sqlite = shipped.filter((f) => /better-sqlite3|node:sqlite|DatabaseSync|\.sqlite3?/.test(strip(readFileSync(f, 'utf8'))))
check('no SQLite driver in any shipped client source', sqlite.length === 0,
  sqlite.map((f) => relative(clientRoot, f)).slice(0, 3).join(' '))

// 3. the protocol and UI layers have no disk or process access.
//    Excluded on purpose: apps/desktop (its whole job is spawning children) and any test.
const privileged = shipped
  .filter((f) => !f.includes(join('apps', 'desktop')) && !/\.test\./.test(f))
  .filter((f) => /from ['"]node:(fs|child_process|net|http)['"]|require\(['"]node:(fs|child_process)['"]/.test(strip(readFileSync(f, 'utf8'))))
check('packages/* and apps/web never import node:fs or node:child_process', privileged.length === 0,
  privileged.map((f) => relative(clientRoot, f)).slice(0, 3).join(' '))

// 4. nobody reaches for the user's runtime root.
const HOME_RE = /LOCALAPPDATA|homedir\s*\(|['"]~[/\\]\.rivet|process\.env\.HOME|os\.homedir/
const homeward = shipped.filter((f) => HOME_RE.test(strip(readFileSync(f, 'utf8'))))
check('no shipped source constructs a path into the user profile', homeward.length === 0,
  homeward.map((f) => relative(clientRoot, f)).slice(0, 3).join(' '))

// 5. E4 client tool delegation is a closed decision, not an unfinished feature.
//    Comments are stripped first, so this file's own prose about the routes cannot trip it.
const DELEGATE_RE = /delegate-capabilities|delegate\/[^\s'"`]*\/result/
const delegates = shipped.filter((f) => DELEGATE_RE.test(strip(readFileSync(f, 'utf8'))))
check('E4 未参与：两条 delegate 路由在 shipped 源码里零调用点（2026-10-10 定为不接）',
  delegates.length === 0, delegates.map((f) => relative(clientRoot, f)).slice(0, 3).join(' '))

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  console.error('这些是计划的非目标，不是风格偏好——先回退改动，再解释为什么需要它。')
  process.exit(1)
}
if (!quiet) console.log(`\nnon-goal checks passed (${shipped.length} shipped files scanned)`)
