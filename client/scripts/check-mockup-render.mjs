#!/usr/bin/env node
/**
 * check-mockup-render.mjs — the approved drawing's two PNG deliverables must still come out of the
 * HTML source they are generated from.
 *
 * Why this exists: `analysis-reports/定稿-天枢客户端方案/design/` ships the mockup as
 * `<html>` + two PNGs, and the 定稿 README calls the script that makes them 「复截脚本」. Nothing had
 * ever run that script. When we ran it (2026-10-12) two things fell out: it could not be invoked the
 * way its own usage comment describes (relative path → net::ERR_FILE_NOT_FOUND, since it built
 * `file:///` + argv with no resolve — fixed in that script), and *byte equality is not a property of
 * the pipeline*: the same command twice produced 495616 and 495617 bytes. So the check has to be
 * pixel-based, not hash-based. Measured jitter of one identical re-render against itself:
 * 124/6.4M pixels (0.0019%), max channel delta 5 — sub-perceptual AA noise. Default threshold 0.01%
 * sits an order of magnitude above that, so it flags real layout/colour drift without chasing jitter.
 *
 * Built-in controls (a green here is not "the parser found nothing"):
 *  - the face is enumerated, not hardcoded: both shipped PNGs must be present, and each is compared
 *    to a render of the same HTML (second one with the drawing's own `#collapsed` hash state);
 *  - a cross check must stay LARGE: collapsed render vs expanded PNG is reported, and if it ever
 *    drops below the cross threshold the `#collapsed` state is not actually taking effect, so the
 *    "both states reproduce" claim would be hollow — that is reported as 未测到/红, not as a pass;
 *  - no Edge / no playwright-core / no PNG → 红 with the reason ("没测到"不是"过了").
 *
 * Renders go to the OS temp dir only; the approved PNGs are inputs and are never overwritten.
 *
 *   node scripts/check-mockup-render.mjs            # both states
 *   node scripts/check-mockup-render.mjs --tol=0.02 # percent-of-pixels threshold
 *   node scripts/check-mockup-render.mjs --quiet
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')
const designDir = join(repoRoot, 'analysis-reports', '定稿-天枢客户端方案', 'design')
const HTML = join(designDir, 'desktop-mockup-dsh-style.html')
// Same viewport the drawing was authored at, and the same @2x the shipped PNGs carry (3200x2000).
const VIEWPORT = { width: 1600, height: 1000 }
const SCALE = 2
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const tol = Number((args.find((a) => a.startsWith('--tol=')) ?? '--tol=0.01').split('=')[1])

const failures = []
const checksRun = []
const check = (label, ok, detail = '') => {
  checksRun.push(label)
  if (!ok) failures.push(label)
  if (!quiet) console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal 8-bit truecolour PNG reader (non-interlaced). Decoding is required: hashing is not a
 *  stable judgement, and the sizes alone (495616 vs 495617) prove it. */
function decodePng(file) {
  const buf = readFileSync(file)
  if (buf.subarray(1, 4).toString('hex') !== '504e47') throw new Error(`${file} 不是 PNG`)
  let off = 8
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('ascii')
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`${file}: 只支持 8-bit 非隔行，实得 depth=${depth} interlace=${interlace}`)
  const ch = color === 6 ? 4 : color === 2 ? 3 : null
  if (!ch) throw new Error(`${file}: 不支持的颜色类型 ${color}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    raw.copy(cur, 0, p, p + stride); p += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = cur[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      cur[x] = v & 0xff
    }
    cur.copy(out, y * stride)
    cur.copy(prev)
  }
  return { w, h, ch, px: out }
}

/** percent of pixels differing (RGB channels only — alpha is constant in these shots). */
function diffPercent(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { percent: 100, maxDelta: 255, size: `${a.w}x${a.h} vs ${b.w}x${b.h}` }
  let diff = 0, maxDelta = 0
  const n = Math.min(a.px.length, b.px.length)
  for (let i = 0; i < n; i += a.ch) {
    let d = 0
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.px[i + k] - b.px[i + k]))
    if (d > 0) { diff++; if (d > maxDelta) maxDelta = d }
  }
  return { percent: (diff * 100) / (a.w * a.h), maxDelta, size: `${a.w}x${a.h}`, diffPixels: diff, total: a.w * a.h }
}

const exists = (f) => { try { readFileSync(f); return true } catch { return false } }

// ---------------------------------------------------------------- the inputs are the deliverables
check(`定稿设计资产在盘上（HTML 源稿 + 两张入库 PNG）`,
  exists(HTML) && exists(join(designDir, 'tianshu-desktop-mockup-dsh-style.png')) && exists(join(designDir, 'tianshu-desktop-mockup-dsh-collapsed.png')),
  '缺任何一个都是"没测到"，不是"过了"')

let browser = null
try {
  if (!existsSyncEdge()) throw new Error(`no Edge at ${EDGE}`)
  const pw = await import(pathToFileURL(join(repoRoot, 'node_modules', 'playwright-core', 'index.js')).href)
  // playwright-core 是 CJS：动态 import 的具名导出要经 default 拿（这一手在 check-live-geometry 里踩过）
  const { chromium } = pw.default ?? pw
  browser = await chromium.launch({ executablePath: EDGE, headless: true })
} catch (e) {
  check('浏览器可用（playwright-core + 系统 Edge）', false, `${e.message} — 这一格未取到证据`)
}

function existsSyncEdge() { return exists(EDGE) }

/** Render the drawing; `hash` selects the state the HTML itself implements (line: location.hash). */
async function render(hash, outName) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE })
  await page.goto(pathToFileURL(HTML).href + hash, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1000)
  const out = join(tmp, outName)
  await page.screenshot({ path: out, fullPage: false })
  await page.close()
  return out
}

const tmp = mkdtempSync(join(tmpdir(), 'mockup-render-'))

if (browser) {
  const states = [
    { hash: '', png: 'tianshu-desktop-mockup-dsh-style.png', label: '展开态' },
    { hash: '#collapsed', png: 'tianshu-desktop-mockup-dsh-collapsed.png', label: '收起态' },
  ]
  const shots = []
  for (const [i, st] of states.entries()) {
    const file = await render(st.hash, `state-${i}.png`)
    shots.push({ ...st, png2: decodePng(join(designDir, st.png)), render: decodePng(file) })
  }

  // 同一条命令渲两次，用来给"抖动"而不是"哈希相等"定标（第一次跑就观测到 0.0019% 的自我差）。
  const again = decodePng(await render('', 'state-0-repeat.png'))
  const jitter = diffPercent(shots[0].render, again)
  check(`重渲自身的抖动在阈值内（同一条命令两次：${jitter.percent.toFixed(4)}% 像素差，最大通道差 ${jitter.maxDelta}）`,
    jitter.percent <= tol, `阈值 ${tol}%；这一条不过就说明判据在追编码器噪声而不是画面漂移`)

  for (const s of shots) {
    if (s.render.w !== 3200 || s.render.h !== 2000) {
      check(`${s.label}：渲染尺寸 == 图上标的 1600×1000 @2x`, false, `实得 ${s.render.w}x${s.render.h}`)
      continue
    }
    const d = diffPercent(s.render, s.png2)
    check(`${s.label}：源稿重渲与入库 PNG 的像素差 ≤ ${tol}%（实得 ${d.percent.toFixed(4)}%，${d.diffPixels}/${d.total}，最大通道差 ${d.maxDelta}，尺寸 ${d.size}）`,
      d.percent <= tol, '源稿改了而 PNG 没重打，或反过来——定稿图与它声称的源不再同一')
  }

  // 反向对照：#collapsed 必须真的换了一张图。两种状态互差若跌进阈值，"两态都可复现"就是空话。
  const cross = diffPercent(shots[1].render, shots[0].png2)
  check(`反向对照：收起态渲染 vs 入库展开图必须差得开（实得 ${cross.percent.toFixed(3)}%，最大通道差 ${cross.maxDelta}）`,
    cross.percent > 5, `只要求 >5%，实得 ${cross.percent.toFixed(3)}%——再小就说明 #collapsed 没生效，上面那条绿是空的`)

  await browser.close()
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
if (!quiet) console.log(`\nmockup render checks passed (${checksRun.length} checks, tol=${tol}%)`)
process.exit(0)
