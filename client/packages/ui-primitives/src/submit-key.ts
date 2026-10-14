/**
 * `submitsOnEnter` — the one home of the composer's "Enter sends" rule.
 *
 * Why a function instead of an inline `key === 'Enter'`: `apps/web/src/App.tsx`'s textarea used to
 * send on `key === 'Enter' && !shiftKey` alone. For the input method this product's primary audience
 * uses, that is a defect — while a CJK IME is composing, Enter **commits the candidate word**, and
 * the engine fires the same `keydown` (`key: 'Enter'`, `shiftKey: false`) with `isComposing: true`.
 * Without that flag in the test, the first Enter of a Chinese sentence shipped the half-written
 * buffer as a prompt: the message went out mid-word, and with a provider key attached it also spent
 * a turn. Found 2026-10-13 by reading the handler — no composition guard existed anywhere in the tree.
 *
 * **Why the caller must hand over `isComposing` explicitly.** React's synthetic keyboard event does
 * *not* carry it: `@types/react@18.3.31`'s `KeyboardEvent` interface (index.d.ts:2273) lists altKey,
 * code, getModifierState, key, locale, location, metaKey, repeat, shiftKey — no `isComposing` — and
 * react-dom builds the synthetic event from exactly that interface. Measured in the built page: a
 * composing Enter dispatched at a real React `<textarea>` reads `nativeEvent.isComposing === true`
 * while the synthetic `e.isComposing` is `undefined`. So writing `submitsOnEnter(e)` against a React
 * event would compile-fail here by design (missing required property) rather than silently send —
 * which is the failure mode this fix itself hit on the way in.
 *
 * Deliberately NOT implemented: the legacy `keyCode === 229` fallback (older WebKit left
 * `isComposing` unset). Both engines this client ships — system Edge/Chromium for the browser build,
 * Electron's Chromium for the desktop shell — set it. If a target that doesn't is ever added, this
 * function is the single place to change; `check:layers` pins every Enter-submitting site to it.
 */
export interface SubmitKey {
  /** `KeyboardEvent.key` — `'Enter'` for both the send and the IME commit. */
  readonly key: string
  /** Shift+Enter is a newline, not a send. */
  readonly shiftKey: boolean
  /**
   * The composition flag **from the native event** (`e.nativeEvent.isComposing` for React).
   * Required, not optional: an absent flag is indistinguishable from "not composing", and that is
   * exactly how a React call site would re-introduce the bug.
   */
  readonly isComposing: boolean
}

/** A deliberate Enter press: not a newline, not a candidate-word commit. */
export function submitsOnEnter(e: SubmitKey): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing
}
