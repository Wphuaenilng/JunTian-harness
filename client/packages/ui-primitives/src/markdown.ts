/**
 * Incremental markdown (plan §8: the only fix for the streaming O(n²) trap).
 *
 * A run appends deltas into ONE block. Re-parsing the whole block per delta costs
 * O(n) per token, so a long answer costs O(n²) and the UI stutters near the end.
 * Blocks are immutable once sealed, so parse each block once and only re-parse the
 * open tail — the tail is short-lived and bounded, so total cost is O(n).
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

export function renderMarkdown(id: number, source: string, open: boolean): string {
  if (!open) {
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const html = micromark(source, { allowDangerousHtml: false })
    cache.set(id, html)
    // Bounded: closed blocks only grow while a session is open, and this is a view
    // cache, not data — dropping the oldest on overflow keeps long runs cheap.
    if (cache.size > 3000) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
    return html
  }
  return micromark(stabilizeUntrustedTail(source), { allowDangerousHtml: false })
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
