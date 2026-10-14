#!/usr/bin/env node
/**
 * check-docs.mjs — a docs-truth gate, because the ledgers are the thing the user trusts.
 *
 * Three kinds of claim rot silently when code moves, and all three are mechanically checkable:
 *   1. "this file/script exists at this path" — a README pointing at a renamed script is a
 *      doc that teaches the next reader to run something that fails;
 *   2. "this is a table" — a row whose pipe count differs from its header is a table that
 *      stops rendering, and tsc/test suites cannot see it;
 *   3. what the parked CI workflow asserts about *this tree* (a lockfile, a missing
 *      packageManager, the root engines, the scripts and package it runs) — the owner reads
 *      exactly these lines before spending a `mv` on shared infrastructure, so a stale claim
 *      there is a broken pipeline they have to discover by hand.
 *
 *   node scripts/check-docs.mjs            # all package + app + root READMEs
 *   node scripts/check-docs.mjs --quiet    # failures only (used by ci-smoke)
 *
 * Both checks are cheap enough to run on every CI pass, and each one has already caught a
 * real mistake in this repo's own tooling: a relative path resolved against the wrong base,
 * and a table-width flush bug that cried wolf 33 times over ui-chat.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')

const failures = []
const report = (ok, label, detail = '') => {
  if (!quiet || !ok) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * Path mentions. `.tsx` must be tried before `.ts` in the alternation — otherwise
 * `App.tsx` matches as `App.ts` + a stray `x` and the gate reports a file that is there.
 * Narrative mentions of a deliberately wrong path are listed here rather than silenced by
 * skipping code spans generally.
 */
const PATH_IGNORE = ['apps/scripts/launch-sidecar.mjs']
const PATH_RE = /(?:scripts|packages|apps)\/[A-Za-z0-9_.\/-]+\.(?:tsx|mjs|ts|css)/g

// 计划正文只有一个家。此前三处判据各自 `resolve(...)` 一遍同一份路径，第四处（§1）就是第四副本——
// 计划文件一旦改名，改漏一处的那条判定会带着「找不到文件」红，或者更糟：安静地不量任何东西。
const planDoc = resolve(clientRoot, '..', 'analysis-reports', '定稿-天枢客户端方案', '天枢Web桌面客户端自研计划-v2.0.md')
// 定稿目录页（同一批交付物）也一样：它的文件夹路径原本只在 block 7 里定义，新的判据要读它就会写第二份。
const finalFolder = resolve(clientRoot, '..', 'analysis-reports', '定稿-天枢客户端方案')
const finalReadme = join(finalFolder, 'README.md')

// 表格单元：按未转义的 `|` 拆（转义的 `\|` 是格内字面量，与 README 那条表格判据同一把尺子）。
// §7 风险表与新加的 §1 阶段表共用这一份拆格器与这三条形状自证。
const splitCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
const SPLIT_SHAPE = [
  { s: '| a | 中 | b |', want: ['a', '中', 'b'] },
  { s: '| x \\| y | 低 | z |', want: ['x \\| y', '低', 'z'] },
  { s: '|---|---|---|', want: ['---', '---', '---'] },
]
const badSplitShape = () => SPLIT_SHAPE.filter((c) => JSON.stringify(splitCells(c.s)) !== JSON.stringify(c.want))
const splitShapeText = (bad) => (bad.length > 0
  ? `拆格器自己坏了：${bad.map((c) => `${c.s} → ${JSON.stringify(splitCells(c.s))}`).join(' ｜ ')}`
  : '三种形状各拆对了一次（转义的不拆格）')

// 一句 markdown 正文里的分号条款（§1 的「非目标」用它拆）。
const clauses = (line, lead) => line.replace(lead, '').replace(/。$/, '').split('；').map((s) => s.trim()).filter((s) => s.length > 0)
const CLAUSE_SHAPE = [
  { s: '**非目标**：甲；乙；丙。', lead: '**非目标**：', want: ['甲', '乙', '丙'] },
  { s: '甲；乙。', lead: '', want: ['甲', '乙'] },
  { s: '只有甲。', lead: '', want: ['只有甲'] },
]

function readmeFiles() {
  const out = [join(clientRoot, 'README.md')]
  for (const dir of [...readdirSync(join(clientRoot, 'packages')).map((d) => join('packages', d)), ...readdirSync(join(clientRoot, 'apps')).map((d) => join('apps', d))]) {
    const f = join(clientRoot, dir, 'README.md')
    if (existsSync(f)) out.push(f)
  }
  return out
}

const missing = []
for (const file of readmeFiles()) {
  const base = dirname(file)
  const txt = readFileSync(file, 'utf8')
  for (const m of txt.matchAll(PATH_RE)) {
    const p = m[0]
    if (PATH_IGNORE.some((ig) => p.endsWith(ig))) continue
    // A mention may be repo-root-relative or relative to its own package: accept either.
    if (!existsSync(join(base, p)) && !existsSync(join(clientRoot, p))) {
      missing.push(`${relative(clientRoot, file)} → ${p}`)
    }
  }
}
report(missing.length === 0, 'every path mentioned in a README exists', [...new Set(missing)].slice(0, 5).join(' | '))

/**
 * `file.ext:NNN` citations. The ledger's whole evidencing style is "回到那一行看"，所以一条指不到
 * 东西的引用就是一条过期证据。2026-10-11 我为核验它们写了个一次性 shell 检查，连着两次给出**假结论**
 * （一次 `cd` 到仓库外，报"所有文件都不存在"；一次 `grep -q "a|b"` 把 `|` 当字面量，报"一堆引用漂了"）
 * ——一次性检查器坏得无声，所以这件事必须是常驻门。
 *
 * 三条判据：指得到（文件存在）；**不含目录的引用其基名必须全仓唯一**（否则读者要猜目录，我就是猜错
 * 那个）；行号在文件真实行数之内（内核一改，指到 EOF 之后就是假证据）。
 */
const repoRoot = resolve(clientRoot, '..')
const SOURCE_SKIP = new Set(['node_modules', 'dist', '.git', '.sidecar-data', '.live-geometry', '.rivet'])
const byBase = new Map()
const walkSrc = (dir) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SOURCE_SKIP.has(e.name)) walkSrc(join(dir, e.name)); continue }
    if (!/\.(tsx|mts|mjs|ts|css|html|json|md)$/.test(e.name)) continue
    if (!byBase.has(e.name)) byBase.set(e.name, [])
    byBase.get(e.name).push(join(dir, e.name))
  }
}
walkSrc(repoRoot)

const CITE_RE = /([A-Za-z0-9_.\/-]+\.(?:tsx|mts|mjs|ts|css|html|json|md)):(\d+)(?:-(\d+))?/g
const badCites = []
let citesChecked = 0
for (const file of readmeFiles()) {
  const base = dirname(file)
  const txt = readFileSync(file, 'utf8')
  for (const m of txt.matchAll(CITE_RE)) {
    const tok = m[1]
    const last = Number(m[3] ?? m[2])
    citesChecked += 1
    let hit = null
    if (tok.includes('/')) {
      for (const cand of [join(repoRoot, tok), join(clientRoot, tok), join(base, tok)]) {
        if (existsSync(cand)) { hit = cand; break }
      }
      if (!hit) { badCites.push(`${relative(clientRoot, file)} → ${tok}:${m[2]} 文件找不到`); continue }
    } else {
      const cands = byBase.get(tok) ?? []
      if (cands.length === 0) { badCites.push(`${relative(clientRoot, file)} → ${tok}:${m[2]} 文件找不到`); continue }
      if (cands.length > 1) {
        badCites.push(`${relative(clientRoot, file)} → ${tok}:${m[2]} 基名不唯一（${cands.length} 个同名文件），引用必须写路径`)
        continue
      }
      hit = cands[0]
    }
    const lines = readFileSync(hit, 'utf8').split(/\r?\n/)
    if (last > lines.length) {
      badCites.push(`${relative(clientRoot, file)} → ${tok}:${m[2]} 超出该文件行数（只有 ${lines.length} 行）`)
    } else if (!/[^{}();\s]/.test(lines[Number(m[2]) - 1] ?? '')) {
      // 绊线：引用指到空行、或只剩括号/分号的行，几乎一定是那行代码被上下挤走了——行号仍在范围
      // 内，所以原来那条"行号在真实行数之内"照绿（2026-10-12 实测：`check-nongoals.mjs:91` 滑到空行，
      // 真实位置已到 94-96，门一声不响）。引用内容对不对门管不了，但"那一行什么都没有"必须响。
      badCites.push(`${relative(clientRoot, file)} → ${tok}:${m[2]} 指到的是空行/纯符号行——那行代码已被挤走，引用要重定位`)
    }
  }
}
report(citesChecked >= 20, `README 里的 file:line 引用共 ${citesChecked} 条被逐条定位（少于 20 条说明正则或扫描面坏了）`, citesChecked < 20 ? '正控不成立：这条绿没有意义' : '')
report(badCites.length === 0, '每条 file:line 都指得到唯一文件，且行号在真实行数之内', [...new Set(badCites)].slice(0, 20).join(' | '))

/** Table shape: consecutive pipe rows form a block; every row needs the header's width.
 *  `\|` is GFM's escape for a literal pipe inside a cell — it renders inside the cell and does NOT
 *  split it, so counting it as a column boundary reported healthy tables as broken (2026-10-14: a
 *  row writing `api \| cron \| manual` came back one row too wide). Escape first, then count. */
const countCells = (line) => (line.replace(/\\\|/g, '').match(/\|/g) ?? []).length
const CELL_SHAPE = [
  { s: '| a | b \\| c | d |', cells: 4 },
  { s: '| a | b | c | d |', cells: 5 },
  { s: '| \\| 开头也要算一列 | 第二列 |', cells: 3 },
]
const cellBadShape = CELL_SHAPE.filter((c) => countCells(c.s) !== c.cells).map((c) => `${c.s} 应数到 ${c.cells} 列，实数 ${countCells(c.s)}`)
report(cellBadShape.length === 0, '表格列数判据的形状自证（转义竖线不拆格、未转义的拆）', cellBadShape.join(' | '))
const brokenTables = []
for (const file of readmeFiles()) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  let block = []
  const flush = () => {
    if (block.length >= 2) {
      const width = block[0].cells
      const off = block.filter((r) => r.cells !== width)
      if (off.length > 0) brokenTables.push(`${relative(clientRoot, file)}:行${block[0].line} (${width}列) 有 ${off.length} 行不符 → 例 行${off[0].line}(${off[0].cells})`)
    }
    block = []
  }
  lines.forEach((l, i) => {
    const t = l.trim()
    if (t.startsWith('|')) block.push({ line: i + 1, cells: countCells(t) })
    else flush()
  })
  flush()
}
report(brokenTables.length === 0, 'every README table renders (row widths match their header)', brokenTables.slice(0, 4).join(' | '))

// 3. The CI artifact for §9 v1.0's 「协议漂移 CI 全绿」. It waited in `scripts/` as
//    `ci-client.workflow.yml.example` until the owner authorised the one `mv` (2026-10-12); either
//    way its comments assert facts about the tree (a lockfile, a *missing* packageManager field, the
//    root engines, the corepack pnpm it was verified with, that the send step is structurally
//    gated on `configured === false`, which gates it runs, which evidence steps it omits and why).
//    Those rot silently — so they are checked here **against whichever copy is live**: wiring the
//    file must not be the thing that closes the gate.
{
  const repoRoot = resolve(clientRoot, '..')
  const examplePath = join(clientRoot, 'scripts/ci-client.workflow.yml.example')
  const wiredPath = join(repoRoot, '.github/workflows/client-gates.yml')
  const wired = existsSync(wiredPath)
  const artPath = wired ? wiredPath : examplePath
  if (wired) {
    report(!existsSync(examplePath), '协议漂移 CI 已接线，且只有一份制品（.github/workflows/client-gates.yml 在、client/scripts 下的示例已不在）',
      '§9 v1.0 那句「CI 全绿」从命令级升到流水线级；两份副本会各说各话，所以 mv 不是 cp')
  } else if (!existsSync(examplePath)) {
    report(false, 'CI 示例既没被 mv 出去、文件本身也不在了', 'scripts/ci-client.workflow.yml.example 应当二选一存在')
  }
  if (wired || existsSync(examplePath)) {
    const ex = readFileSync(artPath, 'utf8')
    const smoke = readFileSync(join(clientRoot, 'scripts/ci-smoke.mjs'), 'utf8')
    const clientPkg = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8'))
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const bad = []
    // 证据线上门的名单只有一个来源：ci-smoke 源码里真正 spawnSync 的那些。下面两条判定都从它派生，
    // 免得两处各写一遍正则、改坏任一份都不红（同一文件里遮蔽定义的老教训）。
    const derivedGates = [...smoke.matchAll(/spawnSync\(process\.execPath, \[join\(clientRoot, 'scripts\/([a-z0-9-]+\.mjs)'/g)].map((m) => m[1])
    // 诊断里的制品名跟着接线状态走：接线之后读的是 .github/workflows/client-gates.yml，再叫「示例」就是假陈述。
    const art = wired ? '工作流' : '示例'
    const claims = [
      [/client\/pnpm-lock\.yaml exists/.test(ex) === existsSync(join(clientRoot, 'pnpm-lock.yaml')), `${art}说 client/pnpm-lock.yaml 存在`],
      [!(/no `packageManager` field/.test(ex)) === Boolean(clientPkg.packageManager), `${art}说 client/ 没有 packageManager 字段`],
      // 不是"若它写着 >=24 就要求真是 >=24"（那样把注释改成 `>=22` 反而没人管），而是
      // **把它宣称的值取出来**再对树比：值错了红，宣称整句被删也红（没得验就等于没接线）。
      [(() => {
        const claimed = /的 engines 是 "([^"]+)"/.exec(ex)?.[1]
        return claimed !== undefined && claimed === rootPkg.engines?.node
      })(), `${art}引用的根 engines 值（宣称须与 package.json 相等，宣称消失也算红）`],
      [ex.includes('node scripts/ci-smoke.mjs') && existsSync(join(clientRoot, 'scripts/ci-smoke.mjs')), `${art}要跑的 ci-smoke.mjs`],
      [ex.includes('corepack pnpm test') && Boolean(clientPkg.scripts?.test), `${art}要跑的 pnpm test`],
      [ex.includes('corepack pnpm typecheck') && Boolean(clientPkg.scripts?.typecheck), `${art}要跑的 pnpm typecheck`],
      [ex.includes('--filter @tianshu/app-web build') && existsSync(join(clientRoot, 'apps/web/package.json')), `${art}要构建的 @tianshu/app-web`],
      // 步骤里每个 `npm run <脚本>` 都得在根 package.json 真存在。写这条的理由是现场实测出来的：这份 job
      // 原本跑 root `build`，而那条在本地 exit 1（尾巴上的 stage-runtime-deps 要 native sqlite），换成
      // `build:bundle` 才与「客户端门只需要 dist/cli/entry.js」一致。目标名从文件里派生、不点名——往 job 里
      // 加一步没人验过的 npm run，或者上游把脚本改名，都会红。
      (() => {
        const wanted = [...new Set([...ex.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]))]
        const missing = wanted.filter((s) => !Object.keys(rootPkg.scripts ?? {}).includes(s))
        return [wanted.length >= 2 && missing.length === 0,
          `${art}里每个 npm run 目标都在根 package.json 存在（派生 ${wanted.length} 个：${wanted.join(',')}${
            missing.length ? `；不存在 ${missing.join(',')}` : ''}${wanted.length < 2 ? '；派生少于 2 个，正则或文件塌了' : ''}）`]
      })(),
      [/configured === false/.test(smoke), `${art}说"零花费是结构性的"——ci-smoke 里确有 configured===false 这道闸`],
      // 示例对「它跑哪几道门」的宣称是读它的人第一句要看的话，而往 ci-smoke 里加门不会有人回来改示例：
      // 本轮就撞上了——示例停在「五道门」，实际那时已是九道、今天十道。所以示例里只留一条机器可读的
      // `# gates:` 名单，与从 ci-smoke 源码派生的 spawnSync 集合**逐文件名双向对齐**：加门不登记会红，
      // 登记了 ci-smoke 已经不跑的门也会红，名单整行被删同样红（派生侧空则一并落红，不靠写死的道数）。
      (() => {
        const derived = derivedGates
        const line = /^#[ \t]+gates:[ \t]*(.+)$/m.exec(ex)?.[1]
        const claimed = line === undefined ? [] : line.split(',').map((s) => s.trim()).filter(Boolean)
        const unregistered = derived.filter((s) => !claimed.includes(s))
        const phantom = claimed.filter((s) => !derived.includes(s))
        // 顺序也是宣称：这份名单讲的是"这道 job 按什么顺序跑门"，而 `derivedGates` 就是 ci-smoke 源码里
        // spawnSync 的顺序。只比集合会把"调换两道门"这种改动静默吞掉（今天两边顺序恰好一致，所以这条
        // 不是空转的约束，而是一条现在就能被违反的约束）。
        const orderMismatch = claimed.length === derived.length && claimed.some((s, i) => s !== derived[i])
        return [derived.length > 0 && unregistered.length === 0 && phantom.length === 0 && !orderMismatch,
          `${art}的 # gates: 名单与 ci-smoke 实跑的门逐名逐序对齐（派生 ${derived.length} 道${
            line === undefined ? `，${art}没有那条名单` : ''}${
            unregistered.length ? `，${art}漏 ${unregistered.join(',')}` : ''}${
            phantom.length ? `，${art}多写 ${phantom.join(',')}` : ''}${
            orderMismatch ? `，顺序不一致：制品 ${claimed.join(' ')} vs 源码 ${derived.join(' ')}` : ''}）`]
      })(),
      // ci-smoke 文件头那段 "Gates:" 是读这条命令的人看到的第一段解释，而往 ci-smoke 里加门不会有人
      // 回来改注释——本轮就是被上面那条判定逼出来的发现：workflow 名单上 11 道，注释只列了 7 道。
      // 所以让注释与同一份 `derivedGates` 逐名双向对齐：注释漏一道红，写了不跑的门（或整段结构被改没）也红。
      (() => {
        const at = smoke.indexOf('1. drift')
        const until = smoke.indexOf('2. smoke')
        const region = at === -1 || until === -1 ? '' : smoke.slice(at, until)
        const named = [...new Set([...region.matchAll(/`([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))]
        const missing = derivedGates.filter((s) => !named.includes(s))
        const staleNames = named.filter((s) => !derivedGates.includes(s))
        return [region.length > 0 && derivedGates.length > 0 && missing.length === 0 && staleNames.length === 0,
          `ci-smoke 文件头点名的门与它实跑的门逐名对齐（注释点名 ${named.length} 道 / 源码派生 ${derivedGates.length} 道${
            missing.length ? `，注释漏 ${missing.join(',')}` : ''}${
            staleNames.length ? `，注释多写 ${staleNames.join(',')}` : ''}${
            region.length === 0 ? '，找不到 drift/smoke 两个锚，整段结构被改动' : ''}）`]
      })(),
      // 名册那一半，2026-10-12 起改成**两面对齐**：证据线（`verify-all`）的每台要么在 job 的 `run:`
      // 里真跑，要么留在"Deliberately NOT run here"名下带理由。只写一面各红一次——加了真步骤却还
      // 挂在名册里（双记账）、或名册删了却没真接（没交代），都不许安静通过。台数不抄：从 verify-all
      // 步骤表与 `run:` 行各自派生；名册里写了树中不存在的脚本名也红（过期排除等于假安心）。
      (() => {
        const allSrc = readFileSync(join(clientRoot, 'scripts/verify-all.mjs'), 'utf8')
        const surface = [...new Set([...allSrc.matchAll(/join\(clientRoot, 'scripts\/([a-z0-9-]+\.mjs)'/g)].map((m) => m[1]))]
          .filter((n) => n !== 'ci-smoke.mjs' && !derivedGates.includes(n))
        const at = ex.indexOf('Deliberately NOT run here')
        const region = at === -1 ? '' : ex.slice(at)
        const runLines = new Set([...ex.matchAll(/^\s*run:\s*.*$/gm)])
        const runNames = new Set([...ex.matchAll(/node scripts\/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))
        // "在 run: 行里"才算真步骤：名册若把一个已经在跑的脚本写回"故意不跑"，那是双记账——
        // 这道 job 的真实作用面与它的自述不一致，两边都该红。
        const inRunLine = (n) => [...runLines].some((line) => String(line[0]).includes(`${n}`) && /node scripts\//.test(String(line[0])))
        const unaccounted = surface.filter((n) => !inRunLine(n) && !region.includes(n))
        const doubleBooked = surface.filter((n) => inRunLine(n) && (region.includes(`${n}（`) || region.includes(`${n}.mjs`) || region.includes(`\`${n}\``)))
        const phantom = [...new Set([...region.matchAll(/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))]
          .filter((n) => !existsSync(join(clientRoot, 'scripts', n)))
        return [at !== -1 && surface.length >= 4 && runNames.size >= 1 && unaccounted.length === 0 && phantom.length === 0 && doubleBooked.length === 0,
          `${art}的证据线两面对齐（派生 ${surface.length} 台：${surface.join(',')}${
            at === -1 ? '；制品没有那段名册' : ''}${
            runNames.size < 1 ? '；job 里没有一台是 `node scripts/*.mjs` 真步骤，派生可疑' : ''}${
            unaccounted.length ? `；没交代 ${unaccounted.join(',')}` : ''}${
            doubleBooked.length ? `；既真跑又挂在名册里 ${doubleBooked.join(',')}` : ''}${
            phantom.length ? `；写了树里不存在的 ${phantom.join(',')}` : ''}）`]
      })(),
      // 名册的第三条腿（2026-10-13 补，理由是它当场抓到的一条真打脸）：上面那条派生的名单来自
      // `verify-all` 的步骤表，而它 `.filter(... !derivedGates.includes(n))` 把漂移门整批剔除了——
      // 于是 `check-contrast.mjs` 这类**住在 ci-smoke 里**的门，名册写它「故意不跑」而它其实每跑一次
      // CI 都被 spawn 一次，两头自述互相打脸却没有任何判定抓得到。配色 AA 在 2026-10-12 裁定 ①
      // 之后已经由"故意红"改成硬门，那段名册就是这一类没被抓住的陈旧抄写。
      // 判据：名册点名的脚本名与 ci-smoke 实跑的漂移门必须无交集；反例就是把那行加回去。
      (() => {
        const at = ex.indexOf('Deliberately NOT run here')
        const region = at === -1 ? '' : ex.slice(at)
        const named = [...new Set([...region.matchAll(/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))]
        const alsoRuns = named.filter((n) => derivedGates.includes(n))
        return [at !== -1 && alsoRuns.length === 0,
          `${art}的"故意不跑"名册与 ci-smoke 实跑的漂移门无交集（名册点名 ${named.length} 个脚本名 / ` +
            `漂移门 ${derivedGates.length} 道${alsoRuns.length ? `，交集 ${alsoRuns.join(',')}——名册说它不跑，ci-smoke 却在跑它` : ''}${
            at === -1 ? '，找不到名册锚' : ''}）`]
      })(),
      // 触发面也是这道 job 自述的一部分（2026-10-13 补）。它的判据会去读根 `package.json` 里的脚本名
      // （每个 `npm run` 目标的存在性）与 `src/server/protocol.ts`（类型镜像的事实源），所以"改了这些
      // 文件会不会跑到这道 job"必须在 push 与 PR 两侧一致：PR 少一条路径 = 改坏它的那次 PR 根本不触发，
      // 漂移要等合并进 main 之后才红，那就从门禁退化成事后报告。两份清单都从这里派生，条数不抄。
      // 行级解析前先归一化换行——本仓的检出可能是 CRLF（为这一条本台账记过一次"变异实际什么都没改"）。
      (() => {
        const src = ex.replace(/\r\n/g, '\n')
        const block = (name) => {
          const m = new RegExp(`^  ${name}:\\n((?:[ ]{4,}.+\\n?)+)`, 'm').exec(src)
          return m === null ? null : [...m[1].matchAll(/^[ ]+-[ ]+'([^']+)'/gm)].map((x) => x[1])
        }
        const push = block('push') ?? []
        const pr = block('pull_request') ?? []
        const onlyPush = push.filter((p) => !pr.includes(p))
        const onlyPr = pr.filter((p) => !push.includes(p))
        return [push.length >= 3 && pr.length >= 3 && onlyPush.length === 0 && onlyPr.length === 0,
          `${art}的 push 与 pull_request 触发路径逐名相等（push ${push.length} 条 / PR ${pr.length} 条${
            push.length === 0 ? '；读不到 push 段，结构被改动' : ''}${
            pr.length === 0 ? '；读不到 pull_request 段，结构被改动' : ''}${
            onlyPush.length ? `；只有 push 触发 ${onlyPush.join(',')}` : ''}${
            onlyPr.length ? `；只有 PR 触发 ${onlyPr.join(',')}` : ''}）`]
      })(),
      // 零花费面的名册只住在 `verify-accept-zero` 的 `SCRIPTS` 里，别处那几处都是抄写的份。本轮往这张
      // 名单上加 `accept-tasks.ts` 时才看清：三处散文各自写着"schedule / settings / gitwrite / queue"
      // （`verify-all` 的步骤标签、这份制品的步骤名、台账），而加脚本不会有人回去改它们——与上面那条
      // ci-smoke 注释同一类病。所以按派生名单逐名双向对齐：漏一个红（跑了却没在自述里），多写一个也红
      // （宣称跑了其实没有）。台数也不手抄，两边各自派生。
      (() => {
        const zero = readFileSync(join(clientRoot, 'scripts/verify-accept-zero.mjs'), 'utf8')
        const roster = [...new Set([...zero.matchAll(/^ {2}\['(accept-[a-z-]+)\.ts'/gm)].map((m) => m[1].replace(/^accept-/, '')))]
        const verifyAll = readFileSync(join(clientRoot, 'scripts/verify-all.mjs'), 'utf8')
        const words = (s) => s.split('/').map((x) => x.trim()).filter(Boolean)
        const labelList = words((verifyAll.match(/零花费验收面 verify-accept-zero（([^，]*)，/) ?? ['', ''])[1])
        const stepList = words((ex.match(/zero-spend acceptance surface \(?([^,]*),/) ?? ['', ''])[1])
        const diff = (list) => ({ missing: roster.filter((n) => !list.includes(n)), stale: list.filter((n) => !roster.includes(n)) })
        const L = diff(labelList)
        const S = diff(stepList)
        return [roster.length >= 4 && L.missing.length === 0 && L.stale.length === 0 && S.missing.length === 0 && S.stale.length === 0,
          `零花费面两处自述与 \`SCRIPTS\` 派生的名单逐名对齐（名单 ${roster.length} 台：${roster.join(' / ')}；` +
            `verify-all 标签${L.missing.length ? ` 漏 ${L.missing.join(',')}` : ''}${L.stale.length ? ` 多写 ${L.stale.join(',')}` : ''}${L.missing.length + L.stale.length === 0 ? ' 对得上' : ''}；` +
            `workflow 步骤名${S.missing.length ? ` 漏 ${S.missing.join(',')}` : ''}${S.stale.length ? ` 多写 ${S.stale.join(',')}` : ''}${S.missing.length + S.stale.length === 0 ? ' 对得上' : ''}）`]
      })(),
    ]
    for (const [ok, what] of claims) if (!ok) bad.push(what)
    report(bad.length === 0, `${art}里对树的事实宣称仍然成立（判据 ${claims.length} 条，条数与本段 claims 数组同源；失败时逐条点名）`,
      bad.join(' | ') || (wired
        ? '这条判定读的就是 .github/workflows/client-gates.yml 本身——接线没让它闭眼'
        : '它一旦被 mv 进 .github/workflows/client-gates.yml，上面那条改口报「已接线」，而这条继续验文本'))
  }
}

// ---------------------------------------------------------------- 用户可见文案 ↔ 运行时真实行为
// 侧栏搜索的空态文案以前写着"搜索按项目本地取文件、不覆盖 sidecar 会话库"——**这句是错的**，
// 实测（隔离无 key sidecar）`GET /sessions/search` 读的就是 sidecar 自己的转录库
// `~/.rivet/sessions/<项目 slug>/<id>.jsonl`，而且 `q=a` 会回 HTTP 400。这里把文案里的两个可核点
// 与内核源码逐条对照：门槛数、以及路径形状。任一读不到都算红（"没得对"不等于"对得上"）。
{
  const repoRoot = resolve(clientRoot, '..')
  const routesPath = join(repoRoot, 'src/server/session-routes.ts')
  const pathsPath = join(repoRoot, 'src/config/paths.ts')
  const searchPath = join(repoRoot, 'src/server/session-search.ts')
  const copyFiles = [
    join(clientRoot, 'packages/ui-session/src/index.tsx'),
    join(clientRoot, 'packages/locale/src/zh.ts'),
    join(clientRoot, 'packages/locale/src/en.ts'),
  ]
  const bad = []
  const missingFiles = [routesPath, pathsPath, searchPath, ...copyFiles].filter((p) => !existsSync(p))
  if (missingFiles.length > 0) {
    bad.push(`对不了：缺文件 ${missingFiles.map((p) => p.slice(repoRoot.length + 1)).join(', ')}`)
  } else {
    const routes = readFileSync(routesPath, 'utf8')
    const kernelMin = Number(/q\.length < (\d+)/.exec(routes)?.[1] ?? NaN)
    const clientMin = Number(/export const SEARCH_MIN_QUERY = (\d+)/.exec(
      readFileSync(join(clientRoot, 'packages/client-core/src/sidecar-client.ts'), 'utf8'))?.[1] ?? NaN)
    if (!Number.isInteger(kernelMin) || kernelMin <= 0) bad.push('内核里找不到 `q.length < N` 这道闸')
    else if (kernelMin !== clientMin) bad.push(`客户端 SEARCH_MIN_QUERY=${clientMin}，内核要的是 ${kernelMin}`)
    const copy = copyFiles.map((p) => readFileSync(p, 'utf8')).join('\n')
    if (/不覆盖 sidecar|not the sidecar session store/.test(copy)) bad.push('文案还在说"不覆盖 sidecar 会话库"，而实测读的就是那个库')
    const slugFrom = /join\(rivetHome\(\), 'sessions', projectSlug\(cwd\)\)/.test(readFileSync(pathsPath, 'utf8'))
    const perSessionFile = /\$\{session\.id\}\.jsonl/.test(readFileSync(searchPath, 'utf8'))
    if (!slugFrom || !perSessionFile) bad.push(`内核路径形状变了（slug 目录=${slugFrom}、每会话一份 jsonl=${perSessionFile}）`)
    if (!/\.rivet\/sessions\/<slug>\/<id>\.jsonl/.test(copy)) bad.push('文案里没有实测出来的转录形状 `.rivet/sessions/<slug>/<id>.jsonl`')
    // 本轮实测的第二层：搜索读 `<slug>/<id>.jsonl`，而写入侧把每个会话存成 `<id>/` **目录**
    // （`<id>/events.jsonl`、`<id>/ui-history.jsonl`）。两边对不上，所以正文永远 0 命中——
    // 这不是推测：隔离 sidecar 里发一条无 key prompt 后 `GET /events` 读得到那句用户正文，
    // 而 `GET /sessions/search` 对三个子串都回 `hits=0`。文案必须把这条说不圆的路讲出来。
    const writerAt = ['src/tui/frontend-session-provider.ts', 'src/server/__tests__/store-lock-e2e.test.ts', 'src/agent/session-persist.ts']
      .map((p) => join(repoRoot, p))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n')
    const writerUsesDir = /sessionsDir\([^)]*\)[^\n]*,\s*(?:id|targetId|session\.id)\s*,\s*['"][a-z-]+\.jsonl['"]/.test(writerAt)
    const readerUsesFlatFile = /\$\{session\.id\}\.jsonl/.test(readFileSync(searchPath, 'utf8'))
    if (!(writerUsesDir && readerUsesFlatFile)) {
      bad.push(`内核那条不一致看起来变了（目录式写入=${writerUsesDir}、扁平 <id>.jsonl 读取=${readerUsesFlatFile}）——若是内核修好了，就得重测搜索并改掉这段文案`)
    }
    if (!/searchNoteRuntime/.test(copy)) bad.push('空态里没有那句"搜索读的路径与写入的目录式布局不一致"的说明')
  }
  report(bad.length === 0, '侧栏搜索空态文案与内核真实行为逐条一致（门槛数 + 读的是哪一份库）', bad.join(' | '))
}

// ---------------------------------------------------------------- GET /tasks 的 query 过滤：宣称 ↔ 实情
// `sidecar-client.ts` 与 `task-types.ts` 都曾写着"query 会交给 handler、handler 就在那儿读"——**这句
// 在核源码里站不住**：`GET /tasks` 从**第一个**形参取过滤条件（那是 body，而 HTTP 的 GET 没有 body），
// 把路由真正递进来的 query（第二个形参）命名为 `_params` 后整段不看。现场实测写在
// `scripts/accept-tasks.ts`（2026-10-13，一台隔离无 key 实例）：`?status=nonsense&limit=1` 原样回整张表。
// 所以客户端自己把页裁出来（`task-view.ts`）。这条判定钉三头，少一头就是"注释与兜底各说各话"：
// 内核那一侧的形状没变（变了就该删兜底、改注释）、兜底确实接在 `listTasks` 的回包上、两处 docstring
// 不许把已证伪的前提再写一遍。任一读不到都算红。
{
  const repoRoot = resolve(clientRoot, '..')
  const taskRoutesPath = join(repoRoot, 'src/server/task-routes.ts')
  const routerPath = join(repoRoot, 'src/server/index.ts')
  const viewPath = join(clientRoot, 'packages/client-core/src/task-view.ts')
  const bad = []
  const missing = [taskRoutesPath, routerPath, viewPath].filter((p) => !existsSync(p))
  if (missing.length > 0) {
    bad.push(`对不了：缺文件 ${missing.map((p) => p.slice(repoRoot.length + 1)).join(', ')}`)
  } else {
    const routesSrc = readFileSync(taskRoutesPath, 'utf8')
    const handlerArgs = (/'GET \/tasks':\s*async\s*\(([^)]*)\)/.exec(routesSrc) ?? [])[1] ?? ''
    const kernelIgnoresQuery = /(^|[,(]\s*)_params\b/.test(handlerArgs)
    const readsFilterFromBody = /const filter = body && typeof body === 'object'/.test(routesSrc)
    const queryIsSecondArg = /exactHandler\(body, query/.test(readFileSync(routerPath, 'utf8'))
    if (!handlerArgs) bad.push('内核里找不到 `GET /tasks` 的形参表——形状变了，这条判定得重看，不许当它一直绿')
    else if (!(kernelIgnoresQuery && readsFilterFromBody && queryIsSecondArg)) {
      bad.push(`内核开始认 query 了（形参表="${handlerArgs.trim()}" · 忽略第二个形参=${kernelIgnoresQuery} · 过滤从 body 读=${readsFilterFromBody} · 路由把 query 放第二位=${queryIsSecondArg}）：删掉 client-core 的本地兜底与这两处注释里的"不被读"前提，再重跑 accept-tasks.ts`)
    }
    const clientSrc = readFileSync(join(clientRoot, 'packages/client-core/src/sidecar-client.ts'), 'utf8')
    const atList = clientSrc.indexOf('listTasks(')
    const listBody = atList === -1 ? '' : clientSrc.slice(atList, atList + 900)
    const onTheChain = /selectTasks\(page\.tasks, filter\)/.test(listBody) && /\.then\(\(page\)/.test(listBody)
    if (atList === -1) bad.push('`listTasks` 不见了（这条判定的客户端那一头无从对起）')
    else if (!onTheChain) bad.push('兜底不在链上：`listTasks` 没把回包交给 `selectTasks` 裁——那句"内核不读 query"现在只剩注释在替它作保')
    if (!/export \{ selectTasks \}/.test(readFileSync(join(clientRoot, 'packages/client-core/src/index.ts'), 'utf8'))) {
      bad.push('`selectTasks` 没从 client-core 出口导出——测试与面板拿不到同一个口径，就会出现第二份过滤')
    }
    const claims = clientSrc + readFileSync(join(clientRoot, 'packages/client-core/src/task-types.ts'), 'utf8')
    if (/router surfaces\s+query params to handlers|which is what\s*\n?\s*`?task-routes\.ts:197-200`? then reads/.test(claims)) {
      bad.push('docstring 还在宣称"内核会读这份 query"（已被现场实测否证）——按 accept-tasks.ts 判据 ⑪ 的实情改写')
    }
  }
  report(bad.length === 0, 'GET /tasks 的过滤面两头对齐（内核确实不读 query + 客户端确实自己裁 + 注释不再替假前提作保）', bad.join(' | '))
}

// 4. 漂移门的**身份读数**不许在台账里有第二处：事件条数与镜像 sha 每动一次协议就变，抄进正文的那一份
//    不会报错，只会安静地变成假话（本仓 10-12 就在 AA 候选 hex 上栽过一次，本轮又在镜像 56/sha 上抄出
//    两处）。这条钉的是**形状**：README 里出现 `sha \`hex\`` 这种写法就是红。它不管 md5 —— 那种
//    "我按这串逐字节还原过"是过去那一趟的历史证据，不是"现在是多少"的现状宣称。
{
  const shaCopies = []
  for (const file of readmeFiles()) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = /\bsha(?:256)?\s*`[0-9a-f]{8,}`/i.exec(line)
      if (m) shaCopies.push(`${relative(clientRoot, file).replace(/\\/g, '/')}:${i + 1} — ${m[0]}`)
    })
  }
  report(shaCopies.length === 0, '台账不抄漂移门的 sha（条数与哈希只由那条门自己打印）',
    shaCopies.length > 0 ? `${shaCopies.join(' | ')} —— 改成指回 corepack pnpm check:drift 的输出` : '0 处抄本')
}

// 5. 计划正文最后那格「附：调研证据索引」——它给的是**下一位读者去核证据的坐标**，所以坐标本身
//    也会烂（本轮实测：它把 `subscription-gate` 列在 `vscode-extension/src/sidecar/` 的括号里，而那个
//    文件在 `vscode-extension/src/chat/`）。但索引用的是**继承目录的简写**：同一行里 `serve.ts` 指的是
//    上一枚带目录的路径所在的 `src/server/`，`src/chat/` 指的是 `vscode-extension/src/chat/`。
//    所以这条判据必须先还原形状再问存在，否则它会红在一片根本没错的简写上。
{
  const repoRoot = resolve(clientRoot, '..')
  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（证据索引判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const text = readFileSync(planDoc, 'utf8')
    const at = text.indexOf('## 附：调研证据索引')
    const body = at === -1 ? '' : text.slice(at).split('\n').filter((l) => l.startsWith('- ')).join('\n')
    // 外部仓（不在本工作区）——它们不是"烂了"，是"不归本仓管"，逐名登记在下面的例外表里。
    const EXTERNAL_PREFIX = ['deepseek-harness/']
    const missing = []
    let checked = 0
    let externalSkipped = 0
    for (const raw0 of body.split('\n')) {
      // 整行的外部性：`dsh 前端：deepseek-harness/packages/client/、apps/web、apps/desktop` 这一行里
      // `apps/web` 指的是**外部那个仓**的 apps/web，不是本仓的。判据按"本行出现过外部仓路径"整行放行，
      // 但放行的枚数要打出来——悄悄少扫一类，正是这条判据要防的事。
      const lineExternal = [...raw0.matchAll(/`([^`]+)`/g)].some((m) => EXTERNAL_PREFIX.some((x) => m[1].startsWith(x)))
      // 每一行先收集"这行提到过的所有目录祖先"：`src/delegation/` 这类简写继承的是本行第一条
      // `vscode-extension/...` 的祖先，而不是紧邻的那一枚——只用最近一枚会把对的坐标判成错的。
      const bases = new Set([''])
      for (const m of raw0.matchAll(/`([^`]+)`/g)) {
        for (let d = m[1].replace(/[^/]+\/?$/, ''); ; ) {
          bases.add(d)
          if (d === '') break
          d = d.replace(/[^/]+\/$/, '')
        }
      }
      let dir = ''
      for (const m of raw0.matchAll(/`([^`]+)`|（([^（）]+)）/g)) {
        const raw = m[1] ?? m[2]
        if (raw === undefined) continue
        const parts = m[2] !== undefined ? raw.split('/').map((s) => s.trim()).filter(Boolean) : [raw.trim()]
        for (const p of parts) {
          // 括号组里既有文件名（launcher/client/...），也有散文注记（"9 个项目拆解"）——只认纯 ASCII
          // 标识符形状的那些；反引号里的整路径不过这条滤（本仓真有中文名：`2026-10-09-开源Agent客户端架构调研.md`）。
          if (m[2] !== undefined && !/^[A-Za-z0-9_.\-/]+$/.test(p)) continue
          if (p === '' || /\s/.test(p)) continue
          const target = p.includes('/') ? p : (dir ? dir + p : p)
          if (!p.includes('/') && !dir && !/\.(ts|md)$/.test(p)) continue
          if (lineExternal || EXTERNAL_PREFIX.some((x) => target.startsWith(x))) { externalSkipped += 1; continue }
          const base = target.replace(/\/$/, '')
          const leaves = /\.(ts|js|md)$/.test(base) ? [base] : [base + '.ts', base, base + '.tsx']
          const hit = [...bases, dir].some((b) => leaves.some((c) => existsSync(join(repoRoot, b + c))))
          checked += 1
          if (!hit) missing.push(target)
        }
        if (m[1] !== undefined && m[1].includes('/')) dir = m[1].replace(/[^/]+$/, '')
      }
    }
    report(checked >= 10, `计划证据索引里的坐标逐条定位（本轮认到 ${checked} 枚；少于 10 枚说明解析面坏了）`,
      checked < 10 ? '正控不成立：这一条绿没有意义——索引格式变了，门看不见' : '')
    const KNOWN_EVIDENCE_GAPS = ['vscode-extension/src/sidecar/subscription-gate']
    const gaps = missing.filter((p) => !KNOWN_EVIDENCE_GAPS.includes(p))
    const staleGaps = KNOWN_EVIDENCE_GAPS.filter((p) => !missing.includes(p))
    report(gaps.length === 0 && staleGaps.length === 0 && checked >= 10,
      '计划证据索引的坐标都能定位（不成立的逐名登记例外，登记了却已修好的也要红）',
      gaps.length > 0 ? `这些坐标在本仓找不到（不带扩展名的那些，.ts / .tsx / 目录 三种形状 × 本行各级基准都试过）：${gaps.join(' , ')} —— 要么改计划正文，要么把它登记成有理由的例外`
        : staleGaps.length > 0 ? `例外表里这几条已经不缺了（改了正文就删行）：${staleGaps.join(' , ')}` : `${checked} 枚坐标认过，${KNOWN_EVIDENCE_GAPS.length} 处已登记错位，${externalSkipped} 枚按外部仓放行`)
  }
}

// 6. §5.1 的头一条与最后一条是"已实证"的**启动形状**与**移植面**：启动要设哪两个环境变量、entry 在哪、
//    插件里那三个文件可以直接搬（其中两个带着行数宣称）。行数是这一族里最容易烂的一种数——插件那边动
//    一行，计划这里就错一行。正文归用户改，所以这条判据的职责是**在烂掉当天红并且点名**，不是替谁修文档。
{
  const repoRoot = resolve(clientRoot, '..')
  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§5.1 判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const lines = readFileSync(planDoc, 'utf8').split('\n')
    const bootLine = lines.find((l) => l.startsWith('- 启动：')) ?? ''
    const portLine = lines.find((l) => l.startsWith('- 可直接移植：')) ?? ''
    // 一枚 token 后面紧跟 `（N 行…）` 才算带行数宣称（`（9 行去重）` 也算——数字在前、注记在后）。
    const parseClaims = (line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => {
      const c = /^（(\d+) 行/.exec(line.slice(m.index + m[0].length))
      return { file: m[1], n: c ? Number(c[1]) : null }
    })
    const CLAIM_SHAPE = [
      { s: 'x `a/b/client.ts`（457 行）y', want: [{ file: 'a/b/client.ts', n: 457 }] },
      { s: 'x `stream-accept.ts`（9 行去重）y', want: [{ file: 'stream-accept.ts', n: 9 }] },
      { s: 'x `protocol.ts`、y', want: [{ file: 'protocol.ts', n: null }] },
    ]
    const badShape = CLAIM_SHAPE.filter((c) => JSON.stringify(parseClaims(c.s)) !== JSON.stringify(c.want))
    // 计划用的是**继承目录的简写**：`protocol.ts` 指的是同一行那条全路径所在的 `vscode-extension/src/sidecar/`。
    // 所以基准取本行提过的所有目录祖先，而不是紧邻的那一枚（与证据索引那条同一课）。
    const bases = new Set([''])
    for (const m of portLine.matchAll(/`([^`]+)`/g)) {
      for (let d = m[1].replace(/[^/]+\/?$/, ''); ; ) {
        bases.add(d)
        if (d === '') break
        d = d.replace(/[^/]+\/$/, '')
      }
    }
    const claims = parseClaims(portLine)
    const lineCount = (t) => { const a = t.split('\n'); return a[a.length - 1] === '' ? a.length - 1 : a.length }
    const resolveHit = (tok) => {
      const hits = new Set()
      for (const b of bases) for (const l of [tok, `${tok}.ts`, `${tok}.tsx`]) {
        const p = join(repoRoot, b + l)
        if (existsSync(p)) hits.add(p)
      }
      return [...hits]
    }
    const broken = []
    for (const c of claims) {
      const hits = resolveHit(c.file)
      if (hits.length === 0) { broken.push(`${c.file}：本仓找不到（带扩展名与 .ts/.tsx 三种形状 × 本行各级基准都试过）`); continue }
      if (hits.length > 1) { broken.push(`${c.file}：基准不唯一，命中 ${hits.map((h) => relative(repoRoot, h)).join(' , ')}`); continue }
      if (c.n === null) continue
      const n = lineCount(readFileSync(hits[0], 'utf8'))
      if (n !== c.n) broken.push(`${relative(repoRoot, hits[0])}：计划写 ${c.n} 行，实测 ${n} 行`)
    }
    report(badShape.length === 0, `§5.1「可直接移植」那行的"路径（N 行）"解析形状自证（${CLAIM_SHAPE.length} 条）`,
      badShape.length > 0 ? `解析器自己坏了：${badShape.map((c) => c.s).join(' | ')}` : '三种形状各认对了一次（带行数 / 行数后带注记 / 只报名字）')
    report(claims.length >= 3 && badShape.length === 0 && broken.length === 0,
      `§5.1 移植面逐条核回（认到 ${claims.length} 枚，其中 ${claims.filter((c) => c.n !== null).length} 枚带行数宣称；少于 3 枚说明解析面坏了）`,
      broken.length > 0 ? broken.join(' ｜ ') : `${claims.length} 枚都在，${claims.filter((c) => c.n !== null).length} 处行数宣称与实测逐字节行数一致`)

    // 启动形状：两个环境变量名与 entry 路径都从计划那一行 parse，不在这里重打一遍。
    // 「设了这个变量」要的是**赋值形状**，不是"文件里出现过这串名字"——变异 M4 实测：把启动器里的
    // `RIVET_DESKTOP_DIR` 改名成 `RIVET_DESKTOP_DIRX`（隔离当场失效）时，`includes()` 谓词照绿。
    const setsEnv = (text, name) => new RegExp(`\\b${name}\\b\\s*[:=]`).test(text)
    const ENV_SHAPE = [
      { s: 'x = { RIVET_DESKTOP_DIR: d }', name: 'RIVET_DESKTOP_DIR', want: true },
      { s: 'x = { RIVET_DESKTOP_DIRX: d }', name: 'RIVET_DESKTOP_DIR', want: false },
      { s: '// RIVET_DESKTOP_DIR 是给维护者看的', name: 'RIVET_DESKTOP_DIR', want: false },
      { s: 'env.RIVET_SERVER_TOKEN = t', name: 'RIVET_SERVER_TOKEN', want: true },
    ]
    const badEnvShape = ENV_SHAPE.filter((c) => setsEnv(c.s, c.name) !== c.want)
    const envs = [...bootLine.matchAll(/\b(RIVET_[A-Z_]+)=/g)].map((m) => m[1])
    const entry = /node\s+(\S+)\s+serve\s+--port/.exec(bootLine)?.[1] ?? ''
    const launcherPath = join(clientRoot, 'scripts', 'launch-sidecar.mjs')
    const launcher = existsSync(launcherPath) ? readFileSync(launcherPath, 'utf8') : ''
    const noEnv = envs.filter((e) => !setsEnv(launcher, e))
    const bootBad = [
      badEnvShape.length > 0 ? `赋值形状谓词自己坏了：${badEnvShape.map((c) => `${c.name} @ ${c.s}`).join(' , ')}` : '',
      envs.length < 2 ? `启动那一行没解析出环境变量名（认到 ${envs.length} 个：${envs.join(' , ')}）` : '',
      entry === '' ? '启动那一行没解析出 `node <entry> serve --port` 这枚形状' : '',
      launcher === '' ? `读不到启动器 ${relative(clientRoot, launcherPath)}` : '',
      noEnv.length > 0 ? `启动器不再设置计划点名的环境变量：${noEnv.join(' , ')}` : '',
      !launcher.includes("'serve'") || !launcher.includes("'--port'") ? '启动器不再用 serve --port 起内核' : '',
      entry !== '' && !existsSync(join(repoRoot, entry)) ? `计划那条启动行里的 ${entry} 不在盘上（内核没打出来）` : '',
    ].filter(Boolean)
    report(bootBad.length === 0, `§5.1 那条启动形状仍然对得上我们的启动器（${envs.length} 个环境变量 + ${entry || '无 entry'} + serve --port）`,
      bootBad.join(' ｜ ') || `${envs.length} 个名字都以赋值形状出现在启动器里，entry 在盘上`)

    // §5.1 第二条「**问能力不问版本**」。`sidecar-client.ts` 那句注释是宣称，不是证据：这条判据
    // 把两半都量出来——UI 面必须真的读 `capabilities.<名>` 来做功能开关，而 `protocolVersion` 在 UI 面
    // 里只许出现在栅栏（mismatch 那条横幅）上。将来谁写 `if (protocolVersion >= 5) 显示 X`，这条红。
    const uiPackages = readdirSync(join(clientRoot, 'packages')).filter((p) => p.startsWith('ui-'))
    const UI_PREFIXES = [`apps${sep}web${sep}src`, `packages${sep}store${sep}src`, ...uiPackages.map((p) => join('packages', p, 'src'))]
    // 面从共用件那张已经走好的树里筛（`byBase`），不再另起一份 walker：两份扫描面会各自漂移。
    const uiFiles = [...byBase.values()].flat().filter((p) => {
      const rel = relative(clientRoot, p)
      return /\.(tsx?)$/.test(rel) && UI_PREFIXES.some((pre) => rel.startsWith(`${pre}${sep}`))
    })
    const noComments = (s) => s
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const readFileSyncSafe = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
    const isGate = (line) => /\.capabilities\.\w+/.test(line)
    const isFence = (line) => /protocolVersion/.test(line) && /mismatch/i.test(line)
    const FENCE_SHAPE = [
      { s: 'canPatch={health?.capabilities.schedulePatch === true}', gate: true, fence: false },
      { s: 'const mismatch = health !== null && health.protocolVersion !== PROTOCOL_VERSION', gate: false, fence: true },
      { s: 'if (health.protocolVersion >= 5) showNewPanel()', gate: false, fence: false },
    ]
    const badFence = FENCE_SHAPE.filter((c) => isGate(c.s) !== c.gate || isFence(c.s) !== c.fence)
    const fenceLines = []
    let gates = 0
    let fences = 0
    for (const f of uiFiles) {
      noComments(readFileSyncSafe(f)).split('\n').forEach((line, i) => {
        if (isGate(line)) gates += 1
        if (!/protocolVersion/.test(line)) return
        if (isFence(line)) fences += 1
        else fenceLines.push(`${relative(clientRoot, f)} 第 ${i + 1} 行 ${line.trim().slice(0, 70)}`)
      })
    }
    // 面的正控：每个 ui-* 包都必须在面里有一份文件（少一个包＝那个包没人看过）
    const blindPackages = uiPackages.filter((p) => !uiFiles.some((f) => relative(clientRoot, f).startsWith(join('packages', p, 'src'))))
    report(badFence.length === 0, `「问能力不问版本」的两半谓词形状自证（${FENCE_SHAPE.length} 条：能力开关 / 栅栏 / 拿版本当开关的坏形状）`,
      badFence.length > 0 ? `谓词自己坏了：${badFence.map((c) => c.s).join(' ｜ ')}` : '能力开关认对、栅栏认对、`protocolVersion >= 5` 那种坏形状两边都不认')
    const fenceBad = [
      uiFiles.length < 20 ? `UI 面只认到 ${uiFiles.length} 份文件——扫描面坏了，这条绿不算数` : '',
      blindPackages.length > 0 ? `这些 ui-* 包在面外：${blindPackages.join(' , ')}` : '',
      badFence.length > 0 ? '两半谓词的形状自证没过' : '',
      gates < 1 ? 'UI 面里没有一处 `capabilities.<名>` 开关：那句"问能力"没有实现' : '',
      fenceLines.length > 0 ? `版本号被当成开关用在这些行：${fenceLines.join(' ｜ ')}` : '',
    ].filter(Boolean)
    report(fenceBad.length === 0,
      `§5.1「问能力不问版本」在 UI 面成立（扫 ${uiFiles.length} 份 / ${uiPackages.length} 个 ui-* 包都在面内，能力开关 ${gates} 处，版本号 ${fences} 处且全在栅栏上）`,
      fenceBad.join(' ｜ ') || `${fences} 处版本号引用全部落在 mismatch 横幅那几行；面里唯一的开关是 capabilities（上面计数）`)
  }
}

// 7. 目标文件夹那份 README（`analysis-reports/定稿-天枢客户端方案/README.md`）是**范围事实源的目录页**，
//    而它此前不在任何判据的扫描面里：`readmeFiles()` 只覆盖 `client/` 下的 README，`PATH_RE` 只认
//    `scripts|packages|apps/*.ts(x|css)`——四行设计资产的链接形状（`design/*.png`、`*.cjs`、中文文件名）
//    一条都不被认。这里按它自己的形状读：链接目标必须在盘上；那格尺寸宣称必须同时等于 PNG 的实际像素
//    与复截脚本的 viewport×DPR（三个独立事实源，谁漂了都会对不上）。
{
  const folder = finalFolder
  const readmePath = finalReadme
  if (!existsSync(readmePath)) {
    report(false, '定稿 README 在盘上（设计资产判据的前提）', `找不到 ${readmePath}——目标文件夹本身没了，这条没在量任何东西`)
  } else {
    const text = readFileSync(readmePath, 'utf8')
    // 锚点与外链不是文件，滤掉；剩下每一枚都是"这份目录页交给下一位读者的坐标"。
    const links = (t) => [...t.matchAll(/\[[^\]]*\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]).filter((p) => p !== '')
    const LINK_SHAPE = [
      { s: '| [design/a.png](design/a.png) | 说明 |', want: ['design/a.png'] },
      { s: '[plan](天枢Web桌面客户端自研计划-v2.0.md) — 计划', want: ['天枢Web桌面客户端自研计划-v2.0.md'] },
      { s: '[ext](https://example.com/x.png) 与 [锚](#内容)', want: [] },
    ]
    const sizeClaim = (t) => {
      const m = /（(\d+)×(\d+) @(\d)x）/.exec(t)
      return m === null ? null : { w: Number(m[1]), h: Number(m[2]), scale: Number(m[3]) }
    }
    const SIZE_SHAPE = [
      { s: 'x（1600×1000 @2x）y', want: { w: 1600, h: 1000, scale: 2 } },
      { s: 'x（44px 图标细条）y', want: null },
      { s: 'x（3200×2000 @1x）y', want: { w: 3200, h: 2000, scale: 1 } },
    ]
    const pngDims = (p) => {
      // 读之前先问在不在：这一族的失败必须是**一条红判定**，不是崩溃横幅（#85 那个形状——
      // 抛出去会绕过 catch，只剩一段栈，没人知道是哪一格坏了）。
      if (!existsSync(p)) return null
      const b = readFileSync(p)
      if (b.length < 24 || b.toString('latin1', 1, 8) !== 'PNG\r\n\x1a\n') return null
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    }
    const badShape = [
      ...LINK_SHAPE.filter((c) => JSON.stringify(links(c.s)) !== JSON.stringify(c.want)).map((c) => `链接：${c.s}`),
      ...SIZE_SHAPE.filter((c) => JSON.stringify(sizeClaim(c.s)) !== JSON.stringify(c.want)).map((c) => `尺寸：${c.s}`),
    ]
    report(badShape.length === 0, `定稿 README 的链接与"（宽×高 @Nx）"解析形状自证（${LINK_SHAPE.length + SIZE_SHAPE.length} 条）`,
      badShape.length > 0 ? `解析器自己坏了：${badShape.join(' ｜ ')}` : '外链/锚点被正确滤掉，@2x 认对，`44px` 那种非尺寸注记正确不认')

    const referenced = links(text)
    const gone = referenced.filter((p) => !existsSync(join(folder, p)))
    report(referenced.length >= 5 && badShape.length === 0 && gone.length === 0,
      `定稿 README 引用的资产逐个在盘上（认到 ${referenced.length} 枚，含计划正文与四行设计资产；少于 5 枚说明解析面坏了）`,
      gone.length > 0 ? `这些链接目标不在盘上：${gone.join(' , ')}` : `${referenced.length} 枚全部命中`)

    // 尺寸那格：README 的宣称 × PNG 的 IHDR × 复截脚本的 viewport/DPR
    const claims = []
    for (const line of text.split('\n')) {
      const c = sizeClaim(line)
      if (c === null) continue
      const l = links(line)
      claims.push({ ...c, file: l[0] ?? '' })
    }
    const scriptRel = referenced.find((p) => p.endsWith('.cjs')) ?? ''
    const scriptPath = join(folder, scriptRel)
    const scriptSrc = scriptRel === '' || !existsSync(scriptPath) ? '' : readFileSync(scriptPath, 'utf8')
    const num = (key) => Number(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(scriptSrc)?.[1] ?? NaN)
    const view = { width: num('width'), height: num('height'), dpr: num('deviceScaleFactor') }
    const sizeBad = []
    if (claims.length < 1) sizeBad.push('定稿 README 里没有一枚 `（宽×高 @Nx）` 尺寸宣称——那一格被改写了')
    if (scriptRel === '') sizeBad.push('认不到复截脚本（`.cjs` 链接）——那一行的形状变了')
    else if (scriptSrc === '') sizeBad.push(`复截脚本不在盘上：${scriptRel}（README 的链接指向一份不存在的文件）`)
    if (!Number.isInteger(view.width) || !Number.isInteger(view.height) || !Number.isInteger(view.dpr)) {
      sizeBad.push(`复截脚本 ${scriptRel || '(未认到)'} 里 width/height/deviceScaleFactor 没解析全：${JSON.stringify(view)}`)
    }
    for (const c of claims) {
      if (c.file === '') { sizeBad.push('有一枚尺寸宣称那一行没带链接——判据不知道该拿哪份 PNG 对'); continue }
      const d = pngDims(join(folder, c.file))
      if (d === null) { sizeBad.push(existsSync(join(folder, c.file)) ? `${c.file} 读不出一张 PNG 的头维` : `${c.file} 不在盘上，没法对尺寸`); continue }
      if (d.w !== c.w * c.scale || d.h !== c.h * c.scale) {
        sizeBad.push(`${c.file}：README 写 ${c.w}×${c.h} @${c.scale}x（应 ${c.w * c.scale}×${c.h * c.scale}），PNG 实际 ${d.w}×${d.h}`)
      }
      if (Number.isInteger(view.width) && Number.isInteger(view.dpr)
        && (c.w !== view.width || c.h !== view.height || c.scale !== view.dpr)) {
        sizeBad.push(`${c.file}：宣称 ${c.w}×${c.h}@${c.scale}x 与复截脚本 ${view.width}×${view.height}@${view.dpr}x 不是同一台设备形状`)
      }
    }
    const viewText = Number.isInteger(view.width) && Number.isInteger(view.height) && Number.isInteger(view.dpr)
      ? `${view.width}×${view.height}@${view.dpr}x` : '未解析出'
    report(sizeBad.length === 0 && badShape.length === 0,
      `定稿 README 的尺寸宣称三源对齐（README × PNG 头 × 复截脚本；认到 ${claims.length} 枚宣称，脚本 ${viewText}）`,
      sizeBad.join(' ｜ ') || `${claims.map((c) => `${c.w}×${c.h}@${c.scale}x → 像素 ${c.w * c.scale}×${c.h * c.scale}`).join('，')}，PNG 头与脚本 viewport×DPR 都算得出同一个数`)

    // 同一份目录页末尾的「过程稿（不在本目录）」也在对外指坐标：它用两枚 glob 说"那些稿子在别处"，
    // 括号里还点名四类调研报告。glob 与类名都是**只能现数**的宣称——稿子被搬走或删掉、某一类报告没了，
    // 上面那三条判据照旧绿（它们读的是「内容」那一节的 markdown 链接，不是这一节的行内代码）。
    const sec2 = (() => { const at2 = text.indexOf('## 过程稿'); return at2 === -1 ? '' : text.slice(at2) })()
    const globOf = (s) => s.includes('*')
    const globRe = (g) => new RegExp('^' + g.split('/').pop().split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    const RE_SHAPE = [
      { g: 'x/y/*-v1.*', names: ['a-v1.png', 'a-v2.png', 'a.png'], want: ['a-v1.png'] },
      { g: 'x/y/*.md', names: ['a.md', 'a.ts', 'ab.md'], want: ['a.md', 'ab.md'] },
      { g: 'x/y/ab.md', names: ['ab.md', 'cab.md'], want: ['ab.md'] },
    ]
    const reBad = RE_SHAPE
      .filter((c) => JSON.stringify(c.names.filter((n) => globRe(c.g).test(n))) !== JSON.stringify(c.want))
      .map((c) => `${c.g} → ${JSON.stringify(c.names.filter((n) => globRe(c.g).test(n)))}`)
    report(reBad.length === 0, `过程稿那枚 glob 的匹配器形状自证（${RE_SHAPE.length} 条：` + '`*-v1.*` 只认 v1、`*.md` 不吃 .ts、末段是具体名字时不许前缀匹配）',
      reBad.join(' ｜ ') || '三条夹具各匹配对了一次（具体名字那枚不会被同名前缀骗走）')

    const filesOf = (g) => {
      const segs = g.split('/')
      segs.pop()
      const dir = join(repoRoot, ...segs)
      if (!existsSync(dir)) return null
      const re = globRe(g)
      return readdirSync(dir).filter((n) => re.test(n))
    }
    const spans = [...sec2.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const globs = spans.filter(globOf)
    const expanded = globs.map((g) => ({ g, files: filesOf(g) }))
    const globBad = []
    if (sec2 === '') globBad.push('目录页里认不到「## 过程稿」那一节（那一半坐标从此没人读）')
    if (globs.length < 2) globBad.push(`只认到 ${globs.length} 枚 glob（少于 2 枚说明那一行的形状变了，绿不算数）`)
    for (const e of expanded) {
      if (e.files === null) globBad.push(`glob 的目录不在盘上：${e.g}`)
      else if (e.files.length === 0) globBad.push(`glob 数到 0 个文件：${e.g}——稿子被搬走或删了，目录页还在指它`)
    }
    report(globBad.length === 0 && reBad.length === 0 && globs.length >= 2,
      `定稿 README「过程稿」的每一枚 glob 都数得到真文件（${expanded.map((e) => `${e.g} → ${e.files === null ? '目录不在' : `${e.files.length} 个`}`).join('，')}）`,
      reBad.length > 0 ? 'glob 匹配器自己坏了（上一条已点名），这一条的读数不作数' : globBad.join(' ｜ ') || '两枚各展开出真文件')

    const kinds = (() => {
      const m = /调研报告（([^）]*)）/.exec(sec2)
      return m === null ? [] : m[1].split('、').map((s) => s.trim()).filter((s) => s.length > 0)
    })()
    const KIND_WATCH = [
      { kind: '对比分析', kw: '对比' },
      { kind: 'dsh 前端拆解', kw: 'dsh' },
      { kind: '行业调研', kw: '架构调研' },
      { kind: '协议调研', kw: 'protocols' },
    ]
    const mdEntry = expanded.find((e) => e.g.endsWith('*.md'))
    const mdFiles = mdEntry === undefined || mdEntry.files === null ? null : mdEntry.files
    const kindBad = []
    if (kinds.length !== KIND_WATCH.length) kindBad.push(`正文括号里点了 ${kinds.length} 类调研报告 vs 登记表 ${KIND_WATCH.length} 条`)
    for (const k of kinds) if (!KIND_WATCH.some((w) => w.kind === k)) kindBad.push(`正文那类「${k}」在登记表里没有对应条目`)
    for (const w of KIND_WATCH) if (!kinds.includes(w.kind)) kindBad.push(`登记表那类「${w.kind}」在正文括号里没有了`)
    const matched = []
    for (const w of KIND_WATCH) {
      if (mdFiles === null) { kindBad.push('认不到 `*.md` 那枚 glob（或它的目录不在盘上），四类没法对文件'); break }
      if (mdFiles.length < KIND_WATCH.length) { kindBad.push(`${mdEntry.g} 只展开出 ${mdFiles.length} 份 md，少于登记的 ${KIND_WATCH.length} 类`); break }
      const hit = mdFiles.find((f) => f.includes(w.kw))
      if (hit === undefined) kindBad.push(`那一类「${w.kind}」在展开出的 ${mdFiles.length} 份 md 里认不出关键词「${w.kw}」`)
      else if (matched.some((m) => m.file === hit)) kindBad.push(`「${w.kind}」与「${matched.find((m) => m.file === hit).kind}」共用同一份 ${hit}——四类各自要有自己的那份`)
      else matched.push({ kind: w.kind, file: hit })
    }
    report(kindBad.length === 0 && matched.length === KIND_WATCH.length && reBad.length === 0,
      `定稿 README 括号里点名的四类调研报告各能认出一份真文件（登记表 ${KIND_WATCH.length} 类，双向相等）`,
      reBad.length > 0 ? 'glob 匹配器自己坏了（上面已点名），四类的对文件不作数' : kindBad.join(' ｜ ') || matched.map((m) => `${m.kind}→${m.file}`).join(' ， '))
  }
}

// 8. §7 那七行「风险 / 等级 / 对策」此前只有人在台账里核过一遍（#49），而**表格本身没人读**：
//    计划加一行风险、改掉某行的对策说法，没有任何东西会红；六行的对策散在各门里，"谁在盯这一行"
//    也只存在于记忆里。这里把三件事钉在一起：行数与登记表**双向相等**、每行的对策说法里必须有登记的
//    关键子串、每条对策登记的归属文件必须在盘上且真的谈这件事。
{
  // 每行：对策里必须出现的说法 + 归属文件 + 那个文件里必须出现的证据子串。
  const RISK_WATCH = [
    { cell: '漂移检测', owner: 'scripts/gen-protocol-types.mjs', inOwner: 'drift' },
    { cell: 'RIVET_DESKTOP_DIR', owner: 'scripts/launch-sidecar.mjs', inOwner: 'RIVET_DESKTOP_DIR' },
    { cell: '同源伺服', owner: 'scripts/serve-client.mjs', inOwner: 'CORS' },
    { cell: '兜底轮询', owner: 'scripts/check-traps.mjs', inOwner: '审批' },
    { cell: '五类化', owner: 'packages/client-core/src/event-category.ts', inOwner: 'category' },
    { cell: '摘除', owner: 'scripts/check-layers.mjs', inOwner: 'AG-UI' },
    { cell: 'ACP', owner: 'scripts/check-nongoals.mjs', inOwner: 'ACP' },
  ]
  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§7 风险表判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const shapeBad = badSplitShape()
    report(shapeBad.length === 0, `§7 表格拆格的形状自证（${SPLIT_SHAPE.length} 条：普通行 / 转义竖线 / 分隔行）`, splitShapeText(shapeBad))
    const whole = readFileSync(planDoc, 'utf8')
    const at = whole.indexOf('## 7. 风险与对策')
    const rest = at === -1 ? '' : whole.slice(at)
    const endRel = rest.indexOf('\n---', 0)
    const sec = endRel === -1 ? rest : rest.slice(0, endRel)
    const rows = sec.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[-:\s|]+\|\s*$/.test(l))
      .map(splitCells)
      .filter((c) => c.length === 3 && c[0] !== '风险')
    const bad = []
    if (at === -1) bad.push('正文里认不到「## 7. 风险与对策」这一节')
    if (rows.length < 7) bad.push(`只认到 ${rows.length} 行风险（少于 7 行说明解析面坏了，这条绿不算数）`)
    if (rows.length !== RISK_WATCH.length) bad.push(`正文 ${rows.length} 行 vs 登记表 ${RISK_WATCH.length} 条——加一行风险要连登记表一起加`)
    rows.forEach((c, i) => {
      const w = RISK_WATCH[i]
      if (w === undefined) { bad.push(`第 ${i + 1} 行「${c[0]}」在登记表里没有对应条目`); return }
      if (!c[2].includes(w.cell)) bad.push(`第 ${i + 1} 行「${c[0]}」的对策里没有了「${w.cell}」（说法：${c[2]}）`)
      const p = join(clientRoot, w.owner)
      if (!existsSync(p)) { bad.push(`第 ${i + 1} 行登记的归属文件不在盘上：${w.owner}`); return }
      if (!readFileSync(p, 'utf8').includes(w.inOwner)) bad.push(`第 ${i + 1} 行的归属文件 ${w.owner} 里没有了「${w.inOwner}」——它还在盯这件事吗？`)
    })
    report(bad.length === 0 && shapeBad.length === 0,
      `§7 七行风险逐行对上"谁在盯"（登记表 ${RISK_WATCH.length} 条：对策说法 + 归属文件里真的有那句话）`,
      shapeBad.length > 0 ? '拆格器的形状自证没过（上一条已点名），这一条的比较不作数'
        : bad.join(' ｜ ') || `七行逐行对上；归属分别是 ${RISK_WATCH.map((w) => w.owner.replace(/^scripts\//, '').replace(/^packages\/client-core\/src\//, '')).join(' , ')}`)
  }
}

// 9. §1「背景与目标」是这份计划里最后一节还没有判据读过的（§2–§9 与证据索引都已逐行钉回过）。
//    它对外承诺两件事：那张三行阶段表（每个阶段做什么）与那句「非目标」三条（绝不做什么）。
//    ①每一枚对外承诺的功能都要在 §6 对应里程碑那一节里认得出——计划不能对外承诺一件它自己没排的事；
//      登记表与正文**双向**相等（加一枚功能、或把某阶段改名，都要红并且点名是哪一枚）。
//    ②三条非目标逐条登记"谁在盯"，归属文件必须真的还在谈这件事（与 §7 那张表同一把尺子）。
{
  const STAGE_WATCH = [
    { stage: 'MVP', heading: '### M1 MVP', features: [
      { name: '会话列表', kw: '会话' }, { name: '对话', kw: '对话' }, { name: '流式渲染', kw: '流式' }, { name: '审批', kw: '审批' }] },
    { stage: 'v1.0', heading: '### M2 v1.0', features: [
      { name: '历史分页', kw: '历史' }, { name: '文件预览', kw: '预览' }, { name: 'Git 工作台', kw: 'Git' },
      { name: '设置中心', kw: '设置' }, { name: '定时任务看板', kw: '定时' }] },
    { stage: 'v2.0', heading: '### M3 v2.0', features: [
      { name: 'Electron 壳', kw: 'Electron' }, { name: 'AG-UI 适配端点', kw: 'AG-UI' }] },
  ]
  const NON_GOAL_WATCH = [
    { kw: '不修改天枢内核与 sidecar 源码', owner: 'scripts/check-nongoals.mjs', inOwner: 'outside client/' },
    { kw: '不引入', owner: 'scripts/check-nongoals.mjs', inOwner: '不引入' },
    { kw: '不自造协议标准', owner: 'scripts/gen-protocol-types.mjs', inOwner: 'protocol.ts' },
  ]
  // 「浏览器 Web 客户端：会话列表 + 对话」→ 冒号后按 `、`/` + ` 拆，括号注丢掉（括注是给那一枚加的解释）。
  const feats = (goal) => {
    const after = goal.includes('：') ? goal.slice(goal.indexOf('：') + 1) : goal
    return after.split(/[、+]/).map((t) => t.trim().replace(/（.*$/, '').trim()).filter((t) => t.length > 0)
  }
  const FEAT_SHAPE = [
    { s: '甲：A + B', want: ['A', 'B'] },
    { s: '甲：A、B（一个产物，两种宿主）', want: ['A', 'B'] },
    { s: '没有冒号的一格', want: ['没有冒号的一格'] },
  ]
  const badFeatShape = FEAT_SHAPE.filter((c) => JSON.stringify(feats(c.s)) !== JSON.stringify(c.want))
  const badClauseShape = CLAUSE_SHAPE.filter((c) => JSON.stringify(clauses(c.s, c.lead)) !== JSON.stringify(c.want))
  report(badFeatShape.length === 0 && badClauseShape.length === 0,
    `§1 的拆功能与拆句形状自证（功能 ${FEAT_SHAPE.length} 条 + 分号条款 ${CLAUSE_SHAPE.length} 条：冒号后并列、顿号、括号注、无冒号、句末句号）`,
    [...badFeatShape.map((c) => `${c.s} → ${JSON.stringify(feats(c.s))}`), ...badClauseShape.map((c) => `${c.s} → ${JSON.stringify(clauses(c.s, c.lead))}`)].join(' ｜ ')
      || '功能枚举与分号条款各自拆对了一次（括号注与句末句号没被当成一枚功能）')

  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§1 那两条判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const whole = readFileSync(planDoc, 'utf8')
    const secOf = (marker, stop) => {
      const at = whole.indexOf(marker)
      if (at === -1) return ''
      const rest = whole.slice(at)
      const end = stop === undefined ? -1 : rest.indexOf(stop)
      return end === -1 ? rest : rest.slice(0, end)
    }
    const milestone = (heading) => {
      const at = s6.indexOf(heading)
      if (at === -1) return null
      const rest = s6.slice(at)
      const next = rest.indexOf('\n### ', 4)
      return next === -1 ? rest : rest.slice(0, next)
    }
    const s1 = secOf('## 1. 背景与目标', '\n---')
    const s6 = secOf('## 6. 里程碑与任务分解', '\n## 7.')
    const rows = s1.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[-:\s|]+\|\s*$/.test(l))
      .map(splitCells)
      .filter((c) => c.length === 2 && c[0] !== '阶段')
    const bad = []
    const byStage = new Map(rows.map((r) => [r[0], feats(r[1])]))
    const derivedTotal = [...byStage.values()].reduce((n, f) => n + f.length, 0)
    const registeredTotal = STAGE_WATCH.reduce((n, w) => n + w.features.length, 0)
    if (s1 === '') bad.push('正文里认不到「## 1. 背景与目标」这一节')
    if (s6 === '') bad.push('正文里认不到「## 6. 里程碑与任务分解」这一节（功能要落进它对应的那一节）')
    if (rows.length < 3) bad.push(`只认到 ${rows.length} 行阶段（少于 3 行说明拆表坏了，这条绿不算数）`)
    if (byStage.size !== rows.length) bad.push(`${rows.length} 行只得到 ${byStage.size} 个阶段名——阶段名重复或那一格拆坏了`)
    if (rows.length !== STAGE_WATCH.length) bad.push(`正文 ${rows.length} 行 vs 登记表 ${STAGE_WATCH.length} 条——加一个阶段要连登记表一起加`)
    if (derivedTotal !== registeredTotal) bad.push(`正文数到 ${derivedTotal} 枚功能 vs 登记表 ${registeredTotal} 枚`)
    for (const w of STAGE_WATCH) {
      const derived = byStage.get(w.stage)
      if (derived === undefined) { bad.push(`登记表里的阶段「${w.stage}」在正文表里没有这一行`); continue }
      const names = w.features.map((f) => f.name)
      for (const extra of derived.filter((d) => !names.includes(d))) bad.push(`「${w.stage}」正文里多出一枚功能「${extra}」——登记表没有它，也没人排它`)
      for (const miss of names.filter((n) => !derived.includes(n))) bad.push(`「${w.stage}」登记表里的功能「${miss}」在正文那一格里没有了`)
      const sec = milestone(w.heading)
      if (sec === null) { bad.push(`认不到里程碑标题「${w.heading}」（阶段「${w.stage}」登记在它名下）`); continue }
      for (const f of w.features) if (!sec.includes(f.kw)) bad.push(`「${w.stage}」的功能「${f.name}」在 ${w.heading} 那一节里认不出关键词「${f.kw}」——对外承诺了却没排`)
    }
    report(bad.length === 0 && badFeatShape.length === 0 && s1 !== '' && s6 !== '',
      `§1 阶段表逐行对上 §6（登记表 ${STAGE_WATCH.length} 个阶段 / ${registeredTotal} 枚功能，双向相等且各能在对应里程碑那一节认出关键词）`,
      badFeatShape.length > 0 ? '拆功能的形状自证没过（上一条已点名），这一条的比较不作数'
        : bad.join(' ｜ ') || `${rows.length} 行阶段 / ${derivedTotal} 枚功能逐枚对上；里程碑依次是 ${STAGE_WATCH.map((w) => w.heading.replace(/^### /, '').replace(/（.*$/, '')).join(' , ')}`)

    const ngLine = s1.split('\n').find((l) => l.includes('**非目标**'))
    const ngBad = []
    const items = ngLine === undefined ? [] : clauses(ngLine, '**非目标**：')
    if (ngLine === undefined) ngBad.push('§1 里没有「**非目标**」那一行')
    if (items.length > 0 && items.length < 3) ngBad.push(`只认到 ${items.length} 条非目标（少于 3 条说明拆句坏了，这条绿不算数）`)
    if (items.length !== NON_GOAL_WATCH.length) ngBad.push(`正文 ${items.length} 条 vs 登记表 ${NON_GOAL_WATCH.length} 条`)
    for (const it of items) {
      const w = NON_GOAL_WATCH.find((x) => it.includes(x.kw))
      if (w === undefined) { ngBad.push(`正文那条「${it}」在登记表里没有对应条目`); continue }
      const p = join(clientRoot, w.owner)
      if (!existsSync(p)) { ngBad.push(`「${w.kw}」登记的归属文件不在盘上：${w.owner}`); continue }
      if (!readFileSync(p, 'utf8').includes(w.inOwner)) ngBad.push(`「${w.kw}」的归属文件 ${w.owner} 里没有了「${w.inOwner}」——它还在盯这件事吗？`)
    }
    for (const w of NON_GOAL_WATCH) {
      if (!items.some((it) => it.includes(w.kw))) ngBad.push(`登记表那条（关键词「${w.kw}」）在正文里已经没有了`)
    }
    report(ngBad.length === 0 && badClauseShape.length === 0,
      `§1 三条非目标逐条对上"谁在盯"（登记表 ${NON_GOAL_WATCH.length} 条：每条的归属文件里真的有那句话）`,
      badClauseShape.length > 0 ? '拆句的形状自证没过（上面那条已点名），这一条的比较不作数'
        : ngBad.join(' ｜ ') || `三条逐条对上；归属分别是 ${NON_GOAL_WATCH.map((w) => `${w.owner.replace(/^scripts\//, '')}（钉「${w.inOwner}」）`).join(' , ')}`)

    // §1 开头那句**叙述**同样带着四件可对现实的事实（许可证 id / LICENSE 在不在 / `rivet serve` 真被派发 /
    // HTTP·SSE·Bearer 三件在内核各有归属）。上一格钉的是那张表和「非目标」那一行，叙述段仍是背景色。
    const narr = s1.split('\n').find((l) => {
      const t = l.trim()
      return t !== '' && !/^[#|>*-]/.test(t) && !t.includes('**非目标**') && !t.includes('---')
    }) ?? ''
    const licOf = (t) => (/\b(?:Apache|MIT|GPL|LGPL|AGPL|MPL|BSD)(?:-[\d.]+)?\b/i.exec(t) ?? [null])[0]
    const LIC_SHAPE = [
      { s: '完整开源（Apache-2.0），官方桌面端闭源', want: 'Apache-2.0' },
      { s: '许可证是 MIT 那一档', want: 'MIT' },
      { s: '（宽×高 @2x）那种括号不是许可证', want: null },
    ]
    const badLicShape = LIC_SHAPE.filter((c) => licOf(c.s) !== c.want).map((c) => `「${c.s}」→ ${JSON.stringify(licOf(c.s))}（应 ${JSON.stringify(c.want)}）`)
    report(badLicShape.length === 0, `§1 叙述段的许可证识别形状自证（${LIC_SHAPE.length} 条：带版本的 Apache / 裸 MIT / 非许可证的括号注要正确不认）`,
      badLicShape.join(' ｜ ') || '三条各认对一次（`（宽×高 @2x）` 那种括号没被当成许可证）')

    const pkgPath = join(repoRoot, 'package.json')
    const cliDir = join(repoRoot, 'src', 'cli')
    const cliFiles = existsSync(cliDir) ? readdirSync(cliDir).filter((n) => n.endsWith('.ts')) : []
    const cmdPhrase = (narr.match(/`([^`]+)`/) ?? [null, ''])[1].trim()
    const sub = cmdPhrase.includes(' ') ? cmdPhrase.split(/\s+/).pop() : cmdPhrase
    const dispatched = sub === '' || cliFiles.length === 0 ? []
      : cliFiles.filter((n) => new RegExp(`['"]${sub}['"]`).test(readFileSync(join(cliDir, n), 'utf8')))
    const narrBad = []
    if (narr === '') narrBad.push('§1 里认不到那句叙述（第一段正文）——那一节的形状变了')
    const lic = narr === '' ? null : licOf(narr)
    if (lic === null) {
      if (narr !== '') narrBad.push('那句叙述里认不出许可证 id（"完整开源（Apache-2.0）"那半被改写了，判据不知道该对什么）')
    } else {
      if (!existsSync(pkgPath)) narrBad.push(`package.json 不在盘上：${relative(clientRoot, pkgPath)}——没法对许可证 id`)
      else {
        const pkgLic = String(JSON.parse(readFileSync(pkgPath, 'utf8')).license ?? '')
        if (pkgLic !== lic) narrBad.push(`那句写 ${lic}，仓根 package.json 的 license 是 ${pkgLic || '(没有这一字段)'}`)
      }
      if (!existsSync(join(repoRoot, 'LICENSE'))) narrBad.push('那句说"完整开源"，仓根却没有 LICENSE 文件')
    }
    if (sub === '') narrBad.push(`那句里认不到反引号包住的命令名（现在拿到 ${JSON.stringify(cmdPhrase)}）`)
    else if (cliFiles.length === 0) narrBad.push(`扫不到 src/cli 下的 .ts（现 ${cliFiles.length} 份）——子命令这一半没在量任何东西`)
    else if (dispatched.length === 0) narrBad.push(`那句写 \`${cmdPhrase}\`，而 src/cli 的 ${cliFiles.length} 份源码里没有把 '${sub}' 当字符串派发（命令改名了？）`)
    report(narrBad.length === 0 && badLicShape.length === 0,
      `§1 那句叙述的许可证与命令名对上现实（${lic ?? '(未认到)'} × package.json × LICENSE 在盘；'${sub || '(未认到)'}' 命中 src/cli ${cliFiles.length} 份里的 ${dispatched.length} 份）`,
      badLicShape.length > 0 ? '许可证识别的形状自证没过（上一条已点名），这一条的比较不作数'
        : narrBad.join(' ｜ ') || `${lic} 与 package.json 的 license 一致、LICENSE 在盘上；\`${cmdPhrase}\` 由 ${dispatched.join(' , ')} 派发`)

    const PROTOCOL_WATCH = [
      { token: 'HTTP', file: 'src/server/index.ts', inFile: 'createServer' },
      { token: 'SSE', file: 'src/server/sse-stream.ts', inFile: 'text/event-stream' },
      { token: 'Bearer', file: 'src/server/auth.ts', inFile: 'Bearer' },
    ]
    const protoBad = []
    for (const w of PROTOCOL_WATCH) {
      if (narr !== '' && !narr.includes(w.token)) protoBad.push(`那句里没有了「${w.token}」（登记表还说三件齐——说法变了要连这张表一起改）`)
      const p = join(repoRoot, w.file)
      if (!existsSync(p)) { protoBad.push(`归属文件不在盘上：${w.file}`); continue }
      if (!readFileSync(p, 'utf8').includes(w.inFile)) protoBad.push(`${w.file} 里没有了「${w.inFile}」——它还在证明 ${w.token} 吗？`)
    }
    report(protoBad.length === 0 && narr !== '',
      `§1 那句里的三件协议各有内核归属文件（${PROTOCOL_WATCH.map((w) => w.token).join(' / ')}，逐个文件真的有那句证据）`,
      narr === '' ? '上一格已点名：§1 认不到那句叙述，这一条没在量任何东西'
        : protoBad.join(' ｜ ') || PROTOCOL_WATCH.map((w) => `${w.token}=${w.file}:${w.inFile}`).join(' ， '))
  }
}

// 10. 「设计定稿要点」三条是定稿的**成品形状**那一半。台账为它专门写了一张「定稿设计要点逐条对账」表，
//     但要点本身与那张表**互相都不被读**：设计稿加一枚信息架构、或台账那一行漏改，两侧都安静地绿。
//     钉三件事——拆条的形状自证；信息架构七枚逐枚对上归属文件（登记表双向，`三态审批` 要 once/always/deny
//     三枚齐）；七枚每枚都要在台账那张表里出现（缺哪枚 ⇒ 那张表过期，点名是哪一枚）。
{
  if (!existsSync(finalReadme)) {
    report(false, '定稿 README 在盘上（设计要点判据的前提）', `找不到 ${relative(clientRoot, finalReadme)}——这一条没在量任何东西`)
  } else {
    const ftext = readFileSync(finalReadme, 'utf8')
    const at = ftext.indexOf('## 设计定稿要点')
    const rest = at === -1 ? '' : ftext.slice(at)
    const endRel = rest.indexOf('\n## ', 4)
    const sec = endRel === -1 ? rest : rest.slice(0, endRel)
    const bullet = (lead) => {
      const line = sec.split('\n').find((l) => l.trim().startsWith('- ') && l.includes(lead))
      return line === undefined ? null : line.trim().slice(2)
    }
    const itemsOf = (line, sep) => {
      if (line === null) return []
      const after = line.includes('：') ? line.slice(line.indexOf('：') + 1) : line
      return after.split(sep)
        .map((t) => t.trim().replace(/（.*$/, '').replace(/[；;。，,]$/, '').trim())
        .filter((t) => t.length > 0)
    }
    const IA_WATCH = [
      { piece: '项目列表', owner: 'scripts/check-live-geometry.mjs', inOwner: ['us__proj'] },
      { piece: '最近对话', owner: 'scripts/check-live-geometry.mjs', inOwner: ['us__row'] },
      { piece: '对话流', owner: 'packages/client-core/src/event-category.ts', inOwner: ['thinking'] },
      { piece: '三态审批', owner: 'packages/ui-approval/src/index.tsx', inOwner: ['once', 'always', 'deny'] },
      { piece: 'composer', owner: 'apps/web/src/App.tsx', inOwner: ['composer'] },
      { piece: '折叠组右栏', owner: 'scripts/check-layout.mjs', inOwner: ['rail'] },
      { piece: '底部状态条', owner: 'apps/web/src/App.tsx', inOwner: ['app__status'] },
    ]
    const SPLIT_SHAPE = [
      { s: '信息架构：A / B / C（注） / D', sep: /\s*\/\s*/, want: ['A', 'B', 'C', 'D'] },
      // 定稿正文真实写法带来的那条：括注后面紧跟斜杠（没有前导空格），句末还挂着分号——
      // 上一版的夹具两种空格都写了，于是被这一行打了个假阳性，教训写在这条夹具里。
      { s: '信息架构：A（注）/ B；', sep: /\s*\/\s*/, want: ['A', 'B'] },
      { s: '视觉语言：甲、乙、丙', sep: /、/, want: ['甲', '乙', '丙'] },
      // 视觉语言那一行同时用中文顿号与中文逗号（`…（注），白底 + 蓝调灰、…`），第三行用分号——
      // 少认一种分隔就会把两枚并成一枚，就会像上一版那样把"我拆错了"报成"正文少了"。
      { s: '视觉语言：甲（注），乙、丙；', sep: /[、，]/, want: ['甲', '乙', '丙'] },
      { s: '品牌只在 X；SSE/AG-UI 收纳进 Y。', sep: /；/, want: ['品牌只在 X', 'SSE/AG-UI 收纳进 Y'] },
      { s: '没有冒号的一格', sep: /\s*\/\s*/, want: ['没有冒号的一格'] },
    ]
    const iaLine = bullet('信息架构')
    const pieces = itemsOf(iaLine, /\s*\/\s*/)
    const badSplit = SPLIT_SHAPE.filter((c) => JSON.stringify(itemsOf(c.s, c.sep)) !== JSON.stringify(c.want))
      .map((c) => `「${c.s}」→ ${JSON.stringify(itemsOf(c.s, c.sep))}`)
    report(badSplit.length === 0 && sec !== '' && pieces.length >= 7,
      `定稿「信息架构」的拆条形状自证（${SPLIT_SHAPE.length} 条夹具；正文数到 ${pieces.length} 枚）`,
      sec === '' ? '认不到「## 设计定稿要点」那一节——下面两条都没在量任何东西'
        : badSplit.length > 0 ? `拆条器自己坏了：${badSplit.join(' ｜ ')}`
          : pieces.length < 7 ? `正文只数到 ${pieces.length} 枚（少于 7 枚说明那一行的形状变了，绿不算数）`
            : `七枚各认一次：${pieces.join(' , ')}`)

    const watchBad = []
    if (pieces.length !== IA_WATCH.length) watchBad.push(`正文数到 ${pieces.length} 枚 vs 登记表 ${IA_WATCH.length} 条`)
    for (const extra of pieces.filter((x) => !IA_WATCH.some((w) => w.piece === x))) watchBad.push(`正文多出一枚「${extra}」——登记表没有它，也没人盯它`)
    for (const w of IA_WATCH) {
      if (!pieces.includes(w.piece)) { watchBad.push(`登记表那枚「${w.piece}」在正文信息架构里没有了`); continue }
      const p = join(clientRoot, w.owner)
      if (!existsSync(p)) { watchBad.push(`${w.piece} 的归属文件不在盘上：${w.owner}`); continue }
      const body = readFileSync(p, 'utf8')
      const miss = w.inOwner.filter((s) => !body.includes(s))
      if (miss.length > 0) watchBad.push(`${w.piece} 的归属文件 ${w.owner} 里没有了「${miss.join('」「')}」——它还在盯这一枚吗？`)
    }
    report(watchBad.length === 0 && badSplit.length === 0 && pieces.length >= 7,
      `定稿信息架构七枚逐枚对上归属文件（登记表 ${IA_WATCH.length} 条，双向；三态审批要求 once/always/deny 三枚齐）`,
      badSplit.length > 0 ? '拆条的形状自证没过（上一条已点名），这一条的比较不作数'
        : watchBad.join(' ｜ ') || `${pieces.length} 枚逐枚对上；归属依次是 ${IA_WATCH.map((w) => w.owner.replace(/^scripts\//, '').replace(/^packages\//, '').replace(/^apps\/web\/src\//, '')).join(' , ')}`)

    const ledger = readFileSync(join(clientRoot, 'README.md'), 'utf8')
    const lAt = ledger.indexOf('## 定稿「设计要点」逐条对账')
    const lRest = lAt === -1 ? '' : ledger.slice(lAt)
    const lEnd = lRest.indexOf('\n## ', 4)
    const lSec = lEnd === -1 ? lRest : lRest.slice(0, lEnd)
    const lRows = lSec.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[-:\s|]+\|\s*$/.test(l))
      .map(splitCells)
      .filter((c) => c.length === 3 && c[0] !== '定稿要点')
    const uncovered = pieces.filter((x) => !lRows.some((c) => c[0].includes(x)))
    report(lAt !== -1 && badSplit.length === 0 && lRows.length >= 7 && uncovered.length === 0,
      `台账「定稿设计要点逐条对账」那张表覆盖了信息架构的每一枚（表现 ${lRows.length} 行）`,
      lAt === -1 ? '台账里认不到「## 定稿「设计要点」逐条对账」这一节——那张表被改名或删了'
        : badSplit.length > 0 ? '拆条的形状自证没过（上面已点名），这一条不作数'
          : lRows.length < 7 ? `那张表只数到 ${lRows.length} 行（少于 7 行说明表或解析坏了）`
            : uncovered.length > 0 ? `这些要点在台账那张表里没有对应行：${uncovered.join(' , ')}` : `${pieces.length} 枚各有自己的那一行`)
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
if (!quiet) console.log('docs checks passed')
