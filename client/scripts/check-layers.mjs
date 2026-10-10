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

// ---------------------------------------------------------------- 面板不许碰视图 store
{
  const bad = []
  for (const p of PANELS) for (const { file, spec } of all[p] ?? []) if (tianshu(spec) === 'store') bad.push(`${file} → store`)
  record('§4.3 #4', '业务面板不读全局 store（视图状态属于宿主，面板只吃 props）', bad.length === 0, bad.join(' ; '))
}

// ---------------------------------------------------------------- 委托给别的门，点名
{
  const others = ['scripts/check-nongoals.mjs', 'scripts/protocol-ledger.mjs', 'scripts/check-theme.mjs']
  record('委托', '磁盘/进程/SQLite/用户目录、端点台账、主题链路各由点名的门判定', others.every((p) => existsSync(join(clientRoot, p))), others.join(' + '))
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
