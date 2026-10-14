import { createRoot } from 'react-dom/client'
import { CheckpointPanel, GitPanel } from '@tianshu/ui-git'
import type { RewindPoint, SidecarClient, WorkbenchSnapshot } from '@tianshu/client-core'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-git/styles.css'
import './styles.css'

/**
 * Git 工作台探针页（第九个 vite 输入，没有任何链接指向它）。
 *
 * 量两件事，都是源码级判据量不到的：
 *  1. **挂载之后读数请求会不会自己转起来。** `scope` 曾经是渲染期新建的对象字面量
 *     （`cwd ? { cwd } : …`），它进了 `reload` 的依赖、`reload` 又进了 `useEffect` 的依赖，
 *     于是每次渲染都重新读一次，而读回本身又 `setState` → 再渲染。这一格用"两次采样之间
 *     请求数还在不在涨"来判，涨就是循环——不数锚点数，数**外部可观察量**（请求次数）。
 *  2. **换文件时迟到的 diff 会不会盖掉当前那个。** stub 让 `slow.txt` 的回包晚 260ms 落地，
 *     页面按"先点慢的、再点快的"的顺序点，屏上留下的必须是快的那个；留下慢的就是
 *     "用户看到的内容不是他选中的文件"。
 *
 * 这里的 `api` 是一个只实现被这几个面板真用到的那几个方法的桩对象，按 `SidecarClient`
 * 的形状断言过去（面板的 props 要的是整个 client；桩不需要 61 个方法都在）。所以这一格量的是
 * **组件的取数时序**，不是 sidecar 的 git 语义——那部分由 `accept-gitwrite.ts` 在真 bare 仓上量。
 */
type Counts = { snapshot: number; history: number; branches: number; diff: number; points: number; rewinds: number }
const counts: Counts = { snapshot: 0, history: 0, branches: 0, diff: 0, points: 0, rewinds: 0 }
const seenPaths: string[] = []
/** 真发出去的回卷请求（面板把 `pending` 收掉之后才会调它）；门点一次确认应当恰好有一发。 */
const sentRewinds: string[] = []

/**
 * 检查点时间轴的夹具。**顺序故意打乱**（index 2、3、1）：最新那一格必须由组件自己算，
 * 不是"数组最后一个"；空 `content` 那一条用来钉"没标题时不许渲染成空白"。
 */
const POINTS: readonly RewindPoint[] = [
  { index: 2, seq: 41, content: '第二份：' + '一段会超出右栏宽度的中文检查点标题'.repeat(4), timestamp: Date.UTC(2026, 9, 13, 5, 30), },
  { index: 3, seq: 57, content: '', timestamp: Date.UTC(2026, 9, 13, 6, 10) },
  { index: 1, seq: 12, content: '最早的一份检查点', timestamp: Date.UTC(2026, 9, 13, 4, 5) },
]

const SNAPSHOT: WorkbenchSnapshot = {
  repository: {
    id: 'repo-probe', cwd: '/probe/repo', commonDir: '/probe/repo/.git',
    branch: 'main', head: '0'.repeat(40), upstream: 'origin/main',
    ahead: 0, behind: 0, version: 'v-probe-1', state: 'clean',
    remotes: [{ name: 'origin', url: 'https://example.invalid/probe.git' }],
  },
  changes: [
    { path: 'slow.txt', index: ' ', worktree: 'M', conflict: false },
    { path: 'fast.txt', index: ' ', worktree: 'M', conflict: false },
  ],
}

const sleep = (ms: number): Promise<void> => new Promise((res) => { setTimeout(res, ms) })

const stub = {
  workbenchSnapshot: async (): Promise<WorkbenchSnapshot> => { counts.snapshot += 1; return SNAPSHOT },
  workbenchHistory: async (): Promise<{ commits: readonly unknown[], hasMore: boolean }> => {
    counts.history += 1
    return { commits: [], hasMore: false }
  },
  workbenchBranches: async (): Promise<{ branches: readonly unknown[], worktrees: string }> => {
    counts.branches += 1
    return { branches: [], worktrees: '' }
  },
  workbenchDiff: async (_scope: unknown, path: string): Promise<{ diff: string }> => {
    counts.diff += 1
    seenPaths.push(path)
    // 慢的那个先点、后落地；快的那个后点、先落地——落地顺序与点击顺序相反，正是竞态的形状。
    if (path === 'slow.txt') await sleep(260)
    return { diff: `diff --git a/${path} b/${path}\n+内容来自 ${path}\n` }
  },
  rewindPoints: async (): Promise<readonly RewindPoint[]> => { counts.points += 1; return POINTS },
  rewind: async (_sessionId: string, index: number, files: boolean): Promise<unknown> => {
    counts.rewinds += 1
    sentRewinds.push(index + ':' + (files ? 'files' : 'turn-only'))
    return { ok: true }
  },
  close: (): void => undefined,
} as unknown as SidecarClient

function GitProbe() {
  return (
    <main className="app" data-probe="git">
      <h1>Git 工作台探针 · 取数时序与迟到落地</h1>
      <div id="probe-panel" className="app__rail-group">
        <GitPanel api={stub} sessionId="probe-session" cwd="/probe/repo" />
      </div>
      {/* 第二面：检查点时间轴。宿主把它挂在右栏另一组里（`g.id === 'checkpoints'`），
          而所有验法都不点那一组，所以 `ckp*` 这一族 CSS 此前从没在任何浏览器里被渲染过。 */}
      <div id="probe-checkpoints" className="app__rail-group">
        <CheckpointPanel api={stub} sessionId="probe-session" onRewound={() => undefined} />
      </div>
    </main>
  )
}

;(window as unknown as { __gitProbe__: { counts: Counts, seenPaths: string[], sentRewinds: string[] } }).__gitProbe__ = { counts, seenPaths, sentRewinds }

createRoot(document.getElementById('root') as HTMLElement).render(<GitProbe />)
