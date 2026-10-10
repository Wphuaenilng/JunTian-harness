/**
 * Request-body shapes.
 *
 * These are NOT in the contract leaf (`src/server/protocol.ts` covers event and
 * record shapes only), so they are transcribed from the routes that validate them —
 * each field below is checked at the cited line. Keep this file honest against the
 * routes, not against the VS Code extension's copy of the same shapes.
 */
import type { ApprovalMode, AskModeState, PlanModeState } from './protocol-types.ts'

/** POST /sessions — validated at src/server/session-routes.ts:359-375. */
export interface CreateSessionRequest {
  /** Absent → the sidecar's own default workspace; `workspaceSource` on the record says who decided. */
  cwd?: string
  title?: string
  prompt?: string
  missionId?: string
  approvalMode?: ApprovalMode
  model?: string
  domain?: string
  /** 'explicit' | 'default' | 'scratch' (session-routes.ts:361 rejects anything else). */
  workspaceMode?: 'explicit' | 'default' | 'scratch'
  isolatedWorktree?: boolean
  /** 'off' | 'low' | 'medium' | 'high' | 'max' | 'auto' (session-routes.ts:365). */
  reasoningEffort?: string
  planMode?: PlanModeState
  askMode?: AskModeState
  /** Fail-closed gate on countdown auto-approve: no visible UI → no silent approval (protocol.ts:349). */
  planAutoApproveUi?: boolean
  images?: string[]
}

/** POST /sessions/:id/prompt — validated at src/server/session-routes.ts:970-972. */
export interface PromptRequest {
  /** Must be non-empty after trim, else 400. */
  prompt: string
  images?: string[]
  requestId?: string
}

/**
 * POST /sessions/:id/interventions/:requestId/answer — src/server/approval-routes.ts:17-20.
 * `decision` defaults to 'approve' server-side when absent; `remember === true` is the
 * exact condition for the "always allow" third state (plan §2.3, Cline/Roo).
 */
export interface ApprovalAnswerBody {
  decision?: 'approve' | 'deny'
  editedInput?: Record<string, unknown>
  remember?: boolean
}

/** POST /sessions/:id/queue — busy-lane follow-up (echoes back as queue_pending). */
export interface QueueRequest {
  text: string
}
