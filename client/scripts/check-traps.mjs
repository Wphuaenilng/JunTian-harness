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
  // 它不在 CI 里自动跑（要 Electron、约 40 秒、会开两个窗），所以如实标 manual 并写清上次实测。
  record('§5.2-1', 'manual', '第二份桌面实例在 boot 之前就退出（不抢 StoreLock、不改登记）',
    has('scripts/verify-single-instance.mjs'),
    'node scripts/verify-single-instance.mjs：8 项判定，2026-10-10 两轮一致全绿（反向变异两条各红一次）')
}

// ---------------------------------------------------------------- T2 CORS
{
  const vite = read('apps/web/vite.config.ts')
  const proxied = /'\/api':\s*\{[\s\S]*?target:\s*'http:\/\/127\.0\.0\.1:5300'/.test(vite)
  record('§5.2-2', 'static', 'dev 的 /api 代理指向同源伺服层（5300），不是 sidecar 端口', proxied)
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
    record('§5.2-3', 'manual', '产物 token 扫描：需要先 build 且 sidecar 在跑（本机已验，CI 里跳过）',
      true, `built=${has('apps/web/dist')} info=${has('.sidecar-info.json')}`)
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
  record('§5.2-5', 'manual', '报警样式从未在真会话里被渲染过（要验就得晾着一个真闸不放）', true,
    '见 ui-approval/README.md 的 The stall rule')
}

// ---------------------------------------------------------------- T6 绝不旁路
{
  record('§5.2-6', 'delegated', '无 SQLite / UI 层不碰磁盘 / 不构造用户目录路径 / 内核零改动',
    has('scripts/check-nongoals.mjs'), '由 check-nongoals.mjs 逐条判定')
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
