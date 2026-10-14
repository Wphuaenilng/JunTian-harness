#!/usr/bin/env node
/**
 * verify-single-instance.mjs — the M3 单实例锁, measured rather than read off.
 *
 * The lock is the shell's defence against the one failure the plan calls 高（必踩）: two
 * writers on the same session store. `main.mjs` asked for the lock before booting, which
 * looked right — but "looked right" is exactly how the tray icon nearly shipped undecoded.
 * So this starts a real second copy and watches what happens:
 *
 *   1. instance A boots, prints READY, and records its sidecar in .sidecar-info.json;
 *   2. instance B must refuse *before* booting — no second spawn, no rewrite of the info
 *      file (same token, same port, same sidecar pid, same mtime);
 *   3. A must log that it received the second-instance event and raised its window;
 *   4. A must still be alive afterwards, still the only owner.
 *
 * Nothing here costs an upstream call: the shell boots its sidecar keyless-safe against
 * the desktop state dir and no prompt is ever sent.
 *
 *   node scripts/verify-single-instance.mjs
 */
import { spawn } from 'node:child_process'
import { waitForQuietRuntimes } from './lib-instance.mjs'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(clientRoot, 'apps/desktop')
const scriptsDir = resolve(clientRoot, 'scripts')
const electronPkg = resolve(desktopDir, 'node_modules/electron')
const infoFile = resolve(desktopDir, '.runtime/.sidecar-info.json')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronBinary() {
  const marker = resolve(electronPkg, 'path.txt')
  if (!existsSync(marker)) return null
  const p = resolve(electronPkg, 'dist', readFileSync(marker, 'utf8').trim())
  return existsSync(p) ? p : null
}

const bin = electronBinary()
if (!bin) {
  console.error('electron binary not found under apps/desktop/node_modules/electron/dist —')
  console.error('  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ corepack pnpm install')
  process.exit(1)
}

/** Both copies get the same arguments on purpose: same app, same userData, same lock. */
function launch(tag, smokeSeconds) {
  const child = spawn(bin, [desktopDir, '--smoke', String(smokeSeconds), '--isolate-home'], {
    cwd: clientRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let log = ''
  let exitCode = null
  child.stdout.on('data', (b) => { log += b.toString(); process.stdout.write(`[${tag}] ${b}`) })
  child.stderr.on('data', (b) => { log += b.toString() })
  child.once('exit', (code) => { exitCode = code })
  return {
    child,
    get log() { return log },
    get exitCode() { return exitCode },
    get alive() { return exitCode === null },
  }
}
const readInfo = () => {
  const j = JSON.parse(readFileSync(infoFile, 'utf8'))
  return { token: j.token, port: j.port, pid: j.pid, baseUrl: j.baseUrl, mtime: statSync(infoFile).mtimeMs }
}

let first = null
let second = null
let quietNote = ''
try {
  // 预飞：等**本趟验法自己留下的**运行时收尾，再起 instance A。上一步（会话库 / 桌面壳）留下的 sidecar
  // 若还在退场，A 会在 boot 半途死掉——2026-10-12 08:51 那次聚合红就是这个形状（当时红字还谎称"40s 超时"）。
  // 只等不杀，且只认带验法旗标的那几台（`--smoke` / `--isolate-home`）：操作者自己开着的 天枢 窗口不是我们要
  // 等的东西，把它算进来会让这一步永远红。
  // 先按**我们自己登记文件里的 pid** 收一台残留 sidecar（与收尾那句同一个命令，幂等：没登记就只打
  // "nothing to stop"）。这不是绕开竞态，而是掐死它：daemon 握着会话库（StoreLock）时
  // `launch-sidecar` 会以非零退出，main.mjs 的 `launcherExit !== 0` 随即 throw——09:16 那次 exit=1
  // 就是这个形状。只收"本仓隔离 state 目录里登记的那一台"，不按镜像名杀任何东西。
  const reclaim = spawn(process.execPath, [resolve(scriptsDir, 'launch-sidecar.mjs'), '--state-dir', resolve(desktopDir, '.runtime'), '--stop'], { cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let reclaimOut = ''
  reclaim.stdout?.on('data', (b) => { reclaimOut += b.toString() })
  reclaim.stderr?.on('data', (b) => { reclaimOut += b.toString() })
  await new Promise((r) => { reclaim.once('exit', r); setTimeout(r, 8_000) })
  // 等的判据要**只盯会与本步相冲的那几台**：壳（带 `--smoke`/`--isolate-home`）与**绑定在本步隔离
  // state 目录上的** daemon（命令行里带 `.runtime`）。裸 `serve --port` 不能算——默认目录里的 daemon
  // 用的是另一个会话库，与这里不冲突；把它算进来每趟白等满 12s，还把别人的实例说成我们的残留。
  const quiet = await waitForQuietRuntimes(12_000, 500,
    (l) => /--smoke|--isolate-home|[\\/]\.runtime[\\/]/.test(l))
  quietNote = quiet.probeFailed
    ? `探针没跑成（${quiet.lines[0] ?? ''}），预飞等于没做`
    : quiet.quiet
      ? `干净（等了 ${(quiet.waitedMs / 1000).toFixed(1)}s${quiet.waitedMs > 600 ? '——上一步的收尾与本步确有重叠' : '，无需等待'}）`
      : `等满 ${(quiet.waitedMs / 1000).toFixed(1)}s 仍有 ${quiet.mine.length} 台本仓 runtime 在跑（可能是上一趟留下的，也可能就是操作者自己那台——命令行分不出来，所以这里只报不认）：${quiet.mine.slice(0, 2).map((l) => l.slice(0, 90)).join(' | ')}`
  check('预飞的进程探针可用（不是空转）', !quiet.probeFailed,
    quiet.probeFailed ? quietNote : '能列出本仓 runtime')
  // 占着 StoreLock 的残留 daemon 现在是一条**具名红**，不是让 A 去撞出来的一次崩溃：同日实测——
  // 两台 daemon 抢同一个 store 时，第二台以 `data-dir-locked` 非零退出，`main.mjs:163` 随即 throw，
  // 壳带 1 退出（正是 08:51 与 09:16 那两红的形状）。只报不杀：收哪个 PID 由操作者决定。
  check('预飞：起 A 之前，本步的会话库没有被别的 daemon 占着', quiet.quiet || quiet.probeFailed,
    quiet.probeFailed ? '探针坏了，这条不作数（上一条已红）'
      : quiet.quiet ? quietNote
        : `${quietNote}\n      ↳ 若 A 接着起，它会以 exit=1 死在 launch-sidecar 那一步；真凶在这里，不在壳里。\n${quiet.mine.slice(0, 3).map((l) => `      ↳ ${l.slice(0, 150)}`).join('\n')}`)
  // 把"预飞到底做了什么"打在输出里：收到过一台残留 daemon 与"本来就干净"是两件不同的事，
  // 前者是这次根因的现场证据，后者说明还有别的解释没找到。
  console.log(`  i 预飞：先照登记文件收残留 sidecar — ${reclaimOut.trim().split('\n')[0] ?? '(无输出)'}；随后等本仓运行时静下来 — ${quietNote}`)
  first = launch('A', 120)

  let ready = false
  let polls = 0
  for (let i = 0; i < 80 && !ready && first.alive; i++) {
    polls = i + 1
    if (/READY /.test(first.log)) ready = true
    else if (/SINGLE-INSTANCE refused/.test(first.log)) break
    else await sleep(500)
  }
  if (!ready) {
    // 这条红以前只会说 "no READY line in 40s"，而循环在**子进程一退出就 break**——所以"A 七秒就死了"
    // 也被报成 40 秒超时，exit code 和它自己打的日志全丢了。三种失败面貌必须分开说（没测到 ≠ 超时）。
    // 末行必须**一行一条**打出来：拼成一行会被上层截断成半句话，等于又丢了一次现场。
    const tail = first.log.split('\n').filter(Boolean).slice(-8)
      .map((l) => `      ↳ ${l.slice(0, 220)}`).join('\n')
    // 2026-10-12 实测到的那条真因：会话库的 StoreLock 被上一趟的 daemon 占着，`launch-sidecar` 于是
    // 非零退出、main.mjs:163 throw、壳带 1 退出。它的命令行里**没有** state 目录，进程清单认不出来，
    // 登记文件也随上一趟崩溃丢了——所以预飞收不到它。锁消息里带着 holder pid，就把它提到红字第一句。
    const holder = /holder pid (\d+)/.exec(first.log)?.[1] ?? ''
    check('instance A booted', false, /refused/.test(first.log)
      ? 'another shell already holds the lock — close the running 天枢 window and rerun'
      : !first.alive
        ? `A 在打出 READY 之前就退出了：exit=${first.exitCode}，只等了 ${(polls * 0.5).toFixed(1)}s（不是 ${80 * 0.5}s 超时）。`
          + (holder
            ? `根因点名：会话库 StoreLock 被 **pid ${holder}** 占着（上一趟留下的 daemon：命令行里没有 state 目录，进程清单认不出；登记文件也没了，预飞按文件也收不到它）。收它由你按 PID 决定，本验法不代杀进程。\n`
            : '')
          + `它自己的末 8 行：\n${tail}`
        : `等满 ${80 * 0.5}s 仍没有 READY 行：\n${tail}`)
    throw new Error('instance A never became ready')
  }
  check('instance A holds the lock and booted', /SINGLE-INSTANCE acquired/.test(first.log),
    first.log.split('\n').find((l) => l.startsWith('READY'))?.slice(0, 78) ?? '')

  const before = readInfo()
  check('the sidecar of record is A’s own', Boolean(before.token && before.pid),
    `port=${before.port} pid=${before.pid}`)

  second = launch('B', 120)

  let gone = false
  for (let i = 0; i < 60 && !gone; i++) {
    gone = !second.alive
    if (!gone) await sleep(500)
  }
  check('instance B exited on its own', gone, gone ? `exit=${second.exitCode}` : 'still running after 30s')
  check('instance B refused before booting (no second sidecar, no second window)',
    /SINGLE-INSTANCE refused/.test(second.log) && !/READY /.test(second.log) && !/SINGLE-INSTANCE acquired/.test(second.log),
    second.log.split('\n').find((l) => l.startsWith('SINGLE-INSTANCE'))?.trim() ?? 'no SINGLE-INSTANCE line')
  check('instance B quit with a clean code, not a crash', second.exitCode === 0, `exit=${second.exitCode}`)
  check('instance A was told about it and raised its window', /SECOND-INSTANCE shown=true/.test(first.log),
    first.log.split('\n').find((l) => l.startsWith('SECOND-INSTANCE'))?.trim() ?? 'no SECOND-INSTANCE line')

  const after = readInfo()
  check('the info file is byte-for-byte the same record (nobody rewrote the port/token)',
    before.token === after.token && before.port === after.port && before.pid === after.pid && before.mtime === after.mtime,
    `pid ${before.pid} → ${after.pid}, port ${before.port} → ${after.port}`)
  check('instance A is still the only owner afterwards', first.alive, first.alive ? 'alive' : `exit=${first.exitCode}`)
} catch (e) {
  if (e.message !== 'instance A never became ready') check('verification completed', false, e.message)
} finally {
  for (const inst of [second, first]) {
    if (inst?.alive) inst.child.kill('SIGTERM')
  }
  await sleep(500)
  if (first?.alive) first.child.kill('SIGKILL')
  // SIGTERM does not run Electron's quit handlers, so the detached sidecar would be
  // stranded holding the StoreLock. Reclaim it exactly like verify-desktop.mjs does.
  const stop = spawn(process.execPath, [resolve(scriptsDir, 'launch-sidecar.mjs'), '--state-dir', resolve(desktopDir, '.runtime'), '--stop'], { cwd: clientRoot, stdio: 'ignore' })
  await new Promise((r) => { stop.once('exit', r); setTimeout(r, 8_000) })
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\nsingle-instance lock verified: second copy refused, first copy stayed owner')
