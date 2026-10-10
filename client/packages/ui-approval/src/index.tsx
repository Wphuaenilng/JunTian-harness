import { useEffect, useRef, useState } from 'react'
import { useT } from '@tianshu/locale'
import type { ApprovalRequest, ApprovalAnswerBody } from '@tianshu/client-core'
import { APPROVAL_CHOICES, answerFor } from './answer.ts'
import { describeWait, syncArrivals } from './wait.ts'

// Wait/threshold arithmetic lives in wait.ts so the 30-second reminder can be tested without
// paying for a run and leaving its gate unanswered.
export { describeWait, syncArrivals, APPROVAL_HINT_AFTER_MS } from './wait.ts'

// The decision map lives in a JSX-free module so node:test can pin what leaves the panel.
export { APPROVAL_CHOICES, answerFor, type ApprovalChoice } from './answer.ts'

export interface ApprovalPanelProps {
  approvals: readonly ApprovalRequest[]
  onAnswer: (requestId: string, answer: ApprovalAnswerBody) => void
  /** OpenCode #16367 lesson: a pending approval that is not visible is a hung session. */
  stallAfterMs?: number
}

/**
 * Three states (plan §2.3, Cline/Roo): allow once, always allow (the sidecar's
 * `remember` flag — approval-routes.ts:20 passes it straight to the runtime), deny.
 * A pending approval turns loud after `stallAfterMs` instead of waiting quietly.
 */
export function ApprovalPanel({ approvals, onAnswer, stallAfterMs = 30_000 }: ApprovalPanelProps) {
  const t = useT()
  const arrivedAt = useRef(new Map<string, number>())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    syncArrivals(arrivedAt.current, approvals.map((a) => a.requestId), Date.now())
  }, [approvals])

  useEffect(() => {
    if (approvals.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [approvals.length])

  if (approvals.length === 0) return null

  return (
    <div className="ua">
      {approvals.map((a) => {
        const waited = now - (arrivedAt.current.get(a.requestId) ?? now)
        const { hintSeconds, stallSeconds } = describeWait(waited, stallAfterMs)
        const stalled = stallSeconds !== null
        const seconds = stallSeconds ?? hintSeconds ?? 0
        return (
          <section key={a.requestId} className={`ua__card${stalled ? ' ua__card--stalled' : ''}`}>
            <h4 className="ua__title">
              {t('approval.title', { tool: a.toolName })}
              {a.pathGrant && <span className="ua__grant">{a.pathGrant.mode} {a.pathGrant.dir}</span>}
            </h4>
            <pre className="ua__input">{stringifyInput(a.input, t('approval.truncated'))}</pre>
            {stalled && <p className="ua__warn">{t('approval.stalled', { seconds })}</p>}
            {hintSeconds !== null && <p className="ua__hint">{t('approval.waited', { seconds })}</p>}
            <div className="ua__actions">
              {APPROVAL_CHOICES.map(({ choice, labelKey, extraClass }) => (
                <button
                  key={choice}
                  className={`ua__btn${extraClass}`}
                  onClick={() => onAnswer(a.requestId, answerFor(choice))}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** The truncated-tail note is passed in so this stays a pure, testable function. */
export function stringifyInput(input: Record<string, unknown>, truncatedNote: string): string {
  try {
    const s = JSON.stringify(input, null, 2)
    return s.length > 2000 ? `${s.slice(0, 2000)}\n${truncatedNote}` : s
  } catch {
    return String(input)
  }
}
