#!/usr/bin/env node
/**
 * ci-smoke.mjs — the plan's 贯穿项, as one command.
 *
 *   协议漂移监控 CI：类型镜像 diff + 协议消费台账 + 「握手 + 建会话 + 发消息」冒烟（sidecar 无 key 可起）
 *
 * Two stages, both meant to run unattended:
 *   1. drift — the static gates. How many is not written here on purpose: the authoritative
 *      per-name list is the `# gates:` line in `.github/workflows/client-gates.yml`, and
 *      `check:docs` aligns it with the `spawnSync` targets in this file by name AND order, so a
 *      gate added here without registering there (or vice versa) goes red on the spot. Gates:
 *      `gen-protocol-types.mjs --check` (does `src/server/protocol.ts`
 *      still match the mirrored contract the client compiles against),
 *      `protocol-ledger.mjs --check` (does every `ui-*` README still describe the endpoints
 *      that package actually calls), `check-nongoals.mjs` (kernel untouched, no SQLite,
 *      no disk access from the UI layers, no path into the user profile),
 *      `check-docs.mjs` (every README pointer and table still true),
 *      `check-traps.mjs` (§5.2's six traps still plugged), and
 *      `check-theme.mjs` (the 明暗主题 chain: one stamp as truth source, 'system' follows the
 *      OS, and an embedded frame gets re-pushed when the host theme changes), and
 *      `check-layers.mjs` (§4.2/§4.3 layering: panels never import each other, `store` holds
 *      no business data, `client-core` stays React-free),
 *      `check-mockup-tokens.mjs` (the colour tokens still match the approved mockup, by value),
 *      `check-contrast.mjs` (the AA contrast floors — declared pairs and CSS-source pairs, both
 *      themes; a hard gate since the 2026-10-12 ruling, red means blocked),
 *      `check-layout.mjs` (the layout pinned explicitly: columns, rail widths, narrow measure,
 *      one brand), and
 *      `check-scale.mjs` (the mockup scale has one fact source: tokens.css == the drawing, and
 *      every token is actually consumed), and
 *      `check-wire-mirror.mjs` (the wire shapes the client hand-copies from outside
 *      `protocol.ts` — `TaskRecord`, `HealthBody`, `ScheduledTaskRetry`, the status unions —
 *      still match the kernel field for field; a name the kernel never sends is exactly
 *      "the panel is reading a key that isn't on the wire");
 *   2. smoke — boot a **keyless** sidecar in its own state + data directories, assert
 *      the `/health` handshake (protocolVersion + capabilities), create a session, and
 *      exercise the send path. Then aim a **second** launcher at the same `--desktop-dir`
 *      and audit the store-lock failure path: non-zero exit, an error that actually names
 *      `data-dir-locked` + the holder pid, and **no process left behind** — the last one is
 *      measured with the read-only instance probe before/after, because the launcher prints
 *      "已收掉本机刚起的 pid" there and a claim nobody can falsify is just a rumour.
 *
 * Fail-closed about money: the send step is skipped unless `/health` reports
 * `configured: false`. An empty config file is *written* for this process on purpose —
 * without `RIVET_CONFIG_PATH` the runtime falls back to the user's real config root, so
 * "no key" would not actually be guaranteed and a prompt could reach the upstream API.
 * If that fallback ever leaks a key in, this script refuses the risky step rather than
 * discovering it the expensive way.
 *
 *   node scripts/ci-smoke.mjs            # both stages
 *   node scripts/ci-smoke.mjs --drift    # stage 1 only
 *   node scripts/ci-smoke.mjs --smoke    # stage 2 only
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kernelSidecarFreshness } from './lib-freshness.mjs'
import { listProjectRuntimes, waitForQuietRuntimes, PROBE_FAILED } from './lib-instance.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const args = process.argv.slice(2)
const only = args.includes('--drift') ? 'drift' : args.includes('--smoke') ? 'smoke' : 'both'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const note = (msg) => console.log(`  i ${msg}`)

// ---------------------------------------------------------------- stage 1
function driftStage() {
  const r = spawnSync(process.execPath, [join(clientRoot, 'scripts/gen-protocol-types.mjs'), '--check'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  check('protocol mirror matches the contract leaf (drift gate)', r.status === 0, out.split('\n').pop() ?? '')
  if (r.status !== 0) console.log(out)

  // The plan's other 贯穿项: every ui-* README must carry a *fresh* protocol-consumption
  // ledger. Generated from the real call sites, so a panel that starts calling one more
  // endpoint fails CI until its README says so — a handwritten table would just rot.
  const l = spawnSync(process.execPath, [join(clientRoot, 'scripts/protocol-ledger.mjs'), '--check'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const lOut = `${l.stdout ?? ''}${l.stderr ?? ''}`.trim()
  check('every ui-* README carries a fresh protocol consumption ledger', l.status === 0, lOut.split('\n').pop() ?? '')
  if (l.status !== 0) console.log(lOut)

  // Third gate for the plan's 铁律 (sidecar-only, no kernel edits): cheap, static, and the
  // kind of thing that breaks by accident rather than by decision.
  const g = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-nongoals.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const gOut = `${g.stdout ?? ''}${g.stderr ?? ''}`.trim()
  // 这条 label 过去手写被委托门的条款，于是加一条判据它就静默过期一次（2026-10-12 的颜色字面量
  // 棘轮落地时，汇总里就没有它）。现在条款名从 `check-nongoals.mjs` 自己的 `check('…')` 派生，
  // 并给**派生本身**配一条下限：抽到的中文判据名少于 5 条就报红——门绿也不认，空名单不算覆盖。
  const ngSrc = readFileSync(join(clientRoot, 'scripts/check-nongoals.mjs'), 'utf8')
  const ngCn = [...ngSrc.matchAll(/^[ \t]*check\('([^']+)'/gm)].map((m) => m[1] ?? '').filter((s) => /[㐀-鿿]/.test(s))
  const ngDerived = ngCn.length >= 5
  check(`non-goals hold (no kernel edits, no SQLite, no disk access in the UI layers, E4 not registered；这里只列该门以 check() 命名的 ${ngCn.length} 条判据，全量看门自己打印的行 — ${ngDerived ? ngCn.map((s) => s.split('（')[0]).join(' + ') : '派生失败'})`,
    g.status === 0 && ngDerived,
    ngDerived ? (gOut.split('\n').find((s) => s.startsWith('✗')) ?? 'green')
      : `只从 check-nongoals 抽到 ${ngCn.length} 条中文判据名，汇总不可信`)
  if (g.status !== 0) console.log(gOut)

  // Docs are load-bearing here: the README *is* the ledger the user reads to decide what is
  // done. A pointer to a renamed script or a table that stopped rendering is a false record,
  // and no tsc/test run can see it.
  const d = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-docs.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const dOut = `${d.stdout ?? ''}${d.stderr ?? ''}`.trim()
  check('READMEs tell the truth (paths exist, tables render)', d.status === 0,
    dOut.split('\n').find((s) => s.startsWith('✗')) ?? 'green')
  if (d.status !== 0) console.log(dOut)

  // Plan §5.2: the six traps we already fell into, asserted from the tree so a regression
  // shows up as a red gate rather than as a hung session three weeks from now.
  const tr = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-traps.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const trOut = `${tr.stdout ?? ''}${tr.stderr ?? ''}`.trim()
  check('the six §5.2 traps are still plugged', tr.status === 0,
    trOut.split('\n').find((s) => s.startsWith('✗')) ?? 'green')
  if (tr.status !== 0) console.log(trOut)

  // M2 ships 明暗主题 *and* embedded frames, and the seam between them is invisible: mode
  // 'system' with no media subscription, or a frame push keyed only to mount, both look
  // fine until somebody changes the OS theme or the app theme and part of the UI stays behind.
  const th = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-theme.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const thOut = `${th.stdout ?? ''}${th.stderr ?? ''}`.trim()
  check('the theme chain holds (stamp, system follow, frame re-push)', th.status === 0,
    thOut.split('\n').find((s) => s.startsWith('✗')) ?? 'green')
  if (th.status !== 0) console.log(thOut)

  // §4.2's dependency discipline is invisible to tsc: once a workspace package is listed in
  // another's package.json, `ui-chat` importing `ui-git` compiles fine and the layer diagram
  // becomes decoration. This gate reads the real import specifiers instead.
  const ly = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-layers.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const lyOut = `${ly.stdout ?? ''}${ly.stderr ?? ''}`.trim()
  check('the package layering holds (no cross-panel imports, store stays view-only)', ly.status === 0,
    lyOut.split('\n').find((s) => s.trimStart().startsWith('✗')) ?? 'green')
  if (ly.status !== 0) console.log(lyOut)

  // §2.3 / §4.2: the palette's only source of truth is the approved mockup, and "we transcribed
  // it" was a sentence until this compared them token by token (normalized — a raw string
  // compare produced four false alarms out of whitespace, which is how gates get ignored).
  const mk = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-mockup-tokens.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const mkOut = `${mk.stdout ?? ''}${mk.stderr ?? ''}`.trim()
  check('the colour tokens still match the approved mockup (by value)', mk.status === 0,
    mkOut.split('\n').find((s) => s.trimStart().startsWith('✗')) ?? 'green')
  if (mk.status !== 0) console.log(mkOut)

  // 2026-10-12 裁定 ①：AA 是硬门。这道门以前**故意红、故意不接 CI**，因为它在等一个方向决定；
  // 决定下完、软底色/on-accent 一族建立、图上那两枚过不了 4.5 的值改成逐名登记的偏离之后，它跑绿了，
  // 于是按同一条规矩接进来（绿了就接，红就让它红在流水线里，而不是红在"我记得手跑过"里）。
  // 它现在数两面：36 条声明配对 + 源码侧真实叠在一起的 token×token 配对（错误横幅、diff 行这类
  // 没有夹具就渲不出来的状态，像素门结构上量不到，只有源码这一侧看得见）。
  const co = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-contrast.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const coOut = `${co.stdout ?? ''}${co.stderr ?? ''}`.trim()
  check('the AA contrast floors hold (declared pairs and CSS-source pairs, both themes)', co.status === 0,
    coOut.split('\n').find((s) => s.trimStart().startsWith('✗')) ?? 'green')
  if (co.status !== 0) console.log(coOut)

  // 定稿「设计要点」里能被静态钉住的那半：列序、折叠细条宽度、窄栏机制、状态条横跨、品牌一处。
  // 起因是自动排布把对话流挤到了第三列，而当时所有既有检查（含溢出审计）都是绿的。
  const la = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-layout.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const laOut = `${la.stdout ?? ''}${la.stderr ?? ''}`.trim()
  check('the layout is pinned explicitly (columns, rail widths, narrow measure, one brand)', la.status === 0,
    laOut.split('\n').find((s) => s.trimStart().startsWith('✗')) ?? 'green')
  if (la.status !== 0) console.log(laOut)

  // 图的尺寸刻度是否还有单一事实源：tokens.css 里每个 --scale-* 都要等于 HTML 源稿里的同一数，
  // 且必须真被某个 CSS 用掉（没消费者的 token 只是名义上的事实源）。
  const sc = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-scale.mjs'), '--quiet'], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const scOut = `${sc.stdout ?? ''}${sc.stderr ?? ''}`.trim()
  check('the mockup scale has one fact source (tokens.css == drawing, and each token is consumed)', sc.status === 0,
    scOut.split('\n').find((s) => s.trimStart().startsWith('✗')) ?? 'green')
  if (sc.status !== 0) console.log(scOut)

  // 客户端手抄的线上形状（`protocol.ts` 之外那批 interface / 字面量联合）与内核真源逐字段对账。
  // 类型镜像管的是 `protocol.ts` 那 19 个名字；这一道管**镜像够不着的那批**，红了就是"界面在读一个线上没有的键"。
  const wm = spawnSync(process.execPath, [join(clientRoot, 'scripts/check-wire-mirror.mjs')], {
    cwd: clientRoot, encoding: 'utf8',
  })
  const wmOut = `${wm.stdout ?? ''}${wm.stderr ?? ''}`.trim()
  check('the hand-copied wire shapes still match the kernel field for field', wm.status === 0,
    wmOut.split('\n').find((s) => s.trimStart().startsWith('✗')) ?? 'green')
  if (wm.status !== 0) console.log(wmOut)
}

if (only !== 'smoke') driftStage()
if (only === 'drift') process.exit(failures.length > 0 ? 1 : 0)

// ---------------------------------------------------------------- stage 2
// 先问产物再起进程：这条冒烟断言的是 sidecar 的**行为**，而 `dist/cli/entry.js` 比内核源码旧时，
// 红行描述的是那份已经不存在的实现。同一条纪律在客户端那侧由像素门自己守着（`bundleFreshness`）。
{
  const k = kernelSidecarFreshness(repoRoot)
  check('the sidecar artifact is not older than the kernel source', k.status === 'ok', k.message)
  if (k.status !== 'ok') {
    // 产物旧/不在就别往下起进程——后面每一条读数都会跟着说谎，而且失败长得很像客户端缺陷。
    console.log('\nci-smoke: FAILED (kernel artifact stale or absent — 先 npm run build:bundle 再重跑)')
    process.exit(1)
  }
}

const tmp = resolve(clientRoot, '.ci-smoke')
const stateDir = join(tmp, 'state')
const dataDir = join(tmp, 'data')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(dataDir, { recursive: true })
// The launcher only sets RIVET_CONFIG_PATH when the file exists, and the runtime's
// fallback root is the user's own config — so this file is what makes "keyless" true.
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ provider: { providers: {} } }), { mode: 0o600 })

const infoPath = join(stateDir, '.sidecar-info.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const run = (scriptArgs) => spawn(process.execPath, scriptArgs, {
  cwd: clientRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})

let code = 0
try {
  const launcher = run([
    join(clientRoot, 'scripts/launch-sidecar.mjs'),
    '--state-dir', stateDir, '--desktop-dir', dataDir, '--config', join(dataDir, 'config.json'),
    // 这条冒烟会发一条无 key prompt；不关进临时 home 的话，会话目录会落进操作者的 ~/.rivet。
    '--isolate-home',
  ])
  const out = []
  launcher.stdout.on('data', (b) => out.push(b.toString()))
  launcher.stderr.on('data', (b) => out.push(b.toString()))
  // 带上限：`launch-sidecar.mjs` 正常会自己退场（就绪门有它自己的超时），但它若不退，这一发
  // 会让**整道冒烟门永挂**——而挂掉和"还在跑"在 CI 里长得一模一样，且没有任何输出。
  const exitCode = await Promise.race([
    new Promise((res) => launcher.once('exit', res)),
    sleep(180_000).then(() => { launcher.kill('SIGKILL'); return 'TIMEOUT-180s' }),
  ])
  check('keyless sidecar boots and passes its own health gate', exitCode === 0,
    `exit=${exitCode}${String(exitCode) === 'TIMEOUT-180s' ? ' — 180 秒没退场，已 SIGKILL；这一格是"没测到"，不是"过了"' : ''}`)
  if (exitCode !== 0) console.log(out.join('').split('\n').slice(-8).join('\n'))
  if (exitCode !== 0) throw new Error('sidecar did not boot')

  const info = JSON.parse(readFileSync(infoPath, 'utf8'))
  const api = async (method, path, body) => {
    const res = await fetch(`${info.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) }
  }

  // 1. handshake — ask capabilities, not a version (plan §5.1); the version is a fence.
  const health = await api('GET', '/health')
  check('GET /health → 200 with protocolVersion 1', health.status === 200 && health.body.protocolVersion === 1,
    JSON.stringify({ status: health.status, protocolVersion: health.body.protocolVersion, version: health.body.version }))
  check('capabilities advertised (schedulePatch / requestLookup)',
    typeof health.body.capabilities?.schedulePatch === 'boolean' && typeof health.body.capabilities?.requestLookup === 'boolean',
    JSON.stringify(health.body.capabilities))
  check('readiness reached "ready"', health.body.readiness === 'ready', String(health.body.readiness))
  check('this boot really is keyless', health.body.configured === false, `configured=${String(health.body.configured)}`)

  // 协议档还有第二个家：内核在**响应头**上盖 `x-tianshu-protocol`。实测它只在 `/sessions` 这类路由出现
  // （`/health` 与 `/tasks` 都不带），所以这一发必须打在 `/sessions` 上；此前这条栅栏只有手动跑
  // `check-health` 时才看得到，接进聚合冒烟之后 `node scripts/ci-smoke.mjs` 一条命令就覆盖它。
  const listRes = await api('GET', '/sessions')
  const headerProto = Number(listRes.headers?.get('x-tianshu-protocol') ?? 0)
  check('x-tianshu-protocol header on GET /sessions == 1', listRes.status === 200 && headerProto === 1,
    `status=${listRes.status} header=${String(listRes.headers?.get('x-tianshu-protocol'))}（读错响应就会这里是 null，不是 0）`)

  // 2. create a session against the isolated store.
  const created = await api('POST', '/sessions', { title: 'ci-smoke', approvalMode: 'manual' })
  const sessionId = created.body?.id
  check('POST /sessions → 201 with an id', (created.status === 201 || created.status === 200) && typeof sessionId === 'string',
    `${created.status} ${String(sessionId).slice(0, 20)}`)
  const listed = await api('GET', '/sessions')
  check('the session is listed back from the isolated dir', Array.isArray(listed.body.sessions)
    && listed.body.sessions.some((s) => s.id === sessionId), `${listed.body.sessions?.length ?? 0} sessions`)
  note(`data dir ${info.desktopDir}`)

  // 2b. the background-run surface the schedule board reads (plan M2 asks for `/schedule`
  //     **and** `/tasks`). Pure read, no run required: a fresh registry must answer the
  //     documented page shape, and the panel degrades honestly if it does not.
  const jobs = await api('GET', '/tasks?limit=5')
  check('GET /tasks answers the documented page shape',
    jobs.status === 200 && Array.isArray(jobs.body.tasks) && typeof jobs.body.count === 'number',
    `${jobs.status} body=${JSON.stringify(jobs.body).slice(0, 80)}`)

  // 3. the send path. Only safe because `configured === false` above: with a real key
  //    this step is skipped so the smoke can never spend money.
  if (health.body.configured === false) {
    const sent = await api('POST', `/sessions/${sessionId}/prompt`, { prompt: 'ci-smoke: say ok' })
    // Either shape is a pass, and both are "failed closed": a 4xx refusal, or an accepted
    // request that the runtime then reports as un-sendable. A 5xx is a crash, not a
    // refusal, and an actual upstream call is impossible here because configured === false.
    const clean4xx = sent.status >= 400 && sent.status < 500
    const accepted = sent.status < 300
    check('POST /prompt does not 5xx without a key', sent.status < 500, `${sent.status} ${JSON.stringify(sent.body).slice(0, 110)}`)
    // Give the run loop time to say something: sampling once right after a 200 would
    // report "silent" for a refusal that simply arrives a beat later.
    let events = []
    let lastStatus = null
    let pollFailure = null
    for (let i = 0; i < 16; i++) {
      try {
        const after = await api('GET', `/sessions/${sessionId}/events?since=0`)
        events = after.body.events ?? []
        const s = await api('GET', `/sessions/${sessionId}`)
        lastStatus = s.body?.status ?? null
      } catch (e) {
        // Remember it and stop sampling: a dead sidecar must not be reported as merely
        // "silent", which is a much milder finding than the one it actually is.
        pollFailure = e.message
        note(`poll stopped: ${e.message}`)
        break
      }
      if (events.some((e) => e.type === 'error' || e.type === 'done')) break
      await sleep(500)
    }
    const errored = events.filter((e) => e.type === 'error').map((e) => JSON.stringify(e.data).slice(0, 120))
    if (clean4xx) {
      check('and the refusal is a documented 4xx with an error body', typeof sent.body.error === 'string', JSON.stringify(sent.body).slice(0, 90))
    } else if (accepted) {
      // Upstream behaviour, recorded rather than asserted. Two shapes have been observed here:
      //  - 2026-10-09: 200 {status:'running'} and then **nothing at all** in the log, session stuck
      //    at running (kernel's own watchdog logged `[loop-stall] activities=none`).
      //  - 2026-10-11 (this build, rivet 3.28.0): 200 {status:'running'} followed by
      //    `user,status,goal_state,error` and the record ending at `failed` — it reports itself.
      // Neither is a client-checkable requirement, so a self-report is only a check when it
      // happens; the silence path still prints a finding. What the client IS responsible for (the
      // send-stall notice) is covered by the UI, and by `app.sendStalled` below.
      const reports = errored.length > 0 || events.some((e) => e.type === 'done')
      const line = `status=${lastStatus} events=${events.map((e) => e.type).join(',') || '(none)'}`
      if (reports) check('an accepted keyless prompt reports itself', true, line)
      else note(`upstream finding — silent run without a key (kernel logs loop-stall): ${line}`)
    }
    // A poll that threw is only harmless if the sidecar answers *now*: probe it fresh
    // rather than trusting a status captured before the failure, or a crashed daemon
    // would pass as "ran silently".
    let alive = true
    if (pollFailure !== null) {
      try { alive = (await api('GET', '/health')).status === 200 } catch { alive = false }
      check(`the sidecar recovered after the mid-poll "${pollFailure}"`, alive)
    }
    check('the session survives and its event log is readable', lastStatus !== null && alive, `status=${lastStatus}, ${events.length} events`)
  } else {
    check('send step ran', false, 'skipped: a provider key was visible to this sidecar')
  }

  // 抢锁失败那条路径上，启动器会打印「已收掉本机刚起的 pid X，不留残留」——这句**宣称**此前没有任何
  // 门读过，而它恰是聚合偶发红（#120/#123）的攒法：每次失败留一台，谁都没看见。
  // 这里拿真形状验一遍，三条各管一头：① 非 0 退场；② 报的确实是指向 holder pid 的 `data-dir-locked`
  // （不认这句就可能是别的原因死的，那条红不能算这条判据的证据）；③ 它自己 spawn 的那台不许活着。
  // 判据用只读探针的前后计数（不杀任何进程——归属由人判断，见 lib-instance 的规矩）。
  const stateDirB = join(tmp, 'state-b')
  mkdirSync(stateDirB, { recursive: true })
  const beforeB = listProjectRuntimes()
  const probeBroken = beforeB.some((l) => l.startsWith(PROBE_FAILED))
  const beforeSet = new Set(beforeB)
  const b = run([
    join(clientRoot, 'scripts/launch-sidecar.mjs'),
    '--state-dir', stateDirB, '--desktop-dir', dataDir, '--config', join(dataDir, 'config.json'), '--isolate-home',
  ])
  const bOut = []
  b.stdout.on('data', (x) => bOut.push(x.toString()))
  b.stderr.on('data', (x) => bOut.push(x.toString()))
  const bCode = await new Promise((res) => {
    b.once('exit', (c) => res(c ?? -1))
    setTimeout(() => res(-2), 45_000)
  })
  const settle = await waitForQuietRuntimes(8_000, 400, (l) => !beforeSet.has(l))
  const bText = bOut.join('')
  const hitLock = /data-dir-locked/.test(bText) && /holder pid \d+/.test(bText)
  check('撞锁那台自收：非 0 退场 + 报的确实是 data-dir-locked 且点名 holder pid + 尝试之后没有多出一台活着的',
    !probeBroken && !settle.probeFailed && bCode !== 0 && bCode !== -2 && hitLock && settle.quiet,
    probeBroken || settle.probeFailed
      ? `只读探针没跑成，这条属于**没测到**（不是通过）：${[...beforeB, ...settle.lines].find((l) => l.startsWith(PROBE_FAILED)) ?? ''}`
      : `exit ${bCode} · 抢锁形状 ${hitLock ? '对上了' : '对不上——最后一行：' + (bText.trim().split(/\r?\n/).at(-1) ?? '(无输出)').slice(0, 150)} · 基线 ${beforeSet.size} 台，尝试后仍活着的新进程 ${settle.mine.length} 台（等了 ${settle.waitedMs}ms）`)
} catch (e) {
  check('smoke completed', false, e.message)
  code = 1
} finally {
  // The sidecar's own log is the only witness when it dies mid-run, so dump it before
  // any teardown can remove it.
  try {
    const log = readFileSync(join(stateDir, '.sidecar.log'), 'utf8').trim().split('\n')
    if (failures.length > 0) console.log('--- sidecar log ---\n' + log.slice(-14).join('\n'))
  } catch { /* no log to show */ }
  await new Promise((res) => {
    const stop = run([join(clientRoot, 'scripts/launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'])
    stop.once('exit', res)
    setTimeout(res, 8_000)
  })
  rmSync(tmp, { recursive: true, force: true })
  check('temp state and data dirs removed', !existsSync(tmp))
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  code = 1
} else {
  console.log('\nci-smoke: all checks passed')
}
process.exit(code)
