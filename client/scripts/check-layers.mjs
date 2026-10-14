#!/usr/bin/env node
/**
 * check-layers.mjs — 计划 §4.1 / §4.2 / §4.3 的分层纪律，作为门禁而不是约定。
 *
 * 「业务包禁止互相 import，共享只走 import type 与 client-core 服务」「client-core 是唯一
 * 耦合天枢协议处」「业务数据不进全局 store」——这三句是整个架构的承重墙，但 tsc 不会拦：
 * 只要 workspace 依赖还在 package.json 里，`ui-chat` 现在就能 import `ui-git`，代码照样跑，
 * 而分层图从那一刻起变成装饰。所以这里逐条扫真实 import 说明符。
 *
 *   node scripts/check-layers.mjs            # 逐条
 *   node scripts/check-layers.mjs --quiet    # 只报失败（CI）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgRoot = join(clientRoot, 'packages')
const quiet = process.argv.includes('--quiet')

const PANELS = ['ui-approval', 'ui-chat', 'ui-files', 'ui-git', 'ui-schedule', 'ui-session', 'ui-settings']
const BASES = ['ui-primitives', 'ui-theme', 'locale', 'client-core', 'store']

/** Every .ts/.tsx under a package's src, with its import specifiers. */
function importsOf(pkg) {
  const dir = join(pkgRoot, pkg, 'src')
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) { walk(join(d, e.name), rel); continue }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      const src = readFileSync(join(d, e.name), 'utf8')
      for (const m of src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) out.push({ file: `${pkg}/src/${rel}`, spec: m[1] })
    }
  }
  walk(dir, '')
  return out
}

const all = {}
for (const p of readdirSync(pkgRoot)) if (existsSync(join(pkgRoot, p, 'src'))) all[p] = importsOf(p)
const webImports = []
{
  const dir = join(clientRoot, 'apps/web/src')
  for (const f of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(f)) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) webImports.push({ file: `apps/web/src/${f}`, spec: m[1] })
  }
}

const tianshu = (spec) => /^@tianshu\/([\w-]+)$/.exec(spec)?.[1] ?? null
const results = []
const record = (group, label, ok, note = '') => results.push({ group, kind: 'static', label, ok, note })

// ---------------------------------------------------------------- client-core 的 REST 面不得静默变死
{
  // 这一类缺陷本会话已经抓到三次：`api.listTasks()`、`api.events()` 都是「内核有路由、客户端包好了、
  // 没人调」，而 §4.3 #2 的 REST 兜底正是被这种"包了但没接"拖掉的（包了方法不等于接了能力）。
  // 所以把一次性的人肉扫描变成常驻判定：SidecarClient 每个公开方法都要在**产品面**有调用点；
  // 确实不接的必须在这里写下理由，并且**双向对账**——冒出一个没记的红（新写死的方法），
  // 名单里那个被接上了也红（理由过期，必须当场改台账而不是留个空位）。
  const core = readFileSync(join(pkgRoot, 'client-core/src/sidecar-client.ts'), 'utf8')
  const methods = [...new Set([...core.matchAll(/^ {2}(?:async )?([a-z][A-Za-z]*)\(/gm)].map((m) => m[1]))]
    .filter((n) => n !== 'constructor')
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts|mjs)$/.test(e.name)) files.push(p)
    }
  }
  for (const p of Object.keys(all)) if (p !== 'client-core') walk(join(pkgRoot, p, 'src'))
  walk(join(clientRoot, 'apps/web/src'))
  walk(join(clientRoot, 'apps/desktop/src'))
  // 消费面**包含**验收脚本与 client-core 内部：`api.health()` 这类由 `verify-*.mjs` /
  // `serve-client.mjs` 用的方法不是死的（那条路由真在被使用），把面收窄会让门报一堆假死——
  // 第一版就是栽在这里（health / artifacts / workbenchCompare 全被念成死的）。
  // 这一条要抓的是"整棵树里谁都没用过"，那才是 §4.3 #2 那种包了没接的形状。
  walk(join(clientRoot, 'packages/client-core/src'))
  walk(join(clientRoot, 'scripts'))
  const corpus = files.map((p) => readFileSync(p, 'utf8')).join('\n')
  const dead = methods.filter((n) => !corpus.includes(`.${n}(`))
  const EXPECTED_DEAD = {
    protocolVersion: '计划 §5.1 明写「只问 capabilities，版本只当栅栏」——刻意不拿来分支',
  }
  const unexpected = dead.filter((n) => !EXPECTED_DEAD[n])
  const stale = Object.keys(EXPECTED_DEAD).filter((n) => !dead.includes(n))
  // 正控（金丝雀）：产品面必须真的在大量调这些方法，否则"零命中名单全对"可能只是因为扫描语料是空的
  // （目录改名、walk 坏掉都会这样绿着）。取几个已知在用的方法逐个点名。
  const canary = ['listSessions', 'prompt', 'health', 'cockpit', 'events'].filter((n) => corpus.includes(`.${n}(`))
  record('client-core REST 面', `${methods.length} 个公开方法在全消费面（产品 + 验收脚本 + client-core 内部，${files.length} 个源文件）的调用点对得上理由表（无人使用 ${dead.length}/${Object.keys(EXPECTED_DEAD).length}）`,
    unexpected.length === 0 && stale.length === 0 && methods.length >= 40 && canary.length === 5,
    unexpected.length > 0 ? `新出现零调用点：${unexpected.join('、')}——要么接上，要么写下为什么不做（写在这里就得同时改台账的待决清单）`
      : stale.length > 0 ? `理由表里这几个已经有调用点了：${stale.join('、')}——名单过期，删掉那行并更新台账`
        : canary.length < 5 ? `金丝雀只有 ${canary.length}/5 命中，说明扫描面或方法名变了，这条绿没有意义`
          : Object.entries(EXPECTED_DEAD).map(([k, v]) => `${k}=${v}`).join(' ｜ '))
}

// ---------------------------------------------------------------- §4.2 业务包之间零横向依赖
{
  const bad = []
  for (const p of PANELS) {
    for (const { file, spec } of all[p] ?? []) {
      const target = tianshu(spec)
      if (target && target !== p && PANELS.includes(target)) bad.push(`${file} → ${target}`)
    }
  }
  record('§4.2 横向', `面板之间没有互相 import（${PANELS.length} 个业务面板两两组合都查了）`, bad.length === 0, bad.join(' ; '))
  // 面板允许依赖什么，写死成名单：新增一条依赖就等于改架构，必须在这里过一遍。
  const allowed = new Set([...BASES])
  const rogue = []
  for (const p of PANELS) {
    for (const { file, spec } of all[p] ?? []) {
      const target = tianshu(spec)
      if (target && target !== p && !allowed.has(target)) rogue.push(`${file} → ${target}`)
    }
  }
  record('§4.2 横向', `面板只依赖 client-core / store / locale / ui-primitives / ui-theme（其余 @tianshu/* 一律算越层）`, rogue.length === 0, rogue.join(' ; '))
}

// ---------------------------------------------------------------- §4.3 #4 store 的边界
{
  const bad = (all['store'] ?? []).filter(({ spec }) => tianshu(spec)).map(({ file, spec }) => `${file} → ${spec}`)
  record('§4.3 #4', 'store 不 import 任何 workspace 包（尤其 client-core：它的 README 写「协议面为 None」）', bad.length === 0, bad.join(' ; '))
  const viewState = /interface ViewState\s*\{([\s\S]*?)\n\}/.exec(readFileSync(join(pkgRoot, 'store/src/index.ts'), 'utf8'))?.[1] ?? ''
  const business = ['blocks', 'messages', 'timeline', 'approvals', 'toolResults', 'events'].filter((k) => new RegExp(`(^|\\n)\\s*${k}[?]?:`).test(viewState))
  record('§4.3 #4', 'ViewState 的字段里没有业务数据（消息流/审批/工具结果属于 SessionModel）', viewState.length > 0 && business.length === 0,
    viewState ? `字段 ${viewState.split('\n').filter((l) => /:/.test(l)).length} 行，越界字段：${business.join('/') || '无'}` : '没读到 ViewState')
}

// ---------------------------------------------------------------- §4.1 client-core 是唯一耦合处
{
  const core = all['client-core'] ?? []
  const reactish = core.filter(({ spec }) => /^(react|react-dom|zustand|immer|@tianshu\/ui-)/.test(spec)).map(({ file, spec }) => `${file} → ${spec}`)
  record('§4.1', 'client-core 是 React-free 层（不引 react / zustand / 任何 ui-*）', reactish.length === 0, reactish.join(' ; '))
  const kernelPath = [...Object.entries(all)].flatMap(([p, list]) => list.filter(({ spec }) => /\.\.\/.*\/src\/(server|agent|tools)\//.test(spec)).map(({ file }) => file))
    .concat(webImports.filter(({ spec }) => /\.\.\/.*\/src\/(server|agent|tools)\//.test(spec)).map(({ file }) => file))
  record('§4.1', '前端没有直接 import 内核源码树（唯一通路是生成的类型镜像）', kernelPath.length === 0, kernelPath.join(' ; '))
}

// ---------------------------------------------------------------- 底层包不许向上依赖
{
  const prim = (all['ui-primitives'] ?? []).filter(({ spec }) => tianshu(spec)).map(({ file, spec }) => `${file} → ${spec}`)
  record('分层方向', 'ui-primitives 在最底：不 import 任何 workspace 包', prim.length === 0, prim.join(' ; '))
  const loc = (all['locale'] ?? []).filter(({ spec }) => tianshu(spec)).map(({ file, spec }) => `${file} → ${spec}`)
  record('分层方向', 'locale 是叶子包：不 import 任何 workspace 包', loc.length === 0, loc.join(' ; '))
  const apps = Object.entries(all).flatMap(([, list]) => list.filter(({ spec }) => /apps\//.test(spec)).map(({ file }) => file))
  record('分层方向', 'packages/* 从不反向 import apps/*', apps.length === 0, apps.join(' ; '))
  const dom = Object.entries(all).flatMap(([p, list]) => list.filter(({ spec }) => /^react-dom/.test(spec)).map(({ file }) => `${file} → ${spec}`))
  record('分层方向', `只有 apps/web 挂 react-dom（${webImports.filter(({ spec }) => /^react-dom/.test(spec)).length} 处在宿主里）`, dom.length === 0, dom.join(' ; '))
}

// ---------------------------------------------------------------- §4.3 #4 面板不许碰视图 store
{
  const bad = []
  for (const p of PANELS) for (const { file, spec } of all[p] ?? []) if (tianshu(spec) === 'store') bad.push(`${file} → store`)
  record('§4.3 #4', '业务面板不读全局 store（视图状态属于宿主，面板只吃 props）', bad.length === 0, bad.join(' ; '))
}

// ---------------------------------------------------------------- §4.3 #1 旧订阅必须整体作废
{
  // 计划的 §4.3 #1 最后一句是「世代切换旧订阅整体作废」。建连序列与原子替换早就进门了，
  // 这半句此前没人钉：宿主里多开一条 `openSessionStream(...)` 而漏掉它的关闭函数，表现是
  // 界面重复渲染 / 切会话后旧流还在推事件——而且它不会红，只会让人怀疑模型层。
  // 判据不抄行号也不写死名字：从产品面扫开流调用点，抓 `const <name> = openSessionStream(`，
  // 要求同一个文件里存在一个 `return () => …<name>()…` 的清理（effect 卸载即关流）。
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  const siteRe = /const\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*openSessionStream\s*\(/g
  const offenders = []
  const unbound = []
  const wrongLayer = []
  let sites = 0
  const hostFiles = []
  const panelFiles = []
  const walk = (dir, bucket) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, bucket)
      else if (/\.(ts|tsx)$/.test(e.name)) bucket.push(p)
    }
  }
  for (const p of Object.keys(all)) {
    if (/^ui-/.test(p) || p === 'store' || p === 'locale') walk(join(pkgRoot, p, 'src'), panelFiles)
  }
  walk(join(clientRoot, 'apps/web/src'), hostFiles)
  const callRe = /openSessionStream\s*\(/g
  // 连接归宿主：面板自己开一条流会有两个游标、两份世代，模型层的去重救不了"两条流各推各的"。
  for (const p of panelFiles) {
    const rel = p.slice(clientRoot.length + 1).replace(/\\/g, '/')
    const c = [...strip(readFileSync(p, 'utf8')).matchAll(callRe)].length
    if (c > 0) wrongLayer.push(`${rel}：面板里开了 ${c} 条流（连接与世代归宿主 apps/*，面板只吃 props）`)
  }
  for (const p of hostFiles) {
    const src = strip(readFileSync(p, 'utf8'))
    const calls = [...src.matchAll(callRe)].length
    if (calls === 0) continue
    sites += calls
    const rel = p.slice(clientRoot.length + 1).replace(/\\/g, '/')
    if (calls !== 1) offenders.push(`${rel}：同一个文件开了 ${calls} 条流，判据要求一文件一条（多条请拆文件或在台账说明归属）`)
    const bound = [...src.matchAll(siteRe)]
    if (bound.length !== 1) { unbound.push(`${rel}：抓不到 ` + '`const <name> = openSessionStream(`' + ` 这种形状（${bound.length} 处）——关闭函数没被命名，作废就无人可查`); continue }
    const name = String(bound[0][1])
    const cleaned = new RegExp(`return\\s*\\(\\)\\s*=>[^]{0,260}?\\b${name}\\s*\\(\\s*\\)`).test(src)
    if (!cleaned) offenders.push(`${rel}：${name}() 没有出现在任何 effect 清理里 —— 旧订阅不会作废`)
  }
  const coreExports = readFileSync(join(pkgRoot, 'client-core/src/index.ts'), 'utf8').includes('openSessionStream')
  record('§4.3 #1 订阅作废',
    `开流只归宿主，且每条都把自己交给 effect 清理（宿主面 ${hostFiles.length} 个文件扫到 ${sites} 条，面板面 ${panelFiles.length} 个文件 0 条）`,
    sites >= 1 && coreExports && offenders.length === 0 && unbound.length === 0 && wrongLayer.length === 0,
    [...wrongLayer, ...offenders, ...unbound].join(' ; ')
      || (coreExports ? '正控：client-core 仍导出 openSessionStream，宿主那一处把它交给了 effect 清理' : 'client-core 不再导出 openSessionStream——这条判据已无对象，不许当通过'))
}

// ---------------------------------------------------------------- §7 「AG-UI 适配层可整体摘除」
{
  // 计划的对策原话是「只做内部事件模型对齐 + 适配端点输出，不做协议绑定；适配层可整体摘除」。
  // "可摘除"不是设计意图，是可以判定的：**产品面（每个 ui-* 包 + 两个宿主）里不能出现适配层的名字**。
  // 一旦某个面板 import 了它，删掉那层就会崩一个界面——那时这句话就变成谎话，所以这里必须红。
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts)$/.test(e.name)) files.push(p)
    }
  }
  for (const p of Object.keys(all)) if (p !== 'client-core') walk(join(pkgRoot, p, 'src'))
  walk(join(clientRoot, 'apps/web/src'))
  walk(join(clientRoot, 'apps/desktop/src'))
  // client-core 是适配层的**归属者**（它 re-export 给伺服层用），不算产品面；"可摘除"这句
  // 说的是每个 ui-* 包与两个宿主都不依赖它，所以扫的就是这些面。
  const label = (p) => p.slice(clientRoot.length + 1).replace(/\\/g, '/')
  // 不用 `\bAgui`：`translateToAgui` 里 o 与 A 之间没有词边界，那样写会**漏掉最典型的那种引用**
  // （第一版就是这么漏过一次，靠反向变异才发现）。
  const hit = files.filter((p) => /Agui|AGUI|ag-ui|agui/i.test(readFileSync(p, 'utf8'))).map(label)
  const ownersStill = ['packages/client-core/src/ag-ui.ts', 'scripts/serve-client.mjs', 'scripts/accept-agui.ts']
    .filter((p) => existsSync(join(clientRoot, p)))
  record('§7 AG-UI', `产品面零引用 AG-UI 适配层（扫了 ${files.length} 个源文件）——那句「可整体摘除」才是真的`,
    hit.length === 0 && ownersStill.length === 3,
    hit.length > 0 ? hit.join(' ; ')
      : ownersStill.length < 3 ? `归属者只剩 ${ownersStill.length}/3，扫描变绿只是因为整层被删了（那不是"可摘除"的证明，是没得扫）`
        : '正控：适配器本体 + 伺服层 /ag-ui 路由 + 自校验脚本三处都还在，所以这 0 命中是"产品面真的不依赖它"')
}

// ---------------------------------------------------------------- §4.1 传输面只在 client-core
{
  // 计划的 §4.1 写「ui-* 只面对五类事件，不见 sidecar 原始协议」，§4.2 写 client-core 是
  // **「唯一耦合天枢协议处」**。这条把那句话变成判据：产品面（每个 ui-* 包 + store + locale +
  // apps/web 渲染层）**不许出现传输 API**。面板可以拿 `api` prop 调 client-core 的方法名，
  // 但一旦有人在这里手写 `fetch(`，"唯一耦合处"就变成两处了——那是 §4.1 整张图塌一角的开始。
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts)$/.test(e.name)) files.push(p)
    }
  }
  for (const p of Object.keys(all)) if (/^ui-/.test(p) || p === 'store' || p === 'locale') walk(join(pkgRoot, p, 'src'))
  walk(join(clientRoot, 'apps/web/src'))
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  const TRANSPORT = /\bfetch\s*\(|XMLHttpRequest|EventSource|\baxios\b/
  const hit = files.filter((p) => TRANSPORT.test(strip(readFileSync(p, 'utf8'))))
    .map((p) => p.slice(clientRoot.length + 1).replace(/\\/g, '/'))
  // 正控：归属者必须真在用这些 API，否则"0 命中"可能只是正则坏了。
  const core = readFileSync(join(pkgRoot, 'client-core/src/sidecar-client.ts'), 'utf8')
  const coreHits = [...core.matchAll(new RegExp(TRANSPORT.source, 'g'))].length
  record('§4.1 传输面', `产品面零传输 API（${files.length} 个源文件里 fetch / XHR / EventSource / axios 全 0）——协议耦合只剩 client-core 一处`,
    hit.length === 0 && coreHits > 0,
    hit.length > 0 ? hit.join(' ; ') : `正控：sidecar-client.ts 里 ${coreHits} 处（判定读的是剥掉注释后的代码，端点名写在 doc 或用户可见文案里不算）`)

  // 同一条纪律的**词汇面**：`snapshots` 这个包按协议事件类型名索引，所以"只面对五类"要看面板
  // 有没有自己拼这些名字。名字清单从 client-core 的 snapshot-keys.ts 现读（加一个键就自动纳入，
  // 不在这边再抄一遍），判两条形态：`snapshots.<name>` 点访问，以及把键写成 `'context_budget'` 这种字面量。
  const keysFile = join(pkgRoot, 'client-core/src/snapshot-keys.ts')
  const wireNames = existsSync(keysFile)
    ? [...readFileSync(keysFile, 'utf8').matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1])
    : []
  // 字面量那一半只查带下划线的 wire 名。`status`/`phase`/`done`/`landing` 同时也是 payload 的
  // **字段**名（`snapshots[SNAP.status].status`），把它们当键名去扫引号会把无关字符串咬进来——
  // 第一版就是这样把 context-panel.tsx 误判成"在写协议事件名"。`snapshots.<name>` 那种点访问没有
  // 这个歧义：形状本身就是证据，所以那一半保持宽口径。
  const literalNames = wireNames.filter((n) => n.includes('_'))
  // 清单被掏空时这条判据已经没意义，宁可让它一律判成违规（门红），不假装绿。
  const spellsAKey = literalNames.length >= 6
    ? (src) => new RegExp(`'(?:${literalNames.join('|')})'`).test(src)
    : () => true
  const spelled = wireNames.length === 0 ? files : files.filter((p) => {
    const src = strip(readFileSync(p, 'utf8'))
    return /snapshots\.[A-Za-z_]+/.test(src) || spellsAKey(src)
  }).map((p) => p.slice(clientRoot.length + 1).replace(/\\/g, '/'))
  record('§4.1 词汇面', `产品面不写协议事件名（${files.length} 个源文件里 0 处 snapshots.<name> 与 0 个快照键字面量）`,
    literalNames.length >= 6 && spelled.length === 0,
    spelled.length > 0 ? spelled.join(' ; ')
      : `正控：snapshot-keys.ts 里现读出 ${wireNames.length} 个键，其中 ${literalNames.length} 个带下划线的进字面量扫描（少于 6 个说明清单被掏空，那条"0 命中"就没意义了）`)

  // 同一条纪律的**类型面**：五类映射那张表（`EVENT_CATEGORY`）的键类型就是 sidecar 的原始事件联合。
  // 名字不在这边抄——从 client-core 的 `event-category.ts` 里现读 `Record<X, EventCategory>` 的 X；
  // 谁把它 import 进面板，"UI 只面对五类"就在类型层破了：面板会开始 switch 原始事件名。
  const catSrc = readFileSync(join(pkgRoot, 'client-core/src/event-category.ts'), 'utf8')
  const rawTypes = [...new Set([...catSrc.matchAll(/Record<([A-Za-z][A-Za-z0-9]*)\s*,\s*EventCategory>/g)].map((m) => m[1]))]
  const typeHits = rawTypes.length === 0 ? files : files.filter((p) => {
    const src = strip(readFileSync(p, 'utf8'))
    return rawTypes.some((t) => new RegExp(`\\b${t}\\b`).test(src))
  }).map((p) => p.slice(clientRoot.length + 1).replace(/\\/g, '/'))
  const coreOwnHits = rawTypes.reduce((n, t) => n + [...catSrc.matchAll(new RegExp(`\\b${t}\\b`, 'g'))].length, 0)
  record('§4.1 类型面',
    `产品面不引用 sidecar 原始事件联合类型（${files.length} 个源文件里 ${rawTypes.join('/') || '(读不到名字)'} 全 0）——"只面对五类"在类型层也成立`,
    rawTypes.length >= 1 && files.length >= 20 && typeHits.length === 0 && coreOwnHits >= 2,
    rawTypes.length === 0
      ? '读不到分类表的键类型：event-category.ts 的形状被改了，这条判据已经没有对象，不许当通过'
      : typeHits.length > 0
        ? `泄漏点：${typeHits.join(' ; ')}（面板该收五类，不是原始事件联合）`
        : `正控：client-core 的 event-category.ts 自己用了 ${coreOwnHits} 次；扫描面 ${files.length} 个文件`)
}

// ---------------------------------------------------------------- 委托给别的门，点名
{
  const others = ['scripts/check-nongoals.mjs', 'scripts/protocol-ledger.mjs', 'scripts/check-theme.mjs']
  record('委托', '磁盘/进程/SQLite/用户目录、端点台账、主题链路各由点名的门判定', others.every((p) => existsSync(join(clientRoot, p))), others.join(' + '))
}

// ---------------------------------------------------------------- 验法收尾不得从 finally 抛出
{
  // 形状：错误从 `finally` 里抛出去时，**本文件那个 catch 接不到它**，于是这一步报成"屏上一条 ✗
  // 都没有、退出码 1、末行是 node 的崩溃横幅"——追了很久的 #85 就是这个形状。根因在 Windows：
  // `rmSync(dir, {force:true})` 的 force 只压 ENOENT/ENOTDIR，压不住刚被 SIGTERM 掉的子进程还攥着
  // 句柄时的 EBUSY/EPERM。反向对照已复现同形（注入一个逃出 finally 的抛出 → exit 1 / red 0 / 有横幅）。
  // 所以这条不写死文件清单：面从 `scripts/*.mjs` 派生，逐个解析收尾体。
  const CLEANUP_FNS = /\b(?:async )?function (stopAll|teardown|cleanup)\s*\(/
  const files = readdirSync(join(clientRoot, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ['scripts/' + f, readFileSync(join(clientRoot, 'scripts', f), 'utf8')])
  const offenders = []
  let bodies = 0
  let dangers = 0
  for (const [rel, src] of files) {
    const lines = src.split(/\r?\n/)
    const heads = []
    lines.forEach((l, i) => {
      if (/^\s*\}\s*finally\s*\{/.test(l) || CLEANUP_FNS.test(l) && /[^{]*\{\s*$/.test(l)) heads.push([i, l.match(/^\s*/)[0].length])
    })
    for (const [start, indent] of heads) {
      const closer = new RegExp(`^${' '.repeat(indent)}}$`)
      let body = ''
      let closed = false
      for (let i = start; i < lines.length && i < start + 60; i++) {
        if (i > start && closer.test(lines[i])) { closed = true; break }
        body += lines[i] + '\n'
      }
      // 解析不全就是红，不许"没解析到 = 通过"。
      if (!closed) { offenders.push(`${rel}:${start + 1} 收尾体没找到同缩进的闭合 }（解析失败，不是通过）`); continue }
      bodies += 1
      const danger = (body.match(/\b(rmSync|unlinkSync|rmdirSync|execFileSync|execSync)\s*\(/g) || []).length
      const tries = (body.match(/\btry\s*\{/g) || []).length
      dangers += danger
      if (danger > tries) offenders.push(`${rel}:${start + 1} 里 ${danger} 个可抛调用只有 ${tries} 个 try 兜着`)
    }
  }
  record('验法收尾', `${files.length} 个脚本里的 ${bodies} 个收尾体（finally / stopAll / teardown / cleanup），共 ${dangers} 个可抛调用都有 try 兜住`,
    offenders.length === 0, offenders.slice(0, 3).join(' ｜ ') || '错误从收尾体逃不出去，就不会再出现"无 ✗ 只有崩溃横幅"那一步')
}

// ---------------------------------------------------------------- 验法里的等待必须有上界
{
  // #85 结案时顺出来的同族风险：`await new Promise((res) => child.once('exit', res))` 若子进程
  // 永不 exit，就是**整道门永挂**——而挂掉在 CI 里和"还在跑"长得一样，且一行输出都没有。本仓已经
  // 为这句话付过一次学费（`verify-desktop` 里那句注释写着"丢了 7 分钟"）。
  // 允许清单按**语句形状**匹配，不按行号（行号会随每次编辑漂移，那正是判定最爱骗人的地方）。
  const ACCEPTED_UNBOUNDED = [
    [/stall-demo\.mjs/, /new Promise\(\(\)\s*=>\s*undefined\)/, '演示脚本故意挂住不退出（人还在看页面），是设计而非漏'],
    [/serve-client\.mjs/, /res\.once\('drain'/, '同源伺服的写背压：给它加超时等于改产品语义（慢客户端会被强制断流），无现场证据不动'],
  ]
  const files = readdirSync(join(clientRoot, 'scripts')).filter((f) => f.endsWith('.mjs'))
  const offenders = []
  let awaits = 0
  let bounded = 0
  let accepted = 0
  let sawCanarySite = false
  for (const f of files) {
    // 注释处理只做**行级**：跳过以 `//`、`/*`、`*` 开头的行，并去掉行内 `//`（`://` 除外）。
    // 第一版还顺手用 `/\/\*[\s\S]*?\*\//g` 整段剥块注释，结果 `serve-client.mjs` 里有个字符串带
    // `/*`，把后面几十行当"注释"吞了——drain 那处直接从扫描面上消失。是这一行的**正控**（下面
    // 的 canary）报的"正控丢失"把它揭出来的：判据自己坏了会红，不会假装绿。
    // 语句形状也要认：只匹配 `await new Promise(`，纯文字提及（判定标签、注释里的同款短语）不进判定。
    const body = readFileSync(join(clientRoot, 'scripts', f), 'utf8').replace(/(^|[^\:])\/\/[^\n]*/g, '$1')
    const lines = body.split(/\r?\n/)
    lines.forEach((line, idx) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return
      if (!/await new Promise\s*\(/.test(line)) return
      awaits += 1
      const window = lines.slice(idx, idx + 5).join('\n')
      // 正控：`serve-client.mjs` 里那处 drain 等待是**已知存在且在允许清单上**的站点。剥注释或
      // 语句形状一改，它第一个消失——所以拿它当金丝雀，比任何"扫到 ≥N 处"的魔法数都硬（上一版
      // 的阈值就是按剥注释**之前**的读数校准的，于是自己把自己判红了）。
      if (/res\.once\('drain'/.test(window)) sawCanarySite = true
      if (/setTimeout\s*\(|Promise\.race|AbortSignal/.test(window)) { bounded += 1; return }
      const pass = ACCEPTED_UNBOUNDED.find(([fileRe, stmtRe]) => fileRe.test(f) && stmtRe.test(window))
      if (pass) { accepted += 1; return }
      offenders.push(`${f}:${idx + 1} ${line.trim().slice(0, 70)}`)
    })
  }
  record('验法等待有界', `${files.length} 个脚本里 ${awaits} 处 ` + '`await new Promise`' + `：${bounded} 处自带上界、${accepted} 处登记了故意无界的理由，其余必须有界（挂掉的门不会报错，只会沉默）`,
    offenders.length === 0 && sawCanarySite, [
      offenders.length > 0 ? `无界且未登记：${offenders.slice(0, 3).join(' ｜ ')}` : '',
      sawCanarySite ? '' : '正控丢失：没认出 serve-client 的 drain 等待——扫注释/语句形状被判据改坏了，这条绿不算数',
    ].filter(Boolean).join(' ｜ ') || `没有一处等待会无声挂住整道门（金丝雀站点在场）`)
}

// ---------------------------------------------------------------- 写文件之前必须自己把目录建出来
{
  // 2026-10-12 的形状：`--state-dir` 指到一个还不存在的目录，`openSync(logPath, 'w')` 当场 ENOENT，
  // 报出来的是"启动器失败"而不是"你没建目录"——诊断时白烧一轮。同一个脚本里 `desktopDir` 与
  // `RIVET_HOME` 都 recursive 建过，唯独这两个记账文件住的目录隐含"caller 已建好"，而这个前提
  // 在 `--help` 与文档里都没写过。判据不写死文件名：面从 `scripts/*.mjs` 派生，每一处写模式的
  // `openSync(X, 'w')` 之前，同一文件里必须出现过一次 `mkdirSync(..., { recursive: true })`。
  const files = readdirSync(join(clientRoot, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ['scripts/' + f, readFileSync(join(clientRoot, 'scripts', f), 'utf8')])
  // 注释里的形状不算站点——第一版就被自己的注释绊了一次：解释文字里写了 `openSync(logPath, 'w')`，
  // 于是门把 check-layers 自己也当成一个写点。剥离与颜色字面量那条同源（挖空注释但保留换行）。
  const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const offenders = []
  let sites = 0
  let sidecarSites = 0
  for (const [rel, raw] of files) {
    const src = codeOnly(raw)
    const opens = [...src.matchAll(/openSync\(([^,()]*(?:\([^()]*\))?[^,()]*),\s*['"]w[ax+]?\s*['"]\s*\)/g)]
    if (opens.length === 0) continue
    for (const o of opens) {
      const target = String(o[1]).trim()
      sites += 1
      if (rel === 'scripts/launch-sidecar.mjs') sidecarSites += 1
      // 必须是为**这一个路径**建过目录，不是"这个文件里某处建过某个目录"：第一版判据就是这么弱
      // （变异把日志那行的 mkdir 删掉照样绿，因为同一个文件更早为 desktopDir 建过一次）。
      // 认两种写法：`mkdirSync(dirname(X), { recursive: true })`，或 X 本身就是目录时 `mkdirSync(X, …)`；
      // 且必须出现在这个 open 之前、就近的 160 字符里带 `recursive: true`（不给"建了个别的目录"蒙过）。
      const cands = [...src.matchAll(/mkdirSync\((?:dirname\((\s*[^)]*?)\s*\)|([^,)]+))\s*,\s*\{([^)]*)\}/g)]
        .filter((c) => {
          const arg = String(c[1] ?? c[2]).trim()
          return arg === target || `dirname(${arg})` === target || arg === target.replace(/^dirname\((.*)\)$/, '$1')
        })
        .filter((c) => /recursive:\s*true/.test(String(c[3])) && (c.index ?? 0) < (o.index ?? 0))
      if (cands.length === 0) offenders.push(`${rel}：写模式 open（目标 ${target}）之前，没有为这个路径建目录的 mkdirSync(..., { recursive: true })`)
    }
  }
  record('写文件先建目录', `面 ${sites} 处写模式 openSync（从 scripts/*.mjs 派生，注释已挖空）`,
    offenders.length === 0 && sites >= 1 && sidecarSites === 1,
    offenders.slice(0, 3).join(' ｜ ')
      || (sites === 0 ? '面塌了：一处写模式 open 都没找到，这条绿不算'
        : sidecarSites !== 1 ? `正控丢失：启动器里应当恰好有 1 处写模式 open，实测 ${sidecarSites}——扫描面或注释剥离被改坏了，其余读数不作数`
          : '每一处写之前都建过目录（含 `--state-dir` 那条曾经的隐含前提）'))
}

// ---------------------------------------------------------------- 只读探针只许有一个家
// 剥注释但保留换行：注释里的形状不算第二个家（同一条课：门不许因为文档写得好而红）。
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
// 面从 `scripts/` 的目录派生，不写死文件清单：多第三个文件也一样管。同时收 `.mjs` 与 `.ts`：
// 验收脚本有一份 `.ts` 住在同一个目录，只扫 `.mjs` 就是给它留了第二个家。
const scriptFiles = readdirSync(join(clientRoot, 'scripts')).filter((f) => f.endsWith('.mjs') || f.endsWith('.ts'))
/** 在 scripts/ 的纯代码里找某个形状，返回 `'scripts/<file>'` 清单。needle 由调用方拼出来。 */
const codeHomes = (needle) => scriptFiles
  .filter((f) => codeOnly(readFileSync(join(clientRoot, 'scripts', f), 'utf8')).includes(needle))
  .map((f) => 'scripts/' + f)

{
  // `lib-instance.mjs` 自己的文档写着"一条只会静默失败的 PowerShell 不许有两份拷贝"，而
  // `verify-desktop.mjs` 里实际留着一整份私有副本（同一条命令、同一个失败标记串）——两份的漂移
  // 方式正是坏掉的那份读起来像"机器上什么都没有"，而每个调用方都会把它当成好消息。
  // needle 自己拼出来，免得这个文件因为写了判据就被算成一个家。
  const NEEDLE = 'Get-Cim' + 'Instance Win32_Process'
  const homes = codeHomes(NEEDLE)
  const libHome = 'scripts/lib-instance.mjs'
  record('只读探针单一家',
    `CIM 进程探针在 scripts/ 里只有 lib-instance.mjs 一个家（面从目录派生，实测 ${homes.length} 处）`,
    homes.length === 1 && homes[0] === libHome,
    homes.length === 0
      ? '面塌了：一处探针都没找到，这条绿不算（共用件被删或 needle 被改坏）'
      : homes.length > 1
        ? `探针有 ${homes.length} 个家：${homes.join(' , ')}——留两份就会有一份静默坏掉，把"看不见"读成"没有残留"`
        : `${libHome} 是唯一持数处（正控：lib-instance.mjs 必须在这张表里）`)
}

{
  // 同一门课的第二遍：`~/.rivet` 的条目计数原本住在 `verify-desktop.mjs` 里，`verify-dev-proxy`
  // 要问同一个问题时只能再抄一遍。这个数存在的唯一理由是**前后两次可比**——两份实现一漂移，
  // 比较就失去意义，而漂移出来的那一半长得跟"隔离生效了"一模一样。
  // 钉的是路径拼法（唯一的读数入口），调用方写 `countOperatorHome()` 不会被算成一个家。
  const NEEDLE = "homedir(), '." + "rivet'"
  const homes = codeHomes(NEEDLE)
  const libHome = 'scripts/lib-home.mjs'
  record('操作者 home 计数单一家',
    `~/.rivet 的条目计数在 scripts/ 里只有 lib-home.mjs 一个家（面从目录派生，实测 ${homes.length} 处）`,
    homes.length === 1 && homes[0] === libHome,
    homes.length === 0
      ? '面塌了：没有任何文件在拼这个路径，这条绿不算（共用件被删或 needle 被改坏）'
      : homes.length > 1
        ? `计数有 ${homes.length} 个家：${homes.join(' , ')}——前后对比要的是同一个尺子，留两份就有漂移一格假绿`
          : `${libHome} 是唯一持数处（正控：lib-home.mjs 必须在这张表里）`)
}

// ---------------------------------------------------------------- 证据面不许有"占位绿"
{
  // ok 位写死常量的判定长这样：`record('§5.2-5','manual','报警样式从未被渲染过…', true, …)`——它永远
  // 打印一行 ✓，而 ✓ 的内容可以是任何话，"没测到"也从不会红。这一族已经被抓到三次（#47 的一条 traps、
  // 本轮 `verify-dev-proxy` 的三条），不该再靠人记得去看。
  // **位次不写死，名字也不写死**：ok 在第 1 / 2 / 3 / 4 位都有（`check-docs.mjs` 的 `report(ok, label, detail)`
  // 就是第一位），所以"记录器"这个名字集合从每个文件自己的定义里派生——形参表里出现名为 `ok` 的参数就算。
  // 这不是洁癖：先前写死 `record|check` 时，`check-docs` 那 7 条判定整个在面外（现测派生出三个名字
  // report / record / check）。同名不同物也由此自动分开：`gen-protocol-types.mjs` 里也有个 `report`，
  // 但它的形参是 `(label, d)`，不是记录器，就不进这张面。
  // 认法是按括号深度：`true` 必须是该调用的**直接实参**才算（第一版用正则找 `record(` 再往后走，于是把
  // 本文件夹具字符串里的形状当成调用点——门抓到自己头上，正是这条判据该有的样子）。字符串、模板、正则、
  // 注释都在同一次线性遍历里跳过。
  // 边界明写：写死的 `false` **不在**这张面上。那是 fail-closed 的红线（只在另一面不存在时才响），
  // 与"永远 ✓ 的占位绿"形状相反，把它一起拦等于打掉诚实的红灯。
  const recorderNames = (raw) => {
    const src = codeOnly(raw)
    const out = new Set()
    for (const m of src.matchAll(/(?:const|let|function)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*)?\(([^)]*)\)/g)) {
      // 形参名要整词边界；**允许 TS 类型标注**（`ok: boolean`）与默认值（`ok = false`）——第一版没认
      // 类型标注，于是 7 份 `accept-*.ts` 那整张面被静默关在门外（调用数从 253 掉到 159 才暴露）。
      if (/(^|[,)\s])ok\b\s*(?::[^,)=]*)?([,)]|\s*=)/.test(m[2])) out.add(m[1])
    }
    return out
  }
  const scanHardOk = (file, raw, names) => {
    const src = codeOnly(raw)
    const hits = []
    let calls = 0
    const frames = []
    let depth = 0
    let prev = ''
    let pendingRec = false
    let line = 1
    let i = 0
    while (i < src.length) {
      const c = src[i]
      if (c === '\n') { line++; i++; continue }
      if (c === '"' || c === "'" || c === '`') {
        const q = c
        i++
        while (i < src.length) {
          if (src[i] === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue }
          if (src[i] === q) { i++; break }
          if (src[i] === '\n') line++
          i++
        }
        prev = q
        continue
      }
      // `/` 当正则还是除法：看前一个有意义的字符（JS 词法的经典启发式，夹具里有一条专门盯它）
      if (c === '/' && /[=(,:[!&|?;{}+\-*%~^<>]/.test(prev)) {
        i++
        let cls = false
        while (i < src.length) {
          if (src[i] === '\\') { i += 2; continue }
          if (src[i] === '[') cls = true
          else if (src[i] === ']') cls = false
          else if (src[i] === '\n') break
          else if (src[i] === '/' && !cls) { i++; break }
          i++
        }
        prev = '/'
        continue
      }
      if (c === '(' || c === '[' || c === '{') {
        depth++
        frames.push({ rec: pendingRec, depth, open: i + 1, argEnd: null })
        if (pendingRec) calls += 1
        pendingRec = false
        prev = c
        i++
        continue
      }
      if (c === ')' || c === ']' || c === '}') { depth--; frames.pop(); prev = c; i++; continue }
      if (/\s/.test(c)) { i++; continue }
      if (c === ',') {
        const top = frames[frames.length - 1]
        if (top !== undefined && top.rec && depth === top.depth && top.argEnd === null) top.argEnd = i
        prev = c
        i++
        continue
      }
      const wm = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))
      if (wm !== null) {
        const word = wm[0]
        // 名字要整词且不是属性访问：`sidecarCheck(` 与 `t.record(` 都不算调用点；
        // 是不是记录器由这个文件的 `names` 说了算（派生自它自己的形参表），不在这张面上的名字直接跳过
        if (names.has(word) && prev !== '.') {
          const rest = src.slice(i + word.length)
          const am = /^[ \t]*\r?\n?[ \t]*\(/.exec(rest)
          if (am !== null) pendingRec = true
        }
        if (word === 'true' && (prev === ',' || prev === '(')) {
          const top = frames[frames.length - 1]
          if (top !== undefined && top.rec && depth === top.depth) {
            const raw = src.slice(top.open, top.argEnd ?? i).replace(/\s+/g, ' ').trim()
            const quoted = /^(['"`])([\s\S]*)\1$/.exec(raw)
            hits.push({ file, line, label: (quoted ? quoted[2] : raw).slice(0, 90) })
          }
        }
        i += word.length
        prev = word[word.length - 1]
        continue
      }
      prev = c
      i++
    }
    return { hits, calls }
  }
  // 形状自证：每条是 `[源码, 期望命中数, 名字集合, 那句在说什么]`。有牙（四种写死形状都抓到）也
  // 不咬人（比较式、对象属性、正则字面量、注释、名字前缀、属性访问、同名却不派生自形参表——都放行）。
  const RC = new Set(['record', 'check'])
  const FIXTURES = [
    [`record('g', 'label', true, 'note')`, 1, RC, '三位签名里 ok 位写死'],
    [`check('label', true, 'detail')`, 1, RC, '两位签名里 ok 位写死'],
    ['record(\x27g\x27, \x27label\x27,\n  true,\n  \x27note\x27)', 1, RC, 'ok 位独占一行也认得出'],
    [`report(true, 'label', 'detail')`, 1, new Set(['report']), 'ok 在第一位一样认得出（check-docs 的真实形状）'],
    [`report('label', true)`, 0, RC, '名字不在集合里就不认——"是不是记录器"由派生决定，不是由名字决定'],
    [`record('g', 'label', x === true, 'note')`, 0, RC, '比较式不是写死'],
    [`record('g', 'label', mkdir(p, { recursive: true }), 'note')`, 0, RC, '对象属性里的 true 不是实参'],
    [`record('g', 'label', /, true/.test(s), 'note')`, 0, RC, '正则字面量里的 , true 不算'],
    [`// record('g', 'label', true, 'note')`, 0, RC, '注释里的形状不算违规'],
    [`record('g', 'label', f(', true'), 'note')`, 0, RC, '字符串里的不算'],
    [`sidecarCheck('g', true)`, 0, RC, '名字要整词命中，sidecarCheck 不是 check'],
    [`t.record('g', true)`, 0, RC, '属性访问不在这张面上（明写边界，不假装全覆盖）'],
  ]
  // 名字集合自己也要自证：派生只认"形参表里有 `ok` 的定义"，且不许把解构当定义、不许漏 function 形式。
  // **每条源码拆成两段拼**：整段字面量留在本文件里会被这条判定自己扫到——第一版写成整串时，本文件
  // 派生出的名字里凭空多了一个 `verdict`（夹具字符串里的定义），这就是"门抓到自己头上"的第三种形态。
  const NAME_FIXTURES = [
    [['const report = ', "(ok, label, detail = '') => {}"], ['report'], 'ok 在第一位也算记录器'],
    [['const report = ', '(label, d) => {}'], [], '同名但形参没有 ok：不是记录器（gen-protocol-types 就是这一种）'],
    [['function verdict', '(label, ok, why) { return why }'], ['verdict'], 'function 形式的定义一样派生'],
    [['const check = ', '(label: string, ok: boolean, detail = ""): void => {}'], ['check'], 'TS 类型标注不挡派生（accept-*.ts 的真实形状）'],
    [['for (const [ok, what] of claims) ', '{ void what }'], [], '解构不是定义（这形状今天真实存在于 check-docs）'],
  ]
  const fixtureProblems = []
  for (const [parts, want, why] of NAME_FIXTURES) {
    const got = [...recorderNames(parts.join(''))].sort().join(',')
    const exp = [...want].sort().join(',')
    if (got !== exp) fixtureProblems.push(`名字派生｜${why}：期望 [${exp || '(空)'}]，实得 [${got || '(空)'}]`)
  }
  for (const [src, want, names, why] of FIXTURES) {
    const got = scanHardOk('fixture', src, names).hits.length
    if (got !== want) fixtureProblems.push(`${why}：期望 ${want} 处，实得 ${got} 处`)
  }
  let calls = 0
  const hits = []
  const derivedNames = new Set()
  const perFile = new Map()
  for (const f of scriptFiles) {
    const raw = readFileSync(join(clientRoot, 'scripts', f), 'utf8')
    const names = recorderNames(raw)
    for (const n of names) derivedNames.add(n)
    perFile.set('scripts/' + f, names)
    const r = scanHardOk('scripts/' + f, raw, names)
    calls += r.calls
    hits.push(...r.hits)
  }
  // 正控绑已知站点（不绑总数）：派生面一旦对**某种真实形状**是瞎的，全局数字未必掉得看得见，
  // 但这三处一定少。第一版就是靠这条补上来的——形参写 `ok: boolean` 时派生认不出，七份 `accept-*.ts`
  // 整张面静默出局（调用数 253 → 159 才被人看见，而判定照绿）；有了按站点的正控，那种缩小当场就红。
  const FACE_SITES = [
    { file: 'scripts/accept-queue.ts', name: 'check', why: 'TS 带类型标注的形参（`ok: boolean`）也要派生出来' },
    { file: 'scripts/check-docs.mjs', name: 'report', why: 'ok 在第一位的记录器' },
    { file: 'scripts/check-layers.mjs', name: 'record', why: '本门自己的记录器（四位签名）' },
  ]
  const faceMissing = FACE_SITES.filter((s) => !perFile.get(s.file)?.has(s.name))
  // 双向理由表：面上每一处写死的 ✓ 都得在这张表上有一句**名字对得上**的理由；表里点名过的形状
  // 消失了也要红（豁免不许烂在表里，与配色那族"实测集与理由表双向相等"同一条规矩）。
  const RECORDED_OK = [
    { file: 'scripts/ci-smoke.mjs', label: 'an accepted keyless prompt reports itself',
      why: '上游症状的记录，不是客户端义务：无 key 的 prompt 是"自报失败"还是"全程静默"由内核决定，两种形状都有归宿（自报→这一行，静默→一条 note），所以这一行只在真发生过时才出现，它说的就是"确实发生过"。' },
  ]
  const hitsReal = hits.filter((h) => h.file !== 'fixture')
  const violations = hitsReal.filter((h) => !RECORDED_OK.some((e) => e.file === h.file && e.label === h.label))
  const staleWaivers = RECORDED_OK.filter((e) => !hitsReal.some((h) => h.file === e.file && h.label === e.label))
  const fixtureBad = FIXTURES.filter(([, w]) => w > 0).length
  const fixtureClean = FIXTURES.length - fixtureBad
  const nameList = [...derivedNames].sort()
  const namesFloor = derivedNames.has('record') && derivedNames.has('check') && derivedNames.has('report')
  record('证据面不许有占位绿',
    `面从形参表派生出 ${nameList.length} 个记录器名（${nameList.join(' / ')}），${scriptFiles.length} 个脚本里 ${calls} 处调用，ok 实参是字面量 true 的只剩理由表上点名的 ${RECORDED_OK.length} 条`,
    violations.length === 0 && staleWaivers.length === 0 && fixtureProblems.length === 0 && calls >= 40 && namesFloor && faceMissing.length === 0,
    fixtureProblems.length > 0
      ? `扫描器自己坏了，其余读数都不作数（形状自证失败）：${fixtureProblems.join(' ｜ ')}`
        : faceMissing.length > 0
          ? `派生面对已知站点是瞎的：${faceMissing.map((m) => `${m.file} 里的 ${m.name}()（${m.why}）`).join(' ｜ ')}`
            : !namesFloor
              ? `名字派生面塌了：现派生出 [${nameList.join(' / ') || '(空)'}]，而 record/check/report 这三个今天必须都在（形参表形状被改坏，或剥注释吃掉了定义）`
                : calls < 40
                  ? `面塌了：整个 scripts/ 只认出 ${calls} 处判定调用，这条绿不算（名字边界或剥注释被改坏）`
                    : violations.length > 0
                      ? `${violations.length} 处没交代：${violations.slice(0, 6).map((h) => `${h.file}:${h.line}「${h.label}」`).join(' , ')}——那行 ✓ 与现场无关，要么改成真条件，要么上表写清它凭什么`
                        : staleWaivers.length > 0
                          ? `理由表里有 ${staleWaivers.length} 条已经找不到对应的写死形状：${staleWaivers.map((e) => `${e.file}「${e.label}」`).join(' , ')}——豁免不许烂在表里`
                            : `正控：夹具 ${FIXTURES.length} 条形状 + ${NAME_FIXTURES.length} 条名字派生全按期望落地（写死的 ${fixtureBad} 种都抓到，比较式/对象属性/正则字面量/注释/字符串/名字前缀/属性访问/同名非记录器这 ${fixtureClean} 种误伤全放行），已知站点 ${FACE_SITES.length} 处各按文件点名在场；真面 ${scriptFiles.length} 个文件里 ${hitsReal.length} 处写死，逐条都能对上表上的名字`)
}

// ---------------------------------------------------------------- 提交键只有一个家（IME 守卫）
{
  // 2026-10-13 的缺陷：composer 的提交判定是 `key === 'Enter' && !shiftKey`。中文输入法里那一下
  // Enter 是**把候选词上屏**，引擎发出的是同一条 keydown（`key: 'Enter'`、`shiftKey: false`），只是
  // 多带 `isComposing: true`——于是半截中文串当成 prompt 发了出去（有 key 时还顺手花掉一发）。
  // 修法是把规则收进 `packages/ui-primitives/src/submit-key.ts` 的 `submitsOnEnter`，这条判定保证
  // 它不会被"就地重写一遍"悄悄丢掉：**宿主里每一处拿 key 比 Enter 的行都必须走那个谓词**。
  // 侧栏那些 `role="button"` 的行按 Enter 是激活按钮，那里没有可编辑元素、composition 不会为真，
  // 所以那一面要的是**证据**（同元素块里有 role="button" 且没有可编辑标签），不是谓词。
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
    }
  }
  const hostDir = join(clientRoot, 'apps/web/src')
  walk(hostDir)
  for (const p of Object.keys(all)) walk(join(pkgRoot, p, 'src'))
  const label = (p) => p.slice(clientRoot.length + 1).replace(/\\/g, '/')
  // 前面允许 `.`：真实形状是 `e.key === 'Enter'`，第一版把 `.` 排除掉了，于是整张面一个提交点都没认出来
  // （guarded=0 那条红把它自己抓到了——"0 命中"和"面空了"必须能分辨）。
  const ENTER_RE = /(?:^|[^A-Za-z0-9_])key\s*={2,3}\s*['"]Enter['"]/
  const EDITABLE_RE = /<(textarea|input|select\b)|contentEditable/i
  // 判据分不出"代码"与"叙述"，所以按**行**排注释：`submit-key.ts` 的文件头就把 `key === 'Enter'`
  // 原样写在散文里，第一版因此把那份文件的两行注释判成两处没守卫的提交点（红得对——是它自己的错）。
  // 这里只做行级判断，不剥块注释：本仓有过一次"朴素块注释剥除把整张 STEPS 表吞掉"的事故。
  const prose = (line) => /^\s*(?:\/\/|\*|\/\*)/.test(line)
  const viaPredicate = (line) => /submitsOnEnter\(/.test(line)
  // 调用形状也要钉：React 的合成键盘事件**不带** `isComposing`（本轮在真浏览器里量到的，见
  // `submit-key.ts` 文件头），所以标志必须从 `e.nativeEvent.isComposing` 取。写成 `submitsOnEnter(e)`
  // 的那种调用编译得过、跑起来照发——这正是修复第一版自己的错。
  const readsNative = (line) => /\.nativeEvent\.isComposing/.test(line)
  const buttonEvidence = (lines, i) => {
    const region = lines.slice(Math.max(0, i - 8), i + 1).filter((l) => !prose(l)).join('\n')
    return /role=["']button["']/.test(region) && !EDITABLE_RE.test(region)
  }
  const unguarded = []
  // 「那一个家」自己当然得出现字面量——谓词的本体就是规则，所以先按定义式认出它，扫描时把它例外；
  // 调用点只数 `submitsOnEnter(` 这个形状（`import { submitsOnEnter }` 那种花括号导入不算提交点）。
  const home = files.find((f) => /^\s*export function submitsOnEnter\b/m.test(readFileSync(f, 'utf8')))
  const verdict = (line) => {
    if (prose(line)) return 'skip'
    if (viaPredicate(line)) return readsNative(line) ? 'guarded' : 'bad-call'
    return ENTER_RE.test(line) ? 'bare' : 'skip'
  }
  let guarded = 0
  let buttoned = 0
  for (const f of files) {
    if (f === home) continue
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const v = verdict(line)
      if (v === 'skip') return
      if (v === 'guarded') { guarded += 1; return }
      if (v === 'bad-call') {
        unguarded.push(`${label(f)}:${i + 1}（调了 submitsOnEnter 却没从 e.nativeEvent.isComposing 取标志——React 的合成事件不带这字段，这样写等于没守卫）`)
        return
      }
      if (!f.startsWith(hostDir)) {
        if (buttonEvidence(lines, i)) { buttoned += 1; return }
        unguarded.push(`${label(f)}:${i + 1}（既没走谓词，也没有"同元素块里 role=button 且无可编辑标签"的证据）`)
        return
      }
      unguarded.push(`${label(f)}:${i + 1}（宿主的提交键没走 submitsOnEnter——守卫被就地重写掉了）`)
    })
  }
  // 五条合成形状各钉一种错法：判据分不出真假时"0 命中"这条绿毫无意义。
  const bareBad = (text) => text.split('\n').filter((l) => !prose(l) && ENTER_RE.test(l) && !viaPredicate(l)).length
  const fixtureBare = bareBad("  onKeyDown={(e) => { if (e.key === 'Enter') void send() }}") === 1
  const fixtureGuarded = bareBad('  onKeyDown={(e) => { if (submitsOnEnter(e)) void send() }}') === 0
  const fixtureProse = bareBad("  // 这里的 key === 'Enter' 只是散文，不是提交点") === 0
  const buttonRegion = ['<div', '  role="button"', '  tabIndex={0}', "  onKeyDown={(e) => { if (e.key === 'Enter') onOpen(id) }}"]
  const fixtureButton = buttonEvidence(buttonRegion, buttonRegion.length - 1) === true
  const editableRegion = ['<div role="button"', '<textarea', "  onKeyDown={(e) => { if (e.key === 'Enter') onOpen(id) }}"]
  const fixtureEditable = buttonEvidence(editableRegion, editableRegion.length - 1) === false
  record('提交键只有一个家',
    `每一处 Enter 提交点都对上形状（扫 ${files.length} 个源文件：${home === undefined ? '找不到谓词本体' : `家 ${label(home)}`}、走谓词的提交点 ${guarded} 处、非编辑元素带证据 ${buttoned} 处、没对上 ${unguarded.length} 处）`,
    home !== undefined && unguarded.length === 0 && guarded >= 1 && buttoned >= 1
      && fixtureBare && fixtureGuarded && fixtureProse && fixtureButton && fixtureEditable,
    home === undefined ? '没有任何一份文件定义 `submitsOnEnter`——谓词被删了，这条绿不成立'
      : unguarded.length > 0 ? unguarded.join(' ｜ ')
        : guarded < 1 ? '一处都没有走 submitsOnEnter——谓词成了装饰件，这条绿只是因为面也空了'
          : buttoned < 1 ? '一处按钮证据都没有——豁免面成了空集，说明分类器或那份 JSX 形状变了'
            : !fixtureBare || !fixtureGuarded || !fixtureProse ? '谓词形状自证失败（裸写认不出 / 走了谓词的也被认成裸写 / 注释里的散文被当成提交点）'
              : !fixtureButton || !fixtureEditable ? '豁免面自证失败：role="button" 的行要放行，而带 textarea/input 的行必须不放行'
                : `正控五条按期望落地：裸写必认、走谓词必放行、注释散文必不认、纯按钮行放行、按钮里裹着可编辑元素不放行`)
}

// ---------------------------------------------------------------- 迟到的读回不许写状态
{
  // 2026-10-13 的第二条同类缺陷：侧栏搜索防抖 250ms，而**防抖只拦得住还没发出去的请求**。
  // 已经发出的那一发（用户随后把框清空了、或打到别的查询）落地时照样 `setHits(...)`——于是搜索框是空的，
  // 结果列表却停在旧查询的读数上。修法是把"谁能写状态"收进 `client-core/latest-wins.ts` 的令牌门。
  // 这条判定钉的是形状：**定时回调里发的读请求，落地前必须过 `isCurrent(`**。
  // 面不是写死的：扫宿主与所有包的 src，凡 `setTimeout(` 块里出现 `api.xxx(` 且出现 `setXxx(`，
  // 就算一个站点；块用括号深度取（按行找闭合，跟 check-wire-mirror 同一手法）。
  const files = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
    }
  }
  walk(join(clientRoot, 'apps/web/src'))
  for (const p of Object.keys(all)) walk(join(pkgRoot, p, 'src'))
  const label = (p) => p.slice(clientRoot.length + 1).replace(/\\/g, '/')
  const blockFrom = (lines, start) => {
    let depth = 0
    const out = []
    for (let i = start; i < lines.length; i++) {
      out.push(lines[i])
      const stripped = lines[i].replace(/`[^`]*`/g, '')
      for (const ch of stripped) { if (ch === '(') depth++; else if (ch === ')') depth-- }
      if (i > start && depth <= 0) break
    }
    return out.join('\n')
  }
  // 守卫形状两种都算：令牌门 `isCurrent(`，或宿主里那种 `stopped` 闭包栅栏（deps 一变旧闭包就禁写）。
  const GUARD_RE = /isCurrent\(|\bstopped\b/
  const writesState = (line) => {
    const stripped = line.replace(/\bset(?:Timeout|Interval)\s*\(/g, '')
    return /\bset[A-Z]\w*\s*\(/.test(stripped) && !/useState\(/.test(stripped)
  }
  // 覆盖判据读的是**控制流**不是行距：守卫要和写回在同一个块里、且在它之前才算数。
  // 一直向前走到「关掉一个块的 `}` 行」为止（越过它就到兄弟语句外面了），途中跳过纯注释行，
  // 且只认剥掉行尾注释之后的代码——注释里写一句 `isCurrent(` 不许把裸发洗成有守卫。
  // 固定 4 行那种先咬的是我自己：cockpit 轮询里 `if (stopped) return` 与它的写回隔着两行中文说明，
  // 一条本来有栅栏的站点被报成没守卫（假红）。
  const onlyProse = (l) => /^\s*(?:\/\/|\*|\/\*)/.test(l)
  const codeOf = (l) => l.replace(/\/\/.*$/, '')
  const guardLine = (l) => GUARD_RE.test(codeOf(l))
  // 「本行的守卫」与「护住后面几行的守卫」是两件事：只有**早退**那种才护得住后面。
  // 形状判据：行首是 `if (`、条件里带守卫、且以 `return` 收尾（`{ setErr(1); return }` 也算，
  // 写回在 return 之前）。同行那种混合语句行不算——`void api.a().then(setX).catch(() => { if (g) return; setY(1) })`
  // 里那个 return 只关它自己那个 catch 块，护不到下一句。
  // 这一层是变异逼出来的：摘掉 jobsGate 的守卫后门照绿，因为上一行 `.catch(… if (!boardGate.isCurrent(token)) return …)`
  // 被当成了护住后面的栅栏（假绿）。
  const coversLater = (l) => {
    const c = codeOf(l)
    return /^\s*if\s*\(/.test(c) && GUARD_RE.test(c.slice(0, c.indexOf(')') + 1)) && /\breturn\b[^{}]*\}?\s*$/.test(c)
  }
  const guardCovers = (lines, idx) => {
    if (guardLine(lines[idx])) return true
    for (let j = idx - 1; j >= 0; j--) {
      const l = lines[j]
      if (onlyProse(l)) continue
      if (coversLater(l)) return true
      if (/^\s*\}/.test(l)) break
    }
    return false
  }
  // 站点 = 定时器行，两种回调都要看见：内联的那种（setTimeout(() => { … }, 250)）与**具名的**
  // 那种（setInterval(reload, 30_000) —— 读在具名函数里，定时器行上只剩一个名字）。只按内联块扫，
  // 定时表与 cockpit 轮询这一类一条都派生不出来（本轮扩面之前就是那样），所以顺着名字把函数体取出来再判。
  const sites = []
  const namedCallback = (line) => /\bset(?:Timeout|Interval)\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(line)
  const braceBody = (all, decl) => {
    // 具名回调的函数体按**花括号配平**取。固定行数那种会顺着往下吞——第一次跑就把 `pull` 后面
    // 的 refreshSessions、把 ui-schedule 的 create() 动作处理器都算成了定时读里的写回，
    // 报了四条假红；假红来自判据的覆盖面，不是产品。
    let depth = 0
    let opened = false
    const out = []
    for (let i = decl; i < all.length; i++) {
      out.push(all[i])
      for (const ch of all[i]) {
        if (ch === '{') { depth++; opened = true } else if (ch === '}') depth--
      }
      if (opened && depth <= 0) break
    }
    return out
  }
  const callbackBody = (all, i) => {
    const named = namedCallback(all[i])
    if (named === null) return { start: i, lines: blockFrom(all, i).split('\n') }
    const decl = all.findIndex((l, j) => j !== i && new RegExp('^\\s*(?:const|function)\\s+' + named[1] + '\\b').test(l))
    if (decl === -1) return null
    return { start: decl, lines: braceBody(all, decl) }
  }
  const collectWrites = (bodyLines) => {
    const ws = []
    bodyLines.forEach((l, j) => { if (writesState(l)) ws.push(j) })
    return ws
  }
  for (const f of files) {
    const all = readFileSync(f, 'utf8').split(/\r?\n/)
    const fileSrc = all.join('\n')
    all.forEach((line, i) => {
      if (!/\bset(?:Timeout|Interval)\(/.test(line) || /^\s*(?:\/\/|\*|\/\*)/.test(line)) return
      const body = callbackBody(all, i)
      if (body === null) return
      const text = body.lines.join('\n')
      if (!/\bapi\.[a-zA-Z]+\s*\(/.test(text)) return
      if (!/\bset[A-Z]\w*\s*\(/.test(text)) return
      const ws = collectWrites(body.lines)
      const naked = ws.filter((j) => !guardCovers(body.lines, j))
      sites.push({
        file: label(f),
        line: i + 1,
        named: namedCallback(line) !== null,
        writes: ws.length,
        guarded: naked.length === 0,
        nakedAt: naked.map((j) => body.lines[j].trim().slice(0, 46)),
        declaresGate: /createLatestGate\(/.test(fileSrc),
      })
    })
  }
  const unguarded = sites.filter((s) => !s.guarded)
  // 这一条**不覆盖**"非定时器回调里的读"（同槽重复触发那一族）。数量照旧派生出来打在 note 里，
  // 只报不判——把没覆盖的写成覆盖了，比不覆盖更危险。
  const outsideSites = []
  for (const f of files) {
    const all = readFileSync(f, 'utf8').split(/\r?\n/)
    all.forEach((line, i) => {
      if (!/\bapi\.[a-zA-Z]+\s*\(/.test(line) || /^\s*(?:\/\/|\*|\/\*)/.test(line)) return
      const ahead = all.slice(i, i + 7).join('\n')
      if (!/\.then\(/.test(ahead) || !/\bset[A-Z]\w*\s*\(/.test(ahead)) return
      if (/\bset(?:Timeout|Interval)\(/.test(ahead)) return
      if (GUARD_RE.test(ahead) || /new SessionModel\(/.test(ahead)) return
      outsideSites.push(label(f) + ':' + (i + 1))
    })
  }
  // 正控八条，各钉一种错法：内联裸发必判没守卫、同行令牌放行、stopped 闭包栅栏放行、多行令牌放行、
  // 多行只有一半有守卫必判没守卫、非定时器里的读根本不算站点、守卫与写回隔着注释行仍算覆盖
  // （放宽成「走到块边界为止」就是为了这条，假红那次的形状）、块已关掉之后的裸发必判没守卫
  // （这一条钉住放宽的代价：向前走到块边界就停，不许把上一句的栅栏算到自己头上）。
  const fixture = (src) => {
    const ls = src.split('\n')
    const at = ls.findIndex((l) => /\bset(?:Timeout|Interval)\(/.test(l))
    if (at === -1) return null
    const body = callbackBody(ls, at)
    if (body === null) return null
    const text = body.lines.join('\n')
    if (!/\bapi\.[a-zA-Z]+\s*\(/.test(text) || !/\bset[A-Z]\w*\s*\(/.test(text)) return null
    return collectWrites(body.lines).every((j) => guardCovers(body.lines, j))
  }
  const fxUngated = fixture('const t = setTimeout(() => { void api.listDir(id).then((d) => { setCwd(d) }) }, 250)') === false
  const fxGated = fixture('const t = setTimeout(() => { void api.listDir(id).then((d) => { if (!gate.isCurrent(k)) return; setCwd(d) }) }, 250)') === true
  const fxStopped = fixture('const t = setInterval(() => { void api.cockpit(id).then((c) => { if (stopped) return; setCockpit(c) }) }, 30000)') === true
  const fxGatedMulti = fixture([
    'const t = setTimeout(() => {',
    '  void api.listDir(id)',
    '    .then((d) => {',
    '      if (!gate.isCurrent(k)) return',
    '      setCwd(d.entries)',
    '      setErr(null)',
    '    })',
    '}, 250)'].join('\n')) === true
  const fxNakedMulti = fixture([
    'const t = setTimeout(() => {',
    '  void api.listDir(id)',
    '    .then((d) => {',
    '      setCwd(d.entries)',
    '    })',
    '    .catch(() => { if (!gate.isCurrent(k)) return; setErr(1) })',
    '}, 250)'].join('\n')) === false
  const fxNotSite = fixture('const onMount = () => { void api.listDir(id).then((d) => { setCwd(d) }) }') === null
  const fxProseGap = fixture([
    'const t = setInterval(() => {',
    '  void api.cockpit(id).then((c) => {',
    '    if (stopped) return',
    '    // 时间戳取响应落地那一刻，',
    '    // 不取定时器 firing 那一刻。',
    '    const next = { atMs: Date.now() }',
    '    setSpeedTps(next)',
    '    setCockpit(c)',
    '  })',
    '}, 10000)'].join('\n')) === true
  const fxFenceAtBlockEdge = fixture([
    'const t = setTimeout(() => {',
    '  void api.listDir(id).then((d) => {',
    '    if (!gate.isCurrent(k)) return',
    '    setCwd(d)',
    '  })',
    '  api.stat(id).then((s) => { setStat(s) })',
    '}, 250)'].join('\n')) === false
  // 上一条变异钉住的那种假绿：栅栏在**同行内联块**里（`.catch(() => { if (g) return; setY(1) })`），
  // 它只关自己那个块，护不到下一句的裸发。
  const fxFenceInlineBlock = fixture([
    'const t = setInterval(() => {',
    '  void api.a(id).then((d) => setX(d)).catch(() => { if (!gate.isCurrent(k)) return; setY(1) })',
    '  api.b(id).then((s) => setZ(s))',
    '}, 30000)'].join('\n')) === false
  const namedSites = sites.filter((s) => s.named)
  const namedGuarded = namedSites.length >= 1 && namedSites.every((s) => s.guarded)
  const known = sites.find((s) => s.file === 'apps/web/src/App.tsx')
  // 九条正控放一张表里：`ok` 的合取与失败文案都从这张表派生。分成两处写会漂——上一轮就往文案里
  // 少报了一条，那条红了却查不到是哪一种错法。
  const canaries = [
    ['裸发认出', fxUngated],
    ['同行令牌', fxGated],
    ['stopped 栅栏', fxStopped],
    ['多行令牌', fxGatedMulti],
    ['多行只有一半有守卫', fxNakedMulti],
    ['非定时不算站点', fxNotSite],
    ['隔注释行的栅栏要认', fxProseGap],
    ['栅栏不许跨块边界', fxFenceAtBlockEdge],
    ['内联块里的栅栏护不到下一句', fxFenceInlineBlock],
  ]
  record('迟到的读回不写状态',
    `定时器回调里发的读请求都过了守卫（站点 ${sites.length} 处 = 内联 ${sites.length - namedSites.length} + 具名回调 ${namedSites.length}；没守卫 ${unguarded.length} 处；面从 ${files.length} 个源文件的 setTimeout/setInterval 行派生）`,
    sites.length >= 1 && unguarded.length === 0 && namedGuarded
      && canaries.every((c) => c[1])
      && known !== undefined && known.guarded,
    sites.length === 0 ? '一个站点都没派生出来——扫描面或形状识别坏了，这条绿不算'
      : namedSites.length === 0 ? '具名回调那种站点一条都没有——要么解析具名函数的路断了，要么面里根本没有 setInterval；这条绿不算覆盖面扩到位'
        : canaries.some((c) => !c[1])
          ? `分类器形状自证失败（${canaries.map((c) => c[0] + '=' + c[1]).join(' ')}）`
          : unguarded.length > 0
            ? unguarded.map((s) => s.file + ':' + s.line + '（' + s.writes + ' 次写回里没守卫的是：' + s.nakedAt.join(' ; ') + (s.named ? '｜具名回调' : '') + '）').join(' ｜ ')
            : `已知站点 apps/web/src/App.tsx:${known?.line ?? '?'} 在场且有守卫；这条**不覆盖**非定时器回调的读（现派生 ${outsideSites.length} 处候选，只报不判，逐个读过的结论在台账本轮那条${outsideSites.length > 0 ? '：' + outsideSites.join(' / ') : ''}）`)

  // 非定时器那一族的**下界**判定（同一条判定块、同一份派生面，不再走第六遍目录）。上面那条把逐写回
  // 只管到定时器面，因为粗筛窗口（读点后 7 行）会把 JSX 兄弟属性里的写回也算进来——拿它做硬判据会假红。
  // 但「把整道闸门拆掉」那种退化必须红：面里每个 `createLatestGate()` 门名都要既有人 `.begin(` 取令牌、
  // 又有人 `.isCurrent(` 消费令牌。少了这一条，删掉 refreshSessions / ui-settings reload 的守卫只会让
  // 站点从**报告名单**上冒出来，门照绿——报告项不是判据。
  const armShape = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useMemo\(\s*\(\)\s*=>\s*)?createLatestGate\(/
  const families = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const names = [...new Set([...src.matchAll(new RegExp(armShape.source, 'g'))].map((m) => m[1]))]
    for (const n of names) {
      const begins = (src.match(new RegExp('\\b' + n + '\\.begin\\(', 'g')) ?? []).length
      const reads = (src.match(new RegExp('\\b' + n + '\\.isCurrent\\(', 'g')) ?? []).length
      families.push({ file: label(f), name: n, begins, reads, ok: begins >= 1 && reads >= 1 })
    }
  }
  // 正控：夹具里 `probeGate` 有令牌没人消费、`deadGate` 根本没取令牌，两种残缺都必须点名；
  // `liveGate` 齐备，必须放行（否则这条判据只是在罚形状正确的那个，抓不到任何退化）。
  const fx = (src, name) => {
    const begins = (src.match(new RegExp('\\b' + name + '\\.begin\\(', 'g')) ?? []).length
    const reads = (src.match(new RegExp('\\b' + name + '\\.isCurrent\\(', 'g')) ?? []).length
    return begins >= 1 && reads >= 1
  }
  const fxLive = fx('const g = createLatestGate(); const k = g.begin(); if (g.isCurrent(k)) setX(1)', 'g') === true
  const fxNoRead = fx('const g = createLatestGate(); const k = g.begin(); setX(1)', 'g') === false
  const fxNoBegin = fx('const g = createLatestGate(); if (g.isCurrent(0)) setX(1)', 'g') === false
  const broken = families.filter((x) => !x.ok)
  const knownSite = families.find((x) => x.file === 'apps/web/src/App.tsx' && x.name === 'rosterGate')
  record('迟到的读回不写状态（非定时器面）',
    `每一道 latest-wins 闸门都真的装在读写回上（面里派生 ${families.length} 个门名，逐名要求 begin 与 isCurrent 都在；残缺 ${broken.length} 个）`,
    families.length >= 1 && broken.length === 0 && fxLive && fxNoRead && fxNoBegin
      && knownSite !== undefined && knownSite.ok,
    families.length === 0 ? '一个门名都没派生出来——面或形状识别坏了，这条绿不算'
      : !fxLive || !fxNoRead || !fxNoBegin
        ? `夹具自证失败（齐备放行=${fxLive} 有令牌没消费要认=${fxNoRead} 没取令牌要认=${fxNoBegin}）`
        : broken.length > 0
          ? broken.map((x) => x.file + ' 的 ' + x.name + '（begin ' + x.begins + ' 次 / isCurrent ' + x.reads + ' 次）').join(' ｜ ')
          : `逐名在场：${families.map((x) => x.file.split('/').pop() + ':' + x.name + '(' + x.reads + ')').join(' ')}；已知站点 apps/web/src/App.tsx 的 rosterGate 在场；这一族**不做**逐写回覆盖判定（粗筛窗口会把 JSX 兄弟属性的写回算进来，硬判会假红）`)
}

// ---------------------------------------------------------------- 类名归属（宿主 vs 包）
{
  // §4.2 写的是「有界面的包各带一份 styles.css」，可没人管**宿主**用的是谁的名字。右栏那颗收起钮
  // 一直戴着 `.set__close`——ui-settings 为自己面板定义的类；它借了这么多轮，静态门与像素门全绿，
  // 因为跨包类名普查只比包与包，宿主不在射程里（那条普查的修法见台账 #170）。两个方向都判：
  //   借名 —— 类名只有包 CSS 定义：宿主的元素靠别人的规则活，那个包改样式它就变脸，没人拦；
  //   两家 —— 同一类名宿主 CSS 与包 CSS 都定义：改一处漏一处，而且谁生效由引入顺序决定。
  // CSS 注释里的名字不算——第一版就被 ui-primitives 的一句注释（「组是 .app__secs 的子项」）骗过一次。
  const classesIn = (txt) => {
    const out = new Set()
    for (const m of txt.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) out.add(m[1])
    return out
  }
  const hostCss = new Set()
  const hostCssFiles = []
  const walkCss = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walkCss(p)
      else if (e.name.endsWith('.css')) hostCssFiles.push(p)
    }
  }
  walkCss(join(clientRoot, 'apps/web/src'))
  for (const f of hostCssFiles) for (const c of classesIn(readFileSync(f, 'utf8'))) hostCss.add(c)
  const pkgCss = new Map()
  for (const p of Object.keys(all)) {
    const dir = join(pkgRoot, p, 'src')
    if (!existsSync(dir)) continue
    for (const e of readdirSync(dir)) {
      if (!e.endsWith('.css')) continue
      for (const c of classesIn(readFileSync(join(dir, e), 'utf8'))) (pkgCss.get(c) ?? pkgCss.set(c, []).get(c)).push(p)
    }
  }
  const classify = (tok, pkgMap, hostSet) => {
    const inPkg = pkgMap.get(tok)
    if (!inPkg) return null
    return hostSet.has(tok) ? 'two-homes' : 'borrow'
  }
  const hostDir = join(clientRoot, 'apps/web/src')
  const hostTsx = readdirSync(hostDir).filter((f) => f.endsWith('.tsx'))
  const hits = { borrow: [], 'two-homes': [] }
  let hostTokens = 0
  for (const f of hostTsx) {
    const src = readFileSync(join(hostDir, f), 'utf8')
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\}|\{"([^"]*)"\})/g)) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').replace(/\$\{[^}]*\}/g, ' ')
      for (const tok of raw.split(/[\s,]+/)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(tok)) continue
        hostTokens += 1
        const kind = classify(tok, pkgCss, hostCss)
        if (kind) hits[kind].push(`${f} 用 .${tok}（${kind === 'borrow'
          ? '只有 ' + pkgCss.get(tok).join('/') + ' 的 CSS 定义'
          : '包 CSS 与宿主 CSS 各定义一次：' + pkgCss.get(tok).join('/')}）`)
      }
    }
  }
  // 正控：分类器本身要能各认出一种，而且"宿主自己的类名"与"包里没有的名字"都不许误报——
  // 否则"零处交叉"可能只是它瞎了。喂的是合成表，不动上面那两张真表。
  const fxPkg = new Map([['set__close', ['ui-settings']], ['app__secs', ['ui-chat']]])
  const fxHost = new Set(['app__secs', 'app__rail'])
  const fxBorrow = classify('set__close', fxPkg, fxHost) === 'borrow'
  const fxTwo = classify('app__secs', fxPkg, fxHost) === 'two-homes'
  const fxOwn = classify('app__rail', fxPkg, fxHost) === null
  const fxMiss = classify('wb__line', fxPkg, fxHost) === null
  record('类名归属', '宿主不借用包的 CSS 类名，也不与包同名两家（§4.2 每包一套样式）',
    hostTokens > 0 && pkgCss.size >= 50 && hits.borrow.length === 0 && hits['two-homes'].length === 0
      && fxBorrow && fxTwo && fxOwn && fxMiss,
    hostTokens === 0
      ? '一个宿主 className token 都没扫到——面或形状识别坏了，这条绿不算'
      : !fxBorrow || !fxTwo || !fxOwn || !fxMiss
        ? `分类器自证失败（借名要认=${fxBorrow} 两家要认=${fxTwo} 宿主自己的不许认=${fxOwn} 包里没有的不许认=${fxMiss}）`
        : [...hits.borrow, ...hits['two-homes']].join(' ｜ ')
          || `零处交叉（扫了 ${hostTsx.length} 份宿主 tsx 的 ${hostTokens} 个 className token、宿主 CSS 的 ${hostCss.size} 个类名、包 CSS 的 ${pkgCss.size} 个）`
  )
}

// ------------------------------------------------- 门自己的 DOM 锚点也不许是悬空类名
{
  // 上一条管"宿主借用包的类名"，这一条管**反方向**：门与验法按类名找元素（`querySelector('.x__y')`），
  // 类名一旦被改名或删掉，锚点不会报错——它只会"找不到"，而"找不到"在很多判定里长成的是绿
  // （`present:false` 那一支），有的才是红。上一轮那颗 ✕ 就是活例：`check-live-geometry.mjs` 一度
  // 写着 `.app__panel-head .set__close`，也就是说**门的一个锚点挂在别的包的样式名上**。
  // 面是派生的：所有 scripts/ 下的 .mjs/.ts 里的 querySelector 字面量 × 产品源码（宿主 + 每个包的 src）。
  // id 锚点（`#probe-*`，探针页自己造的容器）不在射程里——它们本来就是测试侧的名字，不是产品类名。
  const walk = (dir, re, out = []) => {
    if (!existsSync(dir)) return out
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, re, out)
      else if (re.test(e.name)) out.push(p)
    }
    return out
  }
  const gateFiles = walk(join(clientRoot, 'scripts'), /\.(mjs|ts)$/)
  const productFiles = [
    ...walk(join(clientRoot, 'apps', 'web', 'src'), /\.(ts|tsx|css|html)$/),
    ...Object.keys(all).flatMap((p) => walk(join(pkgRoot, p, 'src'), /\.(ts|tsx|css)$/)),
  ]
  const productText = productFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
  const seen = new Map()
  for (const f of gateFiles) {
    // 注释里的例子不算锚点：这条判定上线第一秒就把自己的注释抓成了红（"querySelector('.x__y')" 那种写法）。
    // 整行注释与块注释都剥掉；行尾注释里再写一个 querySelector 字面量仍会被抓——那属于"注释写得像代码"，
    // 真出现了改注释比改判据划算。
    const lines = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
      .split(/\r?\n/)
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const m of line.matchAll(/querySelector(?:All)?\(\s*[`'"]([^`'"]+)[`'"]/g)) {
        for (const c of m[1].matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) {
          if (!seen.has(c[1])) seen.set(c[1], `${f.slice(clientRoot.length + 1).replace(/\\/g, '/')}:${i + 1}`)
        }
      }
    })
  }
  const dangling = [...seen.entries()].filter(([tok]) => !productText.includes(tok))
  record('类名归属', '门与验法按类名找元素时，那个类名在产品源码里仍找得到',
    seen.size >= 20 && dangling.length === 0,
    seen.size < 20
      ? `只派生出 ${seen.size} 个类名锚点——扫描面或形状识别坏了，这条绿不算`
      : dangling.length > 0
        ? dangling.map(([tok, where]) => `.${tok}（${where} 找它，产品源码里已没有这个名字）`).join(' ｜ ')
        : `${seen.size} 个类名锚点全部在场（门与验法共 ${gateFiles.length} 份文件，产品源码 ${productFiles.length} 份）`)
}

// ---------------------------------------------------------------- report
const fails = results.filter((r) => !r.ok)
if (!quiet) {
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} [${r.group}][${r.kind}] ${r.label}${r.note ? ` — ${r.note}` : ''}`)
  console.log(`\n${results.length} 条分层判定，扫了 ${Object.keys(all).length + 1} 个源码包/宿主`)
}
if (fails.length > 0) {
  console.error('\nFAILED (分层塌了):')
  for (const f of fails) console.error(`  ✗ [${f.group}] ${f.label} — ${f.note}`)
  process.exit(1)
}
