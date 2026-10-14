#!/usr/bin/env node
/**
 * verify-dev-proxy.mjs — 计划 §4.4 第一格「开发：vite dev + 代理注入 Authorization」的实测。
 *
 * 为什么值得单独验：其余所有证据都跑在**生产形态**（`serve-client.mjs` 同源伺服 + 反代），
 * 开发形态多出一跳（vite 的 proxy），而那一跳此前**从没被任何判定走过**。这条链上还有两个
 * 只写在注释里的宣称：① token 不进浏览器；② SSE 不被 dev 代理缓冲（`x-accel-buffering: no`）。
 *
 *   node scripts/verify-dev-proxy.mjs
 *
 * 零上游花费：只建会话、读心跳与建连序列，不发 prompt。
 * 端口：vite 的代理目标默认 `http://127.0.0.1:5300`，可由 `RIVET_DEV_UPSTREAM` 改指——本脚本就用
 * 它把 vite 指向**自己现挑的** serve-client。必须这样：5300 常常被操作者自己那台 serve-client 占着，
 * 届时我的 serve-client 起不来，而轮询会从**别人的实例**拿到 200——把"没验成"读成"验过了"。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countOperatorHome, describeHomeDelta } from './lib-home.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 打印用的短路径。原先三处判定都按 `clientRoot` 的长度硬切，可其中跟着临时目录走的那两处
 * （`.sidecar-info.json`、隔离 home 里的 marker）根本不在 clientRoot 里，于是
 * `C:\Users\…\.sidecar-info.json` 被切成 `idecar-info.json` 这种看着像相对路径的残句（真这样印过）。
 * 包在里面才切，在外面原样印。
 */
const rel = (p) => (p.startsWith(clientRoot + sep) ? p.slice(clientRoot.length + 1) : p)
/**
 * 端口一律现挑空闲口：原先硬编码 5300/5310，而 5300 很可能被**操作者自己那台 serve-client**
 * 占着——那时我的 serve-client 起不来，轮询却会从别人实例拿到 200，把"没验成"读成"验过了"。
 * vite 的代理目标经 `RIVET_DEV_UPSTREAM` 指到我挑的那一口（默认值仍是配置里的 5300）。
 */
const freePort = () => new Promise((res, rej) => {
  const s = createServer()
  s.on('error', rej)
  s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    const port = typeof a === 'object' && a ? a.port : 0
    s.close(() => res(port))
  })
})
let SERVE_PORT = 0
let VITE_PORT = 0
const results = []
const record = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const deadline = (ms) => Date.now() + ms

const stateDir = mkdtempSync(join(tmpdir(), 'dev-proxy-state-'))
const dataDir = mkdtempSync(join(tmpdir(), 'dev-proxy-data-'))
// 起跑前数一次操作者自己的 `~/.rivet`（只数条目名，不读内容）：`--isolate-home` 是真生效还是
// 只被传了个旗标，回答这个问题要看这趟结束时那个数有没有变。计数在 `lib-home.mjs` 一家。
// 光"没变"不够说明这条判据打在了真发生过的写入路径上：这台机器上 ~/.rivet 本来就不存在，
// 所以两侧都是 -1。另一头同时量**隔离 home 这次真被写过**，两边合起来才叫"关住了"（桌面验法同一招）。
const homeBefore = countOperatorHome()
const runStartedMs = Date.now()
// 隔离 home 落在哪由启动器决定：`--isolate-home` 把 `RIVET_HOME` 指到 `<desktopDir>/rivet-home`，
// sidecar 一开机就往那儿写 `server-info.json`。这条正面证据必须在 `stopAll()` 删临时目录**之前**取。
const isolatedHomeMarker = join(dataDir, 'rivet-home', 'server-info.json')
let wroteIsolatedHome = false
let sidecarUp = false
const children = []

/** 起子进程并把 stdout/stderr 收进缓冲区，失败时报出它在哪个阶段说的什么。 */
function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: clientRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const out = []
  child.stdout?.on('data', (b) => out.push(String(b)))
  child.stderr?.on('data', (b) => out.push(String(b)))
  child.on('exit', (code) => out.push(`[exit ${code}]`))
  children.push({ name, child })
  return { child, tail: () => out.join('').split('\n').slice(-6).join(' | ').slice(0, 400) }
}

async function stopAll() {
  for (const { child, name } of children) {
    try { child.kill('SIGTERM') } catch (e) { console.log(`  kill ${name} 失败：${e.message}`) }
  }
  if (sidecarUp) {
    const r = spawn(process.execPath, [join(clientRoot, 'scripts/launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'], { cwd: clientRoot })
    // 带上限的等：`--stop` 不返回时以前是 `await new Promise((res) => r.on('exit', res))`，
    // 于是整步永挂到外层被杀，报不出"卡在清理"这一句。
    await Promise.race([new Promise((res) => r.on('exit', res)), sleep(8_000).then(() => 'timeout')])
      .then((v) => { if (v === 'timeout') console.log('  sidecar --stop 8 秒没返回，继续（不把它当判定失败）') })
  }
  // 收尾**绝不能把整步炸掉**。`{force:true}` 只压 ENOENT/ENOTDIR，压不住 Windows 上的
  // EBUSY/EPERM：刚 SIGTERM 掉的子进程（尤其同一台机器上还在退的 Electron）可能还攥着 state
  // 目录的句柄。而 stopAll 是在 `finally` 里调的——从 `finally` 抛出的错误**会绕过本文件那个
  // catch**，表现就是"屏上一条 ✗ 都没有、退出码 1、末行 Node.js 版本横幅"。这正是追了很久的
  // 那个非确定性崩溃的形状。清理失败只登记，不致命——但**不能再写成"留下的空目录由 OS 回收"**：
  // 实测留下的不是空目录（registry.db 那套 SQLite、sessions/、.rivet/ 都在里面），照旧说法这样
  // 攒下来了 13 个临时目录。现在先有界重试，真删不掉就把剩余文件数与字节数打出来，让人看得见。
  for (const dir of [stateDir, dataDir]) {
    // 有界重试：句柄是在子进程退出的那一瞬间才放开的，等比"当作没救"便宜。本轮实测同一台实例
    // 停掉之后再删就删得掉（面板沙箱那边验证过）。
    let err = null
    for (let i = 0; i < 6; i++) {
      try { rmSync(dir, { recursive: true, force: true }); err = null; break }
      catch (e) { err = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250) }
    }
    // 还是删不掉的时候，要把**留下了什么**说清楚：这里不是空目录，里面有 registry.db（SQLite，
    // 实例活着时被它自己开着）、sessions/、.rivet/ 等。说成"空目录，由 OS 回收"就是把垃圾
    // 说成噪声——本轮实测这样攒下来了 13 个。数量与字节数都打出来，回收不了就让人看得见。
    if (err !== null) {
      let items = -1
      let bytes = 0
      const walk = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, ent.name)
          if (ent.isDirectory()) walk(p)
          else { items += 1; bytes += statSync(p).size }
        }
      }
      try { walk(dir) } catch { /* 连读都读不到：items 保持 -1，下面如实打"数不出来" */ }
      console.log(`  i 临时目录没删净（${dir}）：${err && err.code ? err.code : err}——不影响判定，不记成失败；`
        + `里面剩 ${items < 0 ? '数不出来' : String(items) + ' 个文件 / ' + String(Math.round(bytes / 1024) + ' KB')}`)
    }
  }
}

let info = null
try {
  // 1) sidecar：隔离的一套库（--isolate-home 免得往操作者的 ~/.rivet 写东西）
  const boot = start('launch-sidecar', process.execPath, [
    join(clientRoot, 'scripts/launch-sidecar.mjs'),
    '--state-dir', stateDir, '--desktop-dir', dataDir, '--isolate-home',
  ])
  const infoFile = join(stateDir, '.sidecar-info.json')
  const t1 = deadline(45_000)
  while (Date.now() < t1) {
    if (existsSync(infoFile)) { try { info = JSON.parse(readFileSync(infoFile, 'utf8')); break } catch { /* 还没写完 */ } }
    await sleep(300)
  }
  if (!info) { record('sidecar 登记文件出现', false, `45 秒内没有 ${infoFile}；启动器输出：${boot.tail()}`); throw new Error('abort') }
  const t2 = deadline(30_000)
  let healthy = null
  while (Date.now() < t2) {
    try {
      const r = await fetch(`${info.baseUrl}/health`, { headers: { authorization: `Bearer ${info.token}` } })
      if (r.status === 200) { healthy = await r.json(); break }
    } catch { /* 还在起 */ }
    await sleep(400)
  }
  if (!healthy) { record('sidecar /health 回到 200', false, `30 秒超时；启动器输出：${boot.tail()}`); throw new Error('abort') }
  sidecarUp = true
  // 这里只报"起来了 + 登记住在哪"。home 隔离不归这条判据吹——它在结尾那条 `~/.rivet` 前后计数里判。
  record(`sidecar 起来了，登记文件就在本步自己的 stateDir 里（${rel(infoFile)}）`,
    existsSync(infoFile) && Number.isFinite(info.pid) && typeof healthy?.protocolVersion === 'number',
    `pid ${info.pid} · ${info.baseUrl} · protocolVersion ${healthy?.protocolVersion ?? '(读不到)'}`)
  try { wroteIsolatedHome = statSync(isolatedHomeMarker).mtimeMs >= runStartedMs - 2_000 } catch { wroteIsolatedHome = false }

  // 2) 现挑两个空闲口：serve-client 与 vite 各一个，谁都没被占的可能
  SERVE_PORT = await freePort()
  VITE_PORT = await freePort()
  record('端口是现挑的空闲口（不撞操作者正在用的 5300/5310）', SERVE_PORT > 0 && VITE_PORT > 0 && SERVE_PORT !== VITE_PORT,
    `serve=${SERVE_PORT} vite=${VITE_PORT}`)
  const serve = start('serve-client', process.execPath, [join(clientRoot, 'scripts/serve-client.mjs'), '--port', String(SERVE_PORT), '--state-dir', stateDir])
  const t3 = deadline(20_000)
  let servedOk = false
  while (Date.now() < t3) {
    try { const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/api/health`); if (r.ok) { servedOk = true; break } } catch { await sleep(300) }
    await sleep(300)
  }
  record(`serve-client 在 :${SERVE_PORT} 应答 /api/health（vite 的代理就指这一口）`, servedOk,
    servedOk ? '200' : `20 秒超时；输出：${serve.tail()}`)
  if (!servedOk) throw new Error('abort')

  // 3) vite dev：直接起它自己的 bin，省掉 shell 层；--strictPort 保证端口不对就失败而不是换个口骗过判定
  // pnpm 不把 devDep 提升到 workspace 根，vite 的真身在 apps/web 下；两处都试，并用完了说用的是哪个
  const viteCandidates = [
    resolve(clientRoot, 'apps/web/node_modules/vite/bin/vite.js'),
    resolve(clientRoot, 'node_modules/vite/bin/vite.js'),
  ]
  const viteBin = viteCandidates.find((p) => existsSync(p))
  record('vite 入口定位（pnpm 的 devDep 落在 apps/web 下，不在 workspace 根）', viteBin !== undefined && existsSync(viteBin),
    viteBin === undefined ? `两处都没有：${viteCandidates.join(' ; ')}` : rel(viteBin))
  if (!viteBin) throw new Error('abort')
  const vite = start('vite', process.execPath, [viteBin, '--port', String(VITE_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: resolve(clientRoot, 'apps/web'),
    // 这一跳的目标口由配置里的 `RIVET_DEV_UPSTREAM` 决定（默认 5300），这里指到我自己那台
    env: { ...process.env, RIVET_DEV_UPSTREAM: `http://127.0.0.1:${SERVE_PORT}` },
  })
  const t4 = deadline(60_000)
  let devOk = false
  while (Date.now() < t4) {
    try { const r = await fetch(`http://127.0.0.1:${VITE_PORT}/`); if (r.ok) { devOk = true; break } } catch { /* not up yet */ }
    await sleep(400)
  }
  record(`vite dev 在 :${VITE_PORT} 起来（--strictPort，绑不上就失败而不是换个口骗过判定）`, devOk,
    devOk ? '轮询 GET / 拿到 2xx' : `60 秒超时；输出：${vite.tail()}`)
  if (!devOk) throw new Error('abort')

  // 4) 走完整链的 /api/health：**我们不带任何 Authorization**，能 200 就说明 token 是在中途注入的
  const viaDev = await fetch(`http://127.0.0.1:${VITE_PORT}/api/health`)
  const devBody = await viaDev.json().catch(() => null)
  record('浏览器侧不带 token 打 vite → /api/health 仍 200（注入发生在 vite→serve-client→sidecar 这一路）',
    viaDev.status === 200 && !!devBody?.protocolVersion, `status ${viaDev.status} · protocolVersion ${devBody?.protocolVersion ?? '缺'}`)

  // 5) dev 伺服的是源码模块（不是构建产物），且产物里找不到那枚 token
  const html = await (await fetch(`http://127.0.0.1:${VITE_PORT}/`)).text()
  const mainSrc = await fetch(`http://127.0.0.1:${VITE_PORT}/src/main.tsx`).then((r) => r.text())
  const appSrc = await fetch(`http://127.0.0.1:${VITE_PORT}/src/App.tsx`).then((r) => r.text())
  const corpus = html + mainSrc + appSrc
  record('dev 把入口当源码发（vite 转译 main.tsx），而不是读构建产物', /@vite\/client|type="module"/.test(html) && appSrc.length > 200,
    `html ${html.length}B · main.tsx ${mainSrc.length}B · App.tsx ${appSrc.length}B`)
  record('dev 发往浏览器的代码里那枚 token 一次都没有出现（正控：token 本身长度 ' + info.token.length + '）',
    !corpus.includes(info.token), corpus.includes(info.token) ? '泄漏：token 出现在 dev 伺服的源码里' : '')

  // 心跳节拍是 **5 秒一发**，但**连上的那一刻**内核会同时发 hello 与 health 两帧——所以前两帧间隔
  // 为 0 是正常的，不是缓冲。真正的判据得看后面的帧：采到 4 帧，相邻间隔里必须出现一个 ≥ 4 秒
  // （说明流在持续增量交付），同时记下**这些帧来自几次 read**——被缓冲的话全部帧会在同一次 read 里到达。
  const sse = await fetch(`http://127.0.0.1:${VITE_PORT}/api/events`)
  const accel = sse.headers.get('x-accel-buffering')
  record('SSE 响应经 vite 带上 x-accel-buffering: no（配置那条宣称的直接证据）', accel === 'no', `实读 ${String(accel)}`)
  const times = []
  const readsWithFrames = []
  if (sse.body) {
    const reader = sse.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const t5 = deadline(24_000)
    while (times.length < 4 && Date.now() < t5) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let gotThisRead = 0
      // 每读到一整帧就记一次时间戳：增量交付才会出现多次带帧的 read
      while (buf.includes('\n\n')) {
        const i = buf.indexOf('\n\n')
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (/^(event|data):/m.test(frame)) { times.push(Date.now()); gotThisRead += 1 }
      }
      if (gotThisRead > 0) readsWithFrames.push(gotThisRead)
    }
    try { await reader.cancel() } catch { /* 已断 */ }
  }
  const gaps = times.slice(1).map((t, i) => t - times[i])
  const maxGap = gaps.length ? Math.max(...gaps) : -1
  record('心跳采到 ≥ 3 帧且**相邻间隔里出现一次 ≥ 4 秒**（流在持续增量交付，不是憋到最后一次给）',
    times.length >= 3 && maxGap >= 4000, `帧 ${times.length} · 间隔 ${JSON.stringify(gaps)} · 有帧的 read ${JSON.stringify(readsWithFrames)}`)
  record('帧来自**多次** read（被代理缓冲的典型形状是全部帧挤在一次交付里）',
    readsWithFrames.length >= 2, `read 次数 ${readsWithFrames.length}`)

  // 7) 建连序列在 dev 这一跳上照旧（会话流：replay_window … approval_snapshot）
  const created = await fetch(`http://127.0.0.1:${VITE_PORT}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: dataDir }),
  })
  const session = await created.json().catch(() => null)
  record('经 vite 建一个会话（POST /api/sessions，零花费）', created.status === 201 && !!session?.id, `status ${created.status}`)
  if (session?.id) {
    const st = await fetch(`http://127.0.0.1:${VITE_PORT}/api/sessions/${session.id}/stream?since=0`)
    const seen = []
    if (st.body) {
      const reader = st.body.getReader()
      const dec = new TextDecoder()
      let b = ''
      const t6 = deadline(12_000)
      while (Date.now() < t6 && !seen.includes('approval_snapshot')) {
        const { value, done } = await reader.read()
        if (done) break
        b += dec.decode(value, { stream: true })
        while (b.includes('\n\n')) {
          const i = b.indexOf('\n\n')
          const m = /^event: (\S+)/m.exec(b.slice(0, i))
          if (m && !seen.includes(m[1])) seen.push(m[1])
          b = b.slice(i + 2)
        }
      }
      try { await reader.cancel() } catch { /* 已断 */ }
    }
    record('dev 这一跳上 §4.3 #1 的建连序列仍成立（replay_window 在前、approval_snapshot 收尾）',
      seen[0] === 'replay_window' && seen.includes('approval_snapshot'), seen.join(' → ').slice(0, 160))
  }
} catch (e) {
  if (e.message !== 'abort') record('未预期的异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e))
} finally {
  await stopAll()
}

// `--isolate-home` 是真生效还是只被传了个旗标：这一趟真建过会话，所以如果 RIVET_HOME 没被关进
// 临时目录，操作者自己的 `~/.rivet` 就会多出条目。只数名字，不读内容（读内容就是碰别人的会话数据）。
const homeAfter = countOperatorHome()
const markerRel = rel(isolatedHomeMarker)
const homeReason = homeAfter !== homeBefore ? describeHomeDelta(homeBefore, homeAfter)
  : wroteIsolatedHome ? `只数名字、未读任何内容；写入证据是本次跑出的 ${markerRel}`
    : sidecarUp ? `${markerRel} 的 mtime 不在本次运行窗口内：--isolate-home 只是被传了、没真生效，"没动过"也就没打在真发生过的写入路径上`
      : `${markerRel} 没出现，而这趟 sidecar 根本没起来（前面已有一条 ✗）——home 隔离这条是**没测到**，不是通过`
record(`这趟没在操作者的 ~/.rivet 里留下东西（前后条目数 ${homeBefore} → ${homeAfter}），且本次确实写进了隔离 home`,
  homeAfter === homeBefore && wroteIsolatedHome, homeReason)

const bad = results.filter((r) => !r.ok)
console.log(`\n${results.length} 项判定，红 ${bad.length} 项`)
process.exit(bad.length === 0 ? 0 : 1)
