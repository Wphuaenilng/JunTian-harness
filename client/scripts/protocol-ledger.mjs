#!/usr/bin/env node
/**
 * protocol-ledger.mjs — the plan's 贯穿项「每个 ui-* 包 README 记录消费的端点与事件类」,
 * generated from code instead of handwritten.
 *
 * A prose table rots the moment a panel starts calling one more endpoint, and a stale
 * "protocol consumption ledger" is worse than none: it is the document people trust when
 * deciding whether a kernel change can break the client. So this derives the table by
 * reading the real call sites, and CI checks it with `--check`.
 *
 *   node scripts/protocol-ledger.mjs            # print the whole table
 *   node scripts/protocol-ledger.mjs --write    # refresh the marked block in each README
 *   node scripts/protocol-ledger.mjs --check    # exit 1 if any block is stale or missing
 *
 * What counts as "consumed":
 *   - endpoints  : `api.<method>(` / `client.<method>(` call sites, mapped through the
 *                  HTTP verb + path template declared in sidecar-client.ts;
 *   - event types: string literals that are members of the mirrored `SessionEventType`
 *                  union (so the ledger drifts with the protocol mirror, not with memory);
 *   - block kinds: `kind === 'x'` / `case 'x'` against the `Block` union — the folded
 *                  surface most views actually switch on, which is not the same as the
 *                  wire list and is recorded separately rather than merged into it.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const core = join(root, 'packages/client-core/src')

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Comments carry protocol row references; a naive scan would count them as call sites. */
const codeOf = (file) => strip(readFileSync(file, 'utf8'))

// ---------------------------------------------------------------- sidecar-client methods
const clientSrc = codeOf(join(core, 'sidecar-client.ts'))
const methodStarts = [...clientSrc.matchAll(/^ {2}(?:async )?([a-z][A-Za-z]*)\(/gm)].filter((m) => m[1] !== 'constructor')

const PATH_ARG = String.raw`(\`[^\`]*\`|'[^']*'|"[^"]*")`
const VERB_CALLS = [
  [new RegExp(String.raw`request(?:<[^>]*>)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*${PATH_ARG}`, 'g'), (m) => [m[1], m[2]]],
  [new RegExp(String.raw`\bpost[A-Za-z]*\(\s*${PATH_ARG}`, 'g'), (m) => ['POST', m[1]]],
  [new RegExp(String.raw`\bput[A-Za-z]*\(\s*${PATH_ARG}`, 'g'), (m) => ['PUT', m[1]]],
  [new RegExp(String.raw`\bpatch[A-Za-z]*\(\s*${PATH_ARG}`, 'g'), (m) => ['PATCH', m[1]]],
  [new RegExp(String.raw`\bdelete[A-Za-z]*\(\s*${PATH_ARG}`, 'g'), (m) => ['DELETE', m[1]]],
]
/**
 * Strip template interpolations with balanced-brace counting. A `[^{}]*` regex dies on
 * `/tasks${q ? `?${q}` : ''}` — it stops at the first inner `}` and leaves `${q ` in the
 * path, which then reads as a different endpoint than the one the client actually calls.
 * `encodeURIComponent(x)` becomes `:x` (keeping the parameter's own name: `:requestId`,
 * `:keyId`), because the hand-written prose next to the ledger uses those names, and a
 * comparison tool that renames one side cannot tell real drift from spelling.
 */
function stripInterps(s) {
  let out = ''
  for (let i = 0; i < s.length;) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 1, j = i + 2
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth++
        else if (s[j] === '}') depth--
        j++
      }
      const inner = s.slice(i + 2, j - 1).trim()
      const m = /^encodeURIComponent\(([^)]*)\)$/.exec(inner)
      out += m ? `:${m[1]}` : ''
      i = j
    } else { out += s[i]; i++ }
  }
  return out
}
const normalise = (quoted) => stripInterps(quoted.slice(1, -1))
  .replace(/\/{2,}/g, '/')
  .split('?')[0]
  .replace(/\/$/, '')

const METHODS = new Map()
methodStarts.forEach((m, i) => {
  const name = m[1]
  const body = clientSrc.slice(m.index, methodStarts[i + 1]?.index ?? clientSrc.length)
  const found = new Set()
  // Most methods call `request('VERB', path)`, but the hot ones (`prompt`, `queue`,
  // `retractQueued`) go through postJson/postExpectingBusy, where the verb lives in the
  // helper name. Missing those would drop the two endpoints the client matters most for.
  for (const [re, pick] of VERB_CALLS) {
    for (const c of body.matchAll(re)) {
      const [verb, quoted] = pick(c)
      found.add(`${verb} ${normalise(quoted)}`)
    }
  }
  if (found.size > 0) METHODS.set(name, [...found].sort())
})
// The live channel is not a SidecarClient method; it is opened straight from the stream
// module, and it is the one surface every folded block comes out of.
METHODS.set('openSessionStream', ['SSE /sessions/:id/stream'])

// ---------------------------------------------------------------- unions
function unionMembers(file, declRe) {
  const src = codeOf(file)
  const m = declRe.exec(src)
  if (!m) return []
  const rest = src.slice(m.index)
  const end = rest.slice(1).search(/\n(?:export |interface |type |const )/)
  const block = end > 0 ? rest.slice(0, end + 1) : rest
  return [...new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]))]
}
const EVENT_TYPES = unionMembers(join(core, 'protocol-types.ts'), /export type SessionEventType =/)
const BLOCK_KINDS = unionMembers(join(core, 'session-model.ts'), /export type Block =/)
if (EVENT_TYPES.length === 0 || BLOCK_KINDS.length === 0) {
  console.error('protocol-ledger: could not read the unions — refusing to write an empty ledger')
  process.exit(1)
}

// ---------------------------------------------------------------- scan
function srcFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function collect(dir) {
  const endpoints = new Set(), events = new Set(), kinds = new Set(), methods = new Set(), callbacks = new Set()
  for (const f of srcFiles(dir)) {
    const src = codeOf(f)
    for (const c of src.matchAll(/\b(?:api|client|this\.api)\.([a-zA-Z][A-Za-z]*)\(|\b(openSessionStream)\(/g)) {
      const name = c[1] ?? c[2]
      if (!METHODS.has(name)) continue
      methods.add(name)
      for (const e of METHODS.get(name)) endpoints.add(e)
    }
    for (const c of src.matchAll(/['"]([a-z0-9_]+)['"]/g)) {
      if (EVENT_TYPES.includes(c[1])) events.add(c[1])
    }
    for (const c of src.matchAll(/kind\s*[=!]==?\s*['"]([a-z_]+)['"]|case\s+['"]([a-z_]+)['"]/g)) {
      const k = c[1] ?? c[2]
      if (BLOCK_KINDS.includes(k)) kinds.add(k)
    }
    // Only host callbacks that carry protocol intent belong in the ledger; `onScroll` and
    // friends are DOM plumbing and would drown the useful half of the row.
    for (const c of src.matchAll(/\b(on[A-Z][A-Za-z]+)\??[,:]/g)) {
      if (!/^on(Mouse|Click|Scroll|Change|Input|KeyDown|KeyUp|Submit|Blur|Focus|Wheel|Copy|Paste|Drag|Drop|Touch)/.test(c[1])) callbacks.add(c[1])
    }
  }
  return {
    endpoints: [...endpoints].sort(),
    events: [...events].sort(),
    kinds: [...kinds].sort(),
    methods: [...methods].sort(),
    callbacks: [...callbacks].sort(),
  }
}

const TARGETS = [
  ...readdirSync(join(root, 'packages')).filter((d) => d.startsWith('ui-')).map((d) => [`@tianshu/${d}`, join(root, 'packages', d, 'src')]),
  ['@tianshu/store', join(root, 'packages/store', 'src')],
  ['apps/web', join(root, 'apps/web', 'src')],
]

// client-core *is* the transport, so its ledger is the method table itself, not call sites.
// Its event surface is the whole union: the adapter folds every member and routes unknown
// ones to the status bar, so "all of them" is the true statement rather than an empty cell.
const coreLedger = {
  endpoints: [...new Set([...METHODS.values()].flat())].sort(),
  events: [`(折叠全部 ${EVENT_TYPES.length} 类；未知类型进状态条)`],
  kinds: BLOCK_KINDS.slice().sort(),
  methods: [...METHODS.keys()].sort(),
  callbacks: [],
}
const rows = [['@tianshu/client-core', coreLedger], ...TARGETS.map(([name, srcDir]) => [name, collect(srcDir)])]

const md = (r) => {
  const [, c] = r
  const cell = (list) => (list.length === 0 ? '—' : list.map((x) => `\`${x}\``).join('、'))
  return [
    `| 端点 | ${cell(c.endpoints)} |`,
    `| 事件类（wire 名） | ${cell(c.events)} |`,
    `| 折叠块类型 | ${cell(c.kinds)} |`,
    `| 宿主回调 props | ${cell(c.callbacks)} |`,
  ].join('\n')
}

const START = '<!-- protocol-ledger:start -->'
const END = '<!-- protocol-ledger:end -->'
const blockFor = (r) => {
  const [name, c] = r
  return [
    START,
    `## 协议消费台账（由 \`node scripts/protocol-ledger.mjs --write\` 从代码生成，勿手改）`,
    '',
    '口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或',
    '`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。',
    '',
    `调用点 ${c.methods.length} 个${c.methods.length === 0 ? '（本包不直接打端点：数据与动作全部由宿主经 props 传入）' : `：${c.methods.map((m) => `\`${m}\``).join('、')}`}`,
    '',
    '| 面 | 消费内容 |',
    '|---|---|',
    md(r),
    END,
  ].join('\n')
}

const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : 'print'

if (mode === 'print') {
  console.log(`\nprotocol mirror: ${EVENT_TYPES.length} event types, ${BLOCK_KINDS.length} block kinds, ${METHODS.size} client methods\n`)
  console.log('| 包 | 端点数 | 事件类 | 折叠块类型 |')
  console.log('|---|---|---|---|')
  for (const r of rows) {
    const [name, c] = r
    console.log(`| ${name} | ${c.endpoints.length} | ${c.events.length ? c.events.map((e) => `\`${e}\``).join(' ') : '—'} | ${c.kinds.map((k) => `\`${k}\``).join(' ') || '—'} |`)
  }
  console.log('\nfull per-package ledger:')
  for (const r of rows) console.log(`\n### ${r[0]}\n\n| 面 | 消费内容 |\n|---|---|\n${md(r)}`)
  process.exit(0)
}

const offenders = []
for (const r of rows) {
  const [name] = r
  if (!name.startsWith('@tianshu/ui-')) continue
  const readme = join(root, 'packages', name.replace('@tianshu/', ''), 'README.md')
  if (!existsSync(readme)) { offenders.push(`${name}: no README`); continue }
  const cur = readFileSync(readme, 'utf8')
  const s = cur.indexOf(START), e = cur.indexOf(END)
  const want = blockFor(r)
  if (s === -1 || e === -1) {
    if (mode === 'write') writeFileSync(readme, `${cur.trimEnd()}\n\n${want}\n`, 'utf8')
    else offenders.push(`${name}: no ledger block`)
    continue
  }
  const have = cur.slice(s, e + END.length)
  if (have === want) continue
  if (mode === 'write') writeFileSync(readme, cur.slice(0, s) + want + cur.slice(e + END.length), 'utf8')
  else offenders.push(`${name}: ledger block is stale`)
}

if (mode === 'write') {
  console.log(`wrote/refreshed ledgers for ${rows.filter((r) => r[0].startsWith('@tianshu/ui-')).length} ui-* packages`)
  process.exit(0)
}
if (offenders.length > 0) {
  console.error('protocol ledger drift:')
  for (const o of offenders) console.error(`  ✗ ${o}`)
  process.exit(1)
}
console.log(`✓ every ui-* README carries a fresh protocol ledger (${EVENT_TYPES.length} event types mirrored)`)
