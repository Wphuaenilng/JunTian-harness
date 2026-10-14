/**
 * Incremental markdown (plan §8: the only fix for the streaming O(n²) trap).
 *
 * A run appends deltas into ONE block, and re-parsing that block per delta costs O(n) per token, so
 * a long answer costs O(n²) and the UI stutters near the end. Two levels keep it O(n): a sealed block
 * is parsed once, and inside the still-open block every finished top-level segment seals as soon as
 * its blank line arrives (see cutPoint), so only the current paragraph ever re-parses.
 */
import { micromark } from 'micromark'

/**
 * The tail that is still arriving can end mid-construct (open fence, half a link),
 * which micromark would resolve as broken HTML. Close the obvious offenders before
 * parsing so a streaming block looks like its final self instead of flickering.
 */
function stabilizeUntrustedTail(md: string): string {
  const fences = (md.match(/^```/gm) ?? []).length
  return fences % 2 === 1 ? `${md}\n\`\`\`` : md
}

const cache = new Map<number, string>()

/**
 * Counting seam for the §8 claim「增量 markdown 是 O(n²) 陷阱的唯一解法」. Before this existed the
 * claim was only true of a one-off measurement script that nobody re-ran, so deleting the cache
 * below would have passed every check in the tree. Two integer increments on a cold path — no
 * subscription, no allocation, nothing reads it in product code.
 */
export const markdownParseCount = { calls: 0, chars: 0 }

function parse(source: string, stabilize: boolean): string {
  markdownParseCount.calls += 1
  // The raw length is what the O(n) claim is about; the fence stabiliser adds a couple of chars.
  markdownParseCount.chars += source.length
  return micromark(stabilize ? stabilizeUntrustedTail(source) : source, { allowDangerousHtml: false })
}

/** Per-open-block streaming state: HTML of the blocks already sealed inside it, and where they end. */
const streaming = new Map<number, { sealedLen: number; html: string }>()

interface Segment { start: number; end: number; first: string }

/** Top-level block segments from `on`: a blank line outside a fence ends a block; a fence stays one
 *  segment even when it contains blank lines, and so do the raw HTML blocks (comment, `pre`,
 *  `script`, `style`, `textarea`) that CommonMark runs past blank lines. */
function segments(src: string, on: number): Segment[] {
  const out: Segment[] = []
  let start = -1
  let end = 0
  let first = ''
  let fence: string | null = null
  let rawEnd: RegExp | null = null
  let i = on
  while (i < src.length) {
    const nl = src.indexOf('\n', i)
    const lineEnd = nl === -1 ? src.length : nl
    const after = nl === -1 ? src.length : nl + 1
    const line = src.slice(i, lineEnd)
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]?.slice(0, 3)
    if (start === -1 && line.trim() !== '') {
      start = i
      end = after
      first = line
      if (marker !== undefined) fence = marker
      else if (/^ {0,3}<!--/.test(line)) rawEnd = /-->/
      else {
        const tag = /^ {0,3}<(pre|script|style|textarea)[\s>]/i.exec(line)?.[1]
        if (tag !== undefined) rawEnd = new RegExp(`</${tag}>`, 'i')
      }
    } else if (fence === null && rawEnd === null && line.trim() === '') {
      if (start !== -1) {
        out.push({ start, end, first })
        start = -1
      }
    } else if (start !== -1) {
      end = after
      if (fence !== null) {
        if (marker !== undefined && marker === fence) fence = null
      } else if (rawEnd !== null && rawEnd.test(line)) rawEnd = null
    }
    i = after
  }
  if (start !== -1) out.push({ start, end, first })
  return out
}

const LIST_FIRST = /^ {0,3}(?:[-*+]|\d{1,3}[.)])(?:\s|$)/
const QUOTE_FIRST = /^ {0,3}>/
const FENCE_FIRST = /^ {0,3}(`{3,}|~{3,})/
/** Raw HTML blocks that a blank line does NOT end (CommonMark types 1-5); never cut around them. */
const RAW_BLOCK = /^ {0,3}(?:<!--|<!\[|<(?:pre|script|style|textarea)[\s>])/i

/**
 * End offset of the last boundary this still-open source may be cut at, or `on` when there is none.
 *
 * A cut must not change a byte of the HTML, so only boundaries whose two neighbouring blocks cannot
 * merge in a whole-document parse are usable: a blank line ends paragraphs, headings, tables and
 * finished fences for good, but two lists merge into one loose `<ul>`, two blockquotes merge into one
 * `<blockquote>`, an indented follow-on line is a continuation, and types 1-5 HTML blocks run past
 * blank lines. The last segment is never cut — it is still arriving.
 */
function cutPoint(src: string, on: number): number {
  const segs = segments(src, on)
  let cut = on
  for (let k = 0; k < segs.length - 1; k++) {
    const s = segs[k]!
    const next = segs[k + 1]!
    if (LIST_FIRST.test(s.first) && LIST_FIRST.test(next.first)) continue
    if (QUOTE_FIRST.test(s.first) && QUOTE_FIRST.test(next.first)) continue
    if (RAW_BLOCK.test(s.first) || RAW_BLOCK.test(next.first)) continue
    if (/^\s/.test(next.first) && !FENCE_FIRST.test(next.first)) continue
    cut = s.end
  }
  return cut
}

export function renderMarkdown(id: number, source: string, open: boolean): string {
  if (!open) {
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const html = parse(source, false)
    cache.set(id, html)
    streaming.delete(id)
    // Bounded: closed blocks only grow while a session is open, and this is a view
    // cache, not data — dropping the oldest on overflow keeps long runs cheap.
    if (cache.size > 3000) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
    return html
  }
  let st = streaming.get(id)
  if (st === undefined) {
    st = { sealedLen: 0, html: '' }
    streaming.set(id, st)
    if (streaming.size > 3000) {
      const oldest = streaming.keys().next().value
      if (oldest !== undefined) streaming.delete(oldest)
    }
  }
  const cut = cutPoint(source, st.sealedLen)
  if (cut > st.sealedLen) {
    // Each slice carries its own trailing blank line, which micromark turns into a trailing "\n";
    // dropping it here keeps the concatenation byte-identical to parsing the whole source.
    const sealed = parse(source.slice(st.sealedLen, cut), false).replace(/\n+$/, '')
    st.html = st.html === '' ? sealed : `${st.html}\n${sealed}`
    st.sealedLen = cut
  }
  const tail = parse(source.slice(st.sealedLen), true)
  return st.html === '' ? tail : `${st.html}\n${tail}`
}

/**
 * Read-only test seam: how large the two view caches currently are. Same standing as
 * `markdownParseCount` — product code never reads it, and it exists because "dropping the oldest on
 * overflow keeps long runs cheap" was a comment about a number nobody was checking.
 */
export function markdownCacheStats(): { blocks: number; streams: number } {
  return { blocks: cache.size, streams: streaming.size }
}

export interface DiffHunk {
  kind: 'add' | 'del' | 'ctx' | 'meta'
  text: string
}

/**
 * Parse a unified diff for display. Line-level classification is enough for the
 * MVP card; the deep edit/accept-reject surface belongs to the Git workbench (M2).
 */
/**
 * Does this output read as a unified diff? Kept in the pure module (not the component)
 * so a node-run acceptance script can assert the same predicate the UI branches on.
 */
export function looksLikePatch(text: string): boolean {
  return /(^|\n)(---\s|\+\+\+\s|@@\s*-\d+)/.test(text)
}

export function parseUnifiedDiff(patch: string): DiffHunk[] {
  return patch.split('\n').map((text) => {
    if (text.startsWith('@@')) return { kind: 'meta' as const, text }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) {
      return { kind: 'meta' as const, text }
    }
    if (text.startsWith('+')) return { kind: 'add' as const, text }
    if (text.startsWith('-')) return { kind: 'del' as const, text }
    return { kind: 'ctx' as const, text }
  })
}

export function diffStats(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    if (h.kind === 'add') added++
    else if (h.kind === 'del') removed++
  }
  return { added, removed }
}
