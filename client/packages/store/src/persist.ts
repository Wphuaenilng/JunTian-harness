/**
 * Persistence for view state — the 「持久化」 cell of plan §4.2's `store` row, which the
 * package previously did not implement (only theme and locale stored anything).
 *
 * What is written is deliberately a whitelist, not "the state minus a few": layout the user
 * chose (which session is open, which right-panel tab, archive filter, panel collapse).
 * Two things are kept OUT on purpose:
 *  - `drafts` — a composer half-typed may contain a credential, a customer path, anything;
 *    writing it to localStorage for the life of the profile is a different risk class from
 *    keeping it in memory for the session, and the plan does not ask for it.
 *  - `connection` / `generation` / `lastSeq` — mirrors of the transport. Restoring those
 *    would make the status bar lie about a stream that does not exist anymore.
 */
import type { PanelSide, RightTab, ViewState } from './index.ts'

const STORAGE_KEY = 'tianshu.view.v1'

const RIGHT_TABS: readonly RightTab[] = ['settings', 'context', 'checkpoints', 'git', 'automations', 'files']

/** Just enough of a Storage to be injectable: tests pass a Map-backed fake. */
export interface KeyedStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStore(): KeyedStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Safari private mode throws on touching the object itself, not just on writing.
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Invalid or absent fields simply drop out; the caller spreads this over defaults. */
export function loadView(storage: KeyedStore | null = browserStore()): Partial<ViewState> {
  if (storage === null) return {}
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null || raw.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}

  const out: Partial<ViewState> = {}
  if (typeof parsed.openSessionId === 'string' || parsed.openSessionId === null) out.openSessionId = parsed.openSessionId
  if (typeof parsed.includeArchived === 'boolean') out.includeArchived = parsed.includeArchived
  if (typeof parsed.rightTab === 'string' && (RIGHT_TABS as readonly string[]).includes(parsed.rightTab)) {
    out.rightTab = parsed.rightTab as RightTab
  }
  if (isRecord(parsed.panels) && typeof parsed.panels.right === 'boolean') {
    out.panels = { right: parsed.panels.right } as Record<PanelSide, boolean>
  }
  return out
}

export function saveView(state: ViewState, storage: KeyedStore | null = browserStore()): void {
  if (storage === null) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(subsetOf(state)))
  } catch {
    // Quota or private mode: layout persistence is a convenience, never worth a crash.
  }
}

/** The whitelisted projection, shared by save and by the change detector below. */
export function subsetOf(state: ViewState): Record<string, unknown> {
  return {
    openSessionId: state.openSessionId,
    includeArchived: state.includeArchived,
    rightTab: state.rightTab,
    panels: state.panels,
  }
}

/**
 * Subscribe-and-persist, but only when the persisted subset actually changed.
 *
 * Not a micro-optimisation: `view.setState({ lastSeq, generation })` runs on **every
 * streamed event**, and a vanilla zustand subscription fires for every setState no matter
 * which field moved. Wiring `saveView` straight to `subscribe` therefore means a
 * synchronous localStorage write per delta — hundreds of them while an archived session
 * replays. localStorage is blocking, so the cost lands on the frame budget of the very
 * path that must stay smooth.
 */
export interface SubscribableView {
  getState(): ViewState
  subscribe(listener: () => void): () => void
}

export function attachViewPersistence(store: SubscribableView, storage: KeyedStore | null = browserStore()): () => void {
  if (storage === null) return () => undefined
  let last = JSON.stringify(subsetOf(store.getState()))
  return store.subscribe(() => {
    const next = JSON.stringify(subsetOf(store.getState()))
    if (next === last) return
    last = next
    saveView(store.getState(), storage)
  })
}

/** Exposed so the test can pin "only these four keys ever leave the app". */
export const PERSISTED_FIELDS = Object.keys({
  openSessionId: null,
  includeArchived: false,
  rightTab: 'settings',
  panels: { right: true },
} satisfies Partial<ViewState>)

export { STORAGE_KEY }
