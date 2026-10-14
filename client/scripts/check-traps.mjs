#!/usr/bin/env node
/**
 * check-traps.mjs — plan §5.2's six known traps, as a gate instead of a memory.
 *
 * Each trap used to be "we handled this", which is true today and silent tomorrow. This turns
 * the machine-checkable half into assertions and, just as importantly, labels the half that is
 * NOT machine-checkable instead of hiding it behind a green tick.
 *
 *   node scripts/check-traps.mjs            # per-trap verdicts
 *   node scripts/check-traps.mjs --quiet    # failures only (CI)
 *
 * Kinds: `static`  — checked from the tree here;
 *        `delegated` — another gate owns it (named, so it cannot quietly stop running);
 *        `manual`   — needs a live process or a human; what proves it is named too.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')
const read = (p) => readFileSync(join(clientRoot, p), 'utf8')
const has = (p) => existsSync(join(clientRoot, p))

const results = []
const record = (trap, kind, label, ok, note = '') => results.push({ trap, kind, label, ok, note })

// ---------------------------------------------------------------- T1 StoreLock 单写者
{
  const launcher = read('scripts/launch-sidecar.mjs')
  const isolated = /function defaultDesktopDir\(\)\s*\{[\s\S]*?join\(clientRoot, '\.sidecar-data'\)/.test(launcher)
  record('§5.2-1', 'static', '默认会话库落在 client/.sidecar-data（不与官方端抢 StoreLock）', isolated)
  const envSet = /RIVET_DESKTOP_DIR:\s*desktopDir/.test(launcher)
  record('§5.2-1', 'static', '启动器把 RIVET_DESKTOP_DIR 显式传给 sidecar 子进程', envSet)
  const ign = read('.gitignore')
  record('§5.2-1', 'static', '隔离目录与 info 文件都在 .gitignore 内（token 与会话不会入库）',
    /\.sidecar-data\//.test(ign) && /\.sidecar-info\.json/.test(ign))
  const desktop = read('apps/desktop/src/main.mjs')
  record('§5.2-1', 'static', '桌面壳自带 --state-dir 与 --desktop-dir（与浏览器那套并存不互抢）',
    /--state-dir/.test(desktop) && /--desktop-dir/.test(desktop))
  // 这条以前只是「代码里写了 requestSingleInstanceLock」，现在有一条真起两份进程的验法。
  // 它不在 CI 里自动跑（要 Electron、约 40 秒、会开两个窗），所以是**委托**而不是人工留档：
  // 判定名字钉在被委托那台的源码里——那两条被改名或删掉，这条立刻红（以前这里手抄过一项
  // "8 项判定"的数，那台验法加过两条预飞之后就变成假陈述，所以现在一个字都不抄）。
  const instFile = 'scripts/verify-single-instance.mjs'
  const inst = has(instFile) ? read(instFile) : ''
  const PINNED_5_2_1 = ['instance B exited on its own', 'instance B quit with a clean code, not a crash']
  const missing521 = PINNED_5_2_1.filter((n) => !inst.includes(n))
  record('§5.2-1', 'delegated', '第二份桌面实例在 boot 之前就退出（不抢 StoreLock、不改登记）',
    has(instFile) && missing521.length === 0,
    has(instFile)
      ? `${instFile}：点名钉住「${PINNED_5_2_1.join('」与「')}」两条判定${missing521.length ? `——读不到：${missing521.join('、')}（被改名或删了，这条宣称已经没有出处）` : '；项数与最近一次通过看那台验法自己打印的行'}`
      : `${instFile} 不在了——「第二份实例会退出」重新变成没有证据的说法`)
}

// ---------------------------------------------------------------- T2 CORS
{
  const vite = read('apps/web/vite.config.ts')
  // 允许在默认值前面挂一个覆盖变量（验证脚本要靠它避开操作者正占着的 5300），但**解析出的默认值
  // 必须仍是同源伺服层**——把 target 直接写成 sidecar 端口就是 §5.2-2 那次的漏水方式。
  const proxied = /'\/api':\s*\{[\s\S]*?target:\s*(?:process\.env\.[A-Z][A-Z0-9_]*\s*\?\?\s*)?'http:\/\/127\.0\.0\.1:5300'/.test(vite)
  record('§5.2-2', 'static', 'dev 的 /api 代理默认指向同源伺服层（5300），不是 sidecar 端口（前置覆盖变量只允许改端口、不许换默认目标）', proxied)
  // 另一半：dev 配置绝不去读 sidecar 的登记文件或 token —— 一旦读了，那条"token 不进浏览器"的
  // 结构性保证就变成一句口头承诺。
  const noSecret = !/sidecar-info|RIVET_SERVER_TOKEN/.test(vite)
  record('§5.2-2', 'static', 'vite 配置里不出现 sidecar 登记文件或 token 概念（代理只认同源层，够不到密钥）', noSecret)
  const launcher = read('scripts/launch-sidecar.mjs')
  const conditional = /if\s*\(origins\.length > 0\)\s*env\.RIVET_DEV_CORS_ORIGINS/.test(launcher)
  record('§5.2-2', 'static', 'RIVET_DEV_CORS_ORIGINS 只在显式要求时设置，默认链路不依赖它', conditional)
}

// ---------------------------------------------------------------- T3 token 不落前端
{
  const web = readdirSync(join(clientRoot, 'apps/web/src')).filter((f) => /\.tsx?$/.test(f)).map((f) => read(`apps/web/src/${f}`)).join('\n')
  const noTok = !/RIVET_SERVER_TOKEN|sidecar-info/.test(web)
  record('§5.2-3', 'static', 'apps/web 源码里不出现 token 概念（不读 info 文件、不嵌密钥）', noTok)
  record('§5.2-3', 'static', 'SidecarClient 在浏览器侧以空 token 构造（Authorization 由代理注入）',
    /token:\s*''/.test(web))
  const built = has('apps/web/dist') && has('.sidecar-info.json')
  if (built) {
    const tok = JSON.parse(read('.sidecar-info.json')).token
    const files = readdirSync(join(clientRoot, 'apps/web/dist/assets')).map((f) => `apps/web/dist/assets/${f}`)
    const hit = files.filter((f) => /\.js$|\.css$|\.html$/.test(f) && read(f).includes(tok))
    record('§5.2-3', 'static', '构建产物里没有当前启动 token', hit.length === 0, hit.join(' '))
  } else {
    // 这条以前写的是 `record(…, 'manual', …, true, '本机已验')`——`true` 是写死的，永远不会红，
    // 而"本机已验"是一句没有凭据的自述。改成真委托：点名由哪条判定负责，并**钉住那条判定还在**
    // （验法被删、被改名、或那行 check 被拿掉，这里立刻红）。跑不跑它是另一回事，这里不替它作保。
    const vd = has('scripts/verify-desktop.mjs') ? read('scripts/verify-desktop.mjs') : ''
    record('§5.2-3', 'delegated', '产物 token 扫描由桌面验法那条全产物扫描 + 金丝雀正控负责（这里没 dist 或没在跑的 sidecar，跳过）',
      /the boot token is in neither the HTML nor ANY shipped asset/.test(vd) && /is not vacuous \(positive control/.test(vd),
      `built=${has('apps/web/dist')} info=${has('.sidecar-info.json')} — 判据名钉在 scripts/verify-desktop.mjs：'the boot token is in neither the HTML nor ANY shipped asset (entry + lazy chunks)' + 那条 canary 正控`)
  }
}

// ---------------------------------------------------------------- T4 协议无正式文档
{
  const mirror = has('packages/client-core/src/protocol-types.ts') && /GENERATED — DO NOT EDIT/.test(read('packages/client-core/src/protocol-types.ts'))
  record('§5.2-4', 'delegated', '类型镜像存在且带「GENERATED」溯源头', mirror, '漂移判定见 gen-protocol-types --check')
}

// ---------------------------------------------------------------- T5 审批静默挂死
{
  const wait = read('packages/ui-approval/src/wait.ts')
  const panel = read('packages/ui-approval/src/index.tsx')
  record('§5.2-5', 'static', '两档提醒（>8s 提示 / >=stallAfterMs 报警）由可测的纯函数给出',
    /APPROVAL_HINT_AFTER_MS = 8_000/.test(wait) && /describeWait\(waited, stallAfterMs\)/.test(panel))
  const t = read('packages/ui-approval/test/wait.test.ts')
  record('§5.2-5', 'static', '30s 报警分支有边界测试（含 29 999 与 30 000）',
    /29_999/.test(t) && /30_000/.test(t))
  // 计划的方子是**两半**：超时提醒（上面两条）+ `/interventions` 快照兜底轮询。后半一直只在代码里，
  // 门读不到——把 `APPROVAL_POLL_MS` 改成 10 分钟、或去掉 `running` 守卫让归档会话也被周期性打靶，
  // 五道判定全绿。这里钉四个条件，缺一个就红。
  const app = read('apps/web/src/App.tsx')
  const pollRaw = /const APPROVAL_POLL_MS = ([\d_]+)/.exec(app)?.[1]
  // 数字里的下划线要一起去掉：`20_000` 用 (\d+) 只取到 "20"，那会让这条门拿着 20 毫秒去判"比报警快"。
  const pollMs = pollRaw === undefined ? NaN : Number(pollRaw.replaceAll('_', ''))
  const pollBlock = /const gateTimer = setInterval\(\(\) => \{[\s\S]{0,400}?\}, APPROVAL_POLL_MS\)/.exec(app)?.[0] ?? ''
  record('§5.2-5', 'static', '兜底轮询四条件：间隔存在且不慢于报警、只在 running 时问、拿到快照就 applySnapshot、卸载时 clearInterval',
    Number.isFinite(pollMs) && pollMs > 0 && pollMs <= 30_000
    && /if \(!m\.current\.running\) return/.test(pollBlock)
    && /api\.interventions\(openSessionId\)\.then\(\(snap\) => m\.applySnapshot\(snap\)/.test(pollBlock)
    && /clearInterval\(gateTimer\)/.test(app),
    `APPROVAL_POLL_MS=${Number.isFinite(pollMs) ? pollMs : '缺失（正则没取到数）'}，报警档 30 000 —— 轮询比报警还慢就等于没有兜底`)
  // 这一条以前写成 `record(…, 'manual', …, true, …)`——`true` 是写死的，永远不会红，还把一句
  // 否定式描述（"从未被渲染过"）打成一条 ✓。现在报警样式真的被画出来了：`/stall-probe.html` 用
  // 产品组件 + 只改 `stallAfterMs` 一个 prop 并排画出"响/不响"两栏，像素门有 4 条判定盯着它。
  // 这里点名钉那 4 条判定的名字：被改名或删掉 → 这条红（= 证据面塌了），而不是继续假装看过。
  const liveFile = 'scripts/check-live-geometry.mjs'
  const liveSrc = has(liveFile) ? read(liveFile) : ''
  const PINNED_5_2_5 = ['审批报警 真的被渲染过（缩短阈值那一侧）', '审批报警 对照组（阈值够不到）保持安静', '审批报警 文字来自 locale 且带秒数', '审批报警 不止换 class（卡片计算样式真的不同）']
  const missing525 = PINNED_5_2_5.filter((n) => !liveSrc.includes(n))
  record('§5.2-5', 'delegated', '审批报警样式被真的渲染过（不是"等一次真 run 才看得见"）',
    has('apps/web/src/stall-probe.tsx') && has(liveFile) && missing525.length === 0,
    missing525.length > 0
      ? `像素门里读不到这些判定名：${missing525.join('、')}——报警的渲染证据已经没了，这条不许绿`
      : has('apps/web/src/stall-probe.tsx')
        ? `${liveFile}：点名钉住 4 条判定（一栏缩短阈值真响、一栏对照组不响）；它测的是渲染与样式，**不**包括"真闸曾挂了 30 秒"那一半——那仍要一次真 run`
        : 'apps/web/src/stall-probe.tsx 不在了——探针页没了，4 条判定只能读到空页')
}

// ---------------------------------------------------------------- T6 绝不旁路
{
  record('§5.2-6', 'delegated', '无 SQLite / UI 层不碰磁盘 / 不构造用户目录路径 / 内核零改动',
    has('scripts/check-nongoals.mjs'), '由 check-nongoals.mjs 逐条判定')
}

// ---------------------------------------------------------------- §5.2 这张表对正文
// 上面那六个编号是**手抄**自计划 §5.2 的：加一条坑、换一条的说法，这张表一声不响。
// 于是钉两件双向相等的事：条数（正文有第 7 条而这里没有 → 红；这里多出一个正文没有的编号 → 红），
// 以及每条"谈的是哪一条坑"的关键子串必须出现在正文那条的标题里（改了说法就要连表一起改）。
{
  const planDoc = resolve(clientRoot, '..', 'analysis-reports', '定稿-天枢客户端方案', '天枢Web桌面客户端自研计划-v2.0.md')
  const TRAP_TITLES = {
    '§5.2-1': 'StoreLock', '§5.2-2': 'CORS', '§5.2-3': 'token',
    '§5.2-4': 'API', '§5.2-5': '审批挂死', '§5.2-6': '旁路',
  }
  if (!existsSync(planDoc)) {
    record('§5.2-表', 'static', '计划正文在盘上（§5.2 表面对账的前提）', false, `找不到 ${planDoc}——这条没在量任何东西`)
  } else {
    const whole = readFileSync(planDoc, 'utf8')
    const at = whole.indexOf('### 5.2 已识别的坑')
    const end = at === -1 ? -1 : whole.indexOf('\n---', at)
    const sec = at === -1 ? '' : whole.slice(at, end === -1 ? undefined : end)
    const items = [...sec.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)]
    const nums = items.map((m) => `§5.2-${m[1]}`)
    const ids = [...new Set(results.map((r) => r.trap))]
    const noJudge = nums.filter((n) => !ids.includes(n))
    const noPlan = ids.filter((n) => !nums.includes(n))
    const titleBad = []
    for (const m of items) {
      const want = TRAP_TITLES[`§5.2-${m[1]}`]
      if (want === undefined) { titleBad.push(`正文第 ${m[1]} 条「${m[2]}」在这里没登记关键词`); continue }
      if (!m[2].includes(want)) titleBad.push(`正文第 ${m[1]} 条标题是「${m[2]}」，登记表要的「${want}」不在里面`)
    }
    const stale = Object.keys(TRAP_TITLES).filter((k) => !nums.includes(k))
    const bad = [
      at === -1 ? '正文里认不到「### 5.2 已识别的坑」这一节' : '',
      items.length < 6 ? `正文只认到 ${items.length} 条坑（少于 6 说明解析面坏了，这条绿不算数）` : '',
      noJudge.length > 0 ? `正文这几条坑在这里没有判定：${noJudge.join(' , ')}` : '',
      noPlan.length > 0 ? `这里在判正文没有的编号：${noPlan.join(' , ')}` : '',
      titleBad.length > 0 ? titleBad.join(' ｜ ') : '',
      stale.length > 0 ? `登记表里这几条编号正文已无对应（改了正文就删行）：${stale.join(' , ')}` : '',
    ].filter(Boolean)
    record('§5.2-表', 'static',
      `§5.2 这张表与正文双向相等（正文 ${items.length} 条 / 这里 ${ids.length} 个编号 / 登记表 ${Object.keys(TRAP_TITLES).length} 条关键词）`,
      bad.length === 0, bad.join(' ｜ ') || `六条编号逐条对上正文标题，双向都没有多出来的`)
  }
}

// ---------------------------------------------------------------- report
const fails = results.filter((r) => !r.ok)
if (!quiet) {
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.trap}][${r.kind}] ${r.label}${r.note ? ` — ${r.note}` : ''}`)
  }
  const manual = results.filter((r) => r.kind === 'manual')
  console.log(`\n静态/委托 ${results.filter((r) => r.kind !== 'manual').length} 条，人工留档 ${manual.length} 条（人工不等于没做，是明确说清谁在盯）`)
}
if (fails.length > 0) {
  console.error(`\nFAILED (§5.2 的坑重新漏水):`)
  for (const f of fails) console.error(`  ✗ [${f.trap}][${f.kind}] ${f.label}${f.note ? ` — ${f.note}` : ''}`)
  process.exit(1)
}
