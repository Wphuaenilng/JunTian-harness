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
// 暗色那张 ramp 的唯一持数处（同一份 lib 也供 AA 门与像素门的配对普查用）——这里要知道
// "哪枚色族成员在暗色块里没被覆写"，不自己抄一份 token 名单。
import { dark } from './lib-contrast.mjs'
import { stripComments, parseCssFiles, COLORISH_PROP } from './lib-css-rules.mjs'
import { NON_DARK_ADAPTED_ENTRIES } from './lib-dark-exceptions.mjs'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const quiet = process.argv.includes('--quiet')

const failures = []
const check = (label, ok, detail = '') => {
  if (!quiet || !ok) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 去注释 = 共用件那份（逐字搬迁，不是重写）：TS 源扫与 CSS 规则扫必须看见同一份"注释已挖空"的文本。
const strip = stripComments

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

// 5a. 裁定 ③（2026-10-12）：破坏性 `rollback` 这一轮不接。这条以前只是"没人调用"——而"没人调用"
//     和"钉住了"是两句话（交接表第 5 条自己纠正过我这句话写错了）。现在真钉：shipped 源码里不许
//     出现打向那条路由的路径形状。它的合法邻居是只读的 `/rollback/preview`（`rollbackPreview()`），
//     所以判据写成"`/rollback` 后面不跟 `/preview`"。三条合成正控各绑一个形状：破坏性写法必须被抓到、
//     preview 与 `git.rollbackFiles` 那个键名必须不被抓到——否则这条绿只是正则失效。
const ROLLBACK_RE = /\/rollback(?!\/preview)/
const rollbackSites = shipped.filter((f) => ROLLBACK_RE.test(strip(readFileSync(f, 'utf8'))))
const RB_SHAPE = [
  { s: "'/sessions/x/rollback'", hit: true },
  { s: "'/sessions/x/rollback/preview'", hit: false },
  { s: "'git.rollbackFiles'", hit: false },
]
const rbBadShape = RB_SHAPE.filter((c) => ROLLBACK_RE.test(c.s) !== c.hit)
  .map((c) => `${c.s} 应为${c.hit ? '命中' : '不命中'}`)
check('裁定 ③ 已钉住：破坏性 POST /sessions/:id/rollback 在 shipped 源码里零路径形状（含只读邻居的三条形状正控）',
  rollbackSites.length === 0 && rbBadShape.length === 0,
  rbBadShape.length > 0 ? `判据形状失效，其余读数不作数：${rbBadShape.join(' | ')}`
    : rollbackSites.length > 0 ? `产品面出现了回滚调用点：${rollbackSites.map((f) => relative(clientRoot, f)).slice(0, 3).join(' ')}`
    : '零命中；客户端连 `rollback()` 这个方法都没有（内核那条路由在 src/server/session-routes.ts）')

// 5b. 产品 CSS 的颜色必须走 token——存量按**棘轮**登记，只许减不许增。
//     补这条的理由在像素门那边：那条「每个前景都能在 ramp 里找到出处」是**值相等**判据，`color:#fff`
//     与 `--nb-00` 同值，所以它照绿——门说得出的只有"找不到 ⇒ 硬编码"，反过来不成立。这里从源码这一侧
//     补上能看见字面量的那半边。`tokens.css` 是定义处，不在面内。**已知覆盖不到**：颜色关键字
//     （`white`、`red` 这类）与 `currentColor`，那条形状不在这条正则的面上，如实记着。
const COLOR_RE = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b|\brgba?\(|\bhsla?\(/
const cssFiles = [...sources(join(clientRoot, 'packages'), /\.css$/), ...sources(join(clientRoot, 'apps'), /\.css$/)]
  .filter((f) => !f.endsWith('tokens.css'))
const colorLiterals = []
for (const f of cssFiles) {
  strip(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
    if (COLOR_RE.test(line)) colorLiterals.push(`${relative(clientRoot, f)}:${i + 1}`)
  })
}
const COLOR_LITERAL_MAX = 0
// 上限**等于**现存量，而不是"不超过"：单向棘轮在有人清掉一处之后会把上限留在原处，下一次新加一处
// 就又绿了——债在悄悄回到起点。等于号让"变多"和"变少"都必须回来改这个数，改的时候顺带看一眼清单。
const colorDelta = colorLiterals.length - COLOR_LITERAL_MAX
check('产品 CSS 的颜色字面量存量与登记上限一致（变多变少都要回来改数）',
  colorDelta === 0,
  colorLiterals.length === COLOR_LITERAL_MAX
    ? `实测 ${colorLiterals.length} 处（清单：${colorLiterals.join(' ')}）`
    : `${colorDelta > 0 ? `新增 ${colorDelta} 处（不许）` : `清掉 ${-colorDelta} 处——把 COLOR_LITERAL_MAX 收到 ${colorLiterals.length}`}；实测 ${colorLiterals.length} 处：${colorLiterals.join(' ')}`)
// 正控一：判据的**形状**——命中组含下边界（3 位 hex、rgba 函数），负控组含紧邻的合法值（token 引用、
// `#root` 这种非十六进制的 id）。缺了这一条，正则被改宽时门只会更绿。
const SHAPE = [
  { s: 'color: #fff', hit: true },
  { s: 'background: rgba(34, 197, 94, .10)', hit: true },
  { s: 'color: var(--nb-00)', hit: false },
  { s: 'border: 1px solid #root', hit: false },
]
const shapeBad = SHAPE.filter((c) => COLOR_RE.test(c.s) !== c.hit).map((c) => `${c.s} 应为${c.hit ? '命中' : '不命中'}`)
check('颜色字面量判据的形状自证（含紧邻的合法值）', shapeBad.length === 0, shapeBad.join(' | '))
// 正控二：**扫描面**——面从目录派生，CSS 份数掉下已知下限就是"没在读东西"，而 tokens.css 必须在派生
// 结果里出现过（它被排除是因为它是定义处，不是因为没扫到它）。
const allCss = [...sources(join(clientRoot, 'packages'), /\.css$/), ...sources(join(clientRoot, 'apps'), /\.css$/)]
check('颜色扫描面真在读 CSS（份数派生自目录 + tokens.css 确实在面上被排除）',
  cssFiles.length >= 8 && allCss.some((f) => f.endsWith('tokens.css')),
  `面内 ${cssFiles.length} 份（派生共 ${allCss.length} 份，排除 tokens.css）`)

// 5c. **暗色不跟随的颜色**——像素门结构上测不到的那一族。
//     门只能量"页面上真画出来的东西"，而选中行 / 悬停 / 错误横幅这些状态没有夹具就不会出现
//     （2026-10-12 就是静态扫才发现 `.us__row--sel` 用的是 `--ds-100`：暗色块没覆写它，
//     `--label-primary` 压上去算出来 1.07:1）。所以这一半从 CSS 源码这侧钉：
//     组件 CSS 里凡把**暗色块没有覆写的色族 / 灰阶成员**（`--nb-*` / `--ds-*`）用作颜色，
//     每一处都必须在理由表里逐名登记；表与实测集**双向相等**（多出没记的红、记了但已消失的红）。
//     理由表本身住在共用件 `lib-dark-exceptions.mjs`：像素门要拿同一张表去浏览器里读 computed 值，
//     抄一份就是两个家——改一处漏一处，而这两处问的本来是同一批选择器。
const NON_DARK_ADAPTED = new Map(NON_DARK_ADAPTED_ENTRIES)
const rampToken = /var\((--(?:nb|ds)-[a-z0-9-]+)\)/g
const observedRamp = new Set()
// 解析走共用件 lib-css-rules：同一份产品 CSS，check-contrast 那边要问的是另一半（字面色 × token 色
// 真实叠在一起的配对）。两扇门各写一份 CSS 解析，就等于允许其中一份对错。
for (const { selector, decls } of parseCssFiles(cssFiles)) {
  for (const decl of decls) {
    if (!COLORISH_PROP.test(decl.prop)) continue
    for (const tok of String(decl.value).matchAll(rampToken)) {
      const name = tok[1]
      if (!name || name in dark) continue // 暗色覆写过的会跟随主题，不在这一族
      observedRamp.add(`${selector} ${name}`)
    }
  }
}
// 面自证：解析坏掉时 observedRamp 会塌成空集，那比"少一条"更危险（门会假装安静）。
// 这三个站点是 2026-10-12 之后仍然存在的：品牌块底、近黑主按钮，外加**逗号组规则的第二段选择器**
// （`.app__dot--connecting` 与 `.app__dot--replay` 同住一条规则——共用件曾只取每组第一段，于是这类
//   站点整族失踪，把它钉成金丝雀是防同一种解析退化再犯）。认不出它们就是扫描面坏了。
// （上一版钉的是 `.us__row--sel --ds-100` 与 `.us__proj-count --nb-100`——那两处已随裁定 ①
//   改成 `--bg-selected` / `--bg-inline-code`，金丝雀因此当场红了一次，这就是它该有的行为。）
const RAMP_CANARIES = ['.us__mark --ds-500', '.us__new --nb-1000', '.app__dot--connecting --ds-400']
const canaryMissing = RAMP_CANARIES.filter((c) => !observedRamp.has(c))
const unlisted = [...observedRamp].filter((k) => !NON_DARK_ADAPTED.has(k)).sort()
const stale = [...NON_DARK_ADAPTED.keys()].filter((k) => !observedRamp.has(k)).sort()
check('暗色不跟随的色族/灰阶用法逐处登记理由（实测集与理由表双向相等）',
  unlisted.length === 0 && stale.length === 0 && canaryMissing.length === 0,
  canaryMissing.length > 0
    ? `扫描面认不出已知站点（${canaryMissing.join(' / ')}），解析面坏了，其余读数不作数`
    : `实测 ${observedRamp.size} 处；未登记 ${unlisted.length}：${unlisted.join(' | ')}；已消失仍挂着 ${stale.length}：${stale.join(' | ')}`)

// 上面那条修掉的是"逗号组的第二段"，这条守着剩下那一半**形状**：`rulesOf` 的选择器字符类排掉了换行，
// 所以跨行的选择器组会被解析成"只剩最后一段"——前一段整条从两张门的面上消失，而且比修掉那种
// 更安静（连第一段的读数都没了）。产品 CSS 今天没有这种写法，这条判据量的就是"没有"；一旦有人写出这种
// 头就红并报 file:line，改法是把选择器写成一行（或扩解析，并同步改共用件文件头那段文档）。
const headerSpan = []
for (const f of cssFiles) {
  const text = stripComments(readFileSync(f, 'utf8'))
  for (const m of text.matchAll(/,[^\S\n]*\n[^\S\n]*[^{}\n]*\{/g)) {
    headerSpan.push(`${relative(clientRoot, f).replace(/\\/g, '/')}:${text.slice(0, m.index).split('\n').length}`)
  }
}
check('产品 CSS 没有跨行选择器组（共用件的解析只认写在一行里的规则头）', headerSpan.length === 0,
  headerSpan.length > 0
    ? `这些行开头的选择器头跨到下一行，解析面只会读到最后一段：${headerSpan.join(' | ')}`
    : `扫了 ${cssFiles.length} 份产品 CSS，0 处跨行规则头`)

// 第三条形状守卫，问的是**属性名**那一侧：上面那条登记判定只认 `COLORISH_PROP` 列出的那几个属性，
// 所以"还有别的属性在涂色"这件事它结构上看不见——侧边简写（`border-left:` 这种）就在射程外。
// 这条反过来问：产品 CSS 里凡值带 `--nb-* / --ds-*` 成员的声明，它的属性名必须在谓词里；冒出新属性就红
// 并逐名打印（附一处样例选择器与文件）。这样"扩谓词"变成一个有理由、有读数的动作，而不是一次遗忘。
const propOutsideFace = new Map()
for (const { selector, decls, file } of parseCssFiles(cssFiles)) {
  for (const d of decls) {
    if (!/var\(--(?:nb|ds)-[a-z0-9-]+\)/.test(String(d.value))) continue
    if (COLORISH_PROP.test(d.prop)) continue
    if (!propOutsideFace.has(d.prop)) {
      propOutsideFace.set(d.prop, `${d.prop}（例：${selector} @ ${relative(clientRoot, file).replace(/\\/g, '/')}）`)
    }
  }
}
check('涂色属性谓词覆盖到产品 CSS 里真在用色族成员的每一个属性', propOutsideFace.size === 0,
  propOutsideFace.size > 0
    ? `这些属性在拿 --nb-*/--ds-* 涂色，却不在 COLORISH_PROP 的射程里（登记判定对它们全盲）：${[...propOutsideFace.values()].join(' | ')}`
    : `用到的属性全在谓词里（面内 ${cssFiles.length} 份 CSS）`)

// 5d. 计划 §8「技术选型定案」的八行里，能机械化核对的那几行钉在这里。
//     动机与最下面那条"证据面每台都有人跑"同一个形状：这一族选型以前**只写在计划里**——换一套依赖（最省事的
//     就是顺手加一个组件库，而 §8 明写「禁组件库」）不需要动任何门，界面照跑、类型照过。
//     现在：面从清单目录派生、名册每条必须写出它在 §8 的哪一行；多一个包红、少一个包也红。
{
  const manifests = [clientRoot, ...
    readdirSync(join(clientRoot, 'packages')).map((d) => join(clientRoot, 'packages', d)),
    ...readdirSync(join(clientRoot, 'apps')).map((d) => join(clientRoot, 'apps', d))]
    .map((d) => join(d, 'package.json')).filter((f) => existsSync(f))
  const STACK_ROSTER = {
    react: 'UI 行：React 18 + 禁组件库（peer 与 app-web 各挂一份）',
    'react-dom': 'UI 行',
    '@types/react': '语言行的类型面',
    '@types/react-dom': '语言行的类型面',
    zustand: '状态行：zustand/vanilla',
    immer: '状态行：immer',
    micromark: 'markdown 行：块级增量解析（性能那半由 #104 的门钉）',
    shiki: '高亮行（渲染面由第六个探针页量）',
    vite: '构建行：唯一产物来自 app-web 的 vite build',
    '@vitejs/plugin-react': '构建行的 Vite 侧 React 插件',
    electron: '桌面壳行（devDependency；ABI 那条坑见 verify-desktop）',
    typescript: '语言行：TypeScript strict + 全 ESM',
  }
  const isRegistered = (name) => Object.prototype.hasOwnProperty.call(STACK_ROSTER, name)
  const thirdParty = new Set()
  let esmCount = 0
  for (const f of manifests) {
    const p = JSON.parse(readFileSync(f, 'utf8'))
    if (p.type === 'module') esmCount += 1
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, ver] of Object.entries(p[field] ?? {})) {
        if (String(ver).startsWith('workspace:') || name.startsWith('@tianshu/')) continue
        thirdParty.add(name)
      }
    }
  }
  const deps = [...thirdParty].sort()
  const unregistered = deps.filter((d) => !isRegistered(d))
  const staleRoster = Object.keys(STACK_ROSTER).filter((d) => !thirdParty.has(d))
  // 两条正控绑已知站点：`react` 必须在面内（不在=扫描面塌了），合成包名必须被判"不在名册"
  //（被判在内=名册查询在装绿，"禁组件库"这条就是空的）。
  const canaryIn = isRegistered('react') && deps.includes('react')
  const canaryOut = !isRegistered('zzz-fake-component-kit')
  check(`§8 选型面：三方依赖与名册双向相等（实测 ${deps.length} 个 / 名册 ${Object.keys(STACK_ROSTER).length} 条，多一个少一个都要红）`,
    deps.length >= 10 && unregistered.length === 0 && staleRoster.length === 0 && canaryIn && canaryOut,
    !canaryIn ? '正控失败：`react` 不在派生面里——扫描面塌了，其余读数不作数'
      : !canaryOut ? '正控失败：合成组件库名被名册放行了（"禁组件库"这句是空的）'
      : unregistered.length > 0 ? `名册里没有它的 §8 出处：${unregistered.join(' , ')}`
      : staleRoster.length > 0 ? `名册里这几条已经不在了（选型变了要连表一起改）：${staleRoster.join(' , ')}`
      : `名册每条都写出身在 §8 哪一行：${deps.join(' ')}`)
  // 编译面：这里**没有** tsconfig.base.json（本轮实测才看清），四个开关各自写在两份"管着一次编译入口"的
  // 配置里，而全量档靠 `extends` 继承。所以判据不能钉"某个 base 文件里有"，要钉"每一份自带
  // compilerOptions 的 tsconfig 都得齐"——新加一个包、配一份宽松的 tsconfig 就地红（静默放宽是这条
  // 选型最可能的失守方式）。两份各写一遍是已知形状（与 #78 那个"30 秒阈值两个家"同族），差异由这条判定看着。
  const FLAGS = ['"strict": true', '"exactOptionalPropertyTypes": true', '"noUncheckedIndexedAccess": true', '"verbatimModuleSyntax": true']
  const tsConfigs = [...sources(join(clientRoot, 'packages'), /^tsconfig\.json$/), ...sources(join(clientRoot, 'apps'), /^tsconfig\.json$/)]
    .filter((f) => readFileSync(f, 'utf8').includes('"compilerOptions"'))
  const lax = tsConfigs.filter((f) => { const src = readFileSync(f, 'utf8'); return FLAGS.some((fl) => !src.includes(fl)) })
  const checkCfg = existsSync(join(clientRoot, 'apps', 'web', 'tsconfig.check.json'))
    ? readFileSync(join(clientRoot, 'apps', 'web', 'tsconfig.check.json'), 'utf8') : ''
  const inherits = checkCfg.includes('"extends": "./tsconfig.json"')
  check(`§8 语言行：全 ESM（${esmCount}/${manifests.length} 份清单 type=module）+ 每份自带 compilerOptions 的 tsconfig 四个开关齐（现 ${tsConfigs.length} 份）+ 全量档靠 extends 继承`,
    esmCount === manifests.length && manifests.length >= 14 && tsConfigs.length >= 2 && lax.length === 0 && inherits,
    esmCount !== manifests.length ? `有清单不是 ESM：${esmCount}/${manifests.length}`
      : tsConfigs.length < 2 ? `只认到 ${tsConfigs.length} 份编译配置——扫描面或目录变了`
      : lax.length > 0 ? `这些配置缺开关：${lax.map((f) => relative(clientRoot, f)).join(' , ')}`
      : !inherits ? 'tsconfig.check.json 不再 extends 那份配置：类型全量档与产品编译面可能两套口径' : `开关齐：${FLAGS.join(' , ')}`)
  // 组件库的"痕迹"两面都扫：清单里没挂（上面那条已覆盖）+ 源码里不许 import 它们。
  const LIB_RE = /@mui\/|from ['"]antd|@radix-ui\/|headlessui|tailwindcss|from ['"]@chakra/
  const libSites = shipped.filter((f) => LIB_RE.test(strip(readFileSync(f, 'utf8'))))
  const LIB_SHAPE = [
    { s: "import { Button } from '@mui/material'", hit: true },
    { s: "import './styles.css'", hit: false },
    { s: "from 'zustand/vanilla'", hit: false },
  ]
  const libBadShape = LIB_SHAPE.filter((c) => LIB_RE.test(c.s) !== c.hit).map((c) => `${c.s} 应为${c.hit ? '命中' : '不命中'}`)
  check('§8「禁组件库」：shipped 源码里组件库 import 痕迹为零（含三条形状正控，防正则自己失效）',
    libSites.length === 0 && libBadShape.length === 0,
    libBadShape.length > 0 ? `判据形状失效：${libBadShape.join(' | ')}`
      : libSites.length > 0 ? `产品面引入了组件库：${libSites.map((f) => relative(clientRoot, f)).slice(0, 3).join(' ')}` : '零命中')
  // §3「ACP 适配层后置，不进本计划主线」此前靠的是**人 grep 了一次**——同族的「禁组件库」有门，这一条没有。
  // 形状照那条抄：0 命中 + 形状正控。正控各防一种自失效：同前缀词（capture / adaptive）不许被当成命中，
  // 而注释里的 "ACP" 被剥掉才算数——文档里谈 ACP 是允许的，**代码**里出现就是改了路线，得先动计划。
  const ACP_RE = /\bacp\b|agent[-_]client[-_]protocol|(?:Acp|ACP)[A-Za-z]/
  const acpSites = shipped.filter((f) => ACP_RE.test(strip(readFileSync(f, 'utf8'))))
  const ACP_SHAPE = [
    { s: 'new ACPAdapter()', hit: true },
    { s: "import { acpClient } from './acp'", hit: true },
    { s: 'const capture = 1; const adaptive = 2', hit: false },
    { s: '// ACP 只是后置，不在主线', hit: false, stripFirst: true },
  ]
  const acpBadShape = ACP_SHAPE
    .filter((c) => ACP_RE.test(c.stripFirst ? strip(c.s) : c.s) !== c.hit)
    .map((c) => `${c.s} 应为${c.hit ? '命中' : '不命中'}`)
  check('§3「ACP 后置」：shipped 源码里 ACP 适配痕迹为零（四条形状正控，防同前缀词与注释剥除自己失效）',
    acpSites.length === 0 && acpBadShape.length === 0,
    acpBadShape.length > 0 ? `判据形状失效：${acpBadShape.join(' | ')}`
      : acpSites.length > 0
        ? `产品面出现了 ACP 适配代码（§3 明写后置；要接就先改计划再动这条门）：${acpSites.map((f) => relative(clientRoot, f)).slice(0, 3).join(' ')}`
        : `零命中（扫了 ${shipped.length} 份 shipped 源码）`)
  // §1「非目标：不引入 dsh 的 Cordis/Typert」这条此前**任何门都没读过**（同族的「禁组件库」「ACP 后置」
  // 各有一条 0 命中判据）。名字不写死在门里——那会把计划正文变成第二份事实源：名字从「非目标」那一行
  // parse 出来再拿去扫，正文改掉说法（换一个组件名）时这一条会先要求登记表/解析跟上。
  // 注释里的提及不算命中：文档里谈 dsh 的那套东西是允许的，**代码**里出现才是真引入了它。
  const planDoc = resolve(repoRoot, 'analysis-reports', '定稿-天枢客户端方案', '天枢Web桌面客户端自研计划-v2.0.md')
  const banNames = (item) => [...new Set(item.match(/\b[A-Z][A-Za-z]+\b/g) ?? [])]
  const BAN_SHAPE = [
    { s: '不引入 dsh 的 Cordis/Typert', want: ['Cordis', 'Typert'] },
    { s: '不引入 foo 的 Bar/Baz/Qux', want: ['Bar', 'Baz', 'Qux'] },
    { s: '不修改天枢内核与 sidecar 源码', want: [] },
  ]
  const banBadShape = BAN_SHAPE
    .filter((c) => JSON.stringify(banNames(c.s)) !== JSON.stringify(c.want))
    .map((c) => `「${c.s}」应认出 ${JSON.stringify(c.want)}，实数 ${JSON.stringify(banNames(c.s))}`)
  // 命中谓词自己也要有正控：超集标识符（`CordisClient`）必须算命中（同族里 `\b` 漏检咬过一次），
  // 小写的近似词不算，注释里提到的不算（文档可以谈它，代码里出现才是真引入）。
  const hitRe = (n) => new RegExp(`\\b${n}\\b|${n}[A-Za-z]`)
  const HIT_SHAPE = [
    { s: "import { CordisClient } from 'cordis'", want: true },
    { s: 'const cordial = 1', want: false },
    { s: '// Typert 只是登记在正文里', want: false, stripFirst: true },
  ]
  const hitBadShape = HIT_SHAPE
    .filter((c) => ['Cordis', 'Typert'].some((n) => hitRe(n).test(c.stripFirst ? strip(c.s) : c.s)) !== c.want)
    .map((c) => `「${c.s}」应为${c.want ? '命中' : '不命中'}`)
  check(`§1「不引入」名单的形状自证（名单 ${BAN_SHAPE.length} 条 + 命中谓词 ${HIT_SHAPE.length} 条：超集标识符算命中、近似小写词不算、注释里的不算）`,
    banBadShape.length === 0 && hitBadShape.length === 0,
    [...banBadShape, ...hitBadShape].join(' | ') || '两组夹具各认对一次')
  if (!existsSync(planDoc)) {
    check('§1「不引入」那半句在盘上（名单判据的前提）', false,
      `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const ngLine = readFileSync(planDoc, 'utf8').split('\n').find((l) => l.includes('**非目标**'))
    const ngItem = ngLine === undefined ? undefined
      : ngLine.replace(/^\*\*非目标\*\*：/, '').split('；').find((s) => s.includes('不引入'))
    const names = ngItem === undefined ? [] : banNames(ngItem)
    if (names.length === 0) {
      check('§1「不引入」的组件名从正文 parse 出来（正文是唯一持数处）', false,
        ngLine === undefined ? '正文里没有「**非目标**」那一行'
          : ngItem === undefined ? '「非目标」那一行里没有了「不引入」那条（说法改了，这条判据要跟着改）'
            : '「不引入」那条里认不出任何英文组件名（少于 1 个说明解析坏了，绿不算数）')
    } else {
      const banSites = shipped.filter((f) => {
        const text = strip(readFileSync(f, 'utf8'))
        return names.some((n) => hitRe(n).test(text))
      })
      check(`§1「不引入」：计划点名的组件（${names.join(' / ')}）在 shipped 源码里以标识符形状零命中`,
        banSites.length === 0 && banBadShape.length === 0 && hitBadShape.length === 0,
        banBadShape.length + hitBadShape.length > 0 ? '名单解析或命中谓词的形状自证没过（上一条已点名），这一条的比较不作数'
          : banSites.length > 0
            ? `产品面出现了它的痕迹（§1 明写不引入；要改路线先改计划）：${banSites.map((f) => relative(clientRoot, f)).slice(0, 3).join(' ')}`
            : `零命中（${names.length} 个名字 × ${shipped.length} 份 shipped 源码，注释已剥）`)
    }
  }
  // 两条**偏差**如实登记（不是红，但也不能不说）：§8 写了 tsdown 与 CSS Modules，树里都是 0。
  const buildScripts = manifests.map((f) => {
    const p = JSON.parse(readFileSync(f, 'utf8'))
    return { name: String(p.name ?? f), build: String(p.scripts?.build ?? '') }
  }).filter((x) => x.build && !x.build.includes('-r build'))
  const cssModule = sources(join(clientRoot, 'packages'), /\.module\.css$/).length
    + sources(join(clientRoot, 'apps'), /\.module\.css$/).length
  const plainCss = sources(join(clientRoot, 'packages'), /\.css$/).length + sources(join(clientRoot, 'apps'), /\.css$/).length
  check(`§8 两处选型未采用，实数登记：tsdown 0 处（唯一产物脚本=${buildScripts.length} 份：${buildScripts.map((b) => b.name).join(',')}）；CSS Modules ${cssModule} 处、普通 CSS ${plainCss} 份（面板走 styles.css + 前缀类名 + token，不是 *.module.css）`,
    buildScripts.length === 1 && cssModule === 0 && plainCss >= 8,
    buildScripts.length !== 1
      ? `build 脚本数变了（${buildScripts.length}）：要么补齐包级产物、要么把 §8 那一行改掉，别留两处各说各话`
      : `语言/样式机制与 §8 措辞的差：CSS Modules=${cssModule}（0 才算登记过），普通 CSS=${plainCss} 份由 check:mockup / check:scale / check:contrast 逐值管`)
}

// 6. 可被提交的工作树里不许出现密钥形状。`git add client/...` 是下一次提交，而 AGENTS.md 的铁律是
//    「敏感文件禁止提交」。既有门只查**构建产物**里没有 token；探针与验法会往 state 目录写真的
//    `.sidecar-info.json`（里面就是 bearer token），今天它们恰好被 .gitignore 罩着——"恰好罩着"不是保证，
//    所以这里逐个数：未跟踪 + 已改的文本文件，凡是"密钥类键名 + 24 字符以上的值"这种形状就红。
{
  const SECRET_RE = /(RIVET_SERVER_TOKEN|apiKey|api_key|clientSecret|bearer[\s_]*token)[\s"'`:=]{0,6}([A-Za-z0-9_\-]{24,})/i
  const CRED_SHAPED = /(^|\/)\.?sidecar-info\.json$|(^|\/)\.sidecar-data\/|(^|\/)\.live-geometry\/|(^|\/)\.stall-demo\/|(^|\/)\.ci-smoke\/|\.sidecar\.log$/i

  // 形状自证：这两条正则本身就是判据，被改坏时门不会红、只会安静地永远绿。所以拿**合成值**各咬
  // 一次（真凭据一个字节都不读——读 `.sidecar-info.json` 就等于访问凭据）。边界两头都要有：24 字符
  // 命中、23 字符不命中，否则"恰好宽松"和"恰好失效"长得一模一样。落盘变异（真往工作树写一个带
  // 假 token 的文件）被权限层拦下，没有绕道；这里能证的是判据的形状，不是它读过真文件。
  const SYNTH = 'k'.repeat(48)
  const selfTest = []
  for (const s of [
    `RIVET_SERVER_TOKEN=${SYNTH}`,
    `apiKey: "${'A'.repeat(30)}"`,
    `api_key = ${'x'.repeat(24)}`,
    `clientSecret: '${'B'.repeat(40)}'`,
    `bearer token: ${'c'.repeat(64)}`,
  ]) if (!SECRET_RE.test(s)) selfTest.push(`应命中却没命中：${s.slice(0, 22)}…`)
  for (const s of [`apiKey: 't'`, `api_key=`, `RIVET_SERVER_TOKEN=${'k'.repeat(23)}`, 'bearer'])
    if (SECRET_RE.test(s)) selfTest.push(`短值/裸词被冤枉：${s.slice(0, 22)}…`)
  for (const s of ['client/.sidecar-info.json', '.sidecar-info.json', 'client/.sidecar-data/sess.db',
    'client/.live-geometry/probe.png', 'client/.stall-demo/x', 'client/.ci-smoke/state', 'client/daemon.sidecar.log'])
    if (!CRED_SHAPED.test(s)) selfTest.push(`凭证路径没认出：${s}`)
  // 这两条是历史上真被裸子串冤枉过的合法源码文件，必须留在负控里当墓碑。
  for (const s of ['client/scripts/check-live-geometry.mjs', 'client/scripts/stall-demo.mjs', 'client/README.md'])
    if (CRED_SHAPED.test(s)) selfTest.push(`合法文件被冤枉：${s}`)
  check('两条密钥/凭证判据的形状自证（5 命中 / 4 负控 / 7 路径 / 3 墓碑，全合成值）', selfTest.length === 0, selfTest.slice(0, 3).join(' | '))

  const others = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'client'], { cwd: repoRoot, encoding: 'utf8' })
  const changed = spawnSync('git', ['diff', '--name-only', '-z', '--', 'client'], { cwd: repoRoot, encoding: 'utf8' })
  // `.github/workflows/` 自 2026-10-12 那次授权接线起也是本仓的制品面。上面两条命令的面都从 `client/`
  // 派生，所以「一份含密钥的 workflow YAML」与「提交清单里漏掉那个路径」都会在各自那一边静默全绿。
  // 铁律第 1 条仍然只管**已跟踪**文件：工作树里别人在用的目录（`.rivet/`、`analysis-reports/`）不读。
  const infra = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', '.github'], { cwd: repoRoot, encoding: 'utf8' })
  const infraChanged = spawnSync('git', ['diff', '--name-only', '-z', '--', '.github'], { cwd: repoRoot, encoding: 'utf8' })
  if (others.status !== 0 || changed.status !== 0 || infra.status !== 0 || infraChanged.status !== 0) {
    check('git 能列出 client/ 与 .github/ 的未跟踪与已改文件', false,
      String(others.stderr || changed.stderr || infra.stderr || infraChanged.stderr || '').trim().slice(0, 120))
  } else {
    const nul = (s) => String(s ?? '').split('\0').filter(Boolean)
    const infraListed = [...new Set([...nul(infra.stdout), ...nul(infraChanged.stdout)])]
    const listed = [...new Set([...nul(others.stdout), ...nul(changed.stdout)].map((p) => p.replace(/^client\//, '')))]
    const leaked = []
    let scanned = 0
    // 两条面用各自的家来解析：client/ 下的相对路径拼 clientRoot，`.github/` 下的拼 repoRoot。
    const face = [...listed.map((p) => ({ disp: p, abs: join(clientRoot, p) })),
      ...infraListed.map((p) => ({ disp: p, abs: join(repoRoot, p) }))]
    for (const { disp, abs } of face) {
      if (!/\.(ts|tsx|mjs|cjs|js|json|md|css|html|txt|ya?ml|log|example)$/i.test(disp)) continue
      if (!existsSync(abs)) continue
      let body = ''
      try { body = readFileSync(abs, 'utf8') } catch { continue }
      if (body.length > 400_000) continue
      scanned += 1
      const m = SECRET_RE.exec(body)
      if (m) leaked.push(`${disp} → ${String(m[0]).slice(0, 50)}…`)
    }
    // 正控之二：凭证形状的登记/日志文件**必须**被 .gitignore 罩着。这里只看路径名，永不读内容
    // （读它就等于访问凭据）。形状必须**锚定到目录或登记文件名**——早先用裸子串，把源码文件
    // `check-live-geometry.mjs` 与 `stall-demo.mjs` 都认成了凭证文件，那两条已固化成上面的墓碑负控。
    // 正则只有顶部那一份定义：自证咬的就是扫描用的这个对象，不存在"验的判据≠跑的判据"。
    const unignored = [...new Set([...nul(others.stdout), ...nul(changed.stdout), ...infraListed])]
      .filter((p) => CRED_SHAPED.test(p))
    check(`凭证形状的文件全部被 .gitignore 罩着（只看路径名，未读任何内容）`, unignored.length === 0,
      unignored.length > 0 ? `未被忽略：${unignored.slice(0, 3).join(' , ')}` : '未跟踪清单里没有任何凭证形状的路径')
    // 正控：扫描面必须真的非空（列出 0 个文件时上面两条绿都毫无意义）。
    check(`工作树的未跟踪/已改清单可数（client/ 面 ${listed.length} 项 + .github/ 面 ${infraListed.length} 项，client 侧 >40 才算真扫到东西）`, listed.length > 40, '')
    check(`可提交的工作树里没有密钥形状（未跟踪+已改，实扫 ${scanned} 个文本文件）`,
      leaked.length === 0 && scanned > 40,
      leaked.length > 0 ? leaked.slice(0, 4).join(' | ') : '零命中；state 目录另有 .gitignore 罩着，这条查的是罩子漏了的时候')
    // 台账交给操作者的提交清单从来不是逐文件清单，而是**目录级 pathspec**（README.md / .gitignore /
    // package.json + apps/ packages/ scripts/）。目录级写法省事，代价是：任何**直接躺在 client/ 根下**的新文件
    // 都不在那几条里，会被静默漏出提交——本轮实测就被我自己的一个根下探针命中过一次（91/92）。
    // 2026-10-12 露出同族第二种：交付物整个住在 client/ **之外**（那次授权接线落下的 workflow 文件）。
    // 面从 client/ 派生 ⇒ 清单写得再全也覆盖不到它，"提交了六个路径、CI 其实没接上"这种形状无人报红。
    // 所以这里点名加它，条数从常量派生（不抄），README 那份清单一改这里就会红。
    // .github 那一侧只该有 workflow，正控绑死这个已知站点（同 #119 的面自证做法）：
    // 扫到 0 个文件时上面那条"零命中"的绿毫无意义——文件名或目录形状一改就会静默变空。
    check(`.github 面非空且只有一个 workflow（现 ${infraListed.length} 项，多于 1 项说明有第二份制品）`,
      infraListed.length === 1 && infraListed[0] === '.github/workflows/client-gates.yml',
      `现测：${infraListed.join(' , ') || '空——扫描面塌了，上面那条"零命中"不作数'}`)
    const ADD_NAMED = ['README.md', '.gitignore', 'package.json']
    const ADD_DIRS = ['apps/', 'packages/', 'scripts/']
    const ADD_INFRA = ['.github/workflows/client-gates.yml']
    const PATHSPEC_N = ADD_NAMED.length + ADD_DIRS.length + ADD_INFRA.length
    const inLedgerList = (p) => ADD_NAMED.includes(p) || ADD_INFRA.includes(p) || ADD_DIRS.some((d) => p.startsWith(d))
    const uncovered = [...listed, ...infraListed].filter((p) => !inLedgerList(p))
    check(`台账的 ${PATHSPEC_N} 条 pathspec 覆盖全部改动/新文件（清单面 ${listed.length + infraListed.length} 项）`, uncovered.length === 0,
      uncovered.length > 0 ? `不在清单里：${uncovered.slice(0, 4).join(' , ')}` : `${PATHSPEC_N} 条 pathspec 全覆盖`)
  }
}

// 单测面归同一族：`pnpm test` 是 `node --test packages/*/test/*.test.ts`，住在该形状之外的测试文件
// **不会报错、不会红，只是永远不被执行**，于是台账上那句"N 条单测"就成了空账（本会话为"看起来有证据"
// 这件事付过学费）。面从目录派生、glob 从 package.json 派生，两边都不写死。
// 双向合成正控：`packages/x/test/a.test.ts` 必须算被覆盖、`apps/web/test/a.test.ts` 必须算漏——
// 否则"0 条漏"可能只是判据在空转（一次性扫描器就是这么骗过我的，见台账那条 `node -e` 事故）。
{
  const SKIP = new Set(['node_modules', 'dist', '.runtime', '.live-geometry', '.sidecar-data', '.ci-smoke', '.stall-demo', '.mockup-render', '.git'])
  const testFiles = []
  const walk = (rel) => {
    for (const e of readdirSync(rel ? join(clientRoot, rel) : clientRoot, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p) }
      else if (/\.test\.(ts|mjs|js)$/.test(e.name)) testFiles.push(p)
    }
  }
  walk('')
  const script = String(JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8')).scripts?.test ?? '')
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const patterns = script.split(/\s+/).filter((t) => t.includes('test.'))
  const res = patterns.map((g) => new RegExp('^' + g.split('/').map((seg) =>
    seg.split('*').map(esc).join('[^/]+')).join('/') + '$'))
  const uncovered = testFiles.filter((f) => !res.some((re) => re.test(f)))
  const matchesIn = res.some((re) => re.test('packages/client-core/test/x.test.ts'))
  const matchesOut = res.some((re) => re.test('apps/web/test/x.test.ts'))
  // 每条子句自带名字，红了就点名红的子句。先前这里是一条手写三元"诊断梯"，实测会撒谎：
  // 把阈值 `>= 25` 改成 `>= 999` 时那一行确实红了，梯子里却没有对应那一支，于是红行打出一句绿话。
  const clauses = [
    ['面上有 ≥25 份单测', testFiles.length >= 25],
    ['glob 取到至少一条', patterns.length >= 1],
    ['没有落在面外的测试', uncovered.length === 0],
    ['正控：形状内的路径算被覆盖', matchesIn],
    ['正控：形状外的路径算漏', !matchesOut],
  ]
  const broken = clauses.filter(([, ok]) => !ok).map(([name]) => name)
  check(`每条单测都在 pnpm test 的面上（派生 ${testFiles.length} 份 / glob ${patterns.length} 条 / 面外 ${uncovered.length}）`,
    broken.length === 0, broken.length > 0 ? `这些子句不成立：${broken.join(' / ')}` : `脚本 = ${script}`)
}

// 类型全量档（apps/web/tsconfig.check.json）的 include 不许静默缩小。这条只管"覆盖面在不在"，
// 不管面上还剩几条错误（错误清零才接进 pnpm typecheck，今天已接）。include 从配置文件解析（剥 `//`
// 注释再 JSON.parse），文件面从 packages/ scripts/ apps/web/ 目录派生，两边都不写死清单。
// 两条正控各绑一个合成路径：必然在面内的必须算覆盖、必然在面外的必须算漏——glob 展开写坏时它自己红。
{
  const cfgPath = join(clientRoot, 'apps', 'web', 'tsconfig.check.json')
  const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : ''
  let includes = []
  try { includes = JSON.parse(raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')).include ?? [] } catch { includes = [] }
  const globToRe = (g) => {
    const norm = g.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '')
    const full = /^(apps|packages|scripts)\//.test(norm) ? norm : `apps/web/${norm}`
    const body = full.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .split('**/').join('@@SLASH@@').split('**').join('@@ANY@@')
      .split('*').join('[^/]*').split('@@SLASH@@').join('(?:[^/]+/)*').split('@@ANY@@').join('.*')
    return new RegExp(`^${body}$`)
  }
  const res = includes.map(globToRe)
  const SKIP = new Set(['node_modules', 'dist', '.runtime', '.live-geometry', '.sidecar-data', '.ci-smoke', '.stall-demo', '.mockup-render', '.git'])
  const face = []
  const walk = (rel) => {
    for (const e of readdirSync(join(clientRoot, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p) }
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) face.push(p)
    }
  }
  for (const top of ['packages', 'scripts', join('apps', 'web')]) if (existsSync(join(clientRoot, top))) walk(top)
  const rel = (p) => p.split('\\').join('/')
  const covered = (f) => res.some((re) => re.test(rel(f)))
  const uncovered = face.filter((f) => !covered(f))
  const clauses = [
    ['全量档配置在盘上', raw.length > 0],
    ['include 解析出足够条目', includes.length >= 5],
    ['派生的 TS 文件面非空', face.length >= 90],
    ['没有落在类型面之外的 TS 文件', uncovered.length === 0],
    ['正控：面内的合成路径必须算覆盖', covered('packages/client-core/test/zz-synthetic-fixture.test.ts')],
    ['正控：面外的合成路径必须算漏', !covered('tools/not-in-the-face/zz-synthetic-fixture.ts')],
  ]
  const broken = clauses.filter(([, ok]) => !ok).map(([n]) => n)
  check(`类型全量档覆盖测试与验收脚本面（派生 ${face.length} 个 TS 文件 / include ${includes.length} 条 / 面外 ${uncovered.length}）`,
    broken.length === 0,
    broken.length > 0 ? `这些子句不成立：${broken.join(' / ')}${uncovered.length > 0 ? `（面外前几个：${uncovered.slice(0, 4).map(rel).join(' , ')}）` : ''}`
      : `${includes.join(' , ')}`)
}

// 证据面自己的卫生（计划的「不留没人跑的东西」那一族）：`scripts/` 里每台 check-*/verify-*.mjs 都必须
// 有人跑。可达源不抄清单，从树里派生：`client/package.json` 的 scripts + 任一**其它**脚本的正文引用
// （`ci-smoke` 的门名单与 `verify-all` 的步骤表都是这个集合的成员，所以不必特判）。不可达的必须写进
// EXPECTED_ORPHAN 并给理由；理由过期（那台其实已经有人引用了）同样红——形状照 check:layers 的零调用点名单。
// 判据带**合成正控**：一个必然不可达的夹具名必须被判成孤儿、一个必然可达的已知站点必须不被判；
// 两条不同时成立就报红——否则"分类器整个坏了"和"没有孤儿"打印出来的绿一模一样。
// 「什么算证据面」住在这一份谓词里（2026-10-13 从下面那块提到模块级）：6b 那条问的是**面外**条目，
// 两边各写一份筛名正则的话，改一处就会让另一处把同一份文件既算面内又算面外（第一条上线就被这样咬到：
// `stall-demo.mjs` 与 `relocate-credential.mjs` 是人工档、已在理由表里，却又被当成"没人引用的面外件"）。
const isEvidenceFace = (f) =>
  /^(?:check|verify|accept|probe)-[a-z-]+\.(?:mjs|ts)$/.test(f) || f === 'stall-demo.mjs' || f === 'relocate-credential.mjs'
{
  // 理由表：名字 -> {kind, why}。`kind` 是**可证伪的证据类型**，判定去那份脚本正文里验它还成立：
  //   'keyed' 脚本自己有"没 key 就拒"的守卫（正文出现 configured）
  //   'live'  脚本挂的是**一台已在跑的实例**（正文出现 `openInstance(` 或直接读 `.sidecar-info.json`）
  //           ——所以它进不了零花费的 fresh 隔离线，这不是"忘了接"，是接不进去
  //   'human' 由人亲自跑的文档型工具：why 里点名的那份文档必须真的提到它（和写面 skip 理由同一形状）
  const EXPECTED_ORPHAN = {
    'accept-agui.ts': { kind: 'live', why: 'AG-UI 的官方 schema / 真 CopilotKit 那一半等你拍板（交接第 9 条）；且它回放的是**已在跑那台实例**的历史事件——fresh 隔离实例上没有事件可回放' },
    'accept-approval.ts': { kind: 'keyed', why: '审批"始终允许/拒绝"的活验要一次真上游 run（#27）；没 key 时脚本自己 exit 1' },
    'accept-git.ts': { kind: 'live', why: '读真实会话的 git 历史（挂已在跑的实例）；写路径那条由 accept-gitwrite.ts 常驻覆盖' },
    'accept-stream.ts': { kind: 'keyed', why: '流式帧只有一次真 run 才有；脚本自己没 key 就拒' },
    'accept-tooldiff.ts': { kind: 'live', why: '真 diff 载荷在历史事件里（挂已在跑的实例）；改前视图与渲染那半由像素门与单测常驻覆盖' },
    'probe-cockpit.ts': { kind: 'live', why: '手工探针：直读 .sidecar-info.json 挂现机键名，不是常驻证据' },
    'probe-tool-history.ts': { kind: 'live', why: '手工探针：扫历史会话找工具入参键形，同样挂现机' },
    'probe-stream.ts': { kind: 'keyed', why: 'M0 手工探针：脚本自己没 key 就拒（头注释写明）' },
    'stall-demo.mjs': { kind: 'human', why: '给人看一眼"发送静默"横幅的手动档；client/README.md 的交接表点名它' },
    'relocate-credential.mjs': { kind: 'human', why: '凭据迁移由人亲自跑（不让 agent 读明文）；client/README.md 修法那一行点名它' },
  }
  const dir = join(clientRoot, 'scripts')
  // 候选面从 `scripts/` 派生，但**不只 check/verify**：`accept-*` / `probe-*` 这些 .ts 同样是证据面，
  // 老规则（`^(check|verify)-…\.mjs$`）把 16 份 .ts 证据面整个留在射程外——"不留没人跑的东西"那句
  // 计划要求当时只对 21 台成立。两个 .mjs 工具按名字进名单（它们不是证据面流水线，是人工档）。
  const names = readdirSync(dir).filter(isEvidenceFace)
  const body = (f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return '' } }
  const pkgSrc = readFileSync(join(clientRoot, 'package.json'), 'utf8')
  // "有人跑"必须**真的有人 spawn 它**：可达源是一份白名单，而白名单本身不靠自称——判定要求名单里
  // 每份文件正文都有 spawn/execFile 的形状，没有就被剔掉并且红。上一版把 `scripts/` 下**任何**其它
  // 脚本的正文都当可达源，于是 `check-layers.mjs` 那条归属者名单里的字符串把 `accept-agui.ts` 洗成了
  // "有人跑"，而它一次都没被跑过（本轮现测）。
  // 我第一版改成"先剥注释再找名字"，结果更糟：这些文件里有形如 /\/\*…\*\// 的**正则字面量**，
  // 朴素的块注释剥除会把整个 STEPS 表吞掉，真在跑的 verify-* 反被说成孤儿（本轮实测红 6 台）。
  // 所以这里不剥注释，而是要求名字出现在**调用形状**里：spawn(...) / args: [...] / 短名名册项。
  const RUNNERS = ['ci-smoke.mjs', 'verify-all.mjs', 'verify-accept-zero.mjs']
  const spawnShape = /spawnSync\s*\(|\bspawn\s*\(|execFile/i
  const realRunners = RUNNERS.filter((r) => spawnShape.test(body(r)))
  const fakeRunner = RUNNERS.filter((r) => !realRunners.includes(r))
  const calledAsTarget = (name, src) => {
    const esc = name.replace(/\./g, '\\.')
    return new RegExp(`spawn(?:Sync)?\\s*\\([^)]*${esc}[^)]*\\)`, 's').test(src)
      || new RegExp(`args:\\s*\\[[^\\]]*${esc}[^\\]]*\\]`, 's').test(src)
      || new RegExp(`\\[\\s*['"\`]${esc}['"\`]\\s*,`, '').test(src)
  }
  const isOrphan = (n) => {
    if (pkgSrc.includes(`scripts/${n}`)) return false
    return !realRunners.some((r) => r !== n && calledAsTarget(n, body(r)))
  }
  const orphans = names.filter((n) => isOrphan(n) && !EXPECTED_ORPHAN[n])
  const stale = Object.keys(EXPECTED_ORPHAN).filter((n) => !isOrphan(n))
  const missingReason = names.filter((n) => isOrphan(n) && !EXPECTED_ORPHAN[n]?.why)
  // 理由的**证据**逐条回读：kind 说的必须是那份文件里真有的东西，'human' 点的文档必须真提到它。
  const badEvidence = Object.entries(EXPECTED_ORPHAN).filter(([n, e]) => {
    const src = body(n)
    if (!src) return true
    if (e.kind === 'keyed') return !/configured/.test(src)
    if (e.kind === 'live') return !/openInstance\(|\.sidecar-info\.json/.test(src)
    if (e.kind === 'human') {
      const doc = (e.why.match(/[\w./-]+\.md/) ?? [])[0]
      if (!doc) return true
      const p = join(clientRoot, doc.replace(/^client\//, ''))
      return !existsSync(p) || !readFileSync(p, 'utf8').includes(n)
    }
    return true
  }).map(([n, e]) => `${n}（理由说 kind=${e.kind}，那份文件里对不上）`)
  // 合成正控（三条，绑已知站点而不是绑计数）
  const canaryOrphan = isOrphan('check-zzz-fixture-nobody-runs.mjs')
  const canaryLive = !isOrphan('check-docs.mjs')
  const canaryShortName = !isOrphan('accept-tasks.ts')   // 只由 verify-accept-zero 的**短名名册**可达
  check(`证据面每台都有人跑（${names.length} 台派生自 scripts/，孤儿 ${orphans.length}，理由表 ${Object.keys(EXPECTED_ORPHAN).length} 条）`,
    names.length >= 35 && orphans.length === 0 && stale.length === 0 && missingReason.length === 0
      && badEvidence.length === 0 && fakeRunner.length === 0 && canaryOrphan && canaryLive && canaryShortName,
    names.length < 35 ? `派生面只有 ${names.length} 台——扫描面或正则坏了（正控不成立，这条绿没有意义）`
      : fakeRunner.length > 0 ? `可达白名单里这几份正文没有 spawn 形状：${fakeRunner.join(' , ')}`
      : !canaryOrphan ? '正控失败：夹具孤儿没被认出来（分类器在装绿）'
      : !canaryLive ? '正控失败：`check-docs.mjs` 被判成没人跑（可达源读不到东西）'
      : !canaryShortName ? '正控失败：`accept-tasks.ts` 被判成没人跑——短名名册那种形状不认了'
      : orphans.length > 0 ? `没人跑又不写理由：${orphans.slice(0, 4).join(' , ')}`
      : stale.length > 0 ? `理由表过期（这些已经被真跑起来了）：${stale.join(' , ')}`
      : badEvidence.length > 0 ? `理由的证据对不上：${badEvidence.join(' ｜ ')}`
      : missingReason.length > 0 ? `理由表里有空理由：${missingReason.join(' , ')}`
      : `全部可达（可达白名单 ${realRunners.join(' , ')} + package.json 的 scripts）`)
}

// 6b. 上面那张名册的**另一半**（2026-10-13 补，理由与它同一族）：候选集按 `^(check|verify|accept|probe)-`
//     筛，于是 `lib-*` / `serve-client.mjs` / `ci-smoke.mjs` 这些**面外条目**不在射程里——共用件被改名、
//     被复制成第二个家（本仓为"进程探针曾有两份家"付过学费），或新写的一份 lib 谁都没 import，
//     那条"每台都有人跑"照绿。**上线前先跑一次只读事实清点**（本轮实测：`scripts/` 共 51 项，面内 39、
//     面外 12，而 12 项今天全有引用者）——所以这条一上线就是绿的，它的价值是那张网，不是修东西。
//     形状纪律照上一条：**只认 import/export 语句与 spawn 调用形状**，正文注释里出现名字不算引用
//     （上一轮就是"归属者名单字符串把 accept-agui 洗成有人跑"）。三条合成正控各钉一种错法：
//     夹具名必判失踪、已知共用件必不判、以及**只在注释里出现**的那份必不判（这条证明分类器不吃洗白）。
{
  const sDir = join(clientRoot, 'scripts')
  const allScripts = readdirSync(sDir).filter((f) => /\.(?:mjs|ts)$/.test(f))
  const outside = allScripts.filter((f) => !isEvidenceFace(f)).sort()
  const srcOf = (f) => { try { return readFileSync(join(sDir, f), 'utf8') } catch { return '' } }
  const pkg = readFileSync(join(clientRoot, 'package.json'), 'utf8')
  const esc = (s) => s.replace(/\./g, '\\.')
  const importedBy = (text, name) => text.split(/\r?\n/).some((line) =>
    /^\s*(?:\/\/|\*|\/\*)/.test(line) === false && new RegExp(`\\bfrom\\s*['"][^'"]*/?${esc(name)}['"]`).test(line))
  const spawnedBy = (text, name) =>
    new RegExp(`spawn(?:Sync)?\\s*\\([^)]*${esc(name)}[^)]*\\)|args:\\s*\\[[^\\]]*${esc(name)}`, 's').test(text)
  const referencedBy = (f) => {
    const hits = pkg.includes(`scripts/${f}`) ? ['package.json'] : []
    for (const g of allScripts) {
      if (g === f) continue
      const t = srcOf(g)
      if (importedBy(t, f) || spawnedBy(t, f)) hits.push(g)
    }
    return hits
  }
  const stranded = outside.filter((f) => referencedBy(f).length === 0)
  const canaryMissing = referencedBy('lib-zzz-nobody-imports.mjs').length === 0
  const canaryKnown = referencedBy('lib-contrast.mjs').length > 0
  const canaryProse = !importedBy(`// 见 './lib-contrast.mjs'，注释里提一嘴\ncorepack pnpm check:contrast`, 'lib-contrast.mjs')
  check(`孤儿面之外的 scripts/ 条目也有人引用（面外 ${outside.length} 项由目录派生，失踪 ${stranded.length} 项；认 import 语句与 spawn 形状，不认裸名字）`,
    outside.length >= 10 && stranded.length === 0 && canaryMissing && canaryKnown && canaryProse,
    outside.length < 10 ? `面外只派生出 ${outside.length} 项——目录或筛名正则坏了，这条绿没有意义`
      : !canaryMissing ? '正控失败：一份树里不存在的夹具 lib 被认成有人引用（分类器在装绿）'
      : !canaryKnown ? '正控失败：`lib-contrast.mjs` 被认成没人引用（import 形状没读到）'
      : !canaryProse ? '正控失败：注释里出现的名字被当成引用（洗白洞又开了）'
      : stranded.length > 0 ? `没人 import 也没人 spawn：${stranded.join(' , ')}`
      : '全部有出处')
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  console.error('这些是计划的非目标，不是风格偏好——先回退改动，再解释为什么需要它。')
  process.exit(1)
}
if (!quiet) console.log(`\nnon-goal checks passed (${shipped.length} shipped files scanned)`)
