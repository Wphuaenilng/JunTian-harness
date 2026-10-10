import type { ApprovalAnswerBody } from '@tianshu/client-core'
import type { LocaleKey } from '@tianshu/locale'

/** The three gates the plan's §2.3 (Cline/Roo once / always / reject) puts on screen. */
export type ApprovalChoice = 'once' | 'always' | 'deny'

/**
 * The single place a button becomes wire payload. Worth extracting rather than leaving the
 * object literals inline: `approval-routes.ts:16-21` defaults `decision` to 'approve' and
 * tests `remember === true` strictly, so a stray `remember: false` is fine but a missing
 * `decision` on a denial silently turns 拒绝 into an approval. That is not visible in the
 * panel, only in what leaves it — and a JSX file is outside node:test's reach here.
 */
export function answerFor(choice: ApprovalChoice): ApprovalAnswerBody {
  switch (choice) {
    case 'once':
      return { decision: 'approve' }
    case 'always':
      return { decision: 'approve', remember: true }
    case 'deny':
      return { decision: 'deny' }
  }
}

/** Render order matters (primary action first), so it is declared once, with its styling. */
export const APPROVAL_CHOICES: ReadonlyArray<{ choice: ApprovalChoice; labelKey: LocaleKey; extraClass: string }> = [
  { choice: 'once', labelKey: 'approval.allowOnce', extraClass: ' ua__btn--primary' },
  { choice: 'always', labelKey: 'approval.allowAlways', extraClass: '' },
  { choice: 'deny', labelKey: 'approval.deny', extraClass: ' ua__btn--deny' },
]
