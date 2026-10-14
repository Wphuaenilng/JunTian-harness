#!/usr/bin/env node
/**
 * check-wire-mirror.mjs — 把「客户端手抄的线上形状」钉回内核真源（字段名 / 字面量级）。
 *
 * 为什么要它：漂移门 gen-protocol-types.mjs 是**逐字节复制 src/server/protocol.ts**，那很硬，
 * 但它的射程只有那一份文件里的 19 个名字。客户端另外还手抄了一批线上形状（schedule-types.ts、
 * task-types.ts、sidecar-client.ts 里那些 interface），它们的真源在 protocol.ts **之外**
 * （scheduled-task-model.ts、health-route.ts、git-workbench.ts…）。内核把 TaskRecord.attempt
 * 改名、或把 HealthBody.runningCount 换个叫法，镜像照绿、typecheck 照绿（客户端自己那份还写着
 * 旧名），界面上那个读数变成 undefined——没有编译错误，也没有红判定，只有一句"这里为什么没数据"。
 * 这一面把那段距离量出来。
 *
 * 判据只用外部可观察量：两侧源码里**真存在的名字集合**。硬的只有一条：
 *   客户端声明了、内核没有 → 红（那就是"界面在读一个线上不存在的键"）。
 * 客户端是子集**合法**（只抄界面用得着的那几个字段，多出来的内核字段被忽略），内核独有只打印。
 *
 * 解析上踩过坑，写在这里免得再犯：内核的成员不是每行一个——git-workbench.ts:28 的
 * RepositoryContext 一行写四个，:34 的 GitChange 整条 interface 一行写完。第一版用 `^\s{2}name:`
 * 去数，于是报出 7 条"客户端独有"，逐条打开内核原文看**全都存在**。所以这里的切分是**按花括号
 * 深度**来的；并且解析不动的一律进"未覆盖"清单并点名，不许静默通过。
 *
 *   node scripts/check-wire-mirror.mjs                          # 实跑
 *   node scripts/check-wire-mirror.mjs --kernel-dir X --client-dir Y   # 夹具（变异用，绝不碰 src/**）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? resolve(process.argv[i + 1]) : fallback
}
const KERNEL_DIR = flag('--kernel-dir', join(repoRoot, 'src', 'server'))
const CLIENT_DIR = flag('--client-dir', join(clientRoot, 'packages', 'client-core', 'src'))
/** 镜像文件按定义就是逐字节复制，不参与"手抄"对账（它由 gen-protocol-types.mjs --check 管）。 */
const MIRROR = 'protocol-types.ts'

const failures = []
let checksRun = 0
const check = (label, ok, detail = '') => {
  checksRun += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const rel = (dir, p) => relative(dir, p).replace(/\\/g, '/')
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

/** 注释里带 `{`、`@link`、甚至整条示例声明——先剥掉，但保留行数与换行，坐标才对得上。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function tsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...tsFiles(p))
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** 从头一个 `{` 起按深度找配平的收尾（跳过字符串字面量里的括号）。 */
function closeBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++ }
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (depth === 0) return c === '}' ? i : -1
    }
  }
  return -1
}

/** 只在深度 0 处按 `;` 与换行切段：Array<{ a: string; b: string }> 不能被切成两段。 */
function segments(body) {
  const out = []
  let cur = ''
  let depth = 0
  for (const c of body) {
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1)
    if (depth === 0 && (c === ';' || c === '\n')) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * 收集一个目录里的线上形状声明，两种都要：
 *  - 对象形状 → 顶层字段名集合（索引签名 `[k: string]` 单独记，它让 TS 抓不到键名写错）
 *  - 字面量联合 `type X = 'a' | 'b'` → 字面量集合（改名一样致命：界面 switch 认的是旧名）
 * 取不到形状的一律进 unresolved，由调用方红着点名。
 *
 * 声明的边界按**语句**取，不按"下一个 export"取：第一版按后者切，于是
 * `export type ReviewPolicy = 'a' | 'b'` 后面那句 `import type { TaskRecord } from …` 里的 `{`
 * 被当成了它的体，把一条字面量联合判成了对象形状（三条假"种类不同"）。
 */
function collectTypes(dir, skipNames = []) {
  const types = new Map()
  const unresolved = []
  for (const file of tsFiles(dir)) {
    if (skipNames.includes(file.split(/[\\/]/).pop())) continue
    const text = codeOnly(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/^export\s+(interface|type)\s+([A-Za-z][\w$]*)/gm)) {
      const name = m[2]
      const from = m.index + m[0].length
      const nl = text.indexOf('\n', from)
      const firstLine = text.slice(from, nl < 0 ? text.length : nl)
      const rest = nl < 0 ? '' : text.slice(nl + 1)
      let brace = firstLine.indexOf('{')
      let braceAt = brace >= 0 ? from + brace : -1
      if (brace < 0) {
        // 体也可能从下一行才开始（`export interface X` 换行再 `{`）；只向下看一眼。
        const nextLine = rest.slice(0, rest.indexOf('\n') + 1)
        const lead = nextLine.match(/^\s*/)
        if (/^\s*\{/.test(nextLine) && lead) braceAt = nl + lead[0].length + 1
      }
      if (braceAt >= 0) {
        const end = closeBrace(text, braceAt)
        if (end < 0) { unresolved.push({ name, why: `花括号不配平（${rel(dir, file)}:${lineOf(text, m.index)}）` }); continue }
        const fields = new Set()
        let indexSig = false
        for (const seg of segments(text.slice(braceAt + 1, end))) {
          const fm = seg.match(/^(?:readonly\s+)?(\[[^\]]*\]|[A-Za-z_$][\w$]*)\??\s*:/)
          if (!fm) continue
          if (fm[1].startsWith('[')) { indexSig = true; continue }
          fields.add(fm[1])
        }
        types.set(name, { kind: 'object', fields, indexSig, file: rel(dir, file), line: lineOf(text, m.index) })
        continue
      }
      // 没有体：只可能是**语句内**的字面量联合（含换行续写的 `| 'x'`），别的一概不猜。
      let litText = firstLine
      if (/[|=']\s*$/.test(firstLine) || /^\s*=/.test(firstLine)) {
        for (const line of rest.split('\n')) {
          if (/^\s*\|/.test(line) || /^\s*'[a-zA-Z0-9_\-]+'/.test(line)) { litText += line; continue }
          break
        }
      }
      const lits = [...litText.matchAll(/'([^']+)'|\"([^\"]+)\"/g)].map((x) => x[1] ?? x[2])
      if (lits.length > 0) {
        types.set(name, { kind: 'union', fields: new Set(lits), indexSig: false, file: rel(dir, file), line: lineOf(text, m.index) })
      } else {
        unresolved.push({ name, why: `既不是对象体也没有字面量联合（${rel(dir, file)}:${lineOf(text, m.index)}）` })
      }
    }
  }
  return { types, unresolved }
}

const kernel = collectTypes(KERNEL_DIR)
const client = collectTypes(CLIENT_DIR, [MIRROR])
const mirrorFile = join(CLIENT_DIR, MIRROR)
const mirrorCount = existsSync(mirrorFile)
  ? (codeOnly(readFileSync(mirrorFile, 'utf8')).match(/^export\s+(interface|type)\s+[A-Za-z]/gm) ?? []).length
  : 0

check('内核与客户端两侧的类型名册都读到了', kernel.types.size >= 100 && client.types.size >= 30,
  `内核 ${tsFiles(KERNEL_DIR).length} 份源文件认到 ${kernel.types.size} 个导出形状；客户端认到 ${client.types.size} 个。镜像文件 ${MIRROR} 里那 ${mirrorCount} 个不参与对账——它是逐字节复制，由 gen-protocol-types.mjs --check 管`)

// 正控：这些名字**必须**两侧同时被认出来。少一个说明解析器退回"只能数每行一个字段"那种瞎态，
// 而那种状态报出来的"没有差异"是假的（第一版就在这里造过 7 条不存在的差异）。
// 名单里特意含"整条 interface 一行写完"的 GitChange、"一行四个字段"的 RepositoryContext，以及若干字面量联合。
const MUST_PAIR = ['ScheduledTask', 'TaskRecord', 'HealthBody', 'ScheduledTaskRetry', 'DirEntry', 'GitChange', 'RepositoryContext', 'CronTrigger', 'TaskStatus', 'TaskSource', 'ScheduledTaskStatus', 'ReviewPolicy', 'CronTriggerType']
const missingPair = MUST_PAIR.filter((n) => !(client.types.has(n) && kernel.types.has(n)))
check(`正控：${MUST_PAIR.length} 个手抄形状两侧都真被认出来（含单行 interface 与一行多字段的写法）`, missingPair.length === 0,
  missingPair.length ? missingPair.map((n) => `${n}：客户端 ${client.types.has(n) ? '有' : '无'} / 内核 ${kernel.types.has(n) ? '有' : '无'}`).join(' ｜ ') : `全在：${MUST_PAIR.join(' , ')}`)

const pairs = [...client.types.keys()].filter((n) => kernel.types.has(n))
const bad = []
const info = []
for (const name of pairs) {
  const c = client.types.get(name)
  const k = kernel.types.get(name)
  if (!c || !k) continue
  if (c.kind !== k.kind) { bad.push(`${name}：形状种类不同（客户端 ${c.kind} @${c.file}:${c.line} / 内核 ${k.kind} @${k.file}:${k.line}）`); continue }
  const clientOnly = [...c.fields].filter((x) => !k.fields.has(x))
  const kernelOnly = [...k.fields].filter((x) => !c.fields.has(x))
  if (clientOnly.length) bad.push(`${name}（客户端 ${c.file}:${c.line}）写了内核没有的 ${clientOnly.join(', ')} —— 内核那份（${k.file}:${k.line}）有的是：${[...k.fields].join(', ')}`)
  info.push(`${name} ${c.kind === 'union' ? '字面量' : '字段'} ${c.fields.size}/${k.fields.size}${clientOnly.length ? ` ← 客户端独有 ${clientOnly.join(',')}` : ''}${kernelOnly.length ? `（内核另有 ${kernelOnly.length} 个没抄）` : ''}${c.indexSig ? ' [索引签名]' : ''}`)
}
// 解析不动的名字，只有落在"我要对账的那批"里才算洞；其余（内核里那些函数类型、Map/Record 别名）
// 与这一面无涉，只报数不判红——否则这道门会永久红，而永久红的东西没人会读。
const relevant = new Set([...pairs, ...MUST_PAIR])
const fmt = (u) => `${u.name}：${u.why}`
const blindClient = client.unresolved.filter((u) => relevant.has(u.name))
const blindKernel = kernel.unresolved.filter((u) => relevant.has(u.name))
const noiseUnresolved = client.unresolved.length + kernel.unresolved.length - blindClient.length - blindKernel.length
check(`每一条手抄形状都不比线宽大（对账 ${pairs.length} 个同名形状）`,
  bad.length === 0 && blindClient.length === 0 && blindKernel.length === 0,
  [
    bad.length ? `不一致：\n      ${bad.join('\n      ')}` : '',
    blindClient.length ? `客户端这一侧解析不成：${blindClient.map(fmt).join(' ｜ ')}` : '',
    blindKernel.length ? `内核这一侧解析不成：${blindKernel.map(fmt).join(' ｜ ')}` : '',
  ].filter(Boolean).join('\n      ') || `${pairs.length} 条全对得上（内核独有字段不判红：客户端只抄界面用得着的那几个是合法的）`)
console.log(`  i 与这一面无涉的别名（函数类型 / Map / Record，没有体也没有字面量）：${noiseUnresolved} 条`)

console.log(`  i 逐条（客户端 / 内核 的数量）：\n      ${info.join('\n      ')}`)
const indexSigs = pairs.filter((n) => client.types.get(n)?.indexSig)
if (indexSigs.length) console.log(`  i 带索引签名、因而 TS 抓不到键名写错的那几份：${indexSigs.join(' , ')}`)

console.log(`\n${checksRun} 项判定，红 ${failures.length} 项`)
process.exit(failures.length > 0 ? 1 : 0)
