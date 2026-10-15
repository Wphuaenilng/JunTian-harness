/**
 * verify-rest-surface.mjs — 把「协议面 0 缺口」从人肉对账变成实测（零上游花费）。
 *
 * 为什么要它：台账里那句"官方插件用的路径我全有对应"一直是我手点对账出来的；而客户端自己构造的
 * 每一条路径（**读、写、流三种都算**），其中任何一条拼错、被内核改名、或方法论上根本不存在，
 * **表现都是运行时某个面板空着**——没有编译错误，也没有红判定，只有一句"这里为什么没数据"。
 *
 * 判据只用外部可观察量（HTTP 状态、SSE 的头几帧），并且**路径从 client-core 源码派生**，不在这里重打一遍
 * URL：那样就成了第二份事实源，改方法而忘改本文件时它会跟着一起骗人。派生面扫 `client-core/src` 的
 * **全部源文件**——只读那一份 `sidecar-client.ts` 时，两条 SSE 流整条不在射程里（2026-10-13 补）。
 *
 *   404 / 405  → 红：客户端在打一条内核不服务的路由（这就是那句"0 缺口"的反例）
 *   5xx        → 红：路由在，但服务端炸了
 *   400 / 422  → 不算红：路由在，只是我这发的合成参数被拒（明细照样打印，方便看是谁的锅）
 *
 * 零花费：只 boot 无 key 实例。读面全打；写面只打**在这台临时实例 / 一次性仓库里不产生外溢**的那些
 * （归档、改名、中止、配置位…），其余每一条都要在 `WRITE_SKIP` 里写明"为什么不发、谁替我发过"，
 * 而那句理由点名的脚本会被逐条回读（`api.<方法名>` 真在那份文件里出现过才算）。模型面（`prompt`/`queue`）
 * 一条都不发——本验法零上游花费的前提就钉在那两条上。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 内核源码在这里**只读**：用来判"这条路由名内核里到底有没有"。铁律（不改 src/**）由
// check:nongoals 第 1 条守着，本文件一次写入都没有。
const repoRoot = resolve(clientRoot, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * 有界等待。**必须**在先到的一侧 `clearTimeout`：`Promise.race([p, sleep(N)])` 里那个定时器
 * 不会因为 race 出结果就消失，它继续吊着事件循环——本文件因此把"全部判定已完成"的这一次
 * 跑成了整整 180 秒（我一开始怀疑 git 扫大仓、又怀疑服务器工作区根，两次实测一秒不变，
 * 最后计时发现 180.148s 正好等于那个超时值）。
 */
const bound = (p, ms, onTimeout) =>
  new Promise((res) => {
    const t = setTimeout(() => res(onTimeout()), ms)
    Promise.resolve(p).then((v) => { clearTimeout(t); res(v) }, () => { clearTimeout(t); res(onTimeout()) })
  })
const failures = []
let checksRun = 0
const check = (label, ok, detail = '') => {
  checksRun += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer()
  s.on('error', rej)
  s.listen(0, '127.0.0.1', () => {
    const a = s.address()
    const port = typeof a === 'object' && a ? a.port : 0
    s.close(() => res(port))
  })
})

/**
 * 取一条模板字符串的字面量内容，**支持嵌套**（`/tasks${q ? `?${q}` : ''}` 这种）。
 * 旧写法在第一个反引号就收工，于是截出半条路径，只能整条算"取不到"——`/tasks` 就是这么从这一面
 * 漏掉的，而它正是"query 会被内核读"那句假前提能活下来的洞（2026-10-13 由 accept-tasks.ts 实测否证）。
 * 取不到（引号拼变量、没有字面路径）返回 null，让调用方如实计数。
 */
function extractTemplate(src, fromTick) {
  if (src[fromTick] !== '`') return null
  let depth = 0
  for (let i = fromTick + 1; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === '$' && src[i + 1] === '{') { depth++; i++; continue }
    if (c === '}' && depth > 0) { depth--; continue }
    if (c === '`' && depth === 0) return src.slice(fromTick + 1, i)
  }
  return null
}

/**
 * 取 `this.request(verb, <第二个实参>)` 里那个路径实参，**两种字面量形状都要认**：
 * ① 模板字面量（可能嵌套，交给 `extractTemplate`）；② 单/双引号的纯字面量——`this.request('GET', '/health')`
 * 这种。上一版只认反引号，后果分两种，都不是"少扫一条"那么无害：GET 面把 7 条**明明有字面量**的路
 * 报成"路径拼在变量里，没有字面量可派生"（对源码的一句假陈述），而写面的正则硬性要求反引号，于是
 * 9 条调用点**连"未派生"都不进**——`createSession`、`workbenchStage/Commit/Branch/Sync`、
 * `createScheduleTask`、`setApprovalConfig`、`setDefaultModelConfig`、`createCustomProvider` 全在
 * 名册之外，而名册那句"每个触网的写方法都有归属"读起来像已经数全了。真变量/表达式返回 null，由调用方点名。
 */
function extractPathArg(src, atDelim) {
  const d = src[atDelim]
  if (d === '`') return extractTemplate(src, atDelim)
  if (d !== "'" && d !== '"') return null
  for (let i = atDelim + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === d) return src.slice(atDelim + 1, i)
  }
  return null
}

/**
 * GET 面从**调用点**派生，不猜方法体：`this.request('GET', `路径`)` 里动词与路径是写在一起的，
 * 而方法是 `health(): Promise<…>` 这种非 async 形状——第一版按 `async` 头切片，于是头认不全、
 * 体互相溢出，把 POST 路由算进 GET 面报了四条假 404。改按调用点后，动词由代码自己说。
 */
function deriveGetPaths() {
  const src = readFileSync(join(clientRoot, 'packages/client-core/src/sidecar-client.ts'), 'utf8')
  const heads = [...src.matchAll(/^ {2}(?:private |readonly )?(?:async )?([a-zA-Z]+)\s*\(/gm)]
  const methodAt = (idx) => {
    let name = '?'
    for (const h of heads) { if (h.index < idx) name = h[1]; else break }
    return name
  }
  const out = []
  const unresolved = []
  for (const m of src.matchAll(/this\.request(?:<[^>]*>)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*([^\s,)])/g)) {
    const verb = m[1]
    if (verb !== 'GET') continue
    const name = methodAt(m.index)
    const atDelim = m.index + m[0].length - 1
    const tmpl = extractPathArg(src, atDelim)
    // 取不到（真把路径拼在变量里、或模板不闭合）就**如实算作取不到并点名**，不去打一条拼错的 URL——
    // 那会把验法自己的 bug 报成内核缺路由。
    if (tmpl === null) { unresolved.push(`${name}（第二实参不是字面量，起手 ${JSON.stringify(src[atDelim])}）`); continue }
    out.push({ name, tmpl })
  }
  // 直呼 `fetch(`${this.baseUrl}/…`)` 的只读一发也算面（它没有 postJson 可排除）。
  // 但 `${this.baseUrl}${path}` 那种**纯变量**直呼不算——它没有字面路径，取到的是空气。
  for (const p of [...src.matchAll(/fetch\(`\$\{this\.baseUrl\}(\/[^`]*)`/g)]) {
    if (p[1].length > 1 && !p[1].startsWith('${')) out.push({ name: 'inline-fetch', tmpl: p[1] })
  }
  return { paths: out, unresolved }
}

// 合成值：够让路由被真正命中即可；被 400 拒不算失败（那说明路由存在）。
const SUBS = [
  [/\$\{encodeURIComponent\(id\)\}/g, '__ID__'],
  [/\$\{encodeURIComponent\(requestId\)\}/g, 'probe-request'],
  [/\$\{encodeURIComponent\(name\)\}/g, 'deepseek'],
  [/\$\{encodeURIComponent\(keyId\)\}/g, 'default'],
  [/\$\{encodeURIComponent\(path\)\}/g, 'README.md'],
  // 查询词要给**合法长度**：内核明说 `Query "q" must be at least 2 characters`（这句是从 400 的
  // 响应体里读来的——上一版只记状态码，我就只能把这类挡在门外算"参数不对"，其实差一个字符）。
  [/\$\{encodeURIComponent\((?:q|trimmed|query)\)\}/g, 'probe'],
  // scope 的形状**照客户端自己的构造器**：`gitScopeQuery` 产出 `cwd=…` 或 `sessionId=…`。
  // 上一轮我凭印象塞了 `scope=workspace`，于是六条 `/git/workbench*` 全回 400——那批路由
  // 名义上打了、实际上没被 exercise。用真会话 id 才算真跑过。
  [/\$\{gitScopeQuery\([^)]*\)\}/g, 'sessionId=__ID__'],
  [/\$\{encodeURIComponent\([^)]*\)\}/g, 'x'],
  [/\$\{(?:before)\}/g, '999999999'],
  [/\$\{(?:since)\}/g, '0'],
  [/\$\{(?:limit)\}/g, '5'],
  [/\$\{(?:offset)\}/g, '0'],
  [/\$\{(?:staged)\}/g, 'false'],
  // from/to/sha 用**真 sha 占位符**：字面量 `HEAD` 在内核里不是合法 ref 形状（compare/commit 两条
  // 因此一直 400）。占位符在下面用探针仓库的 `git rev-parse` 实值替换。
  [/\$\{(?:from)\}/g, '__SHA1__'],
  [/\$\{(?:to)\}/g, '__SHA__'],
  [/\$\{(?:sha)\}/g, '__SHA__'],
  // `${q ? `?${q}` : ''}`（`listTasks` 的查询串）：`q` 是 `URLSearchParams.toString()`，
  // **无旗标时整段就是空串**，所以物化成"不带 query 的那条路"正是它默认的调用形状——不是猜的。
  // 这条规则必须在下面那条"去掉一切 `${}`"之前，否则 catch-all 会在第一个 `}` 处截断，
  // 拼出 `/tasks?` 这种尾巴上挂着裸问号的形状。
  [/\$\{\w+\s*\?\s*`[^`]*`\s*:\s*''\s*\}/g, ''],
  // 剩下的一律**去掉**而不是塞 'x'：`/sessions${q}` 里 q 是 '?…' 或 ''，塞 x 会拼出
  // `/sessionsx` 这种根本不存在的形状——那正是刚才那条假 404 的来源。
  [/\$\{[^}]*\}/g, ''],
]
const materialize = (tmpl) => {
  let s = tmpl
  for (const [re, to] of SUBS) s = s.replace(re, to)
  s = s.replace(/[?&]+$/, '') // 去掉留下裸 ?/& 的尾巴
  if (!s.startsWith('/')) s = `/${s}`
  return s
}

// 合成值与物化只有一份定义（上面紧挨着 materialize 的那份）：这里曾留着一份旧的副本，
// 两份同名 const 在 ESM 里是 SyntaxError——`node --check` 当场抓到，不是靠跑起来才发现。

// 写面派生：`this.request('POST'|'PUT'|'PATCH'|'DELETE', <路径>)` 与两个 POST 帮助器
// （`postJson` / `postExpectingBusy`——`prompt`/`queue` 那三条就走在这儿，不一起收就会漏）。
// 路径实参模板与引号字面量**两种都认**（见 `extractPathArg` 那段：只认反引号时，9 条用引号写路径的
// 调用点连"未派生"都不进，名册那句"每个触网的写方法都有归属"就成了对 27 条里的 18 条说话）。
function deriveWritePaths() {
  const src = readFileSync(join(clientRoot, 'packages/client-core/src/sidecar-client.ts'), 'utf8')
  const heads = [...src.matchAll(/^ {2}(?:private |readonly )?(?:async )?([a-zA-Z]+)\s*\(/gm)]
  const methodAt = (idx) => {
    let name = '?'
    for (const h of heads) { if (h.index < idx) name = h[1]; else break }
    return name
  }
  // 帮助器**自己的定义**不是端点调用点：`postExpectingBusy` 里那句 `this.postJson(path, body, 409)`
  // 第二实参当然是变量，把它算成"一条没归属的写路径"会凭空造出失踪案。
  const HELPERS = new Set(['request', 'postJson', 'postExpectingBusy'])
  const notLiteral = (name, atDelim) => `${name}（第二实参不是字面量，起手 ${JSON.stringify(src[atDelim])}）`
  const out = []
  const unresolved = []
  for (const m of src.matchAll(/this\.request(?:<[^>]*>)?\(\s*'(POST|PUT|PATCH|DELETE)'\s*,\s*([^\s,)])/g)) {
    const name = methodAt(m.index)
    const atDelim = m.index + m[0].length - 1
    const tmpl = extractPathArg(src, atDelim)
    if (tmpl === null) { unresolved.push(notLiteral(name, atDelim)); continue }
    out.push({ name, verb: m[1], tmpl })
  }
  for (const m of src.matchAll(/this\.(?:postJson|postExpectingBusy)\(\s*([^\s,)])/g)) {
    const name = methodAt(m.index)
    if (HELPERS.has(name)) continue
    const atDelim = m.index + m[0].length - 1
    const tmpl = extractPathArg(src, atDelim)
    if (tmpl === null) { unresolved.push(notLiteral(name, atDelim)); continue }
    out.push({ name, verb: 'POST', tmpl })
  }
  return { paths: out, unresolved }
}

/**
 * 流式调用点单独派生一遍，而且**扫 client-core 的全部源文件**——上一版两个派生器都只读
 * `sidecar-client.ts` 那一份，于是 `openServerEvents`（`GET /events`，客户端唯一的全局流）与
 * `openSessionStream`（`GET /sessions/:id/stream`，每条会话的事件流）从头到尾不在这张脸上：
 * 「客户端构造的每一条只读路径都被内核服务」这句话当时只对 REST 那 32 条成立，而它读起来像全覆盖。
 * 认"哪些是流"用可观察的形状，不靠点名：**这个文件自己写了 `text/event-stream` 或调 `readSse(`**，
 * 那它的 `fetch(` 就是开流。流不能按 HTTP 状态判完（响应永不结束），所以下面用**有界读首帧**来验。
 */
function deriveStreamSites() {
  const dirSrc = join(clientRoot, 'packages/client-core/src')
  const files = readdirSync(dirSrc).filter((f) => f.endsWith('.ts')).sort()
  const readers = files.filter((f) => /text\/event-stream|readSse\(/.test(readFileSync(join(dirSrc, f), 'utf8')))
  const sites = []
  const unresolved = []
  for (const f of readers) {
    const body = readFileSync(join(dirSrc, f), 'utf8')
    for (const m of body.matchAll(/await fetch\(\s*([`'"])/gs)) {
      const atDelim = m.index + m[0].length - 1
      const tmpl = extractPathArg(body, atDelim)
      const line = body.slice(0, m.index).split('\n').length
      if (tmpl === null) { unresolved.push(`${f}:${line}（第二实参不是字面量）`); continue }
      sites.push({ file: f, line, tmpl })
    }
  }
  return { sites, unresolved, scanned: files.length, readers }
}

/** 把流的路径实参物化：去掉 baseUrl 插值，会话 id 与 query 按客户端**首次连接的形状**填上——
 *  `?${qs}` → `since=0` 不是猜的：`session-stream.ts:104` 每次连接都先建
 *  `URLSearchParams({ since: String(lastSeq) })`，全新会话的 lastSeq 就是 0。 */
const streamPath = (tmpl, sid) =>
  tmpl
    .replace(/^\$\{[^{}]*baseUrl\}/, '')
    .replace(/\$\{encodeURIComponent\([^)]*\)\}/g, String(sid))
    .replace(/\$\{qs\}/g, 'since=0')
    .replace(/\$\{[^{}]*\}/g, '')
    .replace(/[?&]+$/, '')

const stateDir = mkdtempSync(join(tmpdir(), 'rest-surface-state-'))
const dataDir = mkdtempSync(join(tmpdir(), 'rest-surface-data-'))
// 探针会话的 cwd 用**一次性小仓库**，不是 `client/` 本身。第一版用 client/，于是
// `/git/workbench*` 那几条在大仓里扫文件，把这一步拖成全场最慢（实测 180 秒）——
// 一步慢到让人想跳过，它就不再是证据。顺带两个提交，`from=HEAD~1` 才是真的存在，
// 那两条 compare 路由才不是空转。
const repoDir = mkdtempSync(join(tmpdir(), 'rest-surface-repo-'))
const git = (args) => spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false',
  '-c', 'user.name=probe', '-c', 'user.email=probe@localhost', ...args],
  { cwd: repoDir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
const port = await freePort()
let baseUrl = null
let token = null
let child = null

try {
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ providers: [] }, null, 2))
  child = spawn(process.execPath, [
    join(clientRoot, 'scripts/launch-sidecar.mjs'),
    '--port', String(port), '--state-dir', stateDir, '--desktop-dir', dataDir,
    '--config', join(dataDir, 'config.json'), '--isolate-home',
  ], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] })
  // ↑ spawn 的 cwd 用探针仓库而不是 client/：内核的文件/搜索类路由把**服务器进程自己的根**当工作区
  //（就是记忆里那条"搜索读 CLI 根 ≠ 会话 cwd，永远 0 命中"的不对称）。上一轮我把 180 秒归因于
  // "会话 cwd 是大仓"，实测换成小仓库**一秒没变**——因为慢的那个根从来就不是会话 cwd。这一行才是检验。
  const launchOut = []
  child.stdout.on('data', (b) => launchOut.push(String(b)))
  child.stderr.on('data', (b) => launchOut.push(String(b)))
  const launchExit = await bound(new Promise((res) => child.once('exit', res)), 180_000, () => { child.kill('SIGKILL'); return 'TIMEOUT-180s' })
  check('无 key sidecar 起得来（本验法零上游花费的前提）', launchExit === 0,
    `exit=${launchExit}${launchExit === 0 ? '' : ` | ${launchOut.join('').split('\n').slice(-4).join(' / ').slice(0, 200)}`}`)
  if (launchExit !== 0) throw new Error('sidecar did not boot')

  const info = JSON.parse(readFileSync(join(stateDir, '.sidecar-info.json'), 'utf8'))
  baseUrl = info.baseUrl ?? `http://127.0.0.1:${port}`
  token = info.token ?? ''
  const H = { authorization: `Bearer ${token}` }

  const health = await fetch(`${baseUrl}/health`, { headers: H })
  check('/health 200（下面每一条状态才有意义）', health.status === 200, `status=${health.status}`)

  // 一次性小仓库：两个提交，`HEAD~1` 与 `sha` 类参数才是真存在。
  const gitReady = git(['rev-parse', '--git-dir']).status === 0 || git(['init', '-q', '.']).status === 0
  writeFileSync(join(repoDir, 'README.md'), '# probe repo\n\nseed line\n', 'utf8')
  git(['add', 'README.md']); git(['commit', '-q', '-m', 'seed'])
  writeFileSync(join(repoDir, 'notes.txt'), 'second\n', 'utf8')
  git(['add', 'notes.txt']); git(['commit', '-q', '-m', 'second'])
  const SHA = (git(['rev-parse', 'HEAD']).stdout ?? '').trim()
  const SHA1 = (git(['rev-parse', 'HEAD~1']).stdout ?? '').trim()
  const headCount = Number(git(['rev-list', '--count', 'HEAD']).stdout.trim() || '0')
  check('探针仓库真的有两个提交（否则 compare/commit 那两条是空转）', gitReady && headCount >= 2 && /^[a-f0-9]{40}$/.test(SHA) && /^[a-f0-9]{40}$/.test(SHA1),
    `commits=${headCount} head=${SHA.slice(0, 8)} head~1=${SHA1.slice(0, 8)}`)

  // 真建一个会话：建会话不产事件、不打模型，因此零花费，但它让 :id 类路由不是空转。
  const created = await fetch(`${baseUrl}/sessions`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: repoDir }),
  })
  const createdBody = await created.json().catch(() => null)
  const realId = createdBody?.id ?? createdBody?.sessionId ?? null
  check('POST /sessions 拿到真 id（否则 :id 那批路由只是空转）', created.status < 300 && !!realId,
    `status=${created.status} id=${String(realId).slice(0, 12)}`)

  const derived = deriveGetPaths()
  check('GET 面派生出来了（少于 15 条说明派生正则坏了，这条绿不算数）', derived.paths.length >= 15,
    `派生 ${derived.paths.length} 条，另有 ${derived.unresolved.length} 条静态取不到（如实报数、逐名点出，不静默少扫）：${derived.unresolved.join(' , ') || '没有'}；模板与引号两种字面量都派生（只认反引号那一版把 7 条**明明有字面量**的 GET 路报成"拼在变量里"，而 listTasks 的嵌套模板在第一个反引号就收工——两类都是静默少扫）`)
  // 正控：上一版会**静默**漏掉的两种形状，各钉一条已知路径在这里。总数少 7 条时那条"派生出来了"照样绿，
  // 所以能拦住回潮的不是总数而是逐名——「可达/被使用」要绑具体形状，不绑裸名字。
  const MUST_DERIVE = ['/health', '/config/approval', '/config/default-model', '/config/default-domain', '/config/checkpoint', '/config/providers', '/schedule/status', '/tasks']
  const notInFace = MUST_DERIVE.filter((x) => !derived.paths.some((p) => materialize(p.tmpl) === x))
  check(`正控：引号字面量与嵌套模板这两类形状各有一条路真的在面里（${MUST_DERIVE.length} 条）`, notInFace.length === 0,
    notInFace.length ? `面里没有：${notInFace.join(', ')} — 派生器又只对反引号生效了？` : `全在：${MUST_DERIVE.join(' , ')}`)

  const missing = []
  const serverErr = []
  const rejected = []
  const probed = []
  // 404 **不能单独当"缺路由"**：这个内核对存在的路由也会用 404 表示"这个会话还没有该数据"
  // （`cockpit` 在没有运行中 agent 的新会话上就间歇 404，两次干净跑里它是 200）。第一版把
  // 状态码当唯一判据，于是同一份代码可以今天绿明天红——那是判据错，不是稳定性差。
  // 所以 404 交给一个确定性的名字判据：路径的字面段名必须在**内核源码**里出现（只读 src/server，
  // 本仓铁律是从不修改内核）。查无此名 = 客户端打了一条内核里根本没有的路由 = 真缺口。
  const kernelCorpus = (() => {
    const roots = ['src/server']
    const files = []
    const walk = (d) => {
      for (const e of readdirSync(join(repoRoot, d), { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) files.push(p)
      }
    }
    for (const r of roots) if (existsSync(join(repoRoot, r))) walk(r)
    return { text: files.map((f) => readFileSync(join(repoRoot, f), 'utf8')).join('\n'), n: files.length }
  })()
  check(`内核路由名册读到了（src/server 下 ${kernelCorpus.n} 份源文件，只读）`, kernelCorpus.n >= 10 && kernelCorpus.text.length > 100_000,
    `${kernelCorpus.n} 份，${kernelCorpus.text.length} 字符`)

  for (const { name, tmpl } of derived.paths) {
    let path = materialize(tmpl)
    path = path.replaceAll('__ID__', String(realId ?? 'probe-session')).replaceAll('probe-session', String(realId ?? 'probe-session'))
      .replaceAll('__SHA1__', SHA1).replaceAll('__SHA__', SHA)
    const bare = path.split('?')[0]
    const segment = bare.split('/').filter((s) => s && s !== String(realId) && s !== 'probe-session' && s !== 'x').pop() ?? ''
    let status = 0
    let snippet = ''
    try {
      const r = await fetch(`${baseUrl}${path}`, { headers: H, signal: AbortSignal.timeout(8_000) })
      status = r.status
      // 400/422 的**响应体**一起留下。没有它，"参数不对"和"这路由其实要别的东西"长得一样，
      // 我就只能靠猜给它们分类——上一轮 `scope=workspace` 那六条假 400 就是这么来的。
      snippet = String(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 110)
    } catch (e) { snippet = String(e && e.message ? e.message : e).slice(0, 110); status = -1 }
    probed.push(`${name} ${bare} → ${status}${status === 404 ? (kernelCorpus.text.includes(segment) ? '（内核有此名，404=无数据）' : '（内核查无此名）') : ''}`)
    if (status === 405) missing.push(`${name}: ${bare} → 405 方法不对`)
    else if (status >= 500 || status === -1) serverErr.push(`${name}: ${bare} → ${status} ${snippet}`)
    else if (status === 404 && segment.length > 3 && !kernelCorpus.text.includes(segment)) missing.push(`${name}: ${bare} → 404 且内核里搜不到 "${segment}"`)
    else if (status === 400 || status === 422) rejected.push(`${name} → ${status} 报文=${snippet}`)
  }
  check(`客户端构造的每一条只读路径都被内核服务（打了 ${probed.length} 条）`,
    missing.length === 0 && serverErr.length === 0,
    [missing.length ? `路由不存在：${missing.slice(0, 4).join(' ｜ ')}` : '',
      serverErr.length ? `服务端错误：${serverErr.slice(0, 3).join(' ｜ ')}` : ''].filter(Boolean).join(' ｜ ')
      || `零缺失；另有 ${rejected.length} 条被合成参数挡在 400/422（路由存在，明细：${rejected.slice(0, 5).join(', ')}）`)
  // 逐条状态全打出来。只报计数会把证据藏起来：第一次变异跑就是在明细里冒出
  // `cockpit → 404`（基线那一跑它是好的），没有这行打印我根本看不见、更谈不上追。
  console.log('  i 逐条状态：')
  for (const p of probed) console.log('    ' + p)

  // 台账「读数时效」脚注的前提要在**当下**成立，不能引用记忆：无 key 实例里没有事件可回放。
  // 两条都要真打一次才算数——而"不会花钱"这件事由配置保证：这台实例的 `providers: []`，
  // 没有任何 key，`/prompt` 不可能出网（实测它就是 400，不是排队等模型）。
  const evPage = await fetch(`${baseUrl}/sessions/${String(realId)}/events?since=0&limit=50`, { headers: H, signal: AbortSignal.timeout(8_000) })
  const evBody = await evPage.json().catch(() => null)
  const evCount = Array.isArray(evBody?.events) ? evBody.events.length : -1
  const promptRes = await fetch(`${baseUrl}/sessions/${String(realId)}/prompt`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'probe: this instance has no provider key' }), signal: AbortSignal.timeout(8_000),
  }).catch((e) => null)
  const promptStatus = promptRes?.status ?? -1
  check('无 key 实例确实没有事件可回放（所以依赖真 run 的旧读数不可零花费复现，这条是那句脚注的前提）',
    evCount === 0 && (promptStatus === 400 || promptStatus === 422),
    `建会话后 events=${evCount}；POST /prompt → ${promptStatus}（这台实例 providers 为空，出不了网）`)

  // 反向对照：一条**故意拼错**的路由必须被同一条判据抓到，否则上面那条绿只是"什么都没看"。
  const bogus = await fetch(`${baseUrl}/sessions/${String(realId)}/definitely-not-a-route`, { headers: H })
  check('反向对照：拼错的路由会报 404（证明判据真的在看状态）', bogus.status === 404, `status=${bogus.status}`)

  // -------------------------------------------------- 写面：派生 + 双向归属 + 安全探针
  // 写调用点同样从源码派生（`this.request('POST'|…)` 与 `this.postJson/postExpectingBusy`），
  // 这样"客户端到底会往线上写哪些条"只有一个事实源。然后**每一条都必须落进两张表之一**：
  // 要么被安全探针打（只在临时实例 / 一次性仓库里生效），要么写明**为什么不发**——
  // 多一条没归属、或表里留着一条源码已删的，都判红。
  const WRITE_PROBE = {
    archiveSession: [200, 204],
    unarchiveSession: [200, 204, 404],
    renameSession: [200, 204],
    abort: [200, 204, 400, 404, 409],
    answerApproval: [200, 204, 400, 404, 409],
    rewind: [200, 204, 400, 404, 409],
    sessionCommit: [200, 204, 400, 409],
    patchScheduleTask: [200, 204, 400, 404],
    pauseScheduleTask: [200, 204, 400, 404],
    deleteScheduleTask: [200, 204, 400, 404, 409],
    retractQueued: [200, 204, 400, 404, 409],
    // 这两条是这一轮从"名册之外"捞回来的引号字面量调用点：**没有任何门真发过它们**，所以不给理由，
    // 直接在这里发一次——合成空 body 被 400 拒也证明路由被服务、路径形状没拼错（本面的判据口径）。
    setDefaultModelConfig: [200, 204, 400, 422],
    setDefaultProvider: [200, 204, 400, 404, 409],
  }
  const WRITE_SKIP = {
    prompt: '打模型 = 付费那一格，本验法零上游花费的前提就在这条上破',
    queue: '入队要有运行中的会话，且它同样通向模型',
    setProviderKey: '写凭据要你先一句确认（你的规矩），且 accept-settings.ts 已在一次性 provider 上真走通并还原',
    deleteProvider: 'accept-settings.ts 已覆盖，不在这里重复副作用',
    createSession: '本验法第 3 步就真发过一次 POST /sessions（就是为了拿 realId），accept-queue.ts 与 accept-gitwrite.ts 也各发过；这里再发一条会多出可见会话，污染后面归档读回的计数',
    setApprovalConfig: 'accept-settings.ts 真发过这条 PUT 并还原档位',
    createCustomProvider: 'accept-settings.ts 真发过（建一个临时 provider，用完删）',
    createScheduleTask: 'accept-schedule.ts 每次跑都真发这条建定义，并在收尾删掉',
    workbenchStage: 'accept-gitwrite.ts 在一次性仓库里真 stage 过',
    workbenchCommit: 'accept-gitwrite.ts 在一次性仓库里真提交过',
    workbenchBranch: 'accept-gitwrite.ts 在一次性仓库里真建过分支',
    workbenchSync: 'accept-gitwrite.ts 连着本地 bare 远端真走过 fetch 与 confirm 后的 push；本面没有远端，也不在这里重复对外动作',
    sessionMergeBack: 'accept-gitwrite.ts 在一次性仓库＋本地 bare 远端真走过这条合并链；本面没有可信远端，也不重复对外动作',
    sessionOpenPr: 'accept-gitwrite.ts 断言它在沙箱里被拒（title 写着 must not open）——那条路由被发到过，但不许真建 PR',
    cancelTask: '取消要有还活着的 job，本面不为此真起一次 run；accept-tasks.ts 在真记录上发过这条（`/tasks/:id/cancel`：running 上取消得 200，且 cancelled 不被随后到达的 failed 盖掉）',
    runNowSchedule: '发它就是真起一次调度 run（通向模型），本面零上游花费的前提不容它；accept-tasks.ts 用它当场造真 job 记录（`/schedule/:id/run-now` 两条，受理并回 triggered:true）',
  }
  const { paths: writes, unresolved: unresolvedWrites } = deriveWritePaths()
  const unassigned = writes.filter((w) => !WRITE_PROBE[w.name] && !WRITE_SKIP[w.name]).map((w) => `${w.name} ${w.verb}`)
  const staleProbe = Object.keys(WRITE_PROBE).filter((n) => !writes.some((w) => w.name === n))
  const staleSkip = Object.keys(WRITE_SKIP).filter((n) => !writes.some((w) => w.name === n))
  check(`每个触网的写方法都有归属（派生 ${writes.length} 个：${Object.keys(WRITE_PROBE).length} 条探针 + ${Object.keys(WRITE_SKIP).length} 条写明不发；另有 ${unresolvedWrites.length} 条静态取不到：${unresolvedWrites.join(' , ') || '没有'}）`,
    writes.length >= 15 && unassigned.length === 0 && staleProbe.length === 0 && staleSkip.length === 0,
    [unassigned.length ? `无归属：${unassigned.join(', ')}` : '', staleProbe.length ? `表里有、源码已无：${staleProbe.join(', ')}` : '',
      staleSkip.length ? `skip 表已过期：${staleSkip.join(', ')}` : ''].filter(Boolean).join(' ｜ ') || '双向都对得上')

  // "为什么不发"的理由里只要点名了某份脚本，那就是一句"这条路由在那边真发过"的宣称——去那边数一遍。
  // 归属理由没有判据就会腐烂：这一轮翻出来两条旧的，`sessionMergeBack` 写着"一次性仓库没有可信远端"，
  // 而 accept-gitwrite.ts 早就连着本地 bare 远端真走过那条链；`setDefaultProvider` 写着"同上"，
  // 而**没有任何脚本调过它**——所以它从 skip 挪进了探针。
  const badExcuse = []
  const namedHomes = Object.values(WRITE_SKIP).filter((r) => /[a-z-]+\.(?:mjs|ts)/.test(r)).length
  for (const [name, reason] of Object.entries(WRITE_SKIP)) {
    for (const f of reason.match(/([a-z-]+\.(?:mjs|ts))/g) ?? []) {
      const p = join(clientRoot, 'scripts', f)
      if (!existsSync(p)) { badExcuse.push(`${name}：理由指的文件不存在（scripts/${f}）`); continue }
      const src = readFileSync(p, 'utf8')
      if (src.includes(`api.${name}`)) continue
      // 第二种证据：理由里用反引号点名的**路由本身**（`/tasks/:id/cancel` 这种）。
      // 这一族里有些验收脚本走 raw('POST', …) 直接打线上形状（accept-tasks.ts 就是），
      // 那时"这条路由发过"是真话，而 `api.<方法名>` 永远不出现——按方法名回读会把真话判成假话。
      const cited = [...reason.matchAll(/`(\/[\w:./-]+)`/g)].map((m) => m[1])
      const segOk = cited.filter((pth) => {
        const segs = pth.split('/').filter((s) => s !== '' && !s.startsWith(':'))
        return segs.length >= 2 && segs.every((s) => src.includes(s))
      })
      if (segOk.length > 0) continue
      badExcuse.push(`${name}：理由说 ${f} 覆盖，但那份文件里既没有 api.${name}，也没有理由点名的路由（${cited.length ? cited.join(' , ') : '没引用路由'}）`)
    }
  }
  check(`每条 skip 理由点名的家都真调过这个方法（${Object.keys(WRITE_SKIP).length} 条理由里有 ${namedHomes} 条指向具体脚本，逐条回读）`, badExcuse.length === 0,
    badExcuse.length ? badExcuse.join(' ｜ ') : '理由与那份脚本逐条对得上')

  const wBad = []
  const wNotes = []
  for (const { name, verb, tmpl } of writes) {
    if (!WRITE_PROBE[name]) continue
    let path = materialize(tmpl).replaceAll('__ID__', String(realId)).replaceAll('__SHA__', SHA)
    const bare = path.split('?')[0]
    const segment = bare.split('/').filter((s) => s && s !== String(realId) && s !== 'probe').pop() ?? ''
    let status = 0
    let snippet = ''
    try {
      const r = await fetch(`${baseUrl}${path}`, {
        method: verb, headers: { ...H, 'content-type': 'application/json' },
        body: verb === 'DELETE' ? undefined : JSON.stringify(name === 'renameSession' ? { title: 'probe-renamed' }
          : name === 'sessionCommit' ? { message: 'chore: probe commit' }
          : name === 'patchScheduleTask' ? { enabled: false } : {}),
        signal: AbortSignal.timeout(8_000),
      })
      status = r.status
      snippet = String(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90)
    } catch (e) { status = -1; snippet = String(e && e.message ? e.message : e).slice(0, 90) }
    wNotes.push(`${name} ${verb} ${bare} → ${status}`)
    if (status >= 500 || status === -1) wBad.push(`${name}: ${verb} ${bare} → ${status} ${snippet}`)
    else if (status === 404 && segment.length > 3 && !kernelCorpus.text.includes(segment)) wBad.push(`${name}: ${verb} ${bare} → 404 且内核里搜不到 "${segment}"`)
    else if (!WRITE_PROBE[name].includes(status)) wBad.push(`${name}: ${verb} ${bare} → ${status} 不在预期 [${WRITE_PROBE[name].join('/')}] 报文=${snippet}`)
  }
  check(`写面 ${wNotes.length} 条安全探针没有 5xx / 没有查无此名 / 状态都落在预期集内`, wBad.length === 0,
    wBad.length > 0 ? wBad.slice(0, 3).join(' ｜ ') : `全在预期内（逐条见下面那份清单——只在判定里截前 4 条，等于把另外 9 条的状态藏起来）`)
  console.log('  i 写面逐条状态：')
  for (const n of wNotes) console.log(`    ${n}`)

  // 写面探针只认状态码——"受理了"不等于"状态真变了"。侧栏那枚 ↩ 今年才落到产品上，它走的就是这一发
  // `POST /sessions/:id/unarchive`，所以这里把归档↔取消归档整条闭环**读回**一遍：读的是列表里的
  // `archived` 字段与"默认列表里看不看得见这条"，不是 HTTP 状态。零上游花费（全程只动会话元数据）。
  const readBack = async (include) => {
    const r = await fetch(`${baseUrl}/sessions${include ? '?includeArchived=true' : ''}`, { headers: H, signal: AbortSignal.timeout(8_000) })
    const j = await r.json().catch(() => null)
    const list = Array.isArray(j?.sessions) ? j.sessions : []
    return { status: r.status, shape: Array.isArray(j?.sessions), rec: list.find((s) => s && s.id === realId) ?? null, count: list.length }
  }
  const flip = async (verb, path) => (await fetch(`${baseUrl}${path}`, {
    method: verb, headers: { ...H, 'content-type': 'application/json' },
    body: verb === 'DELETE' ? undefined : '{}', signal: AbortSignal.timeout(8_000),
  })).status
  if (realId === null) {
    check('归档↔取消归档整条读回（archived 字段 + 默认列表可见性）', false, '没有真会话 id — 没测（不是通过）')
  } else {
    const p = `/sessions/${encodeURIComponent(String(realId))}`
    const stArch = await flip('DELETE', p)
    const a = await readBack(true)
    const stUnarch = await flip('POST', `${p}/unarchive`)
    const u = await readBack(true)
    const dUnarch = await readBack(false)
    await flip('DELETE', p)
    const dArch = await readBack(false)
    const stBack = await flip('POST', `${p}/unarchive`)
    const clauses = [
      ['两次列表读回都是 200 且形状是 {sessions:[…]}', a.status === 200 && u.status === 200 && a.shape && u.shape],
      ['归档后读回 archived === true', a.rec !== null && a.rec.archived === true],
      ['取消归档后读回 archived === false', u.rec !== null && u.rec.archived === false],
      ['取消后这条回到默认列表里（不带 includeArchived 也看得见）', dUnarch.rec !== null],
      ['反向对照：再归一次就退出默认列表（可见性真跟着状态走）', dArch.rec === null],
      ['两次写都落在 2xx（归档 DELETE 与取消归档 POST）', [stArch, stUnarch, stBack].every((s) => s >= 200 && s < 300)],
    ]
    const badC = clauses.filter(([, ok]) => !ok).map(([n]) => n)
    check('归档↔取消归档整条读回（archived 字段 + 默认列表可见性）', badC.length === 0,
      `${badC.length === 0 ? '六条全过' : `不合格：${badC.join('、')}`}｜DELETE→${stArch} 读回 archived=${String(a.rec?.archived)}；POST/unarchive→${stUnarch} 读回 archived=${String(u.rec?.archived)}；默认列表 取消后=${dUnarch.rec ? '在' : '不在'} 归档后=${dArch.rec ? '在' : '不在'}（含归档列表共 ${a.count} 条）`)
  }

  // -------------------------------------------------- 流式面：派生 + 有界读首帧（零上游花费）
  // 流不能按"状态码 + 落不落预期集"判完——响应永不结束。所以这里读**前几帧**就撤：开一条
  // `AbortController`，到点 abort，两侧都 `clearTimeout`（这条线以前被一个泄漏的 race 定时器
  // 整步拖成 180 秒过，见上面 `bound` 的注释）。
  const readStreamHead = async (path, wantFrames, { noAuth = false } = {}, ms = 3_000) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    const out = { status: 0, type: '', kinds: [], err: '', ms: 0 }
    const t0 = Date.now()
    try {
      const r = await fetch(`${baseUrl}${path}`, {
        headers: noAuth ? { accept: 'text/event-stream' } : { ...H, accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
      out.status = r.status
      out.type = String(r.headers.get('content-type') ?? '')
      if (r.body) {
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (out.kinds.length < wantFrames) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
            if (!data) continue
            try {
              const j = JSON.parse(data)
              out.kinds.push(String(j?.type ?? j?.kind ?? '无名'))
            } catch { out.kinds.push('非 JSON 帧') }
            if (out.kinds.length >= wantFrames) break
          }
        }
        await reader.cancel().catch(() => {})
      }
    } catch (e) { out.err = String((e && (e.name || e.message)) || e) }
    clearTimeout(timer)
    ctrl.abort()
    out.ms = Date.now() - t0
    return out
  }

  const streams = deriveStreamSites()
  check('流式面派生自 client-core 全部源文件（不再只读 sidecar-client.ts 那一份）',
    streams.sites.length >= 2 && streams.unresolved.length === 0,
    `扫 ${streams.scanned} 份源文件，其中自己声明读流的 ${streams.readers.length} 份（${streams.readers.join(' , ')}），派生 ${streams.sites.length} 个开流调用点${streams.unresolved.length ? `；另有 ${streams.unresolved.length} 条取不到字面量：${streams.unresolved.join(' , ')}` : ''}`)
  // 收口"扫描面"这件事：光把流面倒全文件不够，还得有人**数一遍全部 fetch 调用点**，
  // 否则将来任何一份新源文件自己 fetch 一条端点，这张脸上不会有任何东西变红。
  const fetchRoster = []
  for (const f of readdirSync(join(clientRoot, 'packages/client-core/src')).filter((x) => x.endsWith('.ts')).sort()) {
    const body = readFileSync(join(clientRoot, 'packages/client-core/src', f), 'utf8')
    for (const m of body.matchAll(/await fetch\(\s*([`'"])/gs)) {
      fetchRoster.push({ file: f, line: body.slice(0, m.index).split('\n').length })
    }
  }
  const streamKeys = new Set(streams.sites.map((s) => `${s.file}:${s.line}`))
  const perFile = fetchRoster.reduce((acc, s) => { acc[s.file] = (acc[s.file] ?? 0) + 1; return acc }, {})
  const unowned = fetchRoster.filter((s) => s.file !== 'sidecar-client.ts' && !streamKeys.has(`${s.file}:${s.line}`))
  check(`client-core 里每一个 fetch 调用点都在这张脸上有位（逐文件数：${Object.entries(perFile).map(([k, v]) => `${k}=${v}`).join(' , ')}）`,
    unowned.length === 0 && fetchRoster.length >= 5,
    unowned.length ? `不在脸上：${unowned.map((s) => `${s.file}:${s.line}`).join(' , ')} — 它既不是 sidecar-client 的传输/读面，也没被流面派生到`
      : `sidecar-client.ts 那几处是两条传输帮助器加一条已被读面派生的 inline；其余每一处都在流面名册里（${[...streamKeys].join(' , ')}）`)
  const streamBares = streams.sites.map((s) => streamPath(s.tmpl, realId ?? 'probe').split('?')[0])
  const notStreamed = ['/events', '/stream'].filter((x) => !streamBares.some((p) => p === x || p.endsWith(x)))
  check('正控：那两条流各自的路径真的被派生出来了（全局 /events 与会话 /stream）', notStreamed.length === 0,
    notStreamed.length ? `面里没有：${notStreamed.join(' , ')} — 派生器又退回单文件了？` : `派生到的路径形如：${streamBares.join(' , ')}`)
  const routeKeys = [`'GET /events'`, `'GET /sessions/:id/stream'`]
  const noKey = routeKeys.filter((k) => !kernelCorpus.text.includes(k))
  check('两条流的内核路由键都在名册里（不是只对着客户端的拼法自证）', noKey.length === 0,
    noKey.length ? `内核里搜不到：${noKey.join(' , ')}` : `都在：${routeKeys.join(' , ')}`)
  const sessSite = streams.sites.find((s) => s.file === 'session-stream.ts')
  const evSite = streams.sites.find((s) => s.file === 'server-events.ts')
  // 打的是**派生出来的那条路径**，不是这里重打一遍 '/events'：否则派生器坏掉时探针照绿，
  // 这条面就又回到"判定与派生各说各话"那个形状。
  const evPath = evSite ? streamPath(evSite.tmpl, realId ?? 'probe') : null
  if (!evPath) {
    check('/events 开成流，头两帧就是 hello + health（App.tsx 只吃 health 那帧，别的直接 return）', false, '派生不到全局流那个调用点 — 没测（不是通过）')
    check('反向对照：不带 token 打 /events 是 401（认证真的管着这条流，不是只写在注释里）', false, '同上，派生不到路径 — 没测（不是通过）')
  } else {
    const evHead = await readStreamHead(evPath, 2)
    check(`${evPath} 开成流，头两帧就是 hello + health（App.tsx 只吃 health 那帧，别的直接 return）`,
      evHead.status === 200 && /text\/event-stream/.test(evHead.type) && evHead.kinds.includes('hello') && evHead.kinds.includes('health'),
      `status=${evHead.status} type=${evHead.type || '无'} 帧=${evHead.kinds.join('→') || '无'} 用了 ${evHead.ms}ms${evHead.err ? ` err=${evHead.err}` : ''}`)
    const anonHead = await readStreamHead(evPath, 1, { noAuth: true })
    check(`反向对照：不带 token 打 ${evPath} 是 401（认证真的管着这条流，不是只写在注释里）`, anonHead.status === 401,
      `status=${anonHead.status} type=${anonHead.type || '无'}${anonHead.err ? ` err=${anonHead.err}` : ''}`)
  }
  if (!sessSite || realId === null) {
    check('会话事件流按客户端那条路径开成 200 的 SSE', false,
      !sessSite ? '派生不到会话流那个调用点 — 没测（不是通过）' : '没有真会话 id — 没测（不是通过）')
  } else {
    const sp = streamPath(sessSite.tmpl, realId)
    const s1 = await readStreamHead(sp, 1)
    check(`会话事件流按客户端那条路径开成 200 的 SSE（${sp}）`, s1.status === 200 && /text\/event-stream/.test(s1.type),
      `status=${s1.status} type=${s1.type || '无'} 用了 ${s1.ms}ms${s1.err ? ` err=${s1.err}` : ''} —— ${s1.kinds.length === 0
        ? '窗口内一条帧都没到。这台实例这条会话没有可回放事件，而内核那四种快照帧都是条件发送（session-routes.ts:1756-1776），所以没帧不是这一条的失败：状态与 content-type 才是证据'
        : `窗口内帧=${s1.kinds.join('→')}`}`)
  }

  // §5.1 那句「MVP 必需 10 个端点」是计划交给下一位读者的**协议面清单**，此前只有我人读过一遍。
  // 此刻客户端这三张脸（读、写、流）都在手上，所以让清单逐条对上派生面：清单里少一枚、或脸上少一枚，
  // 都要在当天红，而不是等某个面板空了才发现。路径**从计划那一行 parse**，不在这里重打一遍。
  {
    const planDoc = resolve(repoRoot, 'analysis-reports', '定稿-天枢客户端方案', '天枢Web桌面客户端自研计划-v2.0.md')
    const listLine = existsSync(planDoc)
      ? readFileSync(planDoc, 'utf8').split('\n').find((l) => l.startsWith('- MVP 必需'))
      : undefined
    if (!listLine) {
      check('§5.1 的 MVP 端点清单在计划正文里', false,
        existsSync(planDoc) ? '那一行的起手式变了（`- MVP 必需…` 认不到），这条判据此刻没在量任何东西' : `读不到计划正文 ${planDoc}`)
    } else {
      // 参数段统一成 `*`：整段插值（`/${encodeURIComponent(id)}/`）与计划的 `:id` 是同一段；不是整段的
      // 插值（`${q}`、`${this.baseUrl}`、嵌套的 `${q ? \`?${q}\` : ''}`）直接删。查询串两边都剥。
      const canon = (raw) => {
        let p = String(raw)
        for (let i = 0; i < 4; i++) {
          const q = p.replace(/\/\$\{[^{}]*\}(?=\/|$)/g, '/*').replace(/\$\{[^{}]*\}/g, '')
          if (q === p) break
          p = q
        }
        p = p.split('?')[0].replace(/:[A-Za-z_]\w*/g, '*')
        if (!p.startsWith('/')) p = `/${p}`
        return p.replace(/\/+$/, '')
      }
      // 一枚 token = 一个**路径族**：`GET|POST /a(/b)` 说的是"这条族里我们讲 GET 与 POST"，
      // 不是"每个方法在每条路径上都要存在"——内核只在 `/a/b` 上收 POST，`POST /a` 根本不存在。
      // 所以判两件事：族里每条路径形状都要在脸上有位；族里每个方法要落在族的**某一条**路径上。
      const parseEndpoint = (token) => {
        const t = String(token).trim()
        const m = /^([A-Z|]+)\s+(\S+)$/.exec(t)
        const verbs = m ? m[1].split('|') : []
        const raw = m ? m[2] : t.startsWith('/') ? t : ''
        if (raw === '') return null
        const par = /\(([^)]*)\)/.exec(raw)
        const paths = par ? [raw.slice(0, par.index), `${raw.slice(0, par.index)}${par[1]}`] : [raw]
        return { token: t, verbs, paths: paths.map(canon), suffix: !m }
      }
      const SHAPE = [
        { t: 'GET /health', want: { token: 'GET /health', verbs: ['GET'], paths: ['/health'], suffix: false } },
        { t: 'GET|POST /sessions', want: { token: 'GET|POST /sessions', verbs: ['GET', 'POST'], paths: ['/sessions'], suffix: false } },
        { t: 'GET /sessions/:id/stream?since=N', want: { token: 'GET /sessions/:id/stream?since=N', verbs: ['GET'], paths: ['/sessions/*/stream'], suffix: false } },
        { t: 'GET|POST /sessions/:id/interventions(/:requestId/answer)', want: { token: 'GET|POST /sessions/:id/interventions(/:requestId/answer)', verbs: ['GET', 'POST'], paths: ['/sessions/*/interventions', '/sessions/*/interventions/*/answer'], suffix: false } },
        { t: '/queue', want: { token: '/queue', verbs: [], paths: ['/queue'], suffix: true } },
      ]
      const badShape = SHAPE.filter((c) => JSON.stringify(parseEndpoint(c.t)) !== JSON.stringify(c.want))
      const tokens = [...listLine.matchAll(/`([^`]+)`/g)].map((m) => m[1])
      const families = tokens.map(parseEndpoint).filter((f) => f !== null)
      const face = [
        ...derived.paths.map((p) => ({ verb: 'GET', key: canon(p.tmpl) })),
        ...writes.map((w) => ({ verb: w.verb, key: canon(w.tmpl) })),
        ...streams.sites.map((s) => ({ verb: 'GET', key: canon(s.tmpl) })),
      ]
      const missing = []
      for (const f of families) {
        if (f.suffix) {
          // 无动词的简写（`配 /queue`）指的是同一行那条路径的同族末端——按后缀配，命中即算。
          if (!face.some((x) => f.paths.some((p) => x.key === p || x.key.endsWith(p)))) missing.push(`${f.token}（按后缀配）`)
          continue
        }
        for (const p of f.paths) if (!face.some((x) => x.key === p)) missing.push(`${f.token} 的路径 ${p}`)
        for (const v of f.verbs) if (!face.some((x) => x.verb === v && f.paths.includes(x.key))) missing.push(`${f.token} 的方法 ${v}`)
      }
      const claimed = new Set(families.flatMap((f) => f.paths))
      const extra = [...new Set(face.map((x) => x.key))].filter((k) => ![...claimed].some((p) => k === p || k.endsWith(p)))
      const claimedN = Number(/必需 (\d+) 个端点/.exec(listLine)?.[1] ?? NaN)
      const pathsTotal = families.reduce((n, f) => n + f.paths.length, 0)
      const bad = [
        badShape.length > 0 ? `解析器自己坏了：${badShape.map((c) => `${c.t} → ${JSON.stringify(parseEndpoint(c.t))}`).join(' ｜ ')}` : '',
        tokens.length < 8 ? `只认到 ${tokens.length} 枚端点（清单那一行的形状变了，这条绿不算数）` : '',
        !Number.isInteger(claimedN) ? `正文里「必需 N 个端点」的 N 没解析出来：${JSON.stringify(/必需 \d+ 个端点/.exec(listLine)?.[0])}` : '',
        Number.isInteger(claimedN) && tokens.length !== claimedN ? `正文写「${claimedN} 个端点」，清单实际列了 ${tokens.length} 枚（改清单要连数一起改）` : '',
        pathsTotal < 10 ? `展开后只有 ${pathsTotal} 条路径形状，少于清单枚数——展开规则坏了` : '',
        missing.length > 0 ? `客户端这三张脸上没有：${missing.join(' , ')}` : '',
      ].filter(Boolean)
      check('§5.1 的 MVP 端点清单逐条对上客户端派生面（读 / 写 / 流三张脸）', bad.length === 0,
        bad.join(' ｜ ') || `清单 ${tokens.length} 枚（与正文那个数一致）展开成 ${pathsTotal} 条路径形状 + 各族方法，全部在脸内；读面 ${derived.paths.length} 条、写面 ${writes.length} 条、流面 ${streams.sites.length} 个调用点，另有 ${extra.length} 条是 §6 M2/M3 的面（不在这份清单里）`)
    }
  }
} finally {
  const stop = spawn(process.execPath, [join(clientRoot, 'scripts/launch-sidecar.mjs'), '--state-dir', stateDir, '--stop'], { cwd: clientRoot, stdio: 'ignore' })
  await bound(new Promise((r) => stop.once('exit', r)), 8_000, () => 'timeout')
  // Windows 上刚退出的 sidecar 会短暂吊着它写过的文件句柄：单次 rmSync 因此报 EPERM，实测每跑一次就在
  // Temp 里留下一个 ~3.4MB 的隔离目录（今天跑了 4 次，留了 4 个）。查过那时**没有任何进程还引用它们**
  // （按命令行给 node/electron 配对，0 命中），所以是暂时锁而不是活着的 daemon——于是给一个**有界**重试，
  // 仍然删不掉就把路径打出来让人手动清；只打 `e.code` 的那句"没删净"既不说明删没删掉也不说明垃圾在哪。
  const rmTemp = async (label, dir) => {
    let code = null
    for (let i = 0; i < 6; i++) {
      try { rmSync(dir, { recursive: true, force: true }); code = null; break }
      catch (e) { code = (e && e.code) || '未知原因'; await sleep(250) }
    }
    return existsSync(dir) ? `${label}仍在（试了 6 次，最后一次 ${code}）：${dir}` : null
  }
  // 探针仓库同样删不干净也不能炸掉整步：这里跑在 `finally` 里，抛出去会绕过本文件的 catch
  // ——那正是 #85 那个形状的现场复发条件。
  const residual = await Promise.all([rmTemp('state 目录', stateDir), rmTemp('data 目录', dataDir), rmTemp('探针仓库', repoDir)])
  const leftover = residual.filter((r) => r !== null)
  console.log(`  i 临时目录收尾：${leftover.length === 0 ? '三个都删净（rmSync 后 existsSync=false）' : leftover.join(' ｜ ')}`)
}

console.log(`\n${checksRun} 项判定，红 ${failures.length} 项`)
process.exit(failures.length > 0 ? 1 : 0)
