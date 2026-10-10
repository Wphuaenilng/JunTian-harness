import { useT } from '@tianshu/locale'

export interface ContextPanelProps {
  /** `SessionModel.state.snapshots`: last-wins per event type, keyed by type. */
  snapshots: Readonly<Record<string, Record<string, unknown>>>
}

const str = (d: Record<string, unknown>, k: string): string => (typeof d[k] === 'string' ? d[k] as string : '')
const num = (d: Record<string, unknown>, k: string): number | null => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? d[k] as number : null)
/** kfmt mirrors the cockpit readout's own compactness rule, not a new policy. */
const kfmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/**
 * Snapshots the panel renders with meaning. Anything in `state`/`custom` that is **not**
 * in this set still gets shown — raw, in the last section — because a snapshot nobody
 * renders is a session fact the user cannot see. `todo_state` and friends will land
 * there before they land here, and that is the intended degradation.
 */
const TYPED = new Set([
  'context_budget', 'phase', 'status', 'done',
  'queue_pending', 'queue_status', 'goal_state', 'domain_usage', 'landing', 'hook_result',
])

/**
 * The runtime-state surface for the open session: the context budget the kernel last
 * sampled, its phase, queue lanes, goal, domain accounting and change landing.
 *
 * Everything here comes from the event timeline the client already folds
 * (`SessionModel.snapshots`) — no second poll, no extra endpoint, so it can disagree
 * with the cockpit strip but never invent a number.
 */
export function ContextPanel({ snapshots }: ContextPanelProps) {
  const t = useT()
  const keys = Object.keys(snapshots).sort()
  if (keys.length === 0) return <div className="ucx"><p className="ucx__empty">{t('ctx.empty')}</p></div>

  const budget = snapshots.context_budget
  const other = keys.filter((k) => !TYPED.has(k))
  const rows: Array<{ label: string; value: string }> = []

  if (budget) {
    const used = num(budget, 'inputTokens') ?? 0
    rows.push(
      { label: t('ctx.model'), value: str(budget, 'model') },
      { label: t('ctx.source'), value: str(budget, 'source') === 'measured' ? t('ctx.sourceMeasured') : t('ctx.sourceEstimate') },
      { label: t('ctx.state'), value: str(budget, 'state') },
      { label: t('ctx.input'), value: t('ctx.tokens', { n: kfmt(used) }) },
      { label: t('ctx.tool'), value: t('ctx.tokens', { n: kfmt(num(budget, 'toolTokens') ?? 0) }) },
      { label: t('ctx.reasoning'), value: t('ctx.tokens', { n: kfmt(num(budget, 'reasoningTokens') ?? 0) }) },
      { label: t('ctx.image'), value: t('ctx.tokens', { n: kfmt(num(budget, 'imageTokens') ?? 0) }) },
      { label: t('ctx.outputReserve'), value: t('ctx.tokens', { n: kfmt(num(budget, 'outputReserve') ?? 0) }) },
      { label: t('ctx.safetyMargin'), value: t('ctx.tokens', { n: kfmt(num(budget, 'safetyMargin') ?? 0) }) },
    )
    const bodyBytes = num(budget, 'bodyBytes')
    if (bodyBytes !== null) rows.push({ label: t('ctx.bodyBytes'), value: kfmt(bodyBytes) })
  }

  const phase = snapshots.phase
  const restore = phase?.historyRestore as Record<string, unknown> | undefined
  const restored = restore !== undefined ? num(restore, 'restored') : null
  const pending = snapshots.queue_pending
  const laneStatus = snapshots.queue_status

  return (
    <div className="ucx">
      <div className="ucx__head">
        <h4>{t('ctx.title')}</h4>
        {budget !== undefined && num(budget, 'sampledAt') !== null && (
          <span className="ucx__rev">
            {t('ctx.revision', { rev: num(budget, 'revision') ?? 0, time: new Date(num(budget, 'sampledAt')!).toLocaleTimeString() })}
          </span>
        )}
      </div>

      {budget && (() => {
        const used = num(budget, 'inputTokens') ?? 0
        const cap = num(budget, 'inputBudget') || 1
        const pct = Math.min(100, Math.round((used / cap) * 100))
        return (
          <section className="ucx__block">
            <h5 className="ucx__sub">{t('ctx.budget')}</h5>
            <div className="ucx__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <p className="ucx__line">
              {t('ctx.used', {
                used: kfmt(used),
                budget: kfmt(num(budget, 'inputBudget') ?? 0),
                window: kfmt(num(budget, 'windowTokens') ?? 0),
              })}
            </p>
            <dl className="ucx__grid">
              {rows.map((r) => (
                <div key={r.label} className="ucx__kv">
                  <dt>{r.label}</dt><dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )
      })()}

      {phase && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.phase')}</h5>
          <p className="ucx__phase">{str(phase, 'phase') || JSON.stringify(phase)}</p>
          {restored !== null && <p className="ucx__line">{t('ctx.restored', { n: restored })}</p>}
        </section>
      )}

      {(snapshots.status || snapshots.done) && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.lifecycle')}</h5>
          <p className="ucx__line">
            {[snapshots.status ? `status:${str(snapshots.status, 'status')}` : '', snapshots.done ? `done:${str(snapshots.done, 'status')}` : '']
              .filter(Boolean).join(' · ')}
          </p>
        </section>
      )}

      {(pending || laneStatus) && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.queue')}</h5>
          {pending && (
            <p className="ucx__line">
              <code>{t('ctx.lane', { id: str(pending, 'laneId') })}</code> {str(pending, 'text')}
            </p>
          )}
          {laneStatus && <p className="ucx__line"><code>{str(laneStatus, 'laneId')}</code> → {str(laneStatus, 'status')}</p>}
        </section>
      )}

      {snapshots.goal_state && str(snapshots.goal_state, 'goal') !== '' && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.goal')}</h5>
          <p className="ucx__phase">{str(snapshots.goal_state, 'goal')}</p>
          <p className="ucx__line">
            {t('ctx.goalIteration', {
              i: num(snapshots.goal_state, 'iteration') ?? 0,
              max: num(snapshots.goal_state, 'maxIterations') ?? 0,
              status: str(snapshots.goal_state, 'status'),
            })}
          </p>
        </section>
      )}

      {snapshots.domain_usage && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.domainUsage')}</h5>
          <p className="ucx__line"><code>{str(snapshots.domain_usage, 'key')}</code></p>
        </section>
      )}

      {snapshots.landing && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.landing')}</h5>
          <p className="ucx__line">
            <code>{t('ctx.landingSha', { action: str(snapshots.landing, 'action'), sha: str(snapshots.landing, 'sha').slice(0, 8) })}</code>
          </p>
        </section>
      )}

      {snapshots.hook_result && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.hook')}</h5>
          <p className="ucx__line">
            {t('ctx.hookLine', {
              event: str(snapshots.hook_result, 'event'),
              turn: num(snapshots.hook_result, 'turn') ?? 0,
              n: Array.isArray(snapshots.hook_result.results) ? (snapshots.hook_result.results as unknown[]).length : 0,
            })}
          </p>
        </section>
      )}

      {other.length > 0 && (
        <details className="ucx__other" open>
          <summary>{t('ctx.other')} ({other.length})</summary>
          <p className="ucx__hint">{t('ctx.noSilentDrop')}</p>
          {other.map((k) => (
            <pre key={k} className="ucx__raw"><code>{k}</code>{' '}{JSON.stringify(snapshots[k])}</pre>
          ))}
        </details>
      )}
    </div>
  )
}
