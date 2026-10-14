import { useT, type LocaleKey } from '@tianshu/locale'
import { SNAP, TYPED_SNAPSHOT_KEYS, type ContextBudgetSnapshot } from '@tianshu/client-core'
import { budgetSegments, ringFor, sharePercent, usedTokens, RING_RADIUS, type BudgetSegment } from './context-geometry.ts'
import { laneIsWaiting } from './queue-lane.ts'

/** Row names come from the protocol fields, not from the drawing's 系统提示词/对话历史 labels —
 *  the snapshot never separates system prompt from history. */
const SEGMENT_LABEL: Record<BudgetSegment['key'], LocaleKey> = {
  input: 'ctx.input', tool: 'ctx.tool', reasoning: 'ctx.reasoning', image: 'ctx.image',
}

export interface ContextPanelProps {
  /** `SessionModel.state.snapshots`: last-wins per event type, keyed by type. */
  snapshots: Readonly<Record<string, Record<string, unknown>>>
  /**
   * Take a queued message back out of the queue. Offered only on a lane the fold still shows as
   * waiting (`laneIsWaiting`), so the panel never offers what the route would answer 409 to.
   */
  onRetract: (laneId: string) => void
}

/** Snapshot lookups are `| undefined` by nature (the bag holds only what this session reported),
 *  so the readers take a possibly-missing bag — bracket access with a named key says exactly that,
 *  which the old `snapshots.phase` dot form silently hid. */
const str = (d: Record<string, unknown> | undefined, k: string): string => { const v = d?.[k]; return typeof v === 'string' ? v : '' }
const num = (d: Record<string, unknown> | undefined, k: string): number | null => {
  const v = d?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
/** kfmt mirrors the cockpit readout's own compactness rule, not a new policy. */
const kfmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/**
 * Snapshots the panel renders with meaning are named by `SNAP` in client-core — the one place the
 * wire vocabulary may be spelled (plan §4.1: ui-* faces the five categories, not the sidecar's
 * protocol). Anything NOT in that set still gets shown — raw, in the last section — because a
 * snapshot nobody renders is a session fact the user cannot see. `todo_state` and friends will land
 * there before they land here, and that is the intended degradation.
 */

/**
 * The runtime-state surface for the open session: the context budget the kernel last
 * sampled, its phase, queue lanes, goal, domain accounting and change landing.
 *
 * Everything here comes from the event timeline the client already folds
 * (`SessionModel.snapshots`) — no second poll, no extra endpoint, so it can disagree
 * with the cockpit strip but never invent a number.
 */
export function ContextPanel({ snapshots, onRetract }: ContextPanelProps) {
  const t = useT()
  const keys = Object.keys(snapshots).sort()
  if (keys.length === 0) return <div className="ucx"><p className="ucx__empty">{t('ctx.empty')}</p></div>

  const budget = snapshots[SNAP.contextBudget]
  const other = keys.filter((k) => !TYPED_SNAPSHOT_KEYS.has(k))
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

  const phase = snapshots[SNAP.phase]
  const restore = phase?.historyRestore as Record<string, unknown> | undefined
  const restored = restore !== undefined ? num(restore, 'restored') : null
  const pending = snapshots[SNAP.queuePending]
  const laneStatus = snapshots[SNAP.queueStatus]

  const snap = budget as unknown as ContextBudgetSnapshot | undefined
  const windowTokens = num(budget ?? {}, 'windowTokens') ?? 0
  const usedTotal = snap === undefined ? 0 : usedTokens(snap)
  const ring = budget === undefined ? null : ringFor(usedTotal, windowTokens)
  const segs = snap === undefined ? [] : budgetSegments(snap)

  /**
   * 定稿图右栏「上下文占用」那一组：占比环 + 分段条。分段的**名字来自协议字段**而不是图上的
   * 「系统提示词/对话历史/工具结果」——内核的快照不区分系统提示词与历史，照抄图上的行名等于
   * 报一个内核从未报告过的分解。缺项就不画那一段，而不是画成 0。
   */
  const gauge = ring === null || budget === undefined ? null : (
    <div className="ucx__gauge">
      <div className="ucx__ring">
        <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={t('ctx.ringAria', { percent: ring.percent })}>
          <circle cx="22" cy="22" r={RING_RADIUS} fill="none" stroke="var(--border-l2)" strokeWidth="2.5" />
          <circle cx="22" cy="22" r={RING_RADIUS} fill="none" stroke="var(--nb-600)" strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray={ring.dashArray} strokeDashoffset={ring.dashOffset} />
        </svg>
        <span className="ucx__rv">{ring.percent}%</span>
      </div>
      <div className="ucx__figs">
        <div className="ucx__used">{t('ctx.used', {
          used: kfmt(usedTotal),
          budget: kfmt(num(budget, 'inputBudget') ?? 0),
          window: kfmt(windowTokens),
        })}</div>
        <div className="ucx__src">{str(budget, 'source') === 'measured' ? t('ctx.sourceMeasured') : t('ctx.sourceEstimate')}</div>
      </div>
      {segs.length > 0 && (
        <>
          <div className="ucx__bar">
            {segs.map((s) => (
              <i key={s.key} className={`ucx__seg ucx__seg--${s.key}`} style={{ width: `${(s.share * 100).toFixed(2)}%` }} />
            ))}
          </div>
          <div className="ucx__legend">
            {segs.map((s) => (
              <div className="ucx__lrow" key={s.key}>
                <span className="ucx__lk"><span className={`ucx__sw ucx__sw--${s.key}`} />{t(SEGMENT_LABEL[s.key])}</span>
                <span className="ucx__lv">{sharePercent(s.windowShare)} · {kfmt(s.tokens)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {segs.length === 0 && <p className="ucx__note">{t('ctx.noSegments')}</p>}
    </div>
  )

  return (
    <div className="ucx">
      {gauge}
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

      {(snapshots[SNAP.status] || snapshots[SNAP.done]) && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.lifecycle')}</h5>
          <p className="ucx__line">
            {[snapshots[SNAP.status] ? `status:${str(snapshots[SNAP.status], 'status')}` : '', snapshots[SNAP.done] ? `done:${str(snapshots[SNAP.done], 'status')}` : '']
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
              {laneIsWaiting(pending, laneStatus) && (
                <button
                  className="ucx__retract"
                  title={t('ctx.retractHint')}
                  onClick={() => onRetract(str(pending, 'laneId'))}
                >
                  {t('ctx.retract')}
                </button>
              )}
            </p>
          )}
          {laneStatus && <p className="ucx__line"><code>{str(laneStatus, 'laneId')}</code> → {str(laneStatus, 'status')}</p>}
        </section>
      )}

      {snapshots[SNAP.goalState] && str(snapshots[SNAP.goalState], 'goal') !== '' && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.goal')}</h5>
          <p className="ucx__phase">{str(snapshots[SNAP.goalState], 'goal')}</p>
          <p className="ucx__line">
            {t('ctx.goalIteration', {
              i: num(snapshots[SNAP.goalState], 'iteration') ?? 0,
              max: num(snapshots[SNAP.goalState], 'maxIterations') ?? 0,
              status: str(snapshots[SNAP.goalState], 'status'),
            })}
          </p>
        </section>
      )}

      {snapshots[SNAP.domainUsage] && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.domainUsage')}</h5>
          <p className="ucx__line"><code>{str(snapshots[SNAP.domainUsage], 'key')}</code></p>
        </section>
      )}

      {snapshots[SNAP.landing] && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.landing')}</h5>
          <p className="ucx__line">
            <code>{t('ctx.landingSha', { action: str(snapshots[SNAP.landing], 'action'), sha: str(snapshots[SNAP.landing], 'sha').slice(0, 8) })}</code>
          </p>
        </section>
      )}

      {snapshots[SNAP.hookResult] && (
        <section className="ucx__block">
          <h5 className="ucx__sub">{t('ctx.hook')}</h5>
          <p className="ucx__line">
            {t('ctx.hookLine', {
              event: str(snapshots[SNAP.hookResult], 'event'),
              turn: num(snapshots[SNAP.hookResult], 'turn') ?? 0,
              n: Array.isArray((snapshots[SNAP.hookResult] ?? {}).results) ? ((snapshots[SNAP.hookResult] ?? {}).results as unknown[]).length : 0,
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
