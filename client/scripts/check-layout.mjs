#!/usr/bin/env node
/**
 * check-layout.mjs — 定稿「设计要点」里几何那部分的常驻门。
 *
 * 存在的理由是一个**已经发生过的真缺陷**：`.app` 用 `grid-template-columns: var(--sidebar-width)
 * 1fr auto` 加自动排布，右栏 `grid-row: 1 / 3` 把它挤进了中间的 `1fr` 轨道，而 `main`（对话流）
 * 落到了末尾的 `auto` 轨道。1443px 视口下实测 tracks `264 889 290`，`main` left=1153 宽 290，
 * 右栏 left=264 宽 320 —— 三列全错位，定稿要求的「居中窄栏对话流」根本没成立。
 *
 * 而当时**所有既有检查都是绿的**：溢出审计量的是 `scrollWidth vs clientWidth`（两者都 1443），
 * 面板存在性量的是 DOM 有没有渲染。一个"没有元素跑到页面外"的断言，完全不等于"元素在正确的列里"。
 * 所以这条门钉的是**列序与几何的显式声明**，并把只能在浏览器里量的那部分如实标成 manual
 * 并附上可复跑的探针与本轮实测数字。
 *
 *   node scripts/check-layout.mjs            # 逐条
 *   node scripts/check-layout.mjs --quiet    # 只报失败（CI）
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')
const read = (p) => readFileSync(join(clientRoot, p), 'utf8')

const css = read('apps/web/src/styles.css')
const chatCss = read('packages/ui-chat/src/styles.css')
const sessionCss = read('packages/ui-session/src/styles.css')
const tokens = read('packages/ui-theme/src/tokens.css')
const app = read('apps/web/src/App.tsx')
const throughput = read('packages/client-core/src/throughput.ts')
const stream = read('packages/client-core/src/session-stream.ts')
const sessionTsx = read('packages/ui-session/src/index.tsx')

const results = []
const record = (kind, label, ok, note = '') => results.push({ kind, label, ok, note })
const has = (re, where) => re.test(where)

// 1. 列序：三列都必须显式指派，不靠自动排布。
{
  const sidebar = /\.app > aside:not\(\.app__rail\)\s*\{[^}]*grid-column:\s*1;/.test(css)
  const main = /\.app > main\s*\{[^}]*grid-column:\s*2;/.test(css)
  const rail = /\.app__rail\s*\{[^}]*grid-column:\s*3;/.test(css)
  record('static', '三列显式指派 grid-column（侧栏 1 / 对话流 2 / 右栏 3）', sidebar && main && rail,
    `sidebar=${sidebar} main=${main} rail=${rail}`)
  record('static', '中列是 1fr，两侧是固定宽（顺序不能反）',
    has(/grid-template-columns:\s*var\(--sidebar-width\)\s+1fr\s+auto/, css), 'var(--sidebar-width) 1fr auto')
}

// 2. 折叠态细条 / 展开宽（定稿收起态截图就是 44px 图标细条；展开是图上 .frame 的第三轨 288）。
{
  // 这两个数现在取自 --scale-*，而把 token 对回图上数字的是 check:scale。这里跟着 var() 走而不是
  // 再抄一遍字面量：两处各自钉一个数，就会在两者不一致时互相打脸。
  const collapsed = has(/\.app__rail\s*\{[^}]*width:\s*var\(--scale-rail-collapsed\)/, css)
  const open = has(/\.app__rail--open\s*\{[^}]*width:\s*var\(--scale-rail-open\)/, css)
  record('static', '右栏折叠取自 --scale-rail-collapsed、展开取自 --scale-rail-open（图上是 44 / 288）',
    collapsed && open, `collapsed=${collapsed} open=${open}`)
}

// 3. 居中窄栏的机制：时间线与输入框各取图上自己的两个宽（748 / 780），但共用同一条居中方式。
{
  const col = has(/\.uc__col\s*\{[^}]*max-width:\s*var\(--measure\)[^}]*margin:\s*0 auto/, chatCss)
  const composer = has(/\.app__composer-col\s*\{[^}]*max-width:\s*var\(--scale-dock-width\)[^}]*margin:\s*0 auto/, css)
  const measure = /--measure:\s*\d+px/.exec(tokens)?.[0] ?? ''
  const dock = /--scale-dock-width:\s*\d+px/.exec(tokens)?.[0] ?? ''
  record('static', '两条中轴各自取图上的 748 / 780 且都 margin:0 auto（数由 check:scale 钉，这里钉机制）', col && composer,
    `${measure} + ${dock} — 两轴宽度不同但同居中，横向错位就没了；共用一个数才会对不上图`)
  record('static', '--measure 有定义（窄栏宽度是设计变量，不是散落的魔数）', measure.length > 0, measure)
}

// 4. 状态条横跨三列（定稿：SSE/AG-UI 状态收纳进底部状态条）。
{
  record('static', '底部状态条跨满三列', has(/\.app__status\s*\{[^}]*grid-column:\s*1\s*\/\s*4/, css),
    'grid-column: 1 / 4')
  record('static', '状态条里挂了 cockpit 读数（上下文/缓存命中/成本）',
    has(/app__cockpit/, css) && has(/app__cockpit/, app), '见 App.tsx 的 .app__cockpit')
  // 状态条那串「分类计数」的口径。2026-10-10 用 scripts/probe-stream.ts 在线上抓到：一开流就有 4 条
  // seq=0 合成元事件（replay_window / delegation_snapshot / job_snapshot / approval_snapshot，
  // 后两条按 §4.3 #5 归 tool），而 tally 是按类累加的——不设这道闸的话，空会话一上来就显示
  // `tool 2 · lifecycle 2`，并且**每重连一次再加一遍**（数字变成"连接次数的读数"，不是活动的读数）。
  record('static', '状态条的分类计数只算真时间线事件（seq>0），连接期 seq=0 元事件不推计数',
    has(/if \(ev\.event\.seq > 0\) tally\.record\(ev\.event\.type\)/, app),
    '与 §4.3 #2「seq=0 不推进游标」同一条理由；判据是 App.tsx 里那句守卫本身，改回无条件 record 就红')
  // 图上那格写的是「⚡ 42 tok/s」（design/desktop-mockup-dsh-style.html:736），而内核没有速度字段
  // （src/tui/cockpit/types.ts 与 src/server/protocol.ts 里 speed/perSec/tps 零命中，唯一的 durationMs
  // 是逐个工具调用的时长，不是模型耗时）。所以这一格只能是**客户端采样**：相邻两次 cockpit 轮询之间
  // 新增的 model.outputTokens ÷ 实测间隔。两个输入都还是内核自己的数，没有一处从文本长度估 token。
  // 这里钉的是**整条链**四段都在：公式定义（只在一处）→ 拿存储的样本去算 → 把新样本存回去 → 渲染那一格。
  // 前三个环节都来自一次真变异：只有"定义 + 消费"两半时，把 `speedSample.current = next` 那行删掉门照绿，
  // 而线上表现是**这一格永远不出现**（每次算都拿到 null 基线）——静态文本门最容易漏的就是这种"写了公式、
  // 忘了喂样本"的断链。
  record('static', '状态条图上第一格「速度」＝相邻两次 cockpit 轮询的 outputTokens 差 ÷ 实测间隔（客户端采样，非内核字段）',
    has(/export function tokensPerSecond\s*\(/, throughput) &&
    has(/tokensPerSecond\(speedSample\.current/, app) && has(/speedSample\.current = next/, app) &&
    has(/formatThroughput\(speedTps\)/, app) && has(/className="app__speed"/, app),
    '公式在 client-core/src/throughput.ts（6 条单测钉住"无产出/计数器倒退 → 不报 0"、"间隔非正 → 不报"），App.tsx 取样本并渲染 .app__speed；语义是每拍的瞬时吞吐，不是整轮平均')
}

// 4b. §4.3 #2 的 REST 兜底：断线期间用落盘日志把时间线推上去。计划这句此前**只接了一半**——
// `api.events(id, since)` 在客户端里是零调用点，内核那条 `GET /sessions/:id/events?since=N`
// （src/server/session-routes.ts:1250 的 B3 replay tail）根本没人问，于是断线时界面只能冻住。
// 行为由 packages/client-core/test/rest-fallback.test.ts 四条回路级测试钉住（真 openSessionStream
// + 脚本化传输：兜底送上的事件进模型、重叠按 seq 丢、游标推进后 SSE 改问新 since、兜底失败不弄死退避、
// 不传 pullRest 就完全惰性）。这里钉的是**链的两头都在**：传输层有这条路子并真去调用，宿主把拉取函数交给它。
{
  record('static', '§4.3 #2 REST 兜底两头都接上：传输层声明并调用 pullRest，宿主把 api.events 的尾段交给它',
    has(/pullRest\?: \(since: number\) => Promise<SessionEvent\[\]>/, stream) && has(/await opts\.pullRest\(lastSeq\)/, stream) &&
    has(/pullRest: \(since\) => api\.events\(/, app),
    '行为证据在 rest-fallback.test.ts（4 条，零花费）；这条静态判定防的是"传输层留着、宿主不再传 pullRest"——那等于整条兜底静默失效')
}

// 5. 品牌只在侧栏头部一处（定稿要点第 3 条）。
{
  const inSession = (sessionTsx.match(/us__brand/g) ?? []).length
  const inWeb = (app.match(/us__brand|app__brand/g) ?? []).length
  record('static', '品牌只出现在侧栏头部一处（宿主不得再印第二处）', inSession === 1 && inWeb === 0,
    `ui-session ${inSession} 处 / apps/web ${inWeb} 处`)
}

// 6. 主按钮取近黑（定稿要点「近黑主按钮」）。
{
  const send = has(/\.app__send[^}]*background:\s*var\(--nb-1000\)/s, css)
  const create = has(/\.us__new[^}]*background:\s*var\(--nb-1000\)/s, sessionCss)
  record('static', '两个主按钮都取 --nb-1000（近黑），不是组件库默认蓝', send && create,
    `app__send=${send} us__new=${create}`)
}

// 7. 定稿要点的「项目列表」层。这一条以前记在 manual 里，写的是"没有实现"——现在钉成静态判定。
{
  const panel = read('packages/ui-session/src/index.tsx')
  const grouping = read('packages/ui-session/src/projects.ts')
  record('static', '侧栏是两级：列表按 cwd 分组，每组渲染一个项目 header',
    /groupSessionsByProject\(sessions\)/.test(panel) && /className="us__group"/.test(panel)
    && /className=\{`us__proj/.test(panel),
    `grouping=${/groupSessionsByProject\(sessions\)/.test(panel)} group=${/className="us__group"/.test(panel)} header=${/className=\{`us__proj/.test(panel)}`)
  record('static', '没选定目录的会话走合成桶，不各占一个 header（scratch 与 runtime-default）',
    /SYNTH_PROJECT_KEY/.test(grouping) && /'scratch'/.test(grouping) && /'runtime-default'/.test(grouping),
    `synth=${/SYNTH_PROJECT_KEY/.test(grouping)} scratch=${/'scratch'/.test(grouping)} runtime-default=${/'runtime-default'/.test(grouping)}`)
  record('static', '项目行几何照 mockup 的 .prow：34px 高、8px gap、20px/6px 圆角 mark、r999 计数胶囊',
    /\.us__proj\s*\{[^}]*height:\s*var\(--scale-project-row\)/.test(sessionCss) && /\.us__proj\s*\{[^}]*gap:\s*8px/.test(sessionCss)
    && /\.us__proj-mark\s*\{[^}]*width:\s*var\(--scale-project-mark\)[^}]*border-radius:\s*6px/.test(sessionCss)
    && /\.us__proj-count\s*\{[^}]*border-radius:\s*999px[^}]*padding:\s*1px 7px/.test(sessionCss),
    `row-token=${/\.us__proj\s*\{[^}]*height:\s*var\(--scale-project-row\)/.test(sessionCss)} 8px gap=${/\.us__proj\s*\{[^}]*gap:\s*8px/.test(sessionCss)} mark-token=${/\.us__proj-mark\s*\{[^}]*width:\s*var\(--scale-project-mark\)/.test(sessionCss)} pill=${/\.us__proj-count\s*\{[^}]*border-radius:\s*999px/.test(sessionCss)}`)
  record('static', '会话行是一行 32px（取自 --scale-session-row），且文字相对项目名左移 8px（图上 8+16+4 对 8+20+8）',
    /\.us__row\s*\{[^}]*height:\s*var\(--scale-session-row\)/.test(sessionCss) && /\.us__group \.us__row\s*\{[^}]*padding-left:\s*8px/.test(sessionCss),
    `row-token=${/\.us__row\s*\{[^}]*height:\s*var\(--scale-session-row\)/.test(sessionCss)} indent8=${/\.us__group \.us__row\s*\{[^}]*padding-left:\s*8px/.test(sessionCss)}`)
}

// 8. 右栏是折叠组栈（定稿要点「折叠组右栏」）。这里以前是互斥 tab，那种形态这些判定过不来。
{
  const primCss = read('packages/ui-primitives/src/styles.css')
  const noTabs = !/app__tab/.test(app) && !/rightTab === '/.test(app)
  record('static', '右栏不再有互斥 tab：既没有 app__tab 渲染，也不再按 rightTab 单选面板',
    noTabs && /<SectionGroup/.test(app) && /RAIL_TABS\.map/.test(app),
    `no-app__tab=${!/app__tab/.test(app)} no-single-select=${!/rightTab === '/.test(app)} group-render=${/<SectionGroup/.test(app)} stack-map=${/RAIL_TABS\.map/.test(app)}`)
  record('static', '折叠组几何照图上 .sec/.sec-head/.sec-body：头 36px、卡片 12px 圆角、组体 2px 12px 12px、open 时 chev 转 90°',
    /\.tp-sec__head\s*\{[^}]*height:\s*var\(--scale-group-head\)/.test(primCss)
    && /\.tp-sec\s*\{[^}]*border-radius:\s*var\(--scale-card-radius\)/.test(primCss)
    && /\.tp-sec__body\s*\{[^}]*padding:\s*2px 12px 12px/.test(primCss)
    && /\.tp-sec--open \.tp-sec__chev\s*\{[^}]*rotate\(90deg\)/.test(primCss),
    `head-token=${/\.tp-sec__head\s*\{[^}]*height:\s*var\(--scale-group-head\)/.test(primCss)} radius-token=${/\.tp-sec\s*\{[^}]*border-radius:\s*var\(--scale-card-radius\)/.test(primCss)} body=${/\.tp-sec__body\s*\{[^}]*padding:\s*2px 12px 12px/.test(primCss)} chev-rotates=${/\.tp-sec--open \.tp-sec__chev\s*\{[^}]*rotate\(90deg\)/.test(primCss)}`)
  record('static', '组内容首次展开才挂载，之后保留（六面板不会一起打 sidecar，折叠也不丢状态）',
    /mountedGroups\.has\(g\.id\)/.test(app) && /setMountedGroups/.test(app) && /native <details|<details/.test(read('packages/ui-primitives/src/section.tsx')),
    `lazy=${/mountedGroups\.has\(g\.id\)/.test(app)} kept-mounted=${/setMountedGroups/.test(app)} uses-native-details=${/<details/.test(read('packages/ui-primitives/src/section.tsx'))}`)
  // 第二张定稿图（collapsed）画的是 44px 图标细条：一枚 « 展开钮 + **每组一枚**图标钮，点一枚就跳进那一组。
  // 这里以前只有一个竖排文字钮，收起态等于把六组 IA 收成"打开整栏"一个动作。
  record('static', '收起态右栏照第二张图是逐组图标的细条（« 展开钮 + 每组一枚，点一枚＝打开那一组并把栏展开）',
    /className="app__railstrip"/.test(app) && /className="app__railexpand"/.test(app)
    && /className="app__railbtn"/.test(app) && /setGroupOpen\(g\.id, true\)/.test(app),
    `strip=${/className="app__railstrip"/.test(app)} expand=${/className="app__railexpand"/.test(app)} railbtn=${/className="app__railbtn"/.test(app)} jump=${/setGroupOpen\(g\.id, true\)/.test(app)}；角点只在该组真有读数时才画=${/railContextPct !== null/.test(app)}`)
  record('static', '细条几何照源稿 .d-rail/.rail-btn/.mini：竖排 gap 4 / padding 10 0、钮 36px 取 --scale-rail-btn、角点 6px 取 --scale-rail-mini',
    /\.app__railstrip\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*4px[^}]*padding:\s*10px 0/.test(css)
    && /\.app__railexpand, \.app__railbtn\s*\{[^}]*width:\s*var\(--scale-rail-btn\)[^}]*height:\s*var\(--scale-rail-btn\)/.test(css)
    && /\.app__railmini\s*\{[^}]*width:\s*var\(--scale-rail-mini\)[^}]*height:\s*var\(--scale-rail-mini\)/.test(css),
    `strip=${/\.app__railstrip\s*\{[^}]*flex-direction:\s*column/.test(css) && /\.app__railstrip\s*\{[^}]*gap:\s*4px/.test(css) && /\.app__railstrip\s*\{[^}]*padding:\s*10px 0/.test(css)} btn-token=${/\.app__railexpand, \.app__railbtn\s*\{[^}]*width:\s*var\(--scale-rail-btn\)/.test(css)} mini-token=${/\.app__railmini\s*\{[^}]*width:\s*var\(--scale-rail-mini\)/.test(css)}`)
}

// 9. 委托与人工项点名。
{
  record('delegated', '色板与定稿 mockup 的一致性由 check-mockup 判定', existsSync(join(clientRoot, 'scripts/check-mockup-tokens.mjs')),
    'scripts/check-mockup-tokens.mjs')
  record('delegated', '几何的浏览器实测（列序 / 窄栏与停靠区的居中对称 / 无横向溢出）由 check-liverender 判定',
    existsSync(join(clientRoot, 'scripts/check-live-geometry.mjs')),
    'scripts/check-live-geometry.mjs：tracks 三条 + `.uc__col`/`.app__composer-col` 的左右留白对称两条 + 三栏可见溢出各一条。以前这条是 manual（"人拿探针量一次 1443px"），现在门每次跑都量——放错 grid 轨道不改变宽度读数，但一定破对称，所以对称是比宽度更硬的那一格')
  record('delegated', '项目层在真会话下的渲染（组头高 / 缩进 −8 / 分组结构与计数胶囊 / 折叠行为 / 合成桶无 tooltip）由 check-liverender 判定',
    existsSync(join(clientRoot, 'scripts/check-live-geometry.mjs')),
    'scripts/check-live-geometry.mjs：环境里现造带 cwd 的会话 + 1 条不带 cwd 的会话 + 一条 `isolatedWorktree: true` 的真 worktree 会话（本地 git，零上游花费），并给其中一条 `PATCH` 一句**长到会截断**的标题；**分组期望值现读自 `GET /sessions`**（这个探针库跨次复用，写死"本轮建了几条"会把工具自己的复用报成产品漂移——已经错过一次）。量 `.us__proj` 34px、屏上文字左缘差 −8px、组头数==现读的 distinct cwd 数+合成桶、每组的计数胶囊==组内行数、胶囊总和==会话数、组外行 0、点组头折叠后行消失且 aria-expanded=false 且 caret 转向、再点恢复、合成桶那条 `title=` 不存在而有路径的那几组 tooltip 等于完整路径、被截断那一行仍是单行 32px 且 `text-overflow:ellipsis`、带 worktree 分支名的行盒宽==74px 上限且整行不被顶宽（变异把 ellipsis 改成 clip 只红省略号那一条）。**徽标 + 超长分支名 + 长标题同屏的那一行已由第四个探针页做成真组件实测**（`/row-probe.html` 挂真 `<SessionList>` 喂夹具，是第 53 条锚点）——这一格仍未测的只剩**徽标会不会从一次真待授权事件里落进来**，那是数据来源问题（无 key 造不出 approval_required），不是渲染问题')
  record('delegated', '第二张定稿图（收起态）的细条由 check-liverender 判定（收起宽 / 钮数==组数 / 每枚 36 方 / 点一枚跳进那一组）',
    existsSync(join(clientRoot, 'scripts/check-live-geometry.mjs')),
    'scripts/check-live-geometry.mjs 的 RAIL_PROBE：点头上那个 ✕ 把栏收起后量 `.app__rail` 的**盒宽**对回图上 `body.details-collapsed` 的第三轨、钮数==展开态 `.tp-sec` 的组数且 « 展开钮在、逐枚量 `.app__railbtn` 对回图上 36px、点「上下文」那枚之后栏回到展开宽且**那一组真的开着**（拿按钮自己的 aria-label 去对组标题，中英两侧都成立）。变异验过：给 `.app__rail` 加一行 `min-width: 50px`（`width: var(--scale-rail-collapsed)` 一个字没动）→ 本门的静态判定与 check:scale 全绿，只有这条像素读数变成 50px 并报红——这就是"看声明的门"与"看盒子的门"的分工')
}

const fails = results.filter((r) => !r.ok)
if (!quiet) {
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} [${r.kind}] ${r.label}${r.note ? ` — ${r.note}` : ''}`)
  console.log(`\n静态 ${results.filter((r) => r.kind === 'static').length} 条，委托 ${results.filter((r) => r.kind === 'delegated').length} 条，人工留档 ${results.filter((r) => r.kind === 'manual').length} 条`)
}
if (fails.length > 0) {
  console.error('\nFAILED (几何又开始靠自动排布碰运气):')
  for (const f of fails) console.error(`  ✗ [${f.kind}] ${f.label} — ${f.note}`)
  process.exit(1)
}
