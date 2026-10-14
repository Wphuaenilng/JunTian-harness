import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApprovalPanel } from '@tianshu/ui-approval'
import type { ApprovalRequest, ApprovalAnswerBody } from '@tianshu/client-core'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-approval/styles.css'
import './styles.css'

/**
 * Stall-alarm probe for §5.2-5 (plan:「审批静默挂死」的对策是"挂起超时显式提醒"). The alarm had never
 * been *rendered* by any judgement — the traps gate could only say "要验就得晾着一个真闸不放", which is
 * an upstream-call cost, not a rendering cost.
 *
 * This page mounts the product `<ApprovalPanel>` twice over the same fixture and changes only the
 * threshold prop:
 *  - `probe-stalled` gets `stallAfterMs = 1`, so the panel's own 1-second ticker turns it loud;
 *  - `probe-quiet` gets a threshold no wait can reach, so it must stay quiet.
 * Same code path, same CSS, same locale string — what is *not* proven here is that a real gate ever
 * sat unanswered for 30 seconds. That half still needs a live run.
 */
const APPROVALS: readonly ApprovalRequest[] = [
  {
    requestId: 'req-probe-write',
    toolName: 'write_file',
    input: { path: '.probe/notes.md', content: '# 探针\n只用来让报警样式被真的画出来一次。' },
    pathGrant: { dir: '.probe', mode: 'write' },
  },
]

const answers: Array<[string, ApprovalAnswerBody]> = []
const onAnswer = (requestId: string, answer: ApprovalAnswerBody): void => {
  answers.push([requestId, answer])
}

// The click probe reads these back from `window.__stallProbe__` — the pixel gate asserts the two
// panels actually differ, not that some element with a scary class exists somewhere.
;(window as unknown as { __stallProbe__: unknown }).__stallProbe__ = {
  stalledId: 'probe-stalled',
  quietId: 'probe-quiet',
  answers,
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <section id="probe-stalled" className="probe-col">
      <ApprovalPanel approvals={APPROVALS} onAnswer={onAnswer} stallAfterMs={1} />
    </section>
    <section id="probe-quiet" className="probe-col">
      <ApprovalPanel
        approvals={APPROVALS.map((a) => ({ ...a, requestId: 'req-probe-quiet' }))}
        onAnswer={onAnswer}
        stallAfterMs={60 * 60 * 1000}
      />
    </section>
  </StrictMode>,
)
