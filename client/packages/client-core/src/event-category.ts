/**
 * 56 sidecar event types → 5 AG-UI-aligned categories (plan §3, §4.3 #5).
 *
 * The UI only ever subscribes by category, so a new sidecar event costs one line
 * here instead of a change in every component. `EVENT_CATEGORY` is exhaustive over
 * the generated union, which means regenerating the protocol mirror with an
 * uncategorized event fails typecheck — deliberate: categorize on purpose, never
 * by accident. `categorize()` stays tolerant for events that arrive from an older
 * or newer runtime over the wire, where ignoring is the correct behavior.
 */
import type { SessionEventType } from './protocol-types.ts'

export type EventCategory = 'lifecycle' | 'text' | 'tool' | 'state' | 'custom'

export const EVENT_CATEGORY: Record<SessionEventType, EventCategory> = {
  // lifecycle — run/turn gates, connection bookkeeping, and anything that needs a
  // visible human decision. Approval hangs are the OpenCode #16367 class of bug,
  // so approval_* belong here: this is the category the UI arms a timeout watch on.
  phase: 'lifecycle',
  done: 'lifecycle',
  status: 'lifecycle',
  error: 'lifecycle',
  turn_complete: 'lifecycle',
  approval_required: 'lifecycle',
  approval_resolved: 'lifecycle',
  approval_snapshot: 'lifecycle',
  retry: 'lifecycle',
  watchdog_recovery: 'lifecycle',
  resume_offer: 'lifecycle',
  recovery_status: 'lifecycle',
  unattended_halt: 'lifecycle',
  autonomy_checkpoint: 'lifecycle',
  landing: 'lifecycle',
  handoff_archived: 'lifecycle',
  replay_window: 'lifecycle',

  // text — model output stream, including reasoning and the user's own echo.
  text_delta: 'text',
  thinking_delta: 'text',
  user: 'text',
  intent_note: 'text',

  // tool — calls, results, side artifacts, background jobs, delegated landing.
  tool_use: 'tool',
  tool_result: 'tool',
  artifact: 'tool',
  tool_delegate: 'tool',
  delegation: 'tool',
  delegation_snapshot: 'tool',
  job: 'tool',
  job_snapshot: 'tool',
  hook_result: 'tool',

  // state — structured session state the UI renders as panels/counters, plus
  // timeline mutations (checkpoint/rewind/fork) that move the conversation back.
  todo_state: 'state',
  context_budget: 'state',
  plan_mode: 'state',
  plan_submitted: 'state',
  plan_draft: 'state',
  plan_auto_approve_pending: 'state',
  plan_auto_approve_cancelled: 'state',
  ask_mode: 'state',
  steer_queued: 'state',
  steer_delivered: 'state',
  queue_pending: 'state',
  queue_status: 'state',
  goal_state: 'state',
  goal_rollover: 'state',
  decision_shift: 'state',
  checkpoint: 'state',
  rewind: 'state',
  fork: 'state',

  // custom — Tianshu-specific surfaces (star domains, zen mode, per-session pickers,
  // ask-the-user cards) with no AG-UI equivalent.
  zen_phase: 'custom',
  model_switched: 'custom',
  domain_changed: 'custom',
  domain_resolved: 'custom',
  domain_usage: 'custom',
  domain_drift: 'custom',
  skills_changed: 'custom',
  user_question: 'custom',
}

export function categorize(type: string): EventCategory {
  return EVENT_CATEGORY[type as SessionEventType] ?? 'custom'
}
