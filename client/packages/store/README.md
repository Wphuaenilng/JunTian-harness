# @tianshu/store

View state only: open session, panel collapse, composer drafts, connection status.

**Business data does not live here.** Message timelines, approvals and tool results
belong to `@tianshu/client-core`'s `SessionModel` and are subscribed per component —
a streaming run produces far more deltas than a human reads, and routing them through
a global store would repaint every panel on each one (plan §4.3 #4).

## Exports

- `createViewStore` — zustand/vanilla + immer
- `setDraft` — per-session composer text survives switching (losing a half-typed
  prompt is the first thing users report)
- `createFrameScheduler` — the rAF tier of the three notification cadences (§4.3 #3).
  It races rAF against a timeout on purpose: a hidden/background tab never fires rAF,
  and a counter batched on rAF alone can stall forever (observed in this project's own
  in-app browser during M1 verification).
- `loadView` / `saveView` — the 「持久化」 cell of §4.2, as a **whitelist**:
  `openSessionId`, `includeArchived`, `rightTab`, `panels`. Out on purpose: `drafts` (a
  half-typed prompt may hold a credential or a local path — putting that in localStorage
  for the life of the profile is a different risk class than holding it in memory, and the
  plan never asked) and `connection`/`generation`/`lastSeq` (mirrors of the transport;
  restoring them makes the status bar lie about a stream that no longer exists). Every
  field is validated on the way back in — a corrupt blob, a non-object, an unknown
  `rightTab`, `panels.right: "true"`, or storage that throws on touch (Safari private mode,
  quota) all degrade to defaults rather than breaking startup. `openSessionId: null` is a
  legitimate value, not a missing field.

## Status

Wired into `apps/web`: the view store is hydrated with `createViewStore(loadView())` and
persisted through `attachViewPersistence(view)` — **not** a bare
`view.subscribe(() => saveView(...))`. That naive form looked clean and was a real defect:
`view.setState({ lastSeq, generation })` fires on every streamed event (and `setDraft` is a
second notification on top), zustand notifies regardless of which field moved, and
localStorage is synchronous — measured with a throwaway script at **120 blocking writes for
60 stream events**. `attachViewPersistence` diffs the persisted subset first, so the same
streaming produces **0 writes** while a genuine layout change still produces exactly 1, and
`test/persist.test.ts` pins that (it fails again if the guard is removed). Verified by
reload too: archive filter, right-panel tab and the open session all come back (the Git
panel re-renders the real repository readout), and the stored blob contains exactly the
four whitelisted fields. Unit tests assert the negative too: the written bytes must not
contain `drafts`, `lastSeq`, `connection` or `generation`.

## Protocol surface consumed

None, by design. This package must not import protocol types.
