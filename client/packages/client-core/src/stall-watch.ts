/**
 * The send-stall rule, as a pure function so it can be tested without a sidecar.
 *
 * Why the client needs it: with no usable provider key the kernel answers
 * `POST /prompt` with 200 `{status:'running'}` and then emits **nothing** — its own
 * watchdog logs `[loop-stall] activities=none` and stops. A UI that only reflects the
 * session status therefore shows a healthy run forever. So the client tracks the one
 * fact it can see (did the timeline move?) and says so out loud.
 */
export interface StallWatch {
  /** seq at the moment the send was accepted. */
  seqAtSend: number
  /** how long to wait before calling it stalled */
  afterMs: number
}

/**
 * Is this send stalled? `true` only while the timeline has not advanced by even one
 * event since the accept — any movement, including our own echoed user block, clears it.
 */
export function isStalled(watch: StallWatch, seqNow: number, elapsedMs: number): boolean {
  if (elapsedMs < watch.afterMs) return false
  return seqNow <= watch.seqAtSend
}

/**
 * Whether to arm at all. A queued send (`busy`) is not a stalled run — the runtime
 * acknowledged it as a lane and its turn has not come yet, so warning there would be
 * a false alarm about input the user can already see is parked.
 */
export function shouldArmStall(accepted: 'ok' | 'busy' | 'conflict' | 'error' | 'queued' | 'lost'): boolean {
  return accepted === 'ok'
}
