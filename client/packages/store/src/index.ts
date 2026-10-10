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
 * Three notification cadences (plan §4.3 #3): immediate for anything that must feel
 * instant, microtask for cheap derived updates, and this one — coalesce everything
 * above it into a single repaint per frame.
 *
 * rAF is the coalescer but cannot be the only trigger: a hidden/background tab never
 * fires it (verified in this project's own in-app browser, where a status counter
 * batched on rAF alone stayed at zero forever). The timeout races it so an update is
 * never lost — it just arrives up to `starveMs` late when nobody is looking.
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
