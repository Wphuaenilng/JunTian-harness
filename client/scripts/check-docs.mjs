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
 *   node scripts/check-docs.mjs            # all package + app + root READMEs + EVIDENCE.md
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
// §6 那份登记名册住在模块级：block 12 填它，block 18（§9 DoD 的可签规则）要复用**同一份**——
// 复制第二份就有两处真相，正是本台账一路在反对的那种写法。
let BOX = []
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
  // EVIDENCE.md 是从本文件搬出去的缺陷账，不在 README 枚举形状里；不点名就整块脱门。
  const out = [join(clientRoot, 'README.md'), join(clientRoot, 'EVIDENCE.md')]
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

// 10. 「设计定稿要点」那三条是定稿的**成品形状**那一半。台账为它专门写了一张「定稿设计要点逐条对账」表，
//     但要点本身与那张表**互相都不被读**：设计稿加一枚、或台账那一行漏改，两侧都安静地绿。
//     三条要点各成一组，每组钉三件事——拆条的形状自证；该组每一枚逐枚对上归属文件（登记表双向，
//     `三态审批` 要 once/always/deny 三枚齐）；该组每一枚都要在台账那张表里出现（缺哪枚 ⇒ 表过期，点名）。
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
    // 登记表按要点分组。每组的 `ledger` 是这一枚在台账那张表里应当出现的字面量——默认等于枚名，
    // 只有定稿写全称、台账写简称时才需要显式别名（不然是会乱配的启发式）。
    const POINT_GROUPS = [
      {
        lead: '信息架构', sep: /\s*\/\s*/, min: 7,
        note: '三态审批要求 once/always/deny 三枚齐',
        watch: [
          { piece: '项目列表', owner: 'scripts/check-live-geometry.mjs', inOwner: ['us__proj'] },
          { piece: '最近对话', owner: 'scripts/check-live-geometry.mjs', inOwner: ['us__row'] },
          { piece: '对话流', owner: 'packages/client-core/src/event-category.ts', inOwner: ['thinking'] },
          { piece: '三态审批', owner: 'packages/ui-approval/src/index.tsx', inOwner: ['once', 'always', 'deny'] },
          { piece: 'composer', owner: 'apps/web/src/App.tsx', inOwner: ['composer'] },
          { piece: '折叠组右栏', owner: 'scripts/check-layout.mjs', inOwner: ['rail'] },
          { piece: '底部状态条', owner: 'apps/web/src/App.tsx', inOwner: ['app__status'] },
        ],
      },
      {
        lead: '视觉语言', sep: /[、，]/, min: 4,
        note: '定稿写「居中窄栏文档流」而台账那一行写简称，别名显式登记',
        watch: [
          { piece: 'dsh 真实 token', owner: 'scripts/check-mockup-tokens.mjs', inOwner: ['mockup'] },
          { piece: '白底 + 蓝调灰', owner: 'packages/ui-theme/src/tokens.css', inOwner: ['--nb-', '--bg-base'] },
          { piece: '近黑主按钮', owner: 'scripts/check-layout.mjs', inOwner: ['--nb-1000'] },
          { piece: '居中窄栏文档流', ledger: '居中窄栏', owner: 'scripts/check-layout.mjs', inOwner: ['--measure'] },
        ],
      },
      {
        lead: '品牌只在', sep: /；/, min: 2,
        note: '',
        watch: [
          { piece: '品牌只在侧栏头部一处', owner: 'scripts/check-layout.mjs', inOwner: ['us__brand'] },
          { piece: 'SSE/AG-UI 状态收纳进底部状态条', owner: 'apps/web/src/App.tsx', inOwner: ['app__status', 'lastSeq'] },
        ],
      },
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
    const badSplit = SPLIT_SHAPE.filter((c) => JSON.stringify(itemsOf(c.s, c.sep)) !== JSON.stringify(c.want))
      .map((c) => `「${c.s}」→ ${JSON.stringify(itemsOf(c.s, c.sep))}`)

    const ledger = readFileSync(join(clientRoot, 'README.md'), 'utf8')
    const lAt = ledger.indexOf('## 定稿「设计要点」逐条对账')
    const lRest = lAt === -1 ? '' : ledger.slice(lAt)
    const lEnd = lRest.indexOf('\n## ', 4)
    const lSec = lEnd === -1 ? lRest : lRest.slice(0, lEnd)
    const lRows = lSec.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[-:\s|]+\|\s*$/.test(l))
      .map(splitCells)
      .filter((c) => c.length === 3 && c[0] !== '定稿要点')

    for (const g of POINT_GROUPS) {
      const line = bullet(g.lead)
      const pieces = itemsOf(line, g.sep)
      report(badSplit.length === 0 && sec !== '' && line !== null && pieces.length >= g.min,
        `定稿「${g.lead}」的拆条形状自证（夹具 ${SPLIT_SHAPE.length} 条；正文数到 ${pieces.length} 枚，下界 ${g.min}）`,
        sec === '' ? '认不到「## 设计定稿要点」那一节——本组的三条判据都没在量任何东西'
          : badSplit.length > 0 ? `拆条器自己坏了：${badSplit.join(' ｜ ')}`
            : line === null ? `正文里没有以「${g.lead}」开头的那一行（改名或删条了？）`
              : pieces.length < g.min ? `正文只数到 ${pieces.length} 枚（少于 ${g.min} 枚说明那一行的形状变了，绿不算数）`
                : `${pieces.length} 枚各认一次：${pieces.join(' , ')}`)

      const watchBad = []
      if (line === null || pieces.length !== g.watch.length) watchBad.push(`正文数到 ${pieces.length} 枚 vs 登记表 ${g.watch.length} 条`)
      for (const extra of pieces.filter((x) => !g.watch.some((w) => w.piece === x))) watchBad.push(`正文多出一枚「${extra}」——登记表没有它，也没人盯它`)
      for (const w of g.watch) {
        if (!pieces.includes(w.piece)) { watchBad.push(`登记表那枚「${w.piece}」在正文里没有`); continue }
        const p = join(clientRoot, w.owner)
        if (!existsSync(p)) { watchBad.push(`${w.piece} 的归属文件不在盘上：${w.owner}`); continue }
        const body = readFileSync(p, 'utf8')
        const miss = w.inOwner.filter((s) => !body.includes(s))
        if (miss.length > 0) watchBad.push(`${w.piece} 的归属文件 ${w.owner} 里没有了「${miss.join('」「')}」——它还在盯这一枚吗？`)
      }
      report(watchBad.length === 0 && badSplit.length === 0 && pieces.length >= g.min,
        `定稿「${g.lead}」逐枚对上归属文件（登记表 ${g.watch.length} 条，双向${g.note ? '；' + g.note : ''}）`,
        badSplit.length > 0 || line === null || pieces.length < g.min ? '上一格（拆条形状）没过，这一条的比较不作数'
          : watchBad.join(' ｜ ') || `${pieces.length} 枚逐枚对上；归属依次是 ${g.watch.map((w) => w.owner.replace(/^scripts\//, '').replace(/^packages\//, '').replace(/^apps\/web\/src\//, '')).join(' , ')}`)

      const uncovered = pieces.filter((x) => {
        const key = g.watch.find((w) => w.piece === x)?.ledger ?? x
        return !lRows.some((c) => c[0].includes(key))
      })
      report(lAt !== -1 && badSplit.length === 0 && pieces.length >= g.min && lRows.length >= 7 && uncovered.length === 0,
        `台账「定稿设计要点逐条对账」那张表覆盖了「${g.lead}」的每一枚（表现 ${lRows.length} 行）`,
        lAt === -1 ? '台账里认不到「## 定稿「设计要点」逐条对账」这一节——那张表被改名或删了'
          : badSplit.length > 0 || pieces.length < g.min ? '上面拆条那一格没过，这一条不作数'
            : lRows.length < 7 ? `那张表只数到 ${lRows.length} 行（少于 7 行说明表或解析坏了）`
              : uncovered.length > 0 ? `这些要点在台账那张表里没有对应行：${uncovered.join(' , ')}` : `${pieces.length} 枚各有自己的那一行`)
    }
  }
}

// 11. 「怎么跑」是给下一位读者的**入口**，而入口的两端都会漂：本仓实测过一次它只列了 15 道门禁里的
//     11 道（读者不知道另外四扇存在），也实测过一次里面一句"七条 pathspec"与门内的八条常量各说各话。
//     所以钉三件事：导读里点到的 `pnpm <别名>` 必须真在 package.json 里；每道 `check:*` 门禁别名都必须
//     被导读点到一次（按别名或按它真正跑的那个脚本文件，文件名从命令串里 parse，不写死）；两边各配形状自证。
{
  const pkgPath = join(clientRoot, 'package.json')
  const ledgerPath = join(clientRoot, 'README.md')
  if (!existsSync(pkgPath) || !existsSync(ledgerPath)) {
    report(false, 'package.json 与台账都在盘上（导读判据的前提）',
      `${existsSync(pkgPath) ? '' : '缺 package.json '}${existsSync(ledgerPath) ? '' : '缺 README.md'}——下面三条没在量任何东西`)
  } else {
    const scriptsOf = (o) => Object.keys(o ?? {})
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const allNames = scriptsOf(pkg.scripts)
    const gated = allNames.filter((n) => n.startsWith('check:'))
    const txt = readFileSync(ledgerPath, 'utf8')
    const at = txt.indexOf('## 怎么跑')
    const rest = at === -1 ? '' : txt.slice(at)
    const endRel = rest.indexOf('\n## ', 4)
    const sec = endRel === -1 ? rest : rest.slice(0, endRel)
    // 只认"整个别名"：`check:mockup` 是 `check:mockup-render` 的前缀，裸 includes 会让前者被后者顶掉。
    const named = (needle) => {
      const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(esc + '(?![-\\w])').test(sec)
    }
    const fileOf = (cmd) => { const m = /node +(?:\.\/)?[\w./-]*?([\w.-]+\.mjs)/.exec(String(cmd)); return m === null ? '' : m[1] }
    const FILE_SHAPE = [
      { v: 'node scripts/check-docs.mjs --flag', want: 'check-docs.mjs' },
      { v: 'node ./scripts/lib/thing.mjs', want: 'thing.mjs' },
      { v: 'node --test packages/*/test/*.test.ts', want: '' },
    ]
    const badFileShape = FILE_SHAPE.filter((c) => fileOf(c.v) !== c.want).map((c) => `「${c.v}」→ ${JSON.stringify(fileOf(c.v))}（应 ${JSON.stringify(c.want)}）`)
    // pnpm 自己的子命令不是本仓别名——它们出现在导读里是正常的（`corepack pnpm install`）。
    const BUILTIN = ['install', 'add', 'remove', 'run', 'dlx', 'exec', 'list', 'init', 'link', 'patch', 'store', 'deploy']
    const BUILTIN_SHAPE = [
      { s: 'corepack pnpm install', want: ['install'] },
      { s: 'corepack pnpm check:docs --drift && pnpm test', want: ['check:docs', 'test'] },
    ]
    const mentionsOf = (s) => [...new Set([...s.matchAll(/pnpm +([a-zA-Z][\w:-]*)/g)].map((m) => m[1]))]
    const badMentionShape = BUILTIN_SHAPE.filter((c) => JSON.stringify(mentionsOf(c.s)) !== JSON.stringify(c.want)).map((c) => `「${c.s}」→ ${JSON.stringify(mentionsOf(c.s))}`)
    report(badFileShape.length === 0 && badMentionShape.length === 0,
      `导读判据的形状自证（脚本名 ${FILE_SHAPE.length} 条 + 别名抽取 ${BUILTIN_SHAPE.length} 条：` + '带 flag 的、带 `./` 的、不是脚本的命令、一条里两个别名）',
      [...badFileShape, ...badMentionShape].join(' ｜ ') || '四组夹具各认对一次')
    const badAlias = mentionsOf(sec).filter((m) => !BUILTIN.includes(m) && !allNames.includes(m))
    report(at !== -1 && badAlias.length === 0 && badFileShape.length === 0 && badMentionShape.length === 0,
      `「怎么跑」点到的每条 pnpm 别名都真存在于 package.json（点名 ${mentionsOf(sec).length} 个，其中内建命令 ${mentionsOf(sec).filter((m) => BUILTIN.includes(m)).length} 个被正确放过）`,
      at === -1 ? '台账里认不到「## 怎么跑」这一节——这一条没在量任何东西'
        : badFileShape.length + badMentionShape.length > 0 ? '上面那条形状自证没过，这一条不作数'
          : badAlias.join(' ｜ ') || '每一个点名的别名都对得上')
    const unhung = gated.filter((g) => { const f = fileOf(pkg.scripts[g]); return !named(g) && !(f !== '' && named(f)) })
    report(gated.length >= 12 && unhung.length === 0 && badFileShape.length === 0,
      `每道门禁别名（package.json 里 ${gated.length} 个 check:*）都被「怎么跑」点到一次——按别名或按它真正跑的脚本文件`,
      gated.length < 12 ? `只数到 ${gated.length} 个 check:* 别名（少于 12 个说明 package.json 或扫描坏了，这条绿不算数）`
        : badFileShape.length > 0 ? '脚本名解析的形状自证没过（上面已点名），这一条不作数'
          : unhung.join(' ｜ ') || `${gated.length} 道全在导读里（别名或脚本文件名各认一次）`)
  }
}

// 12. §6 那批复选框是计划**对外的任务清单本身**。#189 已经要求 §1 阶段表里每一枚功能能在 §6 认出，
//     但反方向此前没人钉：§6 加一条、改一条、或把某条悄悄勾成"已完成"，都没有门知道——这和 §5.2 六条坑、
//     §7 七行风险、设计要点七枚是同一族"没人读的清单"（本仓那一族已各过一次，见 #185/#186/#192/#194）。
//     登记表给每一条一个状态，四种之一，且**都不许静默**：
//       done    归属文件里真放着那句实现证据；
//       partial 只做成一部分（其余按协议不可达或宿主形态差异），除归属证据外还必须在台账里读得到那句偏差说法；
//       parked  你已裁定的搁置/不接/后置，必须在台账里读得到那句裁定；
//       await   还没收口（要一次真上游调用、或等你点头），必须在台账里读得到那句欠账。
//     「没做」与「没人说它没做」是两回事——这条判据的存在理由就是这个差别。
{
  BOX = [
    { m: 'M0', kw: '启动脚本固化', st: 'done', owner: 'scripts/launch-sidecar.mjs', inOwner: 'RIVET_DESKTOP_DIR', row: 'M0 #1 启动脚本固化' },
    { m: 'M0', kw: '握手确认', st: 'done', owner: 'scripts/check-health.mjs', inOwner: 'capabilities', row: 'M0 #2 `/health` 握手' },
    { m: 'M0', kw: '单 HTML 页直连', st: 'done', owner: 'apps/spike/index.html', inOwner: 'getReader', row: 'M0 #3 单页直连 SSE 收发消息' },
    { m: 'M0', kw: '浏览器看到流式', st: 'done', owner: 'apps/spike/index.html', inOwner: 'turn_complete', row: 'M0 #4 验收（浏览器见流式 delta）' },
    { m: 'M1', kw: 'REST + SSE', st: 'done', owner: 'packages/client-core/src/event-category.ts', inOwner: 'text_delta', row: 'M1 `client-core`' },
    { m: 'M1', kw: '会话列表', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'archiveSession', row: 'M1 `ui-session` / `ui-chat` / `ui-approval`' },
    { m: 'M1', kw: 'PartialAccumulator', st: 'done', owner: 'packages/client-core/src/session-model.ts', inOwner: 'PartialAccumulator', row: 'M1 `ui-session` / `ui-chat` / `ui-approval`' },
    { m: 'M1', kw: '三态面板', st: 'done', owner: 'packages/ui-approval/src/answer.ts', inOwner: 'always', row: 'M1 `ui-session` / `ui-chat` / `ui-approval`' },
    { m: 'M1', kw: '中止', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'abort(id: string)', row: 'M1 `/abort`、错误条、`status` 展示' },
    // 这一格是**活过一次**，不是常驻制品：2026-10-10 经你授权拿真上游端到端跑过（台账「§9 MVP 活流端到端」那行
    // 记着 53 条事件账与 4 发上游请求的花费）。#195 初版把它登记成 await 是**我自己读错了自己写的交接**，
    // 2026-10-14 反着从现实的表里量出来才发现（见「里程碑状态 ↔ 登记表」那条判定）。
    { m: 'M1', kw: '完整跑通', st: 'once', say: '真打了一发上游', row: '§9 MVP 活流端到端' },
    { m: 'M2', kw: '历史向上分页', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'historyPage', row: 'M2 历史向上分页（冷通道）' },
    { m: 'M2', kw: '流式 diff', st: 'partial', owner: 'packages/client-core/src/tool-file.ts', inOwner: 'uiContent', sayFile: 'EVIDENCE.md', say: '行进度', row: 'M2 流式 diff 三件套' },
    { m: 'M2', kw: '影子 checkpoint', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'rewindPoints', row: 'M2 影子检查点面板（`ui-git`）' },
    { m: 'M2', kw: '会话搜索', st: 'partial', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'searchSessions', say: '根与布局两处都不一致', row: 'M2 会话搜索' },
    { m: 'M2', kw: 'Git 工作台', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'sessionOpenPr', row: 'M2 Git 工作台（读路径）' },
    { m: 'M2', kw: '设置中心', st: 'done', owner: 'scripts/accept-settings.ts', inOwner: '/config', row: 'M2 设置中心（`ui-settings`）' },
    { m: 'M2', kw: '定时任务看板', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'listScheduledTasks', row: 'M2 定时任务看板（`ui-schedule`）' },
    { m: 'M2', kw: 'Cockpit 快照条', st: 'done', owner: 'packages/client-core/src/sidecar-client.ts', inOwner: 'cockpit(id: string)', row: 'M2 Cockpit 快照条' },
    { m: 'M2', kw: 'MCP Apps', st: 'done', owner: 'packages/ui-primitives/src/app-frame.ts', inOwner: 'postMessage', row: 'M2 明暗主题 × MCP Apps 的接缝' },
    { m: 'M2', kw: 'i18n 双语', st: 'done', owner: 'packages/ui-theme/src/index.ts', inOwner: 'data-theme', row: 'M2 i18n 双语（`@tianshu/locale`）' },
    { m: 'M3', kw: 'Electron 壳', st: 'done', owner: 'apps/desktop/src/main.mjs', inOwner: 'requestSingleInstanceLock' },
    { m: 'M3', kw: 'electron-builder', st: 'parked', say: '两项搁置' },
    { m: 'M3', kw: 'AG-UI 适配端点', st: 'partial', owner: 'packages/client-core/src/ag-ui.ts', inOwner: 'text_delta', say: '是搁置不是完成', row: 'M3 AG-UI 适配端点' },
    { m: 'M3', kw: 'E4 客户端工具委托', st: 'parked', say: 'E4 你已定不接' },
    { m: 'M3', kw: 'ACP 适配层', st: 'parked', owner: 'scripts/check-nongoals.mjs', inOwner: 'ACP', say: '后置为独立项目' },
  ]
  const THREAD = [
    { kw: '协议漂移监控', owner: 'scripts/ci-smoke.mjs', inOwner: 'drift' },
    { kw: '协议消费台账', owner: 'scripts/protocol-ledger.mjs', inOwner: '事件' },
  ]
  // 复选框行的真实写法有四种要各认一次：带括号注与斜杠、带粗体与冒号、以「（可选，独立项目）」开头、
  // 已勾选那一枚（正文里现在没有，但解析器必须认得——否则"被人勾掉"这一类永远看不见）。
  const boxOf = (l) => {
    const m = /^- \[([ xX])\] (\S.*)$/.exec(l)
    return m === null ? null : { tick: m[1], text: m[2] }
  }
  const BOX_SHAPE = [
    { s: '- [ ] 启动脚本固化（随机端口/token + `RIVET_DESKTOP_DIR` 隔离 + CORS 开发开关）；', tick: ' ', head: '启动脚本固化' },
    { s: '- [ ] **流式 diff**（Cline 三件套思路：改前视图 + 增量写入 + 行进度装饰）；', tick: ' ', head: '**流式 diff**' },
    { s: '- [ ] （可选，独立项目）ACP 适配层，面向 Zed/JetBrains 分发——**做就做完整版**。', tick: ' ', head: '（可选，独立项目）ACP' },
    { s: '- [x] 已经勾掉的一条。', tick: 'x', head: '已经勾掉的一条。' },
    { s: '- 协议漂移监控 CI：类型镜像 diff + 冒烟；', tick: null, head: null },
    { s: '  - [ ] 缩进里的子项（§6 现在没有；有了要连登记面一起改）', tick: null, head: null },
  ]
  const badBoxShape = BOX_SHAPE.filter((c) => {
    const g = boxOf(c.s)
    if (c.tick === null) return g !== null
    return g === null || g.tick !== c.tick || !g.text.startsWith(c.head)
  }).map((c) => `「${c.s.slice(0, 24)}…」→ ${JSON.stringify(boxOf(c.s))}`)
  report(badBoxShape.length === 0,
    `§6 复选框解析的形状自证（${BOX_SHAPE.length} 条夹具：括号注、粗体冒号、以「（可选）」开头、已勾选那枚、两种不该算的行）`,
    badBoxShape.join(' ｜ ') || '六条夹具各认对一次（普通条目与缩进子项都没被当成复选框）')

  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§6 判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const plan = readFileSync(planDoc, 'utf8')
    const at6 = plan.indexOf('## 6. 里程碑与任务分解')
    const rest6 = at6 === -1 ? '' : plan.slice(at6)
    const to7 = rest6.indexOf('\n## 7.')
    const s6 = to7 === -1 ? rest6 : rest6.slice(0, to7)
    const secOf = (prefix) => {
      const a = s6.indexOf('### ' + prefix)
      if (a === -1) return null
      const r = s6.slice(a)
      const n = r.indexOf('\n### ', 4)
      return n === -1 ? r : r.slice(0, n)
    }
    const ms = ['M0', 'M1', 'M2', 'M3']
    const derived = new Map(ms.map((k) => {
      const sec = secOf(k + ' ')
      const lines = sec === null ? [] : sec.split('\n').map(boxOf).filter((b) => b !== null)
      return [k, lines]
    }))
    const derivedTotal = [...derived.values()].reduce((n, v) => n + v.length, 0)
    const ticked = [...derived.values()].flat().filter((b) => b.tick !== ' ')
    const bad = []
    if (s6 === '') bad.push('正文里认不到「## 6. 里程碑与任务分解」这一节')
    if (derivedTotal < 20) bad.push(`只数到 ${derivedTotal} 条复选框（少于 20 条说明拆面坏了，这条绿不算数）`)
    for (const k of ms) if (secOf(k + ' ') === null) bad.push(`认不到里程碑标题「### ${k}」`)
    for (const k of ms) {
      const rows = derived.get(k) ?? []
      const want = BOX.filter((w) => w.m === k)
      if (rows.length !== want.length) bad.push(`${k} 正文 ${rows.length} 条 vs 登记表 ${want.length} 条——加一条任务要连登记表一起加`)
      for (const w of want) {
        const hits = rows.filter((r) => r.text.includes(w.kw))
        if (hits.length === 0) bad.push(`${k} 登记表那条「${w.kw}」在正文里认不出——被改名还是被删了？`)
        if (hits.length > 1) bad.push(`${k} 那条的关键词「${w.kw}」命中 ${hits.length} 行，认不准是谁（关键词要唯一）`)
      }
      for (const r of rows) if (!want.some((w) => r.text.includes(w.kw))) bad.push(`${k} 正文多出一条「${r.text.slice(0, 28)}…」——登记表没有它，也就没人执行它`)
    }
    if (ticked.length > 0) bad.push(`正文里有 ${ticked.length} 条被勾成已完成（${ticked.map((b) => b.text.slice(0, 20)).join(' , ')}）——本仓的进度住在台账，要勾得连这条规矩一起改`)
    report(bad.length === 0 && badBoxShape.length === 0 && s6 !== '',
      `§6 的复选框与登记表逐里程碑双向相等（登记表 ${BOX.length} 条 = ${ms.map((k) => `${k}:${(derived.get(k) ?? []).length}`).join(' / ')}），且正文一条都不许勾`,
      badBoxShape.length > 0 ? '复选框解析的形状自证没过（上一条已点名），这一条的比较不作数'
        : s6 === '' ? '认不到 §6 那一节，这一条没在量任何东西'
          : bad.join(' ｜ ') || `${derivedTotal} 条逐条认一次，正文未被勾选`)

    const stBad = []
    const sayFileOf = (w) => w.sayFile ?? 'README.md'
    const ledgerCache = new Map()
    const ledgerOf = (name) => {
      if (!ledgerCache.has(name)) {
        const p = join(clientRoot, name)
        ledgerCache.set(name, existsSync(p) ? readFileSync(p, 'utf8') : '')
      }
      return ledgerCache.get(name)
    }
    for (const w of BOX) {
      if (w.owner !== undefined) {
        const p = join(clientRoot, w.owner)
        if (!existsSync(p)) { stBad.push(`${w.kw} 的归属文件不在盘上：${w.owner}`); continue }
        if (!readFileSync(p, 'utf8').includes(w.inOwner)) stBad.push(`${w.kw} 的归属文件 ${w.owner} 里没有了「${w.inOwner}」——它还在做这一条吗？`)
      }
      if (w.st !== 'done') {
        if (w.say === undefined) { stBad.push(`${w.kw} 登记成 ${w.st} 却没写要在台账读到哪句话`); continue }
        const body = ledgerOf(sayFileOf(w))
        if (body === '') stBad.push(`${w.kw} 要读的那份台账不在盘上：${sayFileOf(w)}`)
        else if (!body.includes(w.say)) stBad.push(`${w.kw}（${w.st}）在 ${sayFileOf(w)} 里读不到「${w.say}」——裁定或欠账的说法没了，这条就成了静默的"没做"`)
      }
    }
    const bySt = (k) => BOX.filter((w) => w.st === k).length
    report(stBad.length === 0 && badBoxShape.length === 0 && s6 !== '' && ledgerOf('EVIDENCE.md') !== '',
      `§6 每条的状态都有出处（${[...new Set(BOX.map((w) => w.st))].map((k) => `${k} ${bySt(k)}`).join(' / ')}，合计 ${BOX.length}；非 done 一律要求在台账里读得到那句话）`,
      s6 === '' ? '上一格已点名认不到 §6，这一条不作数'
        : badBoxShape.length > 0 ? '形状自证没过（上面已点名），这一条不作数'
          : ledgerOf('EVIDENCE.md') === '' ? 'EVIDENCE.md 不在盘上——partial 那格没有可读的第二份台账'
            : stBad.join(' ｜ ')
              || `${BOX.length} 条状态各对上：归属文件 ${BOX.filter((w) => w.owner !== undefined).length} 处有证据、非 done ${BOX.length - bySt('done')} 条各有裁定或欠账说法`)

    // 「里程碑状态（实测，非计划复述）」那张表与上面这份登记表**以前互不相认**：表里写 ✅ 而登记表写 partial
    // （或反过来）时两侧都照绿——这正是 #109 记过的"台账两行互打脸，没有门能抓"。落这条判定当场量出两处：
    //   ① M1「完整跑通」被我登记成 await，而表里那行的证据列写着 2026-10-10 经你授权拿真上游端到端跑过
    //     （53 条事件账 + 4 发上游请求的花费）——**是我读错了自己写的交接**，登记表改成 `once`（活过一次，
    //     不是常驻制品）；② 表里「M2 流式 diff 三件套」写 ✅，而登记表与 EVIDENCE 都判"两件半、第三件按协议
    //     不可达"——表的判定列过报，已改成 ⚠。别名只覆盖能对上的那些行；没别名的行不在这条射程里（如实打印）。
    const VERDICT = { done: '✅', once: '✅', partial: '⚠', parked: '⏸' }
    const ledgerNow = ledgerOf('README.md')
    const tAt = ledgerNow.indexOf('## 里程碑状态')
    const tRest = tAt === -1 ? '' : ledgerNow.slice(tAt)
    const tEnd = tRest.indexOf('\n## ', 4)
    const tSec = tEnd === -1 ? '' : tRest.slice(0, tEnd)
    const tRows = tSec.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[-:\s|]+\|\s*$/.test(l))
      .map(splitCells).filter((c) => c.length === 3 && c[0] !== '计划项')
    const aliased = BOX.filter((w) => w.row !== undefined)
    const vBad = []
    if (tAt === -1) vBad.push('台账里认不到「## 里程碑状态」那一节——别名一条都没在被比')
    if (tRows.length < 30) vBad.push(`那张表只数到 ${tRows.length} 行（少于 30 行说明拆表坏了，比较不作数）`)
    // 等号棘轮（与产品 CSS 颜色字面量那枚同一种做法）：别名条数必须**等于**登记的那个数。
    // 只设下界拦不住"悄悄少钉一条"——变异 Y3 实测：删掉一条别名，下界 15 照绿。要缩小覆盖就得当面改这里。
    const ALIAS_RATCHET = 21
    if (aliased.length !== ALIAS_RATCHET) vBad.push(`带表内别名的登记是 ${aliased.length} 条，而棘轮钉在 ${ALIAS_RATCHET} 条——多钉要一起改这个数，少钉必须当着门说明为什么不再比那一行`)
    for (const w of aliased) {
      const hits = tRows.filter((c) => c[0].startsWith(w.row))
      if (hits.length !== 1) { vBad.push(`别名「${w.row}」在表里命中 ${hits.length} 行（要恰好一行）`); continue }
      const cell = hits[0][1]
      const want = VERDICT[w.st]
      if (w.st === 'parked' ? /^✅/.test(cell) : !cell.startsWith(want)) vBad.push(`「${w.kw}」登记为 ${w.st}，表里那一行却写「${cell.slice(0, 26)}」`)
    }
    const uncoveredRows = tRows.filter((c) => !aliased.some((w) => c[0].startsWith(w.row)))
    report(vBad.length === 0 && stBad.length === 0 && tAt !== -1 && tRows.length >= 30 && aliased.length === ALIAS_RATCHET,
      `登记表 ↔「里程碑状态」那张表的判定列逐条相容（别名棘轮 ${ALIAS_RATCHET} 条；done/once 要 ✅、partial 要 ⚠、parked 不得写 ✅）`,
      tAt === -1 ? '认不到那一节，这一条没在量任何东西'
        : tRows.length < 30 || aliased.length !== ALIAS_RATCHET ? `面塌了（表 ${tRows.length} 行 / 别名 ${aliased.length} 条 ≠ 棘轮 ${ALIAS_RATCHET}）——上面的比较不作数`
          : vBad.join(' ｜ ')
            || `${aliased.length} 条逐条相容；那张表另有 ${uncoveredRows.length} 行没有别名（那条不在本判据射程，包括历史条目与新增格）`)

    // 已裁定的事不许在那张表里被写成待决。#162 给 CI 名册钉过同一族（名册把已跑绿的 AA 门写成"故意红不接"），
    // 那条只盖到名册；这条把面放到状态表正文。只扫这一节是有意的：别处的历史快照段里"当年是 9 对不过"是**如实**，
    // 全文禁它就是把日期标注的读数当成谎报来删。命中数由短语表派生，加一条裁定就加一枚短语。
    const CLOSED_BANNED = ['AA 等你定', '故意红，不接']
    const BAN_SHAPE = [
      { s: '浅色对比度 9 对不过 AA 等你定（#29）', want: 1 },
      { s: '这一行没有那些字', want: 0 },
      { s: 'AA 配色门仍是故意红，不接 CI', want: 1 },
    ]
    const hitsOf = (text) => CLOSED_BANNED.filter((p) => text.includes(p)).length
    const badBanShape = BAN_SHAPE.filter((c) => hitsOf(c.s) !== c.want)
      .map((c) => `「${c.s.slice(0, 20)}…」命中 ${hitsOf(c.s)} 次，应为 ${c.want}`)
    report(badBanShape.length === 0 && tAt !== -1,
      `裁定闭合说法的形状自证（${BAN_SHAPE.length} 条夹具 × ${CLOSED_BANNED.length} 枚禁句：命中数各对一次）`,
      badBanShape.join(' ｜ ') || (tAt === -1 ? '上一格已点名认不到那一节' : `${CLOSED_BANNED.length} 枚禁句在三条夹具上各命中对的一次`))
    const staleInTable = CLOSED_BANNED.filter((p) => tSec.includes(p))
    report(badBanShape.length === 0 && staleInTable.length === 0 && tAt !== -1,
      `「里程碑状态」那张表里没有把已裁定的事写成待决（禁句 ${CLOSED_BANNED.length} 枚，逐枚点名）`,
      tAt === -1 ? '认不到那一节，这一条没在量任何东西'
        : badBanShape.length > 0 ? '形状自证没过（上一条已点名），这一条不作数'
          : staleInTable.join(' ｜ ') || `那张表 ${tRows.length} 行的正文里，${CLOSED_BANNED.length} 枚禁句一条都没出现`)

    const thBad = []
    const thSecIdx = s6.indexOf('### 贯穿项')
    const thSec = thSecIdx === -1 ? '' : s6.slice(thSecIdx)
    const thLines = thSec.split('\n').filter((l) => /^- \S/.test(l))
    if (thSecIdx === -1) thBad.push('§6 里认不到「### 贯穿项」那一节')
    if (thLines.length < THREAD.length) thBad.push(`那一节只有 ${thLines.length} 条条目（少于登记表 ${THREAD.length} 条，拆面坏了）`)
    for (const w of THREAD) {
      if (!thSec.includes(w.kw)) { thBad.push(`贯穿项那条「${w.kw}」在正文里认不出`); continue }
      const p = join(clientRoot, w.owner)
      if (!existsSync(p)) { thBad.push(`贯穿项「${w.kw}」的归属文件不在盘上：${w.owner}`); continue }
      if (!readFileSync(p, 'utf8').includes(w.inOwner)) thBad.push(`贯穿项「${w.kw}」的归属文件 ${w.owner} 里没有了「${w.inOwner}」——它还在盯这件事吗？`)
    }
    for (const l of thLines) if (!THREAD.some((w) => l.includes(w.kw))) thBad.push(`贯穿项正文多出一条「${l.slice(2, 26)}…」——登记表没有它`)
    report(thBad.length === 0 && thSecIdx !== -1,
      `§6 贯穿项那 ${THREAD.length} 条各有一件常驻制品（漂移冒烟 + 协议消费台账），双向不多不少`,
      thSecIdx === -1 ? '认不到「### 贯穿项」，这一条没在量任何东西' : thBad.join(' ｜ ')
        || `${thLines.length} 条各认一次；制品依次是 ${THREAD.map((w) => w.owner.replace(/^scripts\//, '')).join(' , ')}`)
  }
}

// 13. §2「行业调研结论」是最后一节还没有判据读过的（§1、§2.3、§4–§9、附 与定稿 README 都已逐行钉回）。
//     它开头那句自述里有两个数（几个项目、几个协议标准）加一条「几条核心判断」，两侧各有真文件撑着：
//     架构调研报告与协议调研报告都在 `analysis-reports/` 下，逐条 `## N.` 小节。此前 #181 只验过索引里那些
//     路径**存在**，没验过那句自述的**枚数与名单**——一句"调研了 9 个项目"如果名单里只有 8 枚、或报告里
//     只有 8 条项目小节，那三个数就没人对过。判据把三方（那句、名单、报告小节）互相钉住：
//       ① 抽取谓词的形状自证（含合写那一枚按 `/` 拆、`等` 收尾、汉字数词三种真实写法）；
//       ② 那句点到的每一枚名字都要在对应报告里认到一条 `^## N.` 小节标题；报告里认不出的小节必须逐条
//          登记在"收尾节"名单里（多一条没登记 ⇒ 红；名单里那条没了 ⇒ 红，双向）；
//       ③ 三个自述数全部现派生：项目枚数＝名单按 `/` 拆开后的总数、标准枚数＝名单枚数、判断数＝§2 的小节数。
//     ③ 落下来就把一处含糊暴露出来了：那句写「9 个项目」，报告实有 **8** 条编号项目小节——只有把
//     `Cline/Roo Code` 这条合写算成两个代码库才凑得满 9。判据因此**钉的是拆法**（拆完相等），
//     并把不拆那一眼（8 条小节）一起打印出来，免得下次有人把它读成"报告里该有 9 条"。
{
  const reportsDir = resolve(clientRoot, '..', 'analysis-reports')
  const ARCH = '2026-10-09-开源Agent客户端架构调研.md'
  const PROTO = '2026-10-09-agent-client-protocols.md'
  const CN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  // 一句里形如「N 个<描述>（A、B/C、D 等）」的枚举，可出现多次。
  const listsOf = (line) => {
    const out = []
    const re = /(\d+) 个((?:(?!（)[^\n]){0,24})（([^）]*)）/g
    let m
    while ((m = re.exec(line)) !== null) {
      const raw = m[3].split('、').map((t) => t.trim().replace(/ ?等$/, '').trim()).filter((t) => t.length > 0)
      out.push({ stated: Number(m[1]), kind: m[2].trim(), items: raw, split: raw.flatMap((t) => t.split('/').map((x) => x.trim()).filter((x) => x.length > 0)) })
    }
    return out
  }
  const clausesOf = (line) => { const m = /([一二两三四五六七八九十]|\d+)\s*条核心判断/.exec(line); return m === null ? null : /^\d+$/.test(m[1]) ? Number(m[1]) : CN[m[1]] ?? null }
  const LIST_SHAPE = [
    { s: '调研了 9 个开源 Agent 项目（OpenCode、Cline/Roo Code、Crush 等）与 5 个协议标准（ACP、ChatKit）。四条核心判断：', want: [9, 5], wantSplit: [4, 2], wantClause: 4 },
    { s: '调研了 2 个项目（A、B）与 1 个标准（C）。两条核心判断：', want: [2, 1], wantSplit: [2, 1], wantClause: 2 },
    { s: '没有枚举也没有条数的一句。', want: [], wantSplit: [], wantClause: null },
  ]
  const badListShape = LIST_SHAPE.filter((c) => {
    const g = listsOf(c.s)
    return JSON.stringify(g.map((x) => x.stated)) !== JSON.stringify(c.want)
      || JSON.stringify(g.map((x) => x.split.length)) !== JSON.stringify(c.wantSplit)
      || clausesOf(c.s) !== c.wantClause
  }).map((c) => {
    const g = listsOf(c.s)
    return `「${c.s.slice(0, 20)}…」→ 数 ${JSON.stringify(g.map((x) => x.stated))} 枚 ${JSON.stringify(g.map((x) => x.split.length))} 条数 ${JSON.stringify(clausesOf(c.s))}`
  })
  report(badListShape.length === 0,
    `§2 那句的抽取形状自证（${LIST_SHAPE.length} 条夹具：合写按 / 拆、` + '`等` 收尾、两个枚举并存、汉字数词两种写法（二/两）、什么都没抽到的一句）',
    badListShape.join(' ｜ ') || '三组夹具各抽对一次（合写那一枚拆成两枚、`等` 没被当成一枚名字）')

  if (!existsSync(planDoc) || !existsSync(join(reportsDir, ARCH)) || !existsSync(join(reportsDir, PROTO))) {
    report(false, '§2 判据的三份前提都在盘上（计划正文 + 两份调研报告）',
      [planDoc, join(reportsDir, ARCH), join(reportsDir, PROTO)].filter((p) => !existsSync(p)).map((p) => relative(clientRoot, p)).join(' ｜ ') || '未知缺失')
  } else {
    const plan = readFileSync(planDoc, 'utf8')
    const a2 = plan.indexOf('## 2. 行业调研结论')
    const r2 = a2 === -1 ? '' : plan.slice(a2)
    const e2 = r2.indexOf('\n---')
    const s2 = e2 === -1 ? r2.slice(0, 4000) : r2.slice(0, e2)
    const claimLine = s2.split('\n').find((l) => l.startsWith('调研了')) ?? ''
    const lists = listsOf(claimLine)
    const heads = (name) => readFileSync(join(reportsDir, name), 'utf8').split('\n').filter((l) => /^## \d+\. /.test(l))
    const archH = heads(ARCH)
    const protoH = heads(PROTO)
    const subCount = (s2.match(/^### 2\.\d/gm) ?? []).length
    const TAIL = [
      { file: ARCH, kw: '其他有特色的项目', why: '简评段，不是逐项目拆解' },
      { file: ARCH, kw: '对天枢自研', why: '结论建议段' },
      { file: PROTO, kw: 'TL;DR', why: '摘要' },
      { file: PROTO, kw: '其他标准简评', why: '不入选的分节' },
      { file: PROTO, kw: '横向对比速查表', why: '表格' },
      { file: PROTO, kw: '协议选型建议', why: '结论' },
    ]
    const bad = []
    if (claimLine === '') bad.push('§2 里认不到以「调研了」开头的那句自述')
    if (lists.length !== 2) bad.push(`那句只抽到 ${lists.length} 个枚举（应是两个：项目与协议标准）——句式变了要连抽取器一起改`)
    const proj = lists[0]
    const proto = lists[1]
    if (archH.length < 8) bad.push(`架构调研只数到 ${archH.length} 条编号小节（少于 8 条说明报告被截过或读错文件，下面的比较不作数）`)
    if (protoH.length < 5) bad.push(`协议调研只数到 ${protoH.length} 条编号小节（少于 5 条同上）`)
    const faces = [[proj, archH, ARCH], [proto, protoH, PROTO]]
    for (const [w, hs, file] of faces) {
      if (w === undefined || hs.length < 1) continue
      for (const name of w.split) {
        const hit = hs.filter((h) => h.includes(name))
        if (hit.length === 0) bad.push(`${file} 里认不到那句点到的「${name}」对应的小节标题`)
        if (hit.length > 1) bad.push(`「${name}」在 ${file} 里命中 ${hit.length} 条编号小节标题，认不准是哪一条`)
      }
      for (const h of hs) {
        if (w.split.some((name) => h.includes(name))) continue
        const t = TAIL.filter((x) => x.file === file && h.includes(x.kw))
        if (t.length === 0) bad.push(`${file} 有条小节「${h.slice(3, 26)}…」既没被那句点到、也没登记在收尾名单里`)
        if (t.length > 1) bad.push(`${file} 那条「${h.slice(3, 20)}…」被收尾名单里的 ${t.length} 条同时认领（名单要互斥）`)
      }
    }
    for (const t of TAIL) {
      const hs = t.file === ARCH ? archH : protoH
      if (!hs.some((h) => h.includes(t.kw))) bad.push(`收尾名单里那条「${t.kw}」（${t.file}）在报告里已经认不出——名单过期了`)
      if (typeof t.why !== 'string' || t.why.trim() === '') bad.push(`收尾那条「${t.kw}」没写理由——登记型豁免必须说明它凭什么算收尾节（与孤儿脚本那张理由表同一把尺子）`)
    }
    report(bad.length === 0 && badListShape.length === 0 && claimLine !== '' && lists.length === 2,
      `§2 那句点到的每一枚名字都在调研报告里认到一条编号小节，报告里多出来的小节要么被点到、要么登记为收尾节（双向；收尾每条带理由）`,
      badListShape.length > 0 ? '抽取的形状自证没过（上一条已点名），这一条不作数'
        : claimLine === '' ? '§2 里没有以「调研了」开头的那句，这一条没在量任何东西'
          : bad.join(' ｜ ') || `两份报告的编号小节 ${archH.length} + ${protoH.length} 条逐条归类；收尾 ${TAIL.length} 条的理由依次是 ${TAIL.map((t) => `${t.kw}=${t.why}`).join(' , ')}`)

    const numBad = []
    if (proj !== undefined && proj.stated !== proj.split.length) numBad.push(`那句写 ${proj.stated} 个项目、名单拆开是 ${proj.split.length} 枚（不拆是 ${proj.items.length} 枚——差在合写那条）`)
    if (proto !== undefined && proto.stated !== proto.split.length) numBad.push(`那句写 ${proto.stated} 个协议标准、名单是 ${proto.split.length} 枚`)
    const wantClause = clausesOf(claimLine)
    if (wantClause === null) numBad.push('那句里没有「N 条核心判断」')
    else if (wantClause !== subCount) numBad.push(`那句写 ${wantClause} 条核心判断、§2 实有 ${subCount} 个小节`)
    report(numBad.length === 0 && bad.length === 0 && lists.length === 2,
      `§2 那句自述的三个数全部现派生（项目＝名单拆合写后的枚数、标准＝名单枚数、判断＝§2 小节数），不相等就红`,
      lists.length !== 2 || bad.length > 0 ? '上面那条逐名对账没过（已点名），这一条不作数'
        : numBad.join(' ｜ ')
          || `项目 ${proj.stated} 枚（报告 ${archH.length} 条编号小节里 ${archH.length - TAIL.filter((t) => t.file === ARCH).length} 条是逐项目拆解，合写那条拆成两枚才满 ${proj.stated}） / 标准 ${proto.stated} 枚 / 判断 ${subCount} 小节`)
  }
}

// 14. §3「协议选型定案」是这份计划最后一节还没被读过的正文（§1、§2、§4–§9、附 与定稿 README 都已逐行钉回）。
//     它给的是一份**选型定案**：那个框图（唯一通道 / 事件数 / 五类 / 类型层）+ 四条 bullet。每一条今天都
//     有别的门在 Enforcement，但没有一条被**逐名登记**过——所以"计划改了说法而钉它的门没改"这种漂移看不见
//     （§7 那张风险表、§5.2 那六条坑、§6 那 25 条复选框各撞过这一族）。另有一枚**旧数**：框图写
//     「44 种 sidecar 事件」，而类型镜像现测 `eventTypeCount` 是另一个数——那条纠正必须读得到，不然正文那个
//     44 就永远是一块没人管的假事实。
{
  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§3 判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const plan = readFileSync(planDoc, 'utf8')
    const a3 = plan.indexOf('## 3. 协议选型定案')
    const r3 = a3 === -1 ? '' : plan.slice(a3)
    const e3 = r3.indexOf('\n---')
    const s3 = e3 === -1 ? '' : r3.slice(0, e3)
    const ba = s3.indexOf('```')
    const bb = s3.indexOf('```', ba + 3)
    const box = ba === -1 || bb === -1 ? '' : s3.slice(ba + 3, bb)
    const BOX_SHAPE = [
      { s: '│  事件层：44 种 sidecar 事件                    │', kind: 'num', want: 44 },
      { s: '│      lifecycle / text / tool / state / custom │', kind: 'cats', want: ['lifecycle', 'text', 'tool', 'state', 'custom'] },
      { s: '│  传输层：天枢 sidecar REST + SSE（唯一通道）    │', kind: 'cats', want: [] },
      { s: '└───────────────────────────────────────────────┘', kind: 'num', want: null },
    ]
    const numOf = (line) => { const m = /事件层：(\d+) 种/.exec(line); return m === null ? null : Number(m[1]) }
    const catsOf = (line) => {
      const body = line.replace(/^│/, '').replace(/│$/, '').trim()
      if (!body.includes('lifecycle')) return []
      return body.split('/').map((t) => t.trim()).filter((t) => /^[a-z-]+$/.test(t))
    }
    const badBoxShape = BOX_SHAPE.filter((c) => {
      const g = c.kind === 'num' ? numOf(c.s) : catsOf(c.s)
      return JSON.stringify(g) !== JSON.stringify(c.want)
    }).map((c) => `「${c.s.slice(0, 22)}…」→ ${JSON.stringify(c.kind === 'num' ? numOf(c.s) : catsOf(c.s))}`)
    report(badBoxShape.length === 0,
      `§3 那个框图的拆行形状自证（${BOX_SHAPE.length} 条：取数那行、五类那行、含斜杠但不是五类的一行、什么都不该取到的一行）`,
      badBoxShape.join(' ｜ ') || '四条夹具各拆对一次（`REST + SSE` 那行没被误认成五类，制表符那行没被当成取数行）')

    const CAT_WATCH = ['lifecycle', 'text', 'tool', 'state', 'custom']
    const BULLET_WATCH = [
      { kw: '传输绑定私有协议', owner: 'scripts/check-nongoals.mjs', inOwner: 'outside client/' },
      { kw: '内部事件管线', owner: 'scripts/check-layers.mjs', inOwner: '五类' },
      { kw: 'AG-UI 适配端点', owner: 'packages/client-core/src/ag-ui.ts', inOwner: 'AG-UI' },
      { kw: 'ACP 适配层后置', owner: 'scripts/check-nongoals.mjs', inOwner: 'ACP' },
    ]
    const bad = []
    if (s3 === '') bad.push('正文里认不到「## 3. 协议选型定案」到那条 `---` 之间这一节')
    if (box === '') bad.push('§3 里认不到那个围栏框图（下面三条都在读它）')
    const lines = box.split('\n')
    const nums = lines.map(numOf).filter((n) => n !== null)
    const catLines = lines.map(catsOf).filter((c) => c.length > 0)
    if (nums.length !== 1) bad.push(`那个框图里数到 ${nums.length} 行"事件层：N 种"（应为 1 行；多行或没有都说明拆面坏了）`)
    if (catLines.length !== 1) bad.push(`那个框图里数到 ${catLines.length} 行五类枚举（应为 1 行）`)
    const statedEvents = nums[0] ?? 0
    const derivedCats = catLines[0] ?? []
    if (derivedCats.length < 5) bad.push(`五类只拆到 ${derivedCats.length} 枚（少于 5 枚，这条绿不算数）`)
    for (const c of CAT_WATCH) if (!derivedCats.includes(c)) bad.push(`框图那一行里没有「${c}」——五类少了一枚，或改名了`)
    for (const c of derivedCats) if (!CAT_WATCH.includes(c)) bad.push(`框图多出一枚「${c}」，登记的五类名单里没有它`)
    const bullets = s3.split('\n').filter((l) => /^- \*\*/.test(l)).map((l) => { const m = /^- \*\*(.+?)\*\*/.exec(l); return m === null ? '' : m[1] })
    if (bullets.length < 4) bad.push(`§3 只数到 ${bullets.length} 条加粗 bullet（少于 4 条，拆面坏了）`)
    if (bullets.length !== BULLET_WATCH.length) bad.push(`正文 ${bullets.length} 条 vs 登记表 ${BULLET_WATCH.length} 条——加一条定案要连登记表一起加`)
    for (const w of BULLET_WATCH) {
      if (!bullets.some((b) => b.includes(w.kw))) { bad.push(`登记表那条「${w.kw}」在 §3 的 bullet 里认不出——被改名还是被删了？`); continue }
      const p = join(clientRoot, w.owner)
      if (!existsSync(p)) { bad.push(`「${w.kw}」登记的归属文件不在盘上：${w.owner}`); continue }
      if (!readFileSync(p, 'utf8').includes(w.inOwner)) bad.push(`「${w.kw}」的归属文件 ${w.owner} 里没有了「${w.inOwner}」——它还在钉这条定案吗？`)
    }
    for (const b of bullets) if (!BULLET_WATCH.some((w) => b.includes(w.kw))) bad.push(`§3 多出一条 bullet「${b}」——登记表没有它，也就没人钉它`)
    report(bad.length === 0 && badBoxShape.length === 0 && s3 !== '' && box !== '',
      `§3 那四条定案逐条对上归属文件、框图那五类逐枚对上登记（登记表 ${BULLET_WATCH.length} 条 + 五类 ${CAT_WATCH.length} 枚，双向）`,
      badBoxShape.length > 0 ? '框图拆行的形状自证没过（上一条已点名），这一条不作数'
        : bad.join(' ｜ ')
          || `${bullets.length} 条 bullet 各认一次；归属依次是 ${BULLET_WATCH.map((w) => w.owner.replace(/^scripts\//, '').replace(/^packages\/client-core\/src\//, '')).join(' , ')}；五类齐`)

    const catFile = join(clientRoot, 'packages/client-core/src/event-category.ts')
    const evBad = []
    if (!existsSync(catFile)) evBad.push('归属文件不在盘上：packages/client-core/src/event-category.ts')
    else {
      const body = readFileSync(catFile, 'utf8')
      for (const c of derivedCats) if (!body.includes(`'${c}'`)) evBad.push(`适配层 ${'`event-category.ts`'} 里认不到引号形态的「${c}」——那一枚还在落五类吗？`)
    }
    report(evBad.length === 0 && bad.length === 0 && box !== '',
      `框图那五类在 client-core 的适配层里各有一处分支（逐枚按引号字面量核，不认裸名字）`,
      bad.length > 0 ? '上一格已点名（拆面或登记表没过），这一条不作数' : evBad.join(' ｜ ')
        || `${derivedCats.length} 枚逐枚对上：${derivedCats.join(' , ')}`)

    const mfPath = join(clientRoot, 'packages/client-core/src/protocol-manifest.json')
    const mf = existsSync(mfPath) ? JSON.parse(readFileSync(mfPath, 'utf8')) : null
    const ledgerTxt = existsSync(join(clientRoot, 'README.md')) ? readFileSync(join(clientRoot, 'README.md'), 'utf8') : ''
    const nBad = []
    if (mf === null) nBad.push('类型镜像清单不在盘上：packages/client-core/src/protocol-manifest.json')
    else if (typeof mf.eventTypeCount !== 'number') nBad.push('那份清单里没有 eventTypeCount 这一枚数')
    else if (mf.eventTypeCount !== statedEvents && !ledgerTxt.includes('计划写 44')) nBad.push(`正文写 ${statedEvents}、镜像现测 ${mf.eventTypeCount}，而台账里读不到那句纠正（「计划写 44」）——这枚旧数就成了没人管的假事实`)
    report(nBad.length === 0 && bad.length === 0 && mf !== null && statedEvents > 0,
      `框图里那枚事件数有下文：与镜像现测相等就作数，不等就必须能在台账读到那句纠正（改了事件契约就会在这里露出来）`,
      bad.length > 0 ? '上面那条对账没过（已点名），这一条不作数'
        : mf === null ? '清单不在盘上，这一条没在量任何东西'
          : nBad.join(' ｜ ') || (mf.eventTypeCount === statedEvents
            ? `正文 ${statedEvents} == 镜像现测 ${mf.eventTypeCount}（相等，无需纠正说法）`
            : `正文 ${statedEvents} ≠ 镜像现测 ${mf.eventTypeCount}，台账那句「计划写 44」在`))
  }
}

// 15. §5.2 那六个坑：#185 钉的是「计划里那张编号表 ↔ 正文逐条」，而**每个坑还有没有人守**没人钉——
//     `check:traps` 的判定标题带 `§5.2-N`，但删掉某个坑唯一的判定不会有任何门变红（§7 那张风险表
//     早就用"逐行对上谁在盯"钉过，#186；这条是同一把尺子量 §5.2）。
//     判据两侧都现派生：坑数从计划正文数，守卫条数从 `check-traps.mjs` 的标签数；每条坑必须 ≥1 条判定，
//     带 `§5.2-N` 但 N 不在坑数之内的标签也算红（那说明表与门已经各说各话）。
{
  const gateFile = join(clientRoot, 'scripts/check-traps.mjs')
  const TRAP_SHAPE = [
    { s: "check('§5.2-1 StoreLock 在启动脚本里真的被隔离', ok)", want: 1 },
    { s: "report('§5.2-表 六条编号与正文互钉')", want: null },
    { s: "x('§5.2-12 这不是坑号')", want: 12 },
    { s: '没有任何标签的一行', want: null },
  ]
  const numIn = (s) => { const m = /§5\.2-(\d+)/.exec(s); return m === null ? null : Number(m[1]) }
  const badTrapShape = TRAP_SHAPE.filter((c) => numIn(c.s) !== c.want)
    .map((c) => `「${c.s.slice(0, 26)}…」→ ${JSON.stringify(numIn(c.s))}，应为 ${JSON.stringify(c.want)}`)
  report(badTrapShape.length === 0,
    `§5.2 坑号标签的抽取形状自证（${TRAP_SHAPE.length} 条夹具：正常标签、表标签、两位数不是坑号、没有标签的行）`,
    badTrapShape.join(' ｜ ') || '四条夹具各抽对一次（表标签与无标签都不被误当成某个坑的守卫）')

  if (!existsSync(planDoc) || !existsSync(gateFile)) {
    report(false, '§5.2 判据的两份前提都在盘上（计划正文 + check-traps.mjs）',
      [planDoc, gateFile].filter((p) => !existsSync(p)).map((p) => relative(clientRoot, p)).join(' ｜ ') || '未知缺失')
  } else {
    const plan = readFileSync(planDoc, 'utf8')
    const a52 = plan.indexOf('### 5.2 已识别的坑')
    const r52 = a52 === -1 ? '' : plan.slice(a52)
    const e52 = r52.indexOf('\n## ')
    const s52 = e52 === -1 ? '' : r52.slice(0, e52)
    const traps = s52.split('\n').filter((l) => /^\s*\d+\.\s+\*\*/.test(l))
      .map((l) => { const m = /^\s*(\d+)\.\s+\*\*(.+?)\*\*/.exec(l); return m === null ? null : { n: Number(m[1]), title: m[2] } })
      .filter((t) => t !== null)
    const body = readFileSync(gateFile, 'utf8')
    // 只从判定调用的**第一个字符串参数**里取标签——注释里提一句"§5.2-4"不算有人守（解析器不许读注释）。
    const labelsOf = (src) => [...src.matchAll(/(?:check|report|record)\(\s*(?:'([^']*)'|`([^`]*)`)/g)]
      .map((m) => (m[1] ?? m[2] ?? '').replace(/\\\$/g, '$'))
    const labels = labelsOf(body)
    const guarded = new Map(traps.map((t) => [t.n, labels.filter((l) => numIn(l) === t.n).length]))
    const stray = [...new Set(labels.map(numIn).filter((n) => n !== null))].filter((n) => !traps.some((t) => t.n === n))
    const tBad = []
    if (a52 === -1) tBad.push('计划正文里认不到「### 5.2 已识别的坑」那一节')
    if (labels.length < 10) tBad.push(`只从 check-traps 抽出 ${labels.length} 条判定标签（少于 10 条说明取标签的形状坏了，逐条比较不作数）`)
    if (traps.length < 6) tBad.push(`§5.2 只数到 ${traps.length} 条坑（少于 6 条说明拆面坏了，下面的比较不作数）`)
    if (traps.map((t) => t.n).join(',') !== traps.map((_, i) => i + 1).join(',')) tBad.push(`坑号不是连续的 1..${traps.length}（实测 ${traps.map((t) => t.n).join(',')}）——#185 那张编号表与这条的口径要一起改`)
    for (const t of traps) if ((guarded.get(t.n) ?? 0) === 0) tBad.push(`坑 ${t.n}「${t.title}」在 check-traps 里一条判定都没有——这条坑没人守了`)
    for (const n of stray) tBad.push(`check-traps 里有 §5.2-${n} 的标签，而计划 §5.2 只有 ${traps.length} 条坑——门与计划各说各话`)
    report(tBad.length === 0 && badTrapShape.length === 0 && a52 !== -1 && labels.length >= 10 && traps.length >= 6,
      `§5.2 每一条坑都有 ` + '`check:traps`' + ` 的判定守着（坑数与守卫条数两侧都现派生，逐条打印）`,
      badTrapShape.length > 0 ? '抽取的形状自证没过（上一条已点名），这一条不作数'
        : a52 === -1 ? '认不到那一节，这一条没在量任何东西'
          : traps.length < 6 ? `面塌了（只数到 ${traps.length} 条坑）——上面逐条比较不作数`
            : tBad.join(' ｜ ')
              || `${traps.length} 条坑逐条有守卫：${traps.map((t) => `${t.n}→${guarded.get(t.n)} 条`).join(' , ')}`)
  }
}

// 16. §4.3「状态同步核心设计」那五条编号设计，此前只被**逐格**钉过（退避复位 #52、REST 兜底 #70、三档节拍 #71、
//     块不可变 #73、五类与原子替换 #140/#141、增量 markdown #104），但**没有一张"哪条设计由谁守"的名册**——
//     计划加第六条设计、或某条设计的守卫被删，都不会有门变红。与 §7（#186）、§5.2（#203）、§6（#195）同一族。
{
  const DESIGN_WATCH = [
    { n: 1, kw: '连接世代', owner: 'packages/client-core/src/event-category.ts', inOwner: 'replay_window' },
    { n: 2, kw: '断线重连', owner: 'packages/client-core/src/session-stream.ts', inOwner: 'jitter' },
    { n: 3, kw: '流式渲染', owner: 'packages/client-core/src/session-model.ts', inOwner: 'PartialAccumulator' },
    { n: 4, kw: '业务数据不进全局 store', owner: 'packages/store/test/store.test.ts', inOwner: '视图' },
    { n: 5, kw: '事件五类化', owner: 'packages/client-core/src/event-category.ts', inOwner: 'lifecycle' },
  ]
  const NUM_SHAPE = [
    { s: '1. **连接世代**：每次 SSE 建连为一个世代。', want: { n: 1, kw: '连接世代' } },
    { s: '4. **业务数据不进全局 store**：会话消息流在 React-free 的…', want: { n: 4, kw: '业务数据不进全局 store' } },
    { s: '普通段落，不是编号设计。', want: null },
    { s: '10. **第十条**：假想的两位数编号。', want: { n: 10, kw: '第十条' } },
  ]
  const numInLine = (l) => { const m = /^(\d+)\.\s+\*\*(.+?)\*\*/.exec(l); return m === null ? null : { n: Number(m[1]), kw: m[2] } }
  const badNumShape = NUM_SHAPE.filter((c) => JSON.stringify(numInLine(c.s)) !== JSON.stringify(c.want))
    .map((c) => `「${c.s.slice(0, 20)}…」→ ${JSON.stringify(numInLine(c.s))}`)
  report(badNumShape.length === 0,
    `§4.3 编号设计的拆条形状自证（${NUM_SHAPE.length} 条夹具：一条与两条真实写法、普通段落不算、两位数算第 10 条而不是 1 条）`,
    badNumShape.join(' ｜ ') || '四条夹具各拆对一次（普通段落没被当成设计，`10.` 没被前缀匹配成 `1`）')

  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§4.3 判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const plan = readFileSync(planDoc, 'utf8')
    const a43 = plan.indexOf('### 4.3 状态同步核心设计')
    const r43 = a43 === -1 ? '' : plan.slice(a43)
    const e43 = r43.indexOf('\n### 4.4')
    const s43 = e43 === -1 ? '' : r43.slice(0, e43)
    const derived = s43.split('\n').map(numInLine).filter((d) => d !== null)
    const dBad = []
    if (s43 === '') dBad.push('正文里认不到「### 4.3 状态同步核心设计」到「### 4.4」之间这一节')
    if (derived.length < 5) dBad.push(`只数到 ${derived.length} 条编号设计（少于 5 条说明拆面坏了，这条绿不算数）`)
    if (derived.map((d) => d.n).join(',') !== derived.map((_, i) => i + 1).join(',')) dBad.push(`编号不是连续的 1..${derived.length}（实测 ${derived.map((d) => d.n).join(',')}）`)
    if (derived.length !== DESIGN_WATCH.length) dBad.push(`正文 ${derived.length} 条 vs 名册 ${DESIGN_WATCH.length} 条——加一条设计要连名册一起加`)
    for (const w of DESIGN_WATCH) {
      const hit = derived.filter((d) => d.n === w.n && d.kw.includes(w.kw))
      if (hit.length !== 1) { dBad.push(`名册第 ${w.n} 条「${w.kw}」在正文里命中 ${hit.length} 条（要恰好一条）`); continue }
      const p = join(clientRoot, w.owner)
      if (!existsSync(p)) { dBad.push(`第 ${w.n} 条的归属文件不在盘上：${w.owner}`); continue }
      if (!readFileSync(p, 'utf8').includes(w.inOwner)) dBad.push(`第 ${w.n} 条「${w.kw}」的归属文件 ${w.owner} 里没有了「${w.inOwner}」——它还在守这条设计吗？`)
    }
    for (const d of derived) if (!DESIGN_WATCH.some((w) => w.n === d.n && d.kw.includes(w.kw))) dBad.push(`正文第 ${d.n} 条「${d.kw}」名册里没有——这条设计没人认领`)
    report(dBad.length === 0 && badNumShape.length === 0 && s43 !== '',
      `§4.3 五条编号设计逐条对上归属文件（名册双向，编号连续；归属里真的有那句证据）`,
      badNumShape.length > 0 ? '拆条的形状自证没过（上一条已点名），这一条不作数'
        : s43 === '' ? '认不到 §4.3 那一节，这一条没在量任何东西'
          : dBad.join(' ｜ ')
            || `${derived.length} 条逐条对上；归属依次是 ${DESIGN_WATCH.map((w) => w.owner.replace(/^packages\//, '')).join(' , ')}`)

    // §4.3 第 5 条正文里写的也是那枚旧事件数：与 §3 的框图同一把尺子——相等就作数，不等就要求台账读得到那句纠正。
    const evNum = /(\d+) 种 sidecar 事件/.exec(s43)
    const mfPath = join(clientRoot, 'packages/client-core/src/protocol-manifest.json')
    const mf = existsSync(mfPath) ? JSON.parse(readFileSync(mfPath, 'utf8')) : null
    const lTxt = existsSync(join(clientRoot, 'README.md')) ? readFileSync(join(clientRoot, 'README.md'), 'utf8') : ''
    const dnBad = []
    if (evNum === null) dnBad.push('§4.3 里没有「N 种 sidecar 事件」那句（要么被改写，要么这条在量的东西没了）')
    else if (mf === null || typeof mf.eventTypeCount !== 'number') dnBad.push('读不到类型镜像的 eventTypeCount')
    else if (Number(evNum[1]) !== mf.eventTypeCount && !lTxt.includes('计划写 44')) dnBad.push(`§4.3 写 ${evNum[1]}、镜像现测 ${mf.eventTypeCount}，而台账读不到那句纠正`)
    report(dnBad.length === 0 && dBad.length === 0 && evNum !== null && mf !== null,
      `§4.3 那枚事件数与 §3 框图同一把尺子：等于镜像现测就作数，不等于就必须有台账那句纠正`,
      dBad.length > 0 ? '上一条名册没过（已点名），这一条不作数'
        : dnBad.join(' ｜ ')
          || (Number(evNum[1]) === mf.eventTypeCount
            ? `§4.3 ${evNum[1]} == 镜像现测 ${mf.eventTypeCount}（相等，无需纠正说法）`
            : `§4.3 ${evNum[1]} ≠ 镜像现测 ${mf.eventTypeCount}，台账那句「计划写 44」在`))
  }
}

// 17. §4.2 那张分包表（计划写「约 10 包」）与实际工作区此前只被一次性核回过（#72 那次改掉四条 package.json
//     的过期自述），**没有常驻对照**：新加一个包（M2 就加了三个：`ui-files` / `ui-git` / `ui-schedule`）
//     或把某个包改名，计划那张表与真实目录会各说各话而没人报警。这条把两侧双向钉住：
//     表里点名的包必须真在盘上；盘上每个 `packages/*` 与 `apps/*` 要么在表里，要么登记在"后加包"名册里
//     并写明它服务哪个里程碑（理由必须带 `M` + 数字，否则等于没写）。
{
  const LATER = [
    { dir: 'packages/ui-files', because: 'M2 文件预览与 @file 候选' },
    { dir: 'packages/ui-git', because: 'M2 影子检查点面板与 Git 工作台' },
    { dir: 'packages/ui-schedule', because: 'M2 定时任务看板' },
    // 首跑就抓到它：`apps/spike` 不在 §4.2 那张表里，也不是三个 M2 面板包之一。
    // 它是 §6 M0 第 3 条那台一次性 spike（不是产品面），所以按名册的规矩带上它服务的里程碑号。
    { dir: 'apps/spike', because: 'M0 单页直连 SSE 的 spike 台（一次性验收，不是产品包）' },
  ]
  const NAME_SHAPE = [
    { s: '`client-core`', want: 'client-core' },
    { s: '`ui-primitives`', want: 'ui-primitives' },
    { s: '`apps/web` + `apps/desktop`', want: 'apps/web + apps/desktop' },
    { s: '没有反引号的一格', want: null },
  ]
  const nameOf = (cell) => { const m = /^`([\w./-]+)`(?:\s*\+\s*`([\w./-]+)`)?$/.exec(cell.trim()); return m === null ? null : m[2] === undefined ? m[1] : `${m[1]} + ${m[2]}` }
  const badNameShape = NAME_SHAPE.filter((c) => nameOf(c.s) !== c.want)
    .map((c) => `「${c.s}」→ ${JSON.stringify(nameOf(c.s))}`)
  report(badNameShape.length === 0,
    `§4.2 包名单元格的拆法形状自证（${NAME_SHAPE.length} 条夹具：单个反引号名、带连字符名、两个 app 合写的一格、没有反引号的一格不算）`,
    badNameShape.join(' ｜ ') || '四条夹具各拆对一次（合写那格保持成一枚，不被拆成两个包名）')

  if (!existsSync(planDoc)) {
    report(false, '计划正文在盘上（§4.2 判据的前提）', `找不到 ${relative(clientRoot, planDoc)}——这一条没在量任何东西`)
  } else {
    const plan = readFileSync(planDoc, 'utf8')
    const a42 = plan.indexOf('### 4.2 分包方案')
    const r42 = a42 === -1 ? '' : plan.slice(a42)
    const e42 = r42.indexOf('\n### 4.3')
    const s42 = e42 === -1 ? '' : r42.slice(0, e42)
    const cells = s42.split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s:-]+\|/.test(l))
      .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
      .filter((c) => c.length === 3 && c[0] !== '包')
    const listed = new Set()
    for (const c of cells) for (const one of nameOf(c[0]) === null ? [] : nameOf(c[0]).split(' + ')) listed.add(one)
    const onDisk = new Set([
      ...readdirSync(join(clientRoot, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `packages/${d.name}`),
      ...readdirSync(join(clientRoot, 'apps'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `apps/${d.name}`),
    ])
    const laterDirs = new Set(LATER.map((l) => l.dir))
    const pBad = []
    if (s42 === '') pBad.push('正文里认不到「### 4.2 分包方案」到「### 4.3」之间这一节')
    if (cells.length < 9) pBad.push(`那张表只数到 ${cells.length} 行（少于 9 行说明拆表坏了，比较不作数）`)
    if (onDisk.size < 12) pBad.push(`盘上只数到 ${onDisk.size} 个包/app 目录（少于 12 个说明扫描面塌了）`)
    for (const one of listed) {
      const rel = one.startsWith('packages/') || one.startsWith('apps/') ? one : join('packages', one)
      if (!existsSync(join(clientRoot, ...rel.split('/'))) && !existsSync(join(clientRoot, one))) pBad.push(`表里点名「${one}」，盘上却没有这个目录——被改名还是被删了？`)
    }
    for (const d of onDisk) {
      const bare = d.replace(/^packages\//, '')
      if (listed.has(d) || listed.has(bare) || laterDirs.has(d)) continue
      pBad.push(`盘上有 ${d}，既不在 §4.2 那张表里，也不在"后加包"名册里——新包要么进表，要么带里程碑理由登记`)
    }
    for (const l of LATER) {
      if (!onDisk.has(l.dir)) pBad.push(`"后加包"名册里那条 ${l.dir} 已经不在盘上了——名册过期`)
      if (!/\bM\d/.test(l.because)) pBad.push(`${l.dir} 的理由没带里程碑号（` + '`M` + 数字）——等于没写')
    }
    report(pBad.length === 0 && badNameShape.length === 0 && s42 !== '',
      `§4.2 那张分包表与真实工作区双向相等（表 ${cells.length} 行 / 盘上 ${onDisk.size} 个目录 / 名册外后加包 ${LATER.length} 个各带里程碑理由）`,
      badNameShape.length > 0 ? '拆法的形状自证没过（上一条已点名），这一条不作数'
        : s42 === '' ? '认不到 §4.2 那一节，这一条没在量任何东西'
          : cells.length < 9 || onDisk.size < 12 ? `面塌了（表 ${cells.length} 行 / 盘上 ${onDisk.size} 个）——上面的比较不作数`
            : pBad.join(' ｜ ')
              || `表点名 ${listed.size} 个包全部在盘上；盘上 ${onDisk.size} 个目录全部有归属（名册外 ${LATER.length} 个：${LATER.map((l) => `${l.dir.replace(/^(packages|apps)\//, '')}←${l.because}`).join(' , ')}`)
  }
}

// 18. §9 那三条验收标准（DoD）的"签 / 不签"此前只是我写的一句话，而且**台账里只有 v1.0 有一行判定**——
//     MVP 与 v2.0 的证据散在别的行里，读的人无法判断这两条到底签没签。本轮补上那两行，并把规则派生化：
//     一条 DoD **可签** ⟺ 它涵盖的里程碑成员全是 `done`/`once`（复用 block 12 那份名册，不留第二份），
//     且登记的未闭 blocker 在台账里读不到。所以这条**两面都挡**：成员没齐就写 ✅ ⇒ 红（挡过早签）；
//     成员齐了、blocker 也消了却还挂着 ⚠ ⇒ 也红（挡"永远不签"）——#27 一闭，本条就会要求 MVP 那行改成 ✅。
{
  const DOD_WATCH = [
    { line: 'MVP', alias: '§9 MVP DoD', milestones: ['M0', 'M1'], blockers: ['仍未活过（#27）'] },
    { line: 'v1.0', alias: '§9 v1.0', milestones: ['M2'], blockers: ['没活过（#27）', '整体不签'] },
    { line: 'v2.0', alias: '§9 v2.0 DoD', milestones: ['M3'], blockers: ['两项搁置', '是搁置不是完成'] },
  ]
  const DOD_SHAPE = [
    { s: '- **MVP**：无官方桌面端参与，浏览器完成一次完整编码任务；', want: 'MVP' },
    { s: '- **v1.0**：日常开发可完全替代官方桌面端核心流程；', want: 'v1.0' },
    { s: '- **v2.0**：Windows 安装包双击即用。', want: 'v2.0' },
    { s: '- 没有粗体名前的一条。', want: null },
  ]
  const dodName = (l) => { const m = /^- \*\*(.+?)\*\*：/.exec(l); return m === null ? null : m[1] }
  const badDodShape = DOD_SHAPE.filter((c) => dodName(c.s) !== c.want).map((c) => `「${c.s.slice(0, 18)}…」→ ${JSON.stringify(dodName(c.s))}`)
  report(badDodShape.length === 0,
    `§9 DoD 行的拆名形状自证（${DOD_SHAPE.length} 条夹具：三条真实写法与一条没有粗体名前）`,
    badDodShape.join(' ｜ ') || '四条夹具各认对一次（没有「- **名**：」形状的不被当成一条 DoD）')

  const ledgerFile = join(clientRoot, 'README.md')
  const gTxt = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : ''
  const gAt = gTxt.indexOf('## 里程碑状态')
  const gRest = gAt === -1 ? '' : gTxt.slice(gAt)
  const gEnd = gRest.indexOf('\n## ', 4)
  const gSec = gEnd === -1 ? '' : gRest.slice(0, gEnd)
  const gRows = gSec.split('\n')
    .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s:-]+\|/.test(l))
    .map(splitCells).filter((c) => c.length === 3 && c[0] !== '计划项')
  const planTxt = existsSync(planDoc) ? readFileSync(planDoc, 'utf8') : ''
  const p9 = planTxt.indexOf('## 9. 验收标准')
  const p9rest = p9 === -1 ? '' : planTxt.slice(p9)
  const p9end = p9rest.indexOf('\n## ')
  const s9 = p9end === -1 ? p9rest : p9rest.slice(0, p9end)
  const dodLines = s9.split('\n').map(dodName).filter((n) => n !== null)
  const gBad = []
  if (BOX.length === 0) gBad.push('§6 那份名册是空的（block 12 没跑到或被改坏）——这条的可签规则没有输入')
  if (p9 === -1) gBad.push('计划正文里认不到「## 9. 验收标准」那一节')
  if (dodLines.length < 3) gBad.push(`§9 只数到 ${dodLines.length} 条 DoD（少于 3 条说明拆面坏了，比较不作数）`)
  if (gAt === -1 || gRows.length < 30) gBad.push(`台账那张状态表认不到或只数到 ${gRows.length} 行——本条没有可比的判定行`)
  for (const n of dodLines) if (!DOD_WATCH.some((d) => d.line === n)) gBad.push(`§9 新增了一条 DoD「${n}」，名册里没有它`)
  for (const d of DOD_WATCH) {
    if (!dodLines.includes(d.line)) { gBad.push(`名册那条「${d.line}」在 §9 里认不到了——DoD 改了名要连名册一起改`); continue }
    const hits = gRows.filter((c) => c[0].startsWith(d.alias))
    if (hits.length !== 1) { gBad.push(`DoD「${d.line}」在状态表里有 ${hits.length} 行判定（要恰好一行，别名「${d.alias}」）`); continue }
    const members = BOX.filter((w) => d.milestones.includes(w.m))
    if (members.length === 0) { gBad.push(`DoD「${d.line}」的里程碑 ${d.milestones.join('/')} 在 §6 名册里一个成员都没有`); continue }
    const unfinished = members.filter((w) => w.st !== 'done' && w.st !== 'once')
    const liveBlockers = d.blockers.filter((p) => gTxt.includes(p))
    const signable = unfinished.length === 0 && liveBlockers.length === 0
    const signed = /^✅/.test(hits[0][1])
    if (signed && !signable) gBad.push(`DoD「${d.line}」在表里写 ✅，但成员里还有 ${unfinished.length} 条非 done/once、台账里还读得到 ${liveBlockers.length} 句未闭说法——不许过早签`)
    if (!signed && signable) gBad.push(`DoD「${d.line}」的成员全已落地且台账读不到任何未闭说法，表里却仍写「${hits[0][1].slice(0, 22)}」——挂着不签也是错`)
  }
  report(gBad.length === 0 && badDodShape.length === 0 && BOX.length > 0 && dodLines.length >= 3 && gRows.length >= 30,
    `§9 三条 DoD 各有一行判定，且签不签由 §6 名册 + 台账未闭说法派生（两面都挡：过早签 / 挂着不签）`,
    badDodShape.length > 0 ? '拆名的形状自证没过（上一条已点名），这一条不作数'
      : BOX.length === 0 || p9 === -1 || dodLines.length < 3 || gAt === -1 || gRows.length < 30
        ? `面塌了（名册 ${BOX.length} 条 / §9 ${dodLines.length} 条 / 表 ${gRows.length} 行）——上面那条逐条比较不作数`
          : gBad.join(' ｜ ')
            || `三条 DoD 各一行判定；现测：${DOD_WATCH.map((d) => { const m = BOX.filter((w) => d.milestones.includes(w.m)); const u = m.filter((w) => w.st !== 'done' && w.st !== 'once').length; const b = d.blockers.filter((p) => gTxt.includes(p)).length; return `${d.line}：成员 ${m.length} 条里 ${u} 条未闭 / 台账 blocker ${b} 句` }).join(' ｜ ')}`)
}



// --- 块 19：审批验收脚本"自述覆盖几态"必须等于内核真契约下的三态往返 ---
{
  const apPath = join(clientRoot, 'scripts/accept-approval.ts')
  const apSrc = existsSync(apPath) ? readFileSync(apPath, 'utf8') : ''
  // 内核契约（src/server/approval-routes.ts 读 body 的 decision / remember，session-manager 把非 approve 一律当 reject，
  // event-tap 发的 approval_resolved 只有 approve / reject 两种）。所以三态各自的形状是：
  //   允许一次 = decision 'approve' 且不带 remember；始终允许 = 'approve' + remember:true；拒绝 = 非 approve 的 decision。
  const callsOf = (s) => {
    const out = []
    for (const m of s.matchAll(/\b(?:answerApproval|drive)\(/g)) {
      const seg = s.slice(m.index, m.index + 260)
      const d = /decision:\s*'([^']+)'/.exec(seg)
      if (!d) continue
      out.push({ decision: d[1], remember: /remember:\s*true/.test(seg) })
    }
    return out
  }
  const Q = "'"
  const CALL_SHAPE = [
    { s: `api.answerApproval(id, r, { decision: ${Q}approve${Q} })`, want: [{ decision: 'approve', remember: false }] },
    { s: `api.answerApproval(id, r, { decision: ${Q}approve${Q}, remember: true })`, want: [{ decision: 'approve', remember: true }] },
    { s: `api.answerApproval(id, r, { decision: ${Q}reject${Q} })`, want: [{ decision: 'reject', remember: false }] },
    { s: `api.answerApproval(id, r)`, want: [] },
    { s: `const drive = async (answer: { decision: 'approve' | 'reject' }) => {}`, want: [] },
  ]
  const badShape = CALL_SHAPE.filter((c) => JSON.stringify(callsOf(c.s)) !== JSON.stringify(c.want))
    .map((c) => `「${c.s}」→ ${JSON.stringify(callsOf(c.s))}（应 ${JSON.stringify(c.want)}）`)
  const calls = callsOf(apSrc)
  const once = calls.some((c) => c.decision === 'approve' && !c.remember)
  const always = calls.some((c) => c.decision === 'approve' && c.remember === true)
  const deny = calls.some((c) => c.decision !== 'approve')
  const covered3 = once && always && deny
  const claimLines = apSrc.split(/\r?\n/).filter((l) => /✓|实测通过|openInstance\(/.test(l)).join('\n')
  const claims3 = /三态/.test(claimLines)
  const gapLine = /未覆盖[^\n]*始终允许[^\n]*拒绝/.test(apSrc)
  const ledgerTxt = (existsSync(join(clientRoot, 'README.md')) ? readFileSync(join(clientRoot, 'README.md'), 'utf8') : '')
    + (existsSync(join(clientRoot, 'EVIDENCE.md')) ? readFileSync(join(clientRoot, 'EVIDENCE.md'), 'utf8') : '')
  const ledgerHasGap = ledgerTxt.includes('仍未活过')
  report(apSrc !== '' && badShape.length === 0 && claims3 === covered3 && (covered3 ? !gapLine : gapLine && ledgerHasGap),
    '审批验收脚本自述覆盖了哪几态，必须等于内核真契约下的三态往返（允许一次 / 始终允许 = `approve`+`remember:true` / 拒绝 = 非 `approve`；从 `answerApproval` 调用点派生 + 四条形状自证 + 补上了就自动改口的正控）',
    apSrc === '' ? '读不到 scripts/accept-approval.ts——这一条没在量任何东西'
      : badShape.length > 0 ? '调用点抽取的形状自证没过，这一条不作数：' + badShape.join(' ｜ ')
        : covered3
          ? `三态齐（一次/始终/拒绝）：自述必须提三态且"未覆盖"那行要撤（现测 claims3=${claims3} gapLine=${gapLine}）`
          : `现测 ${calls.length} 个 answerApproval 调用点 ⇒ 允许一次=${once} 始终允许=${always} 拒绝=${deny}；自述提三态=${claims3}、"未覆盖"那行=${gapLine}、台账 blocker 那句=${ledgerHasGap}`)
}
// --- 块 20：花钱路径的账单必须覆盖它自己创建的每一个会话，且归档一律排在账单之后 ---
// 起因为真事：2026-10-15 那一趟打印「12 发」，但它只加了两份转录——grant 那轮的会话被一行排在
// billing 之前的 `archiveSession` 烧掉了（归档=DELETE，转录随之没），所以那个数至今是个**下界**。
// 硬列两条会话的账单就是这么漏的：加会话的人不会记得加第三行，而"账单看起来有数"照绿。
{
  const billFace = (s) => {
    const created = [...s.matchAll(/\bconst\s+(\w+)\s*=\s*await\s+api\.createSession\(\s*\{/g)].map((m) => m[1])
    const bills = [...s.matchAll(/\bspendOf\(\s*api\s*,\s*(\w+)\.id\b/g)].map((m) => ({ n: m[1], i: m.index }))
    const arch = [...s.matchAll(/\bapi\.archiveSession\(\s*(\w+)\.id\s*\)/g)].map((m) => ({ n: m[1], i: m.index }))
    const billed = [...new Set(bills.map((b) => b.n))]
    const unbilled = created.filter((n) => !billed.includes(n))
    const preBill = created.filter((n) => {
      const a = arch.filter((x) => x.n === n).map((x) => x.i)
      const b = bills.filter((x) => x.n === n).map((x) => x.i)
      return a.length > 0 && b.length > 0 && Math.min(...a) < Math.max(...b)
    })
    return { created, billed, unbilled, preBill }
  }
  const F20 = "'"
  const FIX20 = [
    { s: `const ses = await api.createSession({ cwd: x })\nconst sp = await spendOf(api, ses.id)\nawait api.archiveSession(ses.id)`,
      want: { created: ['ses'], billed: ['ses'], unbilled: [], preBill: [] } },
    { s: `const a = await api.createSession({})\nconst b = await api.createSession({})\nawait spendOf(api, a.id)`,
      want: { created: ['a', 'b'], billed: ['a'], unbilled: ['b'], preBill: [] } },
    { s: `const c = await api.createSession({})\nawait api.archiveSession(c.id)\nawait spendOf(api, c.id)`,
      want: { created: ['c'], billed: ['c'], unbilled: [], preBill: ['c'] } },
    { s: `const d = await api.getSession(id)\nawait api.archiveSession(e.id)\nconst spendOf = 1`,
      want: { created: [], billed: [], unbilled: [], preBill: [] } },
  ]
  const badFix = FIX20.map((f, k) => {
    const got = billFace(f.s)
    return JSON.stringify([got.created, got.billed, got.unbilled, got.preBill]) === JSON.stringify([f.want.created, f.want.billed, f.want.unbilled, f.want.preBill])
      ? null : `夹具 ${k + 1}：期望 ${JSON.stringify(f.want)}，实读 ${JSON.stringify(got)}`
  }).filter((x) => x !== null)
  const dir20 = join(clientRoot, 'scripts')
  const paidFiles = existsSync(dir20)
    ? readdirSync(dir20).filter((f) => /^accept-.+\.ts$/.test(f) && /\bspends:\s*true\b/.test(readFileSync(join(dir20, f), 'utf8'))).sort()
    : []
  const perFile = paidFiles.map((f) => {
    const raw = readFileSync(join(dir20, f), 'utf8')
    const face = billFace(raw)
    // 交叉一致性：`created` 只认"字面 `const X = await api.createSession({`"这一种形状，
    // 把建会话藏进工厂函数/别名它就整个看不见（R2 反例实测：藏掉一个会话，门照绿）。
    // 所以再数一次"这文件里到底出现了几处 `api.createSession(`"，两边必须相等——
    // 不等就是抽取形状被绕开了，报红并点名差额，而不是静默按少掉的那份继续算账。
    const mentions = (raw.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n').match(/\bapi\.createSession\(/g) ?? []).length
    return { f, face, mentions }
  })
  // 下界只拦"两面皆空也算绿"那一种（会话被藏进工厂函数、名字抽不到 ⇒ 面塌了要红），
  // 所以它是 **1**，不是照某一台的会话数写的 3——写 3 会把一台只开一个会话的合法脚本（accept-stream）判成缺陷。
  const floor = 1
  const bad = perFile.filter((p) => p.face.created.length < floor || p.face.created.length !== p.mentions || p.face.unbilled.length > 0 || p.face.preBill.length > 0)
  report(paidFiles.length > 0 && badFix.length === 0 && bad.length === 0,
    `花钱验收脚本的账单覆盖面（**每一台**声明 \`{ spends: true }\` 的 \`accept-*.ts\`：它创建的每个会话都要有一份读数、归档都要排在账单之后；从 \`createSession\`/\`spendOf\`/\`archiveSession\` 三个调用形状派生 + 四条夹具：齐账、少一个会话、归档抢跑、别的调用不算进来；下界 ${floor} 拦"两面皆空也算绿"）`,
    paidFiles.length === 0 ? '面塌了：scripts/ 下一台声明 `{ spends: true }` 的 accept-*.ts 都没扫到，这一条没在量任何东西'
      : badFix.length > 0 ? '抽取形状自证没过，这一条不作数：' + badFix.join(' ｜ ')
        : bad.length > 0
          ? bad.map((p) => `${p.f}：${p.face.created.length < floor ? `面里只有 ${String(p.face.created.length)} 个会话（${p.face.created.join('、') || '一个都没抽到'}）< 下界 ${floor} ⇒ createSession 的写法变了、账齐了也不作数` : ''}${p.face.created.length !== p.mentions ? `${p.face.created.length < floor ? ' ｜ ' : ''}形状交叉不一致：抽到 ${String(p.face.created.length)} 个名字，文件里却有 ${String(p.mentions)} 处 \`api.createSession(\` ⇒ 有会话藏在工厂函数/别名里，账单面数不到它` : ''}${p.face.unbilled.length ? `${p.face.created.length < floor || p.face.created.length !== p.mentions ? ' ｜ ' : ''}没读数的 ${p.face.unbilled.join('、')}` : ''}${p.face.preBill.length ? `${p.face.unbilled.length || p.face.created.length !== p.mentions || p.face.created.length < floor ? ' ｜ ' : ''}归档抢在账单前（转录会被 DELETE）的 ${p.face.preBill.join('、')}` : ''}`).join(' ｜ ')
          : perFile.map((p) => `${p.f} 创建 ${String(p.face.created.length)} 个会话（${p.face.created.join('、')}，与文件里 ${String(p.mentions)} 处 \`api.createSession(\` 相等）逐名有读数且都排在归档之后`).join(' ｜ '))
}
// --- 块 22：教 node 版本约束的三份指令文件 + 两份配置/报告，写的 engines 值必须等于 package.json 的真值 ---
// 起因是 #101：同一件事曾有四种说法（根 `>=24` / AGENTS 与 .rivet 与 CLAUDE 写"钉 24.18.0" /
// ci.yml 注释写"钉 24.1.0"），而两个假说法还互相矛盾——2026-10-15 由用户「#101 顺手改」授权后一次改齐。
// 射程说明（这是两条独立宣称，分开写清）：**扫哪些文件**=只扫"教约束"的指令面与配置面；
// `client/EVIDENCE.md` 与 `client/README.md` 里那些引用旧错值的句子是**历史记录**（它们正是在说这几个字是错的），
// 故意不在面内——把它们判红等于要求台账不许引用被纠正过的措辞。**认哪些形状**=带 `engines` 字样的行里的版本 token。
{
  const pkgPath = join(clientRoot, '..', 'package.json')
  let realEngines = ''
  try { realEngines = String(JSON.parse(readFileSync(pkgPath, 'utf8')).engines?.node ?? '') } catch { /* 读不到就在下面报红 */ }
  const norm = (v) => String(v).replace(/\s+/g, '')
  const CLAIM_FILES = ['AGENTS.md', '.rivet.md', 'CLAUDE.md', '.github/workflows/ci.yml', 'analysis-reports/项目文档与对比报告.md']
  const claimsIn = (body) => {
    const out = []
    const push = (v) => { const n = norm(v); if (!out.includes(n)) out.push(n) }
    for (const line of body.split(/\r?\n/)) {
      if (!/engines/i.test(line)) continue
      for (const m of line.matchAll(/engines[^\n]{0,80}?(\d{2}\.\d{1,2}\.\d{1,2}|>=\s*\d{2}(?:\.\d+){0,2})/gi)) push(m[1])
      for (const m of line.matchAll(/engines\.node[^0-9\n]{0,12}"([^"]+)"/gi)) push(m[1])
    }
    return out
  }
  const FIX22 = [
    { s: '根 `package.json` 的 `engines.node` 是 `">=24"`', want: ['>=24'] },
    { s: 'Node.js 24（engines 钉 24.18.0）', want: ['24.18.0'] },
    { s: '# engines 钉 24.1.0 且 .npmrc engine-strict=true', want: ['24.1.0'] },
    { s: 'node-version: [24]  # setup-node 用 24', want: [] },
  ]
  const badFix = FIX22.map((f) => {
    const got = claimsIn(f.s)
    return JSON.stringify(got) === JSON.stringify(f.want) ? null : `夹具「${f.s}」应抽 ${JSON.stringify(f.want)}，实抽 ${JSON.stringify(got)}`
  }).filter((x) => x !== null)
  const stale = []
  const missing = []
  for (const rel of CLAIM_FILES) {
    const p = join(clientRoot, '..', rel)
    if (!existsSync(p)) { missing.push(rel); continue }
    for (const v of claimsIn(readFileSync(p, 'utf8'))) if (norm(v) !== norm(realEngines)) stale.push(`${rel}：写着 ${JSON.stringify(v)} 而真值是 ${JSON.stringify(realEngines)}`)
  }
  report(realEngines !== '' && missing.length === 0 && badFix.length === 0 && stale.length === 0,
    `engines 的文档措辞等于 \`package.json\` 真值（面=${CLAIM_FILES.length} 份"教约束"的文件：${CLAIM_FILES.join(' / ')}；台账里引用旧错值的历史句子**故意不在面内**；4 条夹具：真范围、两种旧错写法各抽出一个版本号、没有 engines 字样的行不算）`,
    realEngines === '' ? `读不到 ${pkgPath} 里的 engines.node——这一条没在量任何东西`
      : badFix.length > 0 ? '版本号抽取的形状自证没过，这一条不作数：' + badFix.join(' ｜ ')
        : missing.length > 0 ? `名册里的文件读不到：${missing.join('、')}（改名要连名册一起改）`
          : stale.length > 0 ? stale.join(' ｜ ')
            : `${CLAIM_FILES.length} 份文件里带 engines 字样的版本号全部等于 ${JSON.stringify(realEngines)}（真值取自 ${pkgPath}）`)
}
// --- 块 21：不发钱的验收脚本，发送只能走 lib-instance 那三个受 keyless 兜的出口 ---
// 起因是 `accept-panel.ts` 的真缺陷：它打印"这一发由内核本地受理、不会离开本机"，然后无条件
// `api.prompt`，而它默认打的那台（`client/.sidecar-info.json`）就是**有 key** 的操作者实例。
// 一句谎话 + 一发真上游。所以把不变量钉死：没声明 `{ spends: true }` 的 `accept-*.ts` 里，
// `api.prompt|queue|sendOrQueue` 直连 0 处、裸 `fetch(...)/prompt` 0 处；要发就经过出口的现读守卫。
{
  const stripLineComments = (s) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
  const SEND_RE = /\bapi\.(?:prompt|queue|sendOrQueue)\s*\(/g
  const rawPrompt = (s) => {
    let n = 0
    for (const m of s.matchAll(/\bfetch\(/g)) if (s.slice(m.index, m.index + 220).includes('/prompt')) n += 1
    return n
  }
  const violationsOf = (body) => {
    const s = stripLineComments(body)
    return [...s.matchAll(SEND_RE)].map((m) => m[0]).concat(rawPrompt(s) > 0 ? [`裸 fetch → /prompt ×${String(rawPrompt(s))}`] : [])
  }
  const FIX21 = [
    { name: '直连 api.prompt 被点名', body: `const x = await api.prompt(id, { prompt: 'a' })`, want: 1 },
    { name: '走受守卫的出口不算违规', body: `const x = await sendPrompt(api, id, 'a', 'label')\nconst y = await api.health()`, want: 0 },
    { name: '绕过客户端裸 fetch /prompt 也被点名', body: "const r = await fetch(`${info.baseUrl}/sessions/1/prompt`, { method: 'POST' })", want: 1 },
    { name: '整行注释里的名字不算调用（剥的是行首 //，行尾注释仍计数）', body: `// 这里以前写 api.prompt(id, ...) 于是烧了一发\nconst z = 1`, want: 0 },
    { name: '行尾注释藏不住调用（方向是宁多报不漏报）', body: `const z = 1 // api.prompt(id) 藏在行尾`, want: 1 },
  ]
  const badFix = FIX21.map((f) => (violationsOf(f.body).length === f.want ? null : `夹具「${f.name}」：期望 ${String(f.want)} 条违规，实读 ${String(violationsOf(f.body).length)}（${JSON.stringify(violationsOf(f.body))}）`)).filter((x) => x !== null)
  const dir = join(clientRoot, 'scripts')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^accept-.+\.ts$/.test(f)).sort() : []
  const paid = []
  const free = []
  const bad = []
  for (const f of files) {
    const body = readFileSync(join(dir, f), 'utf8')
    const declaresSpend = /\bspends:\s*true\b/.test(body)
    ;(declaresSpend ? paid : free).push(f)
    if (declaresSpend) continue
    const v = violationsOf(body)
    if (v.length > 0) bad.push(`${f}：${v.join('、')}`)
  }
  report(files.length > 0 && badFix.length === 0 && bad.length === 0,
    `不发钱的验收脚本不许直连发送口（\`scripts/accept-*.ts\` 里没声明 \`{ spends: true }\` 的那些，\`api.prompt/queue/sendOrQueue\` 与裸 \`fetch → /prompt\` 必须为 0 处，发送只经 \`lib-instance\` 的现读守卫；5 条夹具：直连、走出口、裸 fetch、行首注释、行尾注释）`,
    files.length === 0 ? '面塌了：scripts/ 下一个 accept-*.ts 都没扫到，这一条没在量任何东西'
      : badFix.length > 0 ? '违规抽取的形状自证没过，这一条不作数：' + badFix.join(' ｜ ')
        : bad.length > 0 ? bad.join(' ｜ ')
          : `扫了 ${String(files.length)} 份：声明付费 ${String(paid.length)} 份（${paid.join('、')}），其余 ${String(free.length)} 份零直连；出口在 scripts/lib-instance.ts（sendPrompt / sendQueue / sendOrQueueGuarded / rawPromptPost，四个都现读 /health.configured）`)
}
// --- 块 22：每台验收会话的 cwd 必须解析到仓外（源码级——行为级那道只在有人真跑那一趟时才有效）---
// 起因是 #174 那一族的最后一处漏网：`accept-stream.ts` 一路带着 `cwd: repoRoot` 活了 4 天。
// 当时的守卫是 `verify-accept-zero` 的"仓根 `.rivet/` 前后计数"，可那一趟是**零花费**的，而它声明
// `{ spends: true }`、永远进不了那趟的名单——行为计数守不到不跑的路径。内核往**任何会话 cwd** 种
// `.rivet/`（skills + meridian.db/-shm/-wal），而 `src/agent/memory-epoch.ts` 的 LEGACY_FILES 还按
// `<cwd>` **删**其中已有的文件，所以这不是整洁问题：真 run 一次就可能删掉操作者库里的一条。
// 落点认不出来也算违规（不许把"我看不出它落哪"当成通过），没给 cwd 同样算——那等于赌对端是怎么起的。
{
  const strip = (s) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')
  const ROOT = /(clientRoot\s*,\s*['"]\.\.['"]|\brepoRoot\b|process\.cwd\(\))/
  const TMP = /(\bprobeWorkspace\b|tmpdir\()/
  const REG = /(infoPath|stateDir)/
  const IGN = /\.sidecar-data/
  const BUCKET = {
    root: '操作者仓根',
    tmp: '系统临时目录（probeWorkspace）',
    reg: '跟着这次用的登记文件走（caller 的临时目录）',
    ign: '仓内 gitignore 沙箱（client/.sidecar-data）',
    opaque: '认不出落点',
    nocwd: '没给 cwd（落点交给对端怎么起的）',
  }
  const argObj = (s, braceIdx) => {
    let depth = 0
    for (let i = braceIdx; i < s.length; i += 1) {
      const c = s[i]
      if (c === '{') depth += 1
      else if (c === '}') { depth -= 1; if (depth === 0) return s.slice(braceIdx, i + 1) }
    }
    return s.slice(braceIdx, braceIdx + 600)
  }
  const faceOf = (body) => {
    const s = strip(body)
    const defs = new Map()
    for (const d of s.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) if (!defs.has(d[1])) defs.set(d[1], d[2].trim())
    const calls = [...s.matchAll(/\bapi\.createSession\(\s*\{/g)]
    const trace = (expr) => {
      let cur = expr
      for (let hop = 0; hop < 6; hop += 1) {
        if (ROOT.test(cur)) return { k: 'root', text: cur }
        if (TMP.test(cur)) return { k: 'tmp', text: cur }
        if (REG.test(cur)) return { k: 'reg', text: cur }
        if (IGN.test(cur)) return { k: 'ign', text: cur }
        const next = (cur.match(/[A-Za-z_$][\w$]*/g) ?? []).map((n) => defs.get(n)).filter((v) => typeof v === 'string')
        if (next.length === 0) return { k: 'opaque', text: cur }
        cur = next.join(' ')
      }
      return { k: 'opaque', text: cur }
    }
    const windows = calls.map((m) => {
      const obj = argObj(s, m.index + m[0].length - 1)
      const cwd = /\bcwd:\s*([^,\n}]+)/.exec(obj)
      return cwd === null || cwd === undefined ? { k: 'nocwd', text: obj.replace(/\s+/g, ' ').slice(0, 70) } : trace(cwd[1].trim())
    })
    return { windows, broad: (s.match(/\bcreateSession\b/g) ?? []).length, narrow: calls.length }
  }
  const shape = (f) => `${String(f.w.narrow)}窄/${String(f.w.broad)}宽[${f.w.windows.map((x) => x.k).join(',')}]`
  const FIX22 = [
    { n: 'ws.cwd 追到 probeWorkspace ⇒ 临时目录档', body: `const ws = probeWorkspace('k')\nconst s = await api.createSession({ cwd: ws.cwd })`, want: '1窄/1宽[tmp]' },
    { n: '字面 repoRoot ⇒ 仓根档', body: `const repoRoot = resolve(clientRoot, '..')\nconst s = await api.createSession({ cwd: repoRoot, title: 't' })`, want: '1窄/1宽[root]' },
    { n: '两跳（base = join(repoRoot,…）也追得到', body: `const repoRoot = resolve(clientRoot, '..')\nconst base = join(repoRoot, 'x')\nconst s = await api.createSession({ cwd: base })`, want: '1窄/1宽[root]' },
    { n: '没给 cwd 也算一条，档名单独', body: `const s = await api.createSession({ title: 't' })`, want: '1窄/1宽[nocwd]' },
    { n: '行首注释里的调用不作数（面为空）', body: `// const s = await api.createSession({ cwd: repoRoot })\nconst z = 1`, want: '0窄/0宽[]' },
    { n: '跟着登记文件走的沙箱 ⇒ reg 档（三跳）', body: `const { infoPath } = openInstance('x')\nconst stateDir = dirname(infoPath)\nconst root = join(stateDir, 'panel-sandbox')\nconst work = join(root, 'work')\nconst s = await api.createSession({ cwd: work })`, want: '1窄/1宽[reg]' },
    { n: '认不出落点不许静默放过 ⇒ opaque', body: `const mystery = somethingElse()\nconst s = await api.createSession({ cwd: mystery })`, want: '1窄/1宽[opaque]' },
    { n: '别名调用被宽窄不等抓出（窄 0 宽 1）', body: `const cs = api.createSession\nconst s = await cs({ cwd: ws.cwd })`, want: '0窄/1宽[]' },
  ]
  const badFix = FIX22.map((f) => {
    const got = faceOf(f.body)
    const s = shape({ w: got })
    return s === f.want ? null : `夹具「${f.n}」：期望 ${f.want}，实读 ${s}`
  }).filter((x) => x !== null)

  // 两条前提各自要读真契约，不许只信档名：tmp 档成立是因为共用件真把落点建在 tmpdir 里，
  // reg/ign 档成立是因为那个目录真被 .gitignore 罩着。
  const libSrc = existsSync(join(clientRoot, 'scripts', 'lib-instance.ts')) ? readFileSync(join(clientRoot, 'scripts', 'lib-instance.ts'), 'utf8') : ''
  const pwBody = (/export function probeWorkspace[\s\S]*?\n\}/.exec(strip(libSrc)) ?? [''])[0]
  const pwOk = /\btmpdir\(\s*\)/.test(pwBody) && !ROOT.test(pwBody)
  const pwFix = [
    { body: `export function probeWorkspace(l) {\n  const base = join(tmpdir(), l)\n  return { cwd: base }\n}`, want: true },
    { body: `export function probeWorkspace(l) {\n  const base = join(clientRoot, '..', l)\n  return { cwd: base }\n}`, want: false },
  ].map((f, i) => ((/\btmpdir\(\s*\)/.test(f.body) && !ROOT.test(f.body)) === f.want ? null : `pw 夹具 ${String(i + 1)} 没过`)).filter((x) => x !== null)
  const giSrc = existsSync(join(clientRoot, '.gitignore')) ? readFileSync(join(clientRoot, '.gitignore'), 'utf8') : ''
  const giLine = giSrc.split(/\r?\n/).map((l, i) => ({ l: l.trim(), n: i + 1 })).find((x) => x.l === '.sidecar-data/')
  const giFix = [
    { body: 'node_modules/\n.sidecar-data/\n', want: true },
    { body: 'node_modules/\ntmp-data/\n', want: false },
  ].map((f, i) => (f.body.split(/\r?\n/).map((x) => x.trim()).includes('.sidecar-data/') === f.want ? null : `gitignore 夹具 ${String(i + 1)} 没过`)).filter((x) => x !== null)

  const dir = join(clientRoot, 'scripts')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^accept-.+\.ts$/.test(f)).sort() : []
  const bad = []
  const perFile = []
  let windowsTotal = 0
  const bucketTotal = {}
  for (const f of files) {
    const w = faceOf(readFileSync(join(dir, f), 'utf8'))
    windowsTotal += w.windows.length
    for (const x of w.windows) bucketTotal[x.k] = (bucketTotal[x.k] ?? 0) + 1
    if (w.broad !== w.narrow) { bad.push(`${f}：抽到 ${String(w.narrow)} 个 \`api.createSession({\` 窗口，文件里却有 ${String(w.broad)} 处 \`createSession\` 这个名字 ⇒ 要么有会话藏在别名/工厂里（落点面数不到它），要么那名字出现在字符串/类型里——两种都要人看一眼，不许按少掉的那份继续算绿`); continue }
    const v = w.windows.filter((x) => x.k === 'root' || x.k === 'opaque' || x.k === 'nocwd')
    if (v.length > 0) bad.push(`${f}：${v.map((x) => `${BUCKET[x.k]}←\`${x.text.replace(/\s+/g, ' ').slice(0, 90)}\``).join('、')}`)
    const cnt = {}
    for (const x of w.windows) cnt[x.k] = (cnt[x.k] ?? 0) + 1
    perFile.push(`${f} ${String(w.windows.length)} 处〔${Object.entries(cnt).map(([k, n]) => `${BUCKET[k]}×${String(n)}`).join('，') || '无会话'}〕`)
  }
  report(files.length > 0 && windowsTotal >= 1 && badFix.length === 0 && pwFix.length === 0 && giFix.length === 0 && pwOk && giLine !== undefined && bad.length === 0,
    `验收脚本每台会话的 cwd 都要解析得到仓外（\`scripts/accept-*.ts\` 里 \`api.createSession\` 的 \`cwd:\` 表达式沿同文件 \`const/let\` 定义做传递闭包，落点必须归进四档之一：\`${BUCKET.tmp}\`／\`${BUCKET.reg}\`／\`${BUCKET.ign}\`／\`${BUCKET.root}\`；后三档之外的 \`认不出落点\` 与 \`没给 cwd\` 都算违规；两条前提读真契约（\`probeWorkspace\` 函数体里真有 \`tmpdir()\`、\`client/.gitignore\` 真有 \`.sidecar-data/\` 那行）；窄窗数≠宽调用数即红，8 条形状夹具含别名与注释）`,
    files.length === 0 ? '面塌了：scripts/ 下一个 accept-*.ts 都没扫到，这一条没在量任何东西'
      : badFix.length > 0 || pwFix.length > 0 || giFix.length > 0 ? '夹具自证没过，这一条不作数：' + [...badFix, ...pwFix, ...giFix].join(' ｜ ')
        : !pwOk ? `前提破了：lib-instance.ts 的 probeWorkspace 函数体不再从 tmpdir() 起（现读：${pwBody.replace(/\s+/g, ' ').slice(0, 120) || '整个函数都没扫到'}），"临时目录"那一档等于在骗人`
          : giLine === undefined ? '前提破了：client/.gitignore 里没有 `.sidecar-data/` 那一行，"仓内 gitignore 沙箱"那一档会把探针写进 tracked 面'
            : bad.length > 0 ? bad.join(' ｜ ')
              : `扫 ${String(files.length)} 份、${String(windowsTotal)} 台会话〔${Object.entries(bucketTotal).map(([k, n]) => `${k}×${String(n)}`).join('，')}〕；pw 函数体=${pwBody.replace(/\s+/g, ' ').slice(0, 52)}…，gitignore 第 ${String(giLine.n)} 行="${giLine.l}"；逐档 ${perFile.filter((p) => !/0 处/.test(p)).join(' ｜ ')}`)
}
/**
 * 12. ADR-0001 落地判定（`docs/decisions/0001-单仓与全栈自主可控.md`，status: accepted）。
 *
 * 门先立在文档改动之前：首跑应有四条红，红了才证明判据真的在打那九份仓根文件，而不是
 * 写完之后倒推着补的绿灯。唯一一条今天就该绿的是 ⑤——它是正控，防的是"顺手把 pro 分层
 * 机制当闭源残留拆掉"，它红了才是事故。
 *
 * 五条可观察量：① 双仓/闭源/死链安装包这几类禁句在口径文档面里归零（份数取自
 * `ADR_ALL_DOCS`、枚数取自 `ADR_BANS`，都现算并打印，不写死在文案里）；② 外部 PR 处置政策的
 * 锚点句必须**还在**（正控，防"取消双仓"被做成"取消政策"）；③ 桌面端事实源转到 `client/`，
 * `docs/desktop-guide.md` 标 deprecated 且不删档；④ 四份语言 README 不许承诺发不出的安装包，
 * 且必须留诚实替代句（防"删掉就算改完"）；⑤ pro 机制三件制品在位。
 */
const ADR_ROOT_DOCS = ['AGENTS.md', 'CLAUDE.md', '.rivet.md', 'EXTERNAL-PRS.md', 'CONTRIBUTING.md', 'README.md', 'README.en.md', 'README.ja.md', 'README.ko.md']
// 2026-10-16 扩面：同族残留还在三份**现行手册**里（installation.md 教人下载不存在的安装包、
// architecture-overview.md 仍把 `desktop/` 当桌面端落点、user-guide.md 有安装承诺）。
// 只数仓根九份 = 首屏改干净、手册里继续发死链。
// 为什么 `analysis-reports/项目文档与对比报告.md` 那两处不扩进来：它抬头写着「生成日期：2026-10-08 /
// 只读静态分析」，里面「闭源边界：`desktop/`…」「`desktop/` 不在公开仓」记的是**当时看到的现状**，
// 改它等于篡改调研——按 ADR-0001 的历史不动原则，既不写，也不进门的面。
const ADR_DOCS_EXT = ['docs/guides/installation.md', 'docs/user-guide.md', 'docs/architecture-overview.md']
const ADR_ALL_DOCS = [...ADR_ROOT_DOCS, ...ADR_DOCS_EXT]
const adrText = (rel) => { const p = join(repoRoot, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null }
const adrDocs = ADR_ALL_DOCS.map((rel) => ({ rel, text: adrText(rel) }))
const adrMissing = adrDocs.filter((d) => d.text === null).map((d) => d.rel)

const ADR_BANS = [
  { tag: '双仓·开发主仓', re: /开发主仓|dev 主仓/ },
  { tag: '双仓·同步投影', re: /同步投影|投影而来/ },
  { tag: '双仓·英文措辞', re: /projection of the dev repo|the public repo is synchronized from it/i },
  { tag: '闭源叙事', re: /闭源/ },
  { tag: 'Tauri 桌面端', re: /Tauri \+ React/ },
  // 桌面端的**产品落点**不许再写根级 `desktop/`（那目录不在本仓）；但 `src/diagnostics/log-locations.ts`
  // 把 `'desktop'` 定成日志组 id、`<数据根>/desktop` 是运行时目录，所以 sidecar-exit / sessions 那两类
  // 真路径必须放过——把它们一起判红，下次就有人整条宽松化掉。
  { tag: '根级 desktop/ 落点', re: /`desktop\/(?!sidecar-exit|sessions)/ },
  { tag: '安装包死链', re: /releases\/latest/ },
  // 2026-10-16 补的两枚：单仓化第一轮把「开发主仓/同步投影」这类正面措辞清掉了，但同一套
  // 前提还有别的写法——「随 sync 进公开仓」「dev 仓这份」都不在前七枚的射程里，实测漏过
  // CLAUDE.md 的一句插件说明（那文件在面里，形状在面外）。`dev 仓(?!库)` 是防误伤：
  // 「在 dev 仓库里跑」这种正常中文不能算双仓叙事。
  { tag: '双仓·sync 交付链', re: /随 sync|进公开仓|覆盖公开仓/ },
  { tag: '双仓·dev 仓措辞', re: /dev 仓(?!库)|dev仓(?!库)/ },
]
const adrBanHits = []
for (const d of adrDocs) {
  if (d.text === null) continue
  d.text.split('\n').forEach((line, i) => {
    for (const b of ADR_BANS) if (b.re.test(line)) adrBanHits.push(`${d.rel}:${i + 1}〔${b.tag}〕`)
  })
}
// 匹配器自证：既要咬得住真禁句，也不能把合法的新文案（`client/apps/desktop/`、诚实替代句、
// 政策句）误判成红——误伤一次，下次就有人来把这条例宽松化掉。
const ADR_BAN_FIXTURES = [
  { want: true, s: '> 本仓是开发主仓的同步投影。' },
  { want: true, s: '桌面端（`desktop/`）与部分高级实现不在本仓（闭源边界见 EXTERNAL-PRS.md）。' },
  { want: true, s: 'Desktop app: download from [GitHub Releases](https://github.com/a/b/releases/latest)' },
  { want: true, s: 'The public repo is a projection of the dev repo.' },
  { want: true, s: '| `desktop/src` | 约 450 文件 / 9.6 万行（React） |' },
  { want: false, s: '桌面端壳在 `client/apps/desktop/`，Web 端在 `client/apps/web/`。' },
  { want: false, s: '安装包尚未发布：本仓当前 0 个 Release，桌面端从源码运行。' },
  { want: false, s: '外部 PR 先评审、按当前代码重写后落地，以 sync-merged 关闭。' },
  { want: false, s: '| `desktop/sidecar-exit.json` | sidecar 終了理由のパンくず | 終了時 |' },
  { want: false, s: '| `desktop/sessions/<id>/events.jsonl` | デスクトップ UI イベントストリーム |' },
  // 新两枚的形状自证：既要咬住双仓叙事的另外两种写法，又不能把「sync-merged」「dev 仓库」
  // 这类正常中文误判成红——误伤一次，下次就有人来把它宽松化掉。
  { want: true, s: '桌面端与 VS Code 插件随 sync 进公开仓。' },
  { want: true, s: 'dev 仓这份不再覆盖公开仓，台账以公开仓那份为准。' },
  { want: false, s: '外部 PR 以 sync-merged 关闭；本仓就是那份公开仓。' },
  { want: false, s: '在 dev 仓库里跑一次 `npm run dev` 就够了。' },
]
const adrBanFixBad = ADR_BAN_FIXTURES
  .filter((f) => ADR_BANS.some((b) => b.re.test(f.s)) !== f.want)
  .map((f) => `${f.want ? '该认没认' : '误伤'}：${f.s.slice(0, 26)}`)

report(adrBanFixBad.length === 0 && adrMissing.length === 0 && adrBanHits.length === 0,
  `ADR-0001 ① ${ADR_ALL_DOCS.length} 份口径文档里没有这几类字样：${ADR_BANS.map((b) => b.tag).join(' / ')}（${ADR_BANS.length} 枚禁句、${ADR_BAN_FIXTURES.length} 条夹具自证；实扫 ${adrDocs.length - adrMissing.length} 份，命中 ${adrBanHits.length} 处）`,
  adrBanFixBad.length > 0 ? `禁句匹配器的夹具自证没过（${adrBanFixBad.join(' ｜ ')}），这一条不作数`
    : adrMissing.length > 0 ? `文件不在盘上：${adrMissing.join(' , ')}`
      : adrBanHits.length > 0 ? `${adrBanHits.slice(0, 8).join(' ｜ ')}${adrBanHits.length > 8 ? ` ｜ 另有 ${adrBanHits.length - 8} 处` : ''}` : '')

// ② 政策锚点正控：取消双仓叙事不等于取消 PR 处置流程。这些串在政策文件里少一处就是红，
// 所以"把整段政策顺手删了"和"把双仓前提改写掉了"分得开。
const ADR_POLICY = [
  { rel: 'EXTERNAL-PRS.md', needles: [['sync-merged', 2], ['never merged directly', 1], ['CREDITS.md', 1], ['CONTRIBUTORS.md', 1]] },
  { rel: 'CONTRIBUTING.md', needles: [['sync-merged', 1], ['merged directly', 1]] },
]
const adrPolicyBad = []
for (const p of ADR_POLICY) {
  const t = adrText(p.rel)
  if (t === null) { adrPolicyBad.push(`${p.rel} 不在盘上（政策文件被删了？）`); continue }
  for (const [needle, min] of p.needles) {
    const n = t.split(needle).length - 1
    if (n < min) adrPolicyBad.push(`${p.rel} 里「${needle}」只剩 ${n} 处（政策要求 >=${min}）`)
  }
}
report(adrBanFixBad.length === 0 && adrPolicyBad.length === 0,
  `ADR-0001 ② 外部 PR 处置政策的锚点句仍在两份文件里（${ADR_POLICY.reduce((a, p) => a + p.needles.length, 0)} 枚锚点，逐枚数出现次数）`,
  adrBanFixBad.length > 0 ? '上面那条夹具自证没过，这一条不作数'
    : adrPolicyBad.length > 0 ? adrPolicyBad.join(' ｜ ') : '')

// ③ 桌面端事实源：`docs/desktop-guide.md` 讲的是一个发不出的 Tauri 产物——标 deprecated 但
// 不删档；四份 README 凡仍列它作入口的行必须带上 deprecated 注记，且要把桌面端指向 client/。
const dgPath = join(repoRoot, 'docs', 'desktop-guide.md')
const dgText = existsSync(dgPath) ? readFileSync(dgPath, 'utf8') : null
const dgFront = dgText === null ? '' : dgText.split('\n').slice(0, 12).join('\n')
// `docs/` 在 client/ 之外，检出带 CRLF（本机 core.autocrlf=true）：`$` 前不写 `\r?` 的话，
// 这条行级锚点会**永远不匹配**——判据红了却是门瞎，不是文档没改。
const dgDeprecated = /^status:[ ]*deprecated[ ]*\r?$/m.test(dgFront)
const adrDgBad = []
if (dgText === null) adrDgBad.push('docs/desktop-guide.md 被删了（决策要求不删档）')
else if (!dgDeprecated) adrDgBad.push('docs/desktop-guide.md 的 frontmatter 没有 status: deprecated')
for (const d of adrDocs) {
  if (d.text === null || !d.rel.startsWith('README')) continue
  d.text.split('\n').forEach((line, i) => {
    if (line.includes('docs/desktop-guide.md') && !/deprecated/i.test(line)) adrDgBad.push(`${d.rel}:${i + 1} 仍把 desktop-guide 当现行入口（那行没有 deprecated 注记）`)
  })
  if (!d.text.includes('client/')) adrDgBad.push(`${d.rel} 全文没有 client/，桌面端事实源没落到本仓`)
}
report(adrBanFixBad.length === 0 && adrDgBad.length === 0,
  'ADR-0001 ③ 桌面端事实源是本仓 `client/`，desktop-guide 标 deprecated 且不删档（四份 README 的入口行同批核）',
  adrBanFixBad.length > 0 ? '上面那条夹具自证没过，这一条不作数'
    : adrDgBad.length > 0 ? `${adrDgBad.slice(0, 6).join(' ｜ ')}${adrDgBad.length > 6 ? ` ｜ 另有 ${adrDgBad.length - 6} 处` : ''}` : '')

// ④ 发不出的承诺：新仓 Release 实测 0 个，四份语言 README 各留一句诚实替代说法。
// 只查"死链消失"会放过"整段删掉"，所以替代句与死链两条并查。
const ADR_HONEST = {
  'README.md': '安装包尚未发布',
  'README.en.md': 'installers are not published yet',
  'README.ja.md': 'インストーラーは未公開',
  'README.ko.md': '설치 파일은 아직 공개되지 않음',
  // 2026-10-16 扩面：手册里那条死链同样要换成诚实说法，只删链不留说法 = 读者不知道桌面端去哪了。
  'docs/guides/installation.md': '安装包尚未发布',
  'docs/user-guide.md': '安装包尚未发布',
}
const adrHonestBad = Object.entries(ADR_HONEST)
  .filter(([rel, phrase]) => { const t = adrText(rel); return t === null || !t.includes(phrase) })
  .map(([rel]) => `${rel} 缺诚实替代句`)
// 死链要**重新扫四份 README**，不能拿 ① 的命中清单来推——那份清单里只有
// `README.ko.md:NNN〔安装包死链〕` 这种标签，字面量并不含 `releases/latest`，
// 用它当判据等于这条永远不会红（2026-10-16 变异一实测抓出的假绿）。
const adrDeadLinks = Object.keys(ADR_HONEST).flatMap((rel) => {
  const t = adrText(rel)
  if (t === null) return []
  return t.split("\n").map((l, i) => (/releases\/latest/.test(l) ? `${rel}:${i + 1}` : null)).filter(Boolean)
})
report(adrBanFixBad.length === 0 && adrHonestBad.length === 0 && adrDeadLinks.length === 0,
  `ADR-0001 ④ ${Object.keys(ADR_HONEST).length} 份口径文档既不承诺 releases/latest 安装包，也各自留了"尚未发布"的替代说法（缺句 ${adrHonestBad.length} 份、残留死链 ${adrDeadLinks.length} 处）`,
  adrBanFixBad.length > 0 ? '上面那条夹具自证没过，这一条不作数'
    : [adrHonestBad.join(' ｜ '), adrDeadLinks.length ? `仍有死链：${adrDeadLinks.join(' , ')}` : ''].filter(Boolean).join(' ｜ ') || '')

// ⑤ 正控：pro 分层是"对端不在本仓的扩展缝"，不是可以顺手拆掉的闭源残留。三件制品少一件就红，
// 而它今天就应该绿——它绿着才说明这一条打的是"将来的误拆"，不是这次的文案改动。
const ADR_PRO = [
  { rel: 'src/__tests__/npm-pack-boundary.test.ts', needle: null },
  { rel: 'tsup.config.ts', needle: 'src/pro/index.ts' },
  { rel: 'src/api/pro-registry.ts', needle: 'pro/index.js' },
]
const adrProBad = ADR_PRO.filter((a) => {
  const p = join(repoRoot, a.rel)
  if (!existsSync(p)) return true
  return a.needle !== null && !readFileSync(p, 'utf8').includes(a.needle)
}).map((a) => a.rel)
report(adrProBad.length === 0,
  'ADR-0001 ⑤（正控）pro 扩展缝的三件制品仍在位：包边界测试 × tsup 独立 entry × 注册表动态 import',
  adrProBad.length > 0 ? `不在了：${adrProBad.join(' , ')}` : '机制未动，这条防的是将来把它当闭源残留拆掉')

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
if (!quiet) console.log('docs checks passed')
