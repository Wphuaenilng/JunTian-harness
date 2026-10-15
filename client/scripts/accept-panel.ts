/**
 * accept-panel.ts — 检查点/文件面板的数据路径，跑在一条零花费的常驻线上。
 *
 * 两条档：
 *   档一（默认）⇒ 自己造现场：在临时目录里写一棵已知的小树（内容是我写的字面量字节），
 *     建一条 `cwd` 指向它的会话，再问那七个读端点。之所以值得自己造：只有"我知道文件里
 *     本该是什么字节、哪些名字该被搜到、哪些不该"，判据才能写成**逐字相等**和**双向集合**，
 *     而不是"回了一些东西"。挂现机那一档做不到这点——它读的是别人的仓库，猜不出该有什么。
 *   档二（位置参数给了 sessionId）⇒ 只读那台的真会话（含 rewind points 的形状逐条核对）。
 *
 * 有一件事两条档都量不到，脚本把它写成 **未测到**，不算通过：无工具的会话上
 * `GET /sessions/:id/rewind-points` 实测就是 `{points: []}`——检查点由真工具落盘产生，
 * 那需要一次真上游 run。面板的"回滚到某次改动"那一格因此仍挂在付费那一列。
 *
 * 顺带钉住三条本轮实测出来的运行时形状（都不是我从源码推的）：
 *  - `file-content` 的 `path` **不做归一**：请求 `notes/keep.json` 回的是 `notes\keep.json`
 *    （Windows 反斜杠），而根级文件原样回。⇒ 界面不能拿 `content.path` 当键去对树里那一份斜杠写法。
 *  - `list-dir` 要的是一个**文件**时回 200 + 空 entries（不是报错）。
 *  - 越界与不存在与"是个目录"三种失败是**三个不同的码**（403 / 404 / 400），界面必须按码分支。
 *
 * 只读纪律：这条脚本除了 POST /sessions、POST /prompt（档一，且只在 configured:false 上）
 * 与 DELETE /sessions/:id（收尾归档），不打任何写端点；`rewind` / `rollback` 绝不触发。
 * 它把实际打过的方法+路径列出来作证（最后一条判定），不靠注释自称。
 *
 *   node scripts/accept-panel.ts                       # 档一：自己造沙箱
 *   node scripts/accept-panel.ts <sessionId>           # 档二：读那台的真会话
 *   node scripts/accept-panel.ts --info=<隔离实例的 .sidecar-info.json>
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarError } from '../packages/client-core/src/index.ts'
import { openInstance, sendPrompt } from './lib-instance.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { api, info, infoPath } = openInstance('检查点 / 文件面板的数据路径（档一自己造沙箱；rewind 绝不触发）')

const failures: string[] = []
let ran = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  ran += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const enc = encodeURIComponent
const H = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }

// 打过哪些端点，逐条记下来——"绝不触发 rewind/rollback"这句话只有配上清单才是证据。
const calls: string[] = []
const raw = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> => {
  calls.push(`${method} ${path.split('?')[0]}`)
  const r = await fetch(`${info.baseUrl}${path}`, { method, headers: H, body: body === undefined ? null : JSON.stringify(body) })
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null }
}

// ⑦ 的逐字比较函数——和 ⑧ 的正控绑在同一个对象上：判据被放宽成"包含"时，正控那条红。
const bytesEqual = (a: string, b: string): boolean => a === b

/** 沙箱这棵树的逐名+字节数快照：只读纪律要拿**前后两次相等**来证，不是拿注释证。 */
const treeSnapshot = (dir: string): string => {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name)
      const label = rel === '' ? name : `${rel}/${name}`
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs, label)
      else out.push(`${label}:${String(st.size)}`)
    }
  }
  walk(dir, '')
  return out.join(',')
}
let treeBefore = ''

const health = await api.health().catch(() => null)
const keyless = health?.configured === false
const explicitId = process.argv.slice(2).find((a) => !a.startsWith('--'))

// 沙箱：root 里放一个"会话外面"的文件，work/ 才是会话 cwd——越界测试的两条路径都在这棵树内，
// 跑完整个 root 删掉，不留任何东西在别处。
// 沙箱落点跟着**这次用的那份登记文件**走：`verify-accept-zero` 传的是它自己临时目录里的
// `.sidecar-info.json`，沙箱就落在那个目录里，caller 停掉实例之后整棵临时目录由它删——这是唯一能
// 删干净的时机。为什么不能就地删：实测内核会在**每个会话的 cwd** 里种 `.rivet/`，而那不只有 skills，
// 还有 `meridian.db` + `-shm` + `-wal`——三个被实例自己打开着的 SQLite 文件。`rmSync(recursive)`
// 撞上去报 `EPERM` 并中止，我埋的那几个文件因此也留在原地（第一次把这棵树放在系统临时目录时就是这样）。
// 手工跑（默认登记文件在 `client/` 下）时落进 `client/.sidecar-data/panel-sandbox`：被 .gitignore
// 罩着、每次开头预清一次，所以不会越积越多。
const stateDir = dirname(infoPath)
const callerOwned = !stateDir.startsWith(clientRoot)
const baseRoot = join(stateDir, callerOwned ? 'panel-sandbox' : join('.sidecar-data', 'panel-sandbox'))
// 上一轮的会话可能还在这台活实例里开着 `.rivet/meridian.db`——实测那时 `rmSync` 是 EPERM，
// 预清不掉。第二遍跑不能因此崩（本轮就崩过一次，报错来自这句预清），所以退到带 pid 的落点继续量，
// 并把这件事打在屏幕上。
let root = baseRoot
let preCleanErr = ''
try {
  if (existsSync(baseRoot)) rmSync(baseRoot, { recursive: true, force: true })
} catch (e) {
  root = `${baseRoot}-${String(process.pid)}`
  preCleanErr = String(e).slice(0, 80)
}
const work = join(root, 'work')
const FILES: Record<string, string> = {
  'alpha-protocol.ts': 'export const marker = "ALPHA-BODY-7c3f"\n',
  'delta.txt': 'no keyword here at all\n',
  'notes/gamma-protocol.md': '# gamma-protocol\n',
  'notes/keep.json': '{"k":1}\n',
}
const OUTSIDE_NAME = 'panel-outside.txt'
const OUTSIDE_BODY = 'SECRET-OUTSIDE-DO-NOT-SERVE\n'

let sessionId = ''
let manufactured = false

if (explicitId !== undefined) {
  const hit = (await api.listSessions({ includeArchived: true })).find((s) => s.id === explicitId)
  if (hit === undefined) {
    console.error(`✗ 这台实例上没有会话 ${explicitId} —— 档二要求显式给的 id 真存在`)
    process.exit(1)
  }
  sessionId = hit.id
  console.log(`档二        读显式指定的会话 ${sessionId} cwd=${hit.cwd}（不建沙箱、不发消息）`)
} else {
  manufactured = true
  // 预清一次：固定路径 + 每次开头扫干净，避免上一轮被 Windows 句柄拖住留下的壳子越积越多。
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  mkdirSync(join(work, 'notes'), { recursive: true })
  writeFileSync(join(root, OUTSIDE_NAME), OUTSIDE_BODY)
  for (const [rel, body] of Object.entries(FILES)) writeFileSync(join(work, rel), body)
  const created = await api.createSession({
    title: 'panel sandbox probe',
    cwd: work,
    workspaceMode: 'explicit',
  })
  sessionId = created.id
  const rec = await api.getSession(sessionId)
  console.log(`档一        沙箱=${root}\n            会话=${sessionId} cwd=${rec.cwd} workspaceSource=${String(rec.workspaceSource)}`)
  if (preCleanErr !== '') console.log(`  i 上一轮的沙箱预清没删掉（${preCleanErr}），本轮退到带 pid 的落点继续量——这台实例还开着那个会话的 .rivet/meridian.db，删不掉是它的句柄，不是我的判据坏了`)
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  check('① 沙箱会话建成，且内核认的 cwd 真在本次临时目录里（containment，不认默认目录名）',
    typeof created.id === 'string' && created.id.length > 0 && norm(rec.cwd).startsWith(norm(work)) && rec.workspaceSource === 'explicit',
    `cwd=${rec.cwd}，workspaceSource=${String(rec.workspaceSource)}，应当落在 ${work} 里`)

  // 这句话以前无条件说"不会离开本机"，然后无条件 `api.prompt`——而这台脚本也常被手动挂到操作者那台
  // **有 key** 的实例上（`client/.sidecar-info.json` 就是 configured:true）。那时它是谎话，而且真烧一发。
  // 现在发送只有一个出口：`sendPrompt` 在发之前现读 `/health.configured`，有 key 就不发、返回 'not-sent'，
  // ② 于是按"未测到"记红。守门的读数取自当场那次请求，不依赖调用方手里那份可能过期的布尔。
  const acc = await sendPrompt(api, sessionId, 'accept-panel: 造一个有 run、但没有工具落盘的会话', '② 造一个"有过 run"的形状')
  let status = ''
  if (acc !== 'not-sent') {
    for (let i = 0; i < 600; i++) {
      status = (await api.getSession(sessionId)).status
      if (status !== 'running') break
      await sleep(100)
    }
  }
  check('② 那一发被受理并走到终态（无 key ⇒ 预期 failed；这一发只用来制造"有过 run"这件事）',
    acc === 'ok' && status !== 'running', acc === 'not-sent'
      ? '这台有 key，那一发根本没发出去 ⇒ ② 未测到（把脚本挂回 configured:false 的隔离实例才量得到）'
      : `prompt 回 ${JSON.stringify(acc)}，终态 ${status}`)
  // 快照取在 run 之后：内核那一次 `.rivet/` 播种已经算进基线，后面再变就是这一趟读操作干的。
  treeBefore = treeSnapshot(root)
  console.log(`  i 基线快照    ${String(treeBefore.split(',').length)} 个文件（含内核种下的 .rivet/）`)
}

const sid = encodeURIComponent(sessionId)

// ---- 1. list-dir：目录/文件分得清，条目键不发明元数据
const listing = await raw('GET', `/sessions/${sid}/list-dir?path=`)
const entries = (listing.body?.entries ?? []) as { name?: string; isDirectory?: boolean }[]
const names = entries.map((e) => String(e.name))
const dirs = entries.filter((e) => e.isDirectory === true).map((e) => String(e.name))
console.log(`list-dir ''  → ${String(listing.status)}，${String(entries.length)} 条：${names.join(' ')}`)
check('③ 我造的目录被认成目录、我造的文件不被认成目录（条目按名字点名，不按条数——条数会被运行时种的东西影响）',
  dirs.includes('notes') && !dirs.includes('alpha-protocol.ts') && !dirs.includes('delta.txt'),
  `目录=[${dirs.join(',')}]`)
const firstKeys = Object.keys(entries[0] ?? {}).sort().join(',')
check('④ list-dir 的条目只有 {isDirectory,name} 两个键——面板要是想显示大小/时间，得另找出处，不能在这里发明',
  firstKeys === 'isDirectory,name', `实测键=${firstKeys}`)
const asFile = await raw('GET', `/sessions/${sid}/list-dir?path=${enc('alpha-protocol.ts')}`)
const asFileEntries = (asFile.body?.entries ?? []) as unknown[]
check('⑤ 把**文件**路径喂给 list-dir：内核回的是 200 + 空 entries，不是报错（界面据此会把一个文件显示成空目录，这条红=它开始回错误码了，那时可以按码分支）',
  asFile.status === 200 && Array.isArray(asFile.body?.entries) && asFileEntries.length === 0,
  `status=${String(asFile.status)} body=${JSON.stringify(asFile.body).slice(0, 80)}`)
if (manufactured) {
  check('⑥ 一次 run 之后根列表里多出 `.rivet/`（内核会往**任何**会话 cwd 里种 skills）——面板的条目数假设必须容得下它，这条红=它不种了',
    names.includes('.rivet'), `根条目=[${names.join(' ')}]`)
}

// ---- 2. list-files：命中集合是双向的（该有的都在、不该有的一个都不出现）
const hit = await raw('GET', `/sessions/${sid}/files?q=protocol&limit=30`)
const hitFiles = (hit.body?.files ?? []) as string[]
const wantHit = ['alpha-protocol.ts', 'notes/gamma-protocol.md']
const missingHit = wantHit.filter((f) => !hitFiles.includes(f))
const unexpectedHit = hitFiles.filter((f) => !wantHit.includes(f) && !f.startsWith('.rivet/'))
check('⑦ 查询 protocol 的命中集合：我埋的那两条都在，且除 `.rivet/` 种下的之外没有多出来的文件（双向集合，不是"回了一些东西"）',
  missingHit.length === 0 && unexpectedHit.length === 0 && hitFiles.length >= 2,
  `回 ${String(hitFiles.length)} 条=[${hitFiles.join(' ')}]${missingHit.length ? `；缺 ${missingHit.join(',')}` : ''}${unexpectedHit.length ? `；多 ${unexpectedHit.join(',')}` : ''}`)
const neg = await raw('GET', `/sessions/${sid}/files?q=zzz-nothing&limit=30`)
const negFiles = (neg.body?.files ?? []) as string[]
check('⑧ 负面控制：一个连模糊子序列都凑不出来的词必须回空集（如果这里出现任何东西，⑦ 那条"双向"就是假的）',
  negFiles.length === 0, `实得 ${String(negFiles.length)} 条=[${negFiles.slice(0, 6).join(' ')}]`)
const capped = await raw('GET', `/sessions/${sid}/files?q=protocol&limit=1`)
check('⑨ /files 的 limit 在 HTTP 上真被读（与 GET /tasks 那种"query 当不存在"不同形）',
  ((capped.body?.files ?? []) as string[]).length === 1, `limit=1 实得 ${String(((capped.body?.files ?? []) as string[]).length)} 条`)

// ---- 3. file-content：逐字字节 + path 回显的真实形状
const nested = 'notes/keep.json'
const contentRes = await raw('GET', `/sessions/${sid}/file-content?path=${enc(nested)}`)
const gotBody = String(contentRes.body?.content ?? '')
const wantBody = FILES[nested] ?? ''
check('⑩ 正文逐字等于我写进去的那几个字节（不是"包含"，不是长度相等）',
  contentRes.status === 200 && bytesEqual(gotBody, wantBody),
  `status=${String(contentRes.status)}，实得 ${JSON.stringify(gotBody)}，期望 ${JSON.stringify(wantBody)}`)
check('⑪ 正控：上面那个比较函数对"差一个字节"必须拦下（把它写成 includes 或 length 相等，这一条当场红）',
  !bytesEqual(wantBody + 'x', wantBody) && !bytesEqual(gotBody.slice(0, 4), gotBody), `两例都判为不相等`)
const echoed = String(contentRes.body?.path ?? '')
check('⑫ 内核的 path 回显**不是归一化的**：请求斜杠写法，回的是平台原生分隔符（`notes\\keep.json`）——所以界面不能拿 content.path 去对树里那份斜杠名字。这条红=内核开始归一了，那时可以省掉一次换算',
    echoed.includes('\\') && !echoed.includes('/'), `请求 ${JSON.stringify(nested)} → 回显 ${JSON.stringify(echoed)}`)
const topLevel = await raw('GET', `/sessions/${sid}/file-content?path=${enc('alpha-protocol.ts')}`)
check('⑬ 对照：根级文件的回显是原样的（缺陷只在带子目录的路径上出现）——两条合起来才说清"回显保留写法"这件事的边界',
  String(topLevel.body?.path ?? '') === 'alpha-protocol.ts', `回显 ${JSON.stringify(String(topLevel.body?.path ?? ''))}`)

// ---- 4. 三种失败是三个不同的码，且客户端不会把错误变成假内容
const relEscape = await raw('GET', `/sessions/${sid}/file-content?path=${enc('../' + OUTSIDE_NAME)}`)
const absEscape = await raw('GET', `/sessions/${sid}/file-content?path=${enc(join(root, OUTSIDE_NAME))}`)
const missing = await raw('GET', `/sessions/${sid}/file-content?path=${enc('nope-not-here.txt')}`)
const dirReq = await raw('GET', `/sessions/${sid}/file-content?path=${enc('notes')}`)
console.log(`边界        相对越界=${String(relEscape.status)} 绝对越界=${String(absEscape.status)} 不存在=${String(missing.status)} 是目录=${String(dirReq.status)}`)
check('⑭ 越界一律拦在内容之外：相对与绝对两种写法都拿不到正文（403 是正解；回 200 就是沙箱逃逸，红在这里）',
  relEscape.status === 403 && absEscape.status === 403,
  `相对 ${String(relEscape.status)} ${JSON.stringify(relEscape.body?.error ?? '')}；绝对 ${String(absEscape.status)} ${JSON.stringify(absEscape.body?.error ?? '')}`)
check('⑮ 三种失败互不相同：403 越界 / 404 不存在 / 400 是目录——界面要按码分支，不能统一报"读不到"',
  relEscape.status === 403 && missing.status === 404 && dirReq.status === 400 && relEscape.body?.error !== missing.body?.error,
  `403=${JSON.stringify(relEscape.body?.error)} 404=${JSON.stringify(missing.body?.error)} 400=${JSON.stringify(dirReq.body?.error)}`)
let clientErr: SidecarError | undefined
try {
  await api.fileContent(sessionId, '../' + OUTSIDE_NAME)
} catch (e) {
  clientErr = e instanceof SidecarError ? e : undefined
}
check('⑯ 客户端把 403 报成 SidecarError(status=403)，不是回一段假内容——预览面板因此不会把"越界"渲染成"空文件"',
  clientErr?.status === 403, clientErr === undefined ? 'api.fileContent 竟然没抛错' : `status=${String(clientErr.status)}，消息=${clientErr.message.slice(0, 70)}`)

// ---- 5. 检查点那一半：量得到的形状 + 明写量不到的
const points = await api.rewindPoints(sessionId)
const preview = await api.rollbackPreview(sessionId)
const artifacts = await api.artifacts(sessionId)
console.log(`检查点面    rewind-points=${String(points.length)} 条，rollback preview available=${String(preview.available)}${preview.confirmationToken ? '（带 token！）' : '（无 token）'}，artifacts=${String(artifacts.length)} 条`)
check('⑰ 三个读端点各自回自己的容器（points / available / artifacts），且 preview 在没有检查点时不带 confirmationToken——破坏性那一步的令牌只能由真检查点换到',
  Array.isArray(points) && typeof preview.available === 'boolean' && Array.isArray(artifacts) && preview.confirmationToken === undefined,
  `points=${String(points.length)} available=${String(preview.available)} artifacts=${String(artifacts.length)}`)
if (manufactured) {
  console.log('未测到      检查点/回滚那一半：没有工具落盘的会话上 rewind-points 实测就是 0 条，"面板能不能列出可回滚的检查点"要一次真上游 run 才有东西可列（付费那一格，不是通过）')
} else {
  const badShape = points.filter((p) => !(Number.isInteger(p.index) && Number.isInteger(p.seq) && typeof p.content === 'string' && Number.isFinite(p.timestamp)))
  check('⑰b 档二逐条核对 rewind point 的形状（index/seq/content/timestamp 四个键都得在）——这条只在人挂着真历史时跑',
    points.length === 0 || badShape.length === 0, `${String(points.length)} 条里形状不合的 ${String(badShape.length)} 条`)
}

// ---- 收尾：只读纪律用可观察效果证（沙箱逐名+字节数不变），再归档、删净
const nonGet = [...new Set(calls.filter((c) => !c.startsWith('GET ')))]
if (manufactured) {
  const treeAfter = treeSnapshot(root)
  check('⑱ 这一趟读完之后，沙箱里每个文件的名字与字节数一个都没变（前后快照逐名相等）——"只读、绝不触发 rewind/rollback"这句话由可观察效果证，不由注释证',
    nonGet.length === 0 && treeAfter === treeBefore,
    `基线 ${String(treeBefore.split(',').length)} 项 → 现在 ${String(treeAfter.split(',').length)} 项${nonGet.length > 0 ? `；raw 面还打过非 GET：[${nonGet.join(' , ')}]` : ''}`)
  const archived = await api.archiveSession(sessionId)
  check('⑲ 造的会话归档掉（隔离库里不留没主的活跃线程）', archived.archived === true, JSON.stringify(archived))
  const beforeDelete = treeSnapshot(root).split(',').length
  let rmErr = ''
  try { rmSync(root, { recursive: true, force: true }) } catch (e) { rmErr = String(e).slice(0, 80) }
  const gone = !existsSync(root)
  const afterDelete = gone ? 0 : treeSnapshot(root).split(',').length
  const ownedPlace = root.startsWith(stateDir) || root.startsWith(join(clientRoot, '.sidecar-data'))
  check('⑳ 沙箱落在**有主的地方**：要么在本次 caller 的隔离 state 目录里（常驻线），要么在 `client/.sidecar-data/` 下（手工跑，被 .gitignore 罩着、下次开头预清）——绝不落在仓库别处；并且"删不净"这件事必须自己说出来：实测内核在会话 cwd 里开着 `.rivet/meridian.db-shm/-wal`，`rmSync` 撞上去是 EPERM + 中止，此时我埋的文件也还留在原地，回收要等实例停掉之后',
    ownedPlace && (gone || rmErr !== ''),
    ownedPlace
      ? gone
        ? `落点 ${root}；删前 ${String(beforeDelete)} 项 → 已删净`
        : `落点 ${root}；删前 ${String(beforeDelete)} 项 → 现在剩 ${String(afterDelete)} 项，rmSync 报的是 ${rmErr || '（没报错却没删掉——那才是真异常）'}；这份残留归 ${stateDir} 的主人随目录一起回收`
      : `落点跑到了没人管的地方：${root}`)
} else {
  check('⑱ 档二全程只读：raw 面没有一发非 GET，建会话/发 prompt/归档这三处写一次都没调用（这条只在人给 sessionId 时跑）',
    nonGet.length === 0 && calls.length > 0, `打过 ${String(calls.length)} 发，其中非 GET ${String(nonGet.length)} 发`)
}

if (failures.length > 0) {
  console.error(`\n✗ panel data path FAILED:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ 检查点/文件面板的数据路径实测通过（${ran} 项判定；${manufactured ? '含当场造出来的沙箱树与逐字字节核对' : '读的是现机会话'}。未触发任何回滚${keyless ? '；那一发 prompt 只在这台 configured:false 时发，run 从未离开本机' : ''}）`)
