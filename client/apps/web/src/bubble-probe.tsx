import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatStream, blockRenderCount } from '@tianshu/ui-chat'
import type { Block } from '@tianshu/client-core'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-chat/styles.css'
import './styles.css'

/**
 * Render probe for the message bubbles. The drawing's `.ububble` (the user's own message) can only
 * be measured on a page that has one, and the product page has no messages without a run — which
 * costs an upstream call. So this entry feeds the *real* `<ChatStream>` a fixture block list and
 * lets a headless browser read what actually comes out: bubble radius, borders, and where the row
 * aligns. Same standard as `ctx-probe.html` (component + render path are the product's; only the
 * data is a fixture). Nothing here reads tokens, endpoints or disk.
 *
 * The second root is the render face of the same component: it streams 25 deltas into a timeline
 * that already holds 60 sealed blocks and reports how many `BlockView` bodies ran. `<ChatStream>`
 * claims its per-block `memo()` short-circuits untouched blocks — that is a claim about a count,
 * so it is measured as one.
 */
const BLOCKS: readonly Block[] = [
  { kind: 'user', id: 1, text: '修复登录页样式回归：提交后停在 loading' },
  { kind: 'text', id: 2, text: '我先复现一次，再定位到样式文件。', open: false },
  // 三处**左边线**（`.uc__think` / `.uc__intent` / `.tp-md blockquote`）此前在任何被采样的页面上都不存在：
  // 无 key 会话不会发 thinking_delta，也不会有带着补丁回来的工具调用，而引用块要真有一段 `>` 文本。
  // 登记它们之前先按老规矩问一句"这一用法有没有可达状态"——有，那就用真组件把现场造出来，而不是留在
  // 报告项里说"只有 CSS 那一眼"。三条都走产品自己的渲染分支（thinking / tool-open / MarkdownBlock）。
  { kind: 'thinking', id: 3, text: '先确认是谁在等：提交后没有 turn_complete，所以按钮的 pending 没被清。', open: true },
  { kind: 'text', id: 4, text: '复现要点：\n\n> 提交后停在 loading，说明那条 promise 从没 resolve。\n\n上面这行引用是 `.tp-md blockquote` 的现场。', open: false },
  { kind: 'tool', id: 5, name: 'edit_file', input: { path: 'apps/web/src/submit.ts', new_string: 'setPending(false)' }, isError: false, open: true },
]

const SEALED: Block[] = Array.from({ length: 60 }, (_, i) => ({
  kind: 'text',
  id: 1000 + i,
  text: `已经封口的一段，第 ${i} 块。`,
  open: false,
}))
const FRAMES = 25
const OPEN_ID = 2000

function StreamProbe() {
  const [frame, setFrame] = useState(0)
  const reported = useRef(false)
  useEffect(() => {
    if (frame === 0) {
      blockRenderCount.renders = 0
      setFrame(1)
      return
    }
    if (frame > FRAMES) {
      if (reported.current) return
      reported.current = true
      const root = document.getElementById('stream-probe')
      const out = document.getElementById('stream-result')
      if (root && out) {
        out.dataset['frames'] = String(FRAMES)
        out.dataset['sealed'] = String(SEALED.length)
        out.dataset['renders'] = String(blockRenderCount.renders)
        out.dataset['rows'] = String(root.querySelectorAll('.uc__row').length)
        out.dataset['done'] = '1'
      }
      return
    }
    const id = window.setTimeout(() => setFrame((n) => n + 1), 0)
    return () => window.clearTimeout(id)
  }, [frame])
  const open: Block = { kind: 'text', id: OPEN_ID, text: `正在流入 ${'·'.repeat(frame)}`, open: true }
  return <ChatStream blocks={[...SEALED, open]} running={false} theme="dark" />
}

const host = document.getElementById('root')
if (host) {
  createRoot(host).render(
    <StrictMode>
      <ChatStream blocks={BLOCKS} running={false} theme="dark" />
    </StrictMode>,
  )
}

const streamHost = document.getElementById('stream-probe')
if (streamHost) {
  createRoot(streamHost).render(
    <StrictMode>
      <StreamProbe />
    </StrictMode>,
  )
}
