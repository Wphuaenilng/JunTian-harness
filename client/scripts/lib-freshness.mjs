/**
 * 产物新鲜度的唯一实现。谁读 `apps/web/dist`，谁就该先问这一句。
 *
 * 起因是一次**自己对自己**的抓包：`ui-approval` 源码改完之后 dist 还是改之前打的，而台账写着
 * "桌面三条验法在当前产物上重跑"——那一行当下不真。像素门读的是被伺服的 bundle，桌面验法也是
 * （壳 `loadURL` 的就是那台伺服），所以两边共用这条判据，别再各写一份、各漂移一次。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 扫描面从目录派生，**不写包名清单**：写死的清单在第 13 个包出现时会静默漏扫，
 * 而这条判据的全部价值就在于"没有源码被漏掉"。没有 `src/` 的包自动跳过。
 */
function sourceDirs(clientRoot) {
  const pkgRoot = join(clientRoot, 'packages')
  const pkgs = existsSync(pkgRoot)
    ? readdirSync(pkgRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(pkgRoot, e.name, 'src'))).map((e) => join(pkgRoot, e.name, 'src'))
    : []
  return [join(clientRoot, 'apps', 'web', 'src'), ...pkgs]
}

function newestUnder(dir, re) {
  let best = { ms: -1, file: '' }
  if (!existsSync(dir)) return best
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { const inner = newestUnder(p, re); if (inner.ms > best.ms) best = inner; continue }
    if (!re.test(e.name)) continue
    const ms = statSync(p).mtimeMs
    if (ms > best.ms) best = { ms, file: p }
  }
  return best
}

/**
 * @param clientRoot client 仓根（`apps/` 与 `packages/` 的父目录）
 * @returns {{ok:boolean, message:string, srcNewest:{ms:number,file:string}, distNewest:{ms:number,file:string}}}
 *   `ok:false` 的两种形状：源码比产物新（证据过期），或者干脆没有产物（没得可验）。
 */
export function bundleFreshness(clientRoot) {
  const dirs = sourceDirs(clientRoot)
  let src = { ms: -1, file: '' }
  for (const d of dirs) { const n = newestUnder(d, /\.(ts|tsx|css|html)$/); if (n.ms > src.ms) src = n }
  const dist = newestUnder(join(clientRoot, 'apps', 'web', 'dist'), /\.(js|css|html)$/)
  const rel = (f) => f.slice(clientRoot.length + 1)
  if (dist.ms < 0) {
    return { ok: false, srcNewest: src, distNewest: dist, message: '没有 apps/web/dist —— 先 corepack pnpm build，没有产物就没有"读被伺服的界面"这回事' }
  }
  if (src.ms > dist.ms) {
    return { ok: false, srcNewest: src, distNewest: dist, message: `源码比产物新（${rel(src.file)} 晚于 ${rel(dist.file)}）——这不是产品漂移，是证据过期：重打再验` }
  }
  return { ok: true, srcNewest: src, distNewest: dist, message: `产物不早于源码（dist 最新 ${rel(dist.file)}）` }
}

/**
 * 内核侧的同一句话：`node dist/cli/entry.js` 是 sidecar 真跑起来的那份产物，而冒烟阶段测的是
 * **它的行为**——内核源码比它新时，红的那行描述的是一份已经不存在的实现。
 * 三种面貌如实分开：`ok` / `stale` / `absent`，**"没得比"不许读成通过**（同一条门的旧教训）。
 * 面从 `<repoRoot>/src` 递归派生（`.ts`），不写文件清单；比的是 `dist/cli/entry.js` 的 mtime——
 * `npm run build:bundle` 每次都重写它，所以"entry 不早于任何源码"恰好等价于"最后一次构建之后没改过源码"。
 */
export function kernelSidecarFreshness(repoRoot) {
  const srcDir = join(repoRoot, 'src')
  const entry = join(repoRoot, 'dist', 'cli', 'entry.js')
  const rel = (f) => f.slice(repoRoot.length + 1)
  const src = newestUnder(srcDir, /\.ts$/)
  const entryMs = existsSync(entry) ? statSync(entry).mtimeMs : -1
  if (src.ms < 0 && entryMs < 0) {
    return { status: 'absent', srcNewestMs: -1, entryMs, message: `这里既没有 src/ 也没有 dist/cli/entry.js（${rel(srcDir)} 与 ${rel(entry)}）——内核树不在旁边时这条冒烟本来就无从谈起，不能把它读成通过` }
  }
  if (entryMs < 0) {
    return { status: 'absent', srcNewestMs: src.ms, entryMs, message: '没有 dist/cli/entry.js（内核还没构建）——先 npm run build:bundle，没有产物就没有"冒烟测的是当前内核"这回事' }
  }
  if (src.ms > entryMs) {
    return { status: 'stale', srcNewestMs: src.ms, entryMs, message: `内核源码比 sidecar 产物新（${rel(src.file)} 晚于 ${rel(entry)}）——这不是客户端缺陷，是证据过期：重打 build:bundle 再验` }
  }
  return { status: 'ok', srcNewestMs: src.ms, entryMs, message: `sidecar 产物不早于内核源码（entry ${rel(entry)}）` }
}
