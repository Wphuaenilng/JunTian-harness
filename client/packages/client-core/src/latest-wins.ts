/**
 * `createLatestGate` — last-write-wins for reads that may land out of order.
 *
 * The reason it exists is the sidebar search: the effect debounces 250ms, and clearing the box
 * takes the `if (!q)` branch, which nulls the hits and stops the timer — but a request that already
 * left for the *abandoned* query keeps running and, when it lands, writes hits + metadata back. With
 * an empty search box. The debounce removes most of the window; it cannot remove this one, because
 * the cancel path only clears the timer, never the in-flight request.
 *
 * The kernel is single-threaded and answers in request order, so two live queries rarely invert.
 * What actually happens is the abandoned-query case above and, generally, any "state landed after
 * the thing that asked for it stopped caring" shape. A token is the cheap fix: whoever is writing
 * state says which request they belong to, and the gate answers whether that request is still the
 * newest one.
 *
 * Not a cancellation: the request still runs to completion (the sidecar finishes the disk scan
 * either way). This only decides whether the result may touch state.
 */
export interface LatestGate {
  /** Claim "this is the newest request" and return the token to hand back on landing. */
  begin(): number
  /** May a landing carrying `token` write state? Only if nothing newer began since. */
  isCurrent(token: number): boolean
  /** Nothing is in flight any more (the box was cleared): invalidate every outstanding token. */
  invalidate(): void
}

export function createLatestGate(): LatestGate {
  let seq = 0
  return {
    begin: (): number => { seq += 1; return seq },
    isCurrent: (token: number): boolean => token === seq,
    invalidate: (): void => { seq += 1 },
  }
}
