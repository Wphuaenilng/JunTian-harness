import { memo, useEffect, useMemo, useState } from 'react'
import { looksLikePatch, renderMarkdown, parseUnifiedDiff, diffStats } from './markdown.ts'
import { highlightCodeBlocks } from './highlight.ts'

/**
 * HTML here is micromark output with `allowDangerousHtml: false`, so raw HTML in a
 * model response is escaped rather than injected. Do not flip that flag on: tool
 * output and file contents reach this component from an untrusted-ish source.
 *
 * Highlighting is a **post-pass on sealed blocks only**. While `open` is true the plain
 * html is shown — re-running shiki on a growing tail is the O(n²) trap §8 names, and a
 * half-typed token would flash anyway. The swap is async because shiki loads its grammar
 * data on demand; `alive` guards a block that sealed and re-rendered in the meantime.
 */
export const MarkdownBlock = memo(function MarkdownBlock({ id, source, open }: { id: number; source: string; open: boolean }) {
  const plain = useMemo(() => renderMarkdown(id, source, open), [id, source, open])
  const [html, setHtml] = useState(plain)

  useEffect(() => {
    if (open || !plain.includes('<pre><code class="language-')) { setHtml(plain); return }
    let alive = true
    highlightCodeBlocks(plain)
      .then((h) => { if (alive) setHtml(h) })
      .catch(() => { if (alive) setHtml(plain) })
    return () => { alive = false }
  }, [plain, open])

  return <div className="tp-md" dangerouslySetInnerHTML={{ __html: html }} />
})

export const DiffBlock = memo(function DiffBlock({ patch }: { patch: string }) {
  const hunks = useMemo(() => parseUnifiedDiff(patch), [patch])
  const { added, removed } = diffStats(hunks)
  return (
    <div className="tp-diff">
      <div className="tp-diff__head">
        <span className="tp-diff__add">+{added}</span>
        <span className="tp-diff__del">−{removed}</span>
      </div>
      <pre className="tp-diff__body">
        {hunks.map((h, i) => (
          <span key={i} className={`tp-diff__line tp-diff__line--${h.kind}`}>
            {h.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
})

/**
 * Detects a unified diff inside tool output so an edit shows as a diff instead of a
 * JSON blob. Anything else renders as a plain terminal block.
 */
export function ToolOutputBlock({ text }: { text: string }) {
  if (looksLikePatch(text)) return <DiffBlock patch={text} />
  return <pre className="tp-term">{text}</pre>
}

export { renderMarkdown, parseUnifiedDiff, diffStats, looksLikePatch } from './markdown.ts'
