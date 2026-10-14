/**
 * View state (plan §4.3 #4).
 *
 * What belongs here: which session is open, sidebar/right-panel collapse, theme,
 * composer draft, connection status shown in the status bar. What does NOT: message
 * timelines, approvals, tool results — those are business data owned by
 * `@tianshu/client-core`'s SessionModel and subscribed to per component.
 *
 * The boundary matters because a streaming run emits deltas far faster than a human
 * reads; if deltas went through a global store every panel would re-render on each one.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { immer } from 'zustand/middleware/immer'

// Persistence lives in its own module (and is type-only back from there), so the whitelist
// of what may leave the app is reviewable — and testable — without a DOM.
export { loadView, saveView, subsetOf, attachViewPersistence, PERSISTED_FIELDS, STORAGE_KEY, type KeyedStore, type SubscribableView } from './persist.ts'

export type PanelSide = 'right'

/** The 折叠组右栏 of the 定稿 layout: one column, tab-switched content. */
export type RightTab = 'settings' | 'context' | 'checkpoints' | 'git' | 'automations' | 'files'

export interface ViewState {
  openSessionId: string | null
  /** Which sessions the sidebar is showing (archived included = a filter, not a reload). */
  includeArchived: boolean
  panels: Record<PanelSide, boolean>
  rightTab: RightTab
  /** Composer text survives switching sessions — losing a half-typed prompt is a bug users report first. */
  drafts: Record<string, string>
  connection: 'idle' | 'connecting' | 'replay' | 'live' | 'down'
  generation: number
  lastSeq: number
}

export type ViewStore = StoreApi<ViewState>

const initial: ViewState = {
  openSessionId: null,
  includeArchived: false,
  panels: { right: true },
  rightTab: 'settings',
  drafts: {},
  connection: 'idle',
  generation: 0,
  lastSeq: 0,
}

export function createViewStore(override?: Partial<ViewState>): ViewStore {
  return createStore<ViewState>()(immer((set) => ({ ...initial, ...override, panels: { ...initial.panels, ...override?.panels } })))
}

export function setDraft(store: ViewStore, sessionId: string, text: string): void {
  store.setState((s) => ({ drafts: { ...s.drafts, [sessionId]: text } }))
}

/**
 * 计划 §4.3 #3 要「通知三档节拍（立即／微任务／rAF）」。这里只拥有其中**两档**，第三档不归本模块：
 *
 * 1. **立即** = `store.setState` 本身——zustand 同步通知订阅者，所以点一下就要有反应的东西
 *    （主题、面板开合、输入框草稿）直接走这条路，测试 `store.test.ts` 钉的是"订阅者在下一句话之前
 *    就已经被叫过"。
 * 2. **rAF** = 下面这个 `createFrameScheduler`——把一帧内的几十条 delta 合成一次重绘。
 * 3. **微任务** = **React 18 自己的自动批处理**，不是我们另写的一档。全仓 `queueMicrotask` 零命中
 *    是有意的：在 `createRoot` 下再手写一层微任务队列，只会和渲染器的批处理抢时序。
 *
 * rAF 不能是唯一触发器：隐藏／后台标签永远不发 rAF（在本机内置浏览器里实测过——一个只靠 rAF 合帧的
 * 状态计数器会一直停在 0）。所以每次都跟一个 `starveMs` 超时赛跑，更新不会丢，只是没人看着的时候
 * 最多晚到 `starveMs`。
 */
export function createFrameScheduler(fn: () => void, starveMs = 120): () => void {
  let queued = false
  return () => {
    if (queued) return
    queued = true
    let timer: ReturnType<typeof setTimeout>
    const flush = (): void => {
      queued = false
      clearTimeout(timer)
      fn()
    }
    timer = setTimeout(flush, starveMs)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
  }
}
