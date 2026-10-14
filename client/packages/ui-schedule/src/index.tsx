import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT, type LocaleKey } from '@tianshu/locale'
import {
  createLatestGate,
  effectiveStatus,
  type CronTriggerType,
  type ScheduleStatus,
  type ScheduledTask,
  type SidecarClient,
  type TaskRecord,
} from '@tianshu/client-core'

export interface AutomationBoardProps {
  api: SidecarClient
  /** Capabilities come from GET /health; PATCH support is asked, not version-guessed. */
  canPatch: boolean
  /** The session cwd a new automation should inherit (tasks snapshot their workspace). */
  defaultCwd: string | null
}

/** Labels are locale keys; the wire value stays the server's `CronTriggerType`. */
const TRIGGER_TYPES: Array<{ value: CronTriggerType; labelKey: LocaleKey; needsSpec: boolean }> = [
  { value: 'interval', labelKey: 'schedule.triggerInterval', needsSpec: true },
  { value: 'cron', labelKey: 'schedule.triggerCron', needsSpec: true },
  { value: 'oneshot', labelKey: 'schedule.triggerOneshot', needsSpec: true },
  { value: 'startup', labelKey: 'schedule.triggerStartup', needsSpec: false },
  { value: 'file-change', labelKey: 'schedule.triggerFileChange', needsSpec: true },
  { value: 'git-push', labelKey: 'schedule.triggerGitPush', needsSpec: true },
]

/**
 * Kept as keys + raw message so an on-screen error re-renders when the language flips,
 * including the `{label}` of the action that failed.
 */
type Failure = { key: LocaleKey; message: string; labelKey?: LocaleKey }

/**
 * Automations dashboard. The lifecycle column uses `effectiveStatus`, which mirrors
 * the server's precedence (explicit `status` wins, else `enabled`) — pre-#236 rows
 * have no `status` at all and must still read correctly.
 *
 * Creating a task is a real write to the sidecar's scheduler, so the form defaults to
 * a spec that can never fire soon (Feb 29) rather than an eager `interval: 60000`.
 */
export function AutomationBoard({ api, canPatch, defaultCwd }: AutomationBoardProps) {
  const t = useT()
  const [tasks, setTasks] = useState<readonly ScheduledTask[]>([])
  const [jobs, setJobs] = useState<readonly TaskRecord[]>([])
  /** A runtime without the jobs registry errors on `/tasks`; the board must still work. */
  const [jobsUnavailable, setJobsUnavailable] = useState(false)
  const [health, setHealth] = useState<ScheduleStatus | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ prompt: string; type: CronTriggerType; spec: string }>({
    prompt: '', type: 'cron', spec: '0 4 29 2 *',
  })

  // 定时表的两个槽各一把令牌：一轮扫描超过 30s 时，两轮会重叠，而重叠的反序落地会把"板子显示的
  // 是哪一刻"变成随机的。桩不住的那半（jobs 列表）单独一把，因为它与 definitions 是两次独立读。
  const boardGate = useMemo(() => createLatestGate(), [])
  const jobsGate = useMemo(() => createLatestGate(), [])

  const reload = useCallback(() => {
    const token = boardGate.begin()
    const jobToken = jobsGate.begin()
    void Promise.all([api.listScheduledTasks(), api.scheduleStatus()])
      .then(([tsk, h]) => {
        if (!boardGate.isCurrent(token)) return
        setTasks(tsk); setHealth(h); setError(null)
      })
      .catch((e: Error) => { if (!boardGate.isCurrent(token)) return; setError({ key: 'schedule.loadFailed', message: e.message }) })
    // Definitions and runs are different surfaces: a failure here degrades the run list to
    // a labelled empty state rather than blanking the schedule board with it.
    api.listTasks()
      .then((page) => { if (!jobsGate.isCurrent(jobToken)) return; setJobs(page.tasks); setJobsUnavailable(false) })
      .catch(() => { if (!jobsGate.isCurrent(jobToken)) return; setJobs([]); setJobsUnavailable(true) })
  }, [api, boardGate, jobsGate])

  // The server says the 30s poll also surfaces write health, so a save that never
  // reached the disk is visible here rather than only at save time.
  useEffect(() => {
    reload()
    const timer = setInterval(reload, 30_000)
    return () => clearInterval(timer)
  }, [reload])

  const create = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await api.createScheduleTask({
        prompt: draft.prompt.trim(),
        trigger: { type: draft.type, ...(draft.spec.trim() ? { spec: draft.spec.trim() } : {}) },
      })
      setDraft({ ...draft, prompt: '' })
      reload()
    } catch (e) {
      setError({ key: 'schedule.actionFailed', message: (e as Error).message, labelKey: 'schedule.create' })
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<unknown>, labelKey: LocaleKey): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError({ key: 'schedule.actionFailed', message: (e as Error).message, labelKey })
    } finally {
      setBusy(false)
    }
  }

  const needsSpec = TRIGGER_TYPES.find((k) => k.value === draft.type)?.needsSpec ?? true

  return (
    <div className="sc">
      <div className="ckp__head">
        <h4>{t('schedule.title')}</h4>
        <button className="ckp__mini" onClick={reload} disabled={busy}>{t('schedule.refresh')}</button>
      </div>
      {error && (
        <div className="ckp__error">
          {t(error.key, { label: error.labelKey ? t(error.labelKey) : '', message: error.message })}
        </div>
      )}
      {health && (
        <div className="sc__health">
          <span className={`sc__pill${health.status.schedulerRunning ? ' sc__pill--ok' : ''}`}>
            {health.status.schedulerRunning ? t('schedule.schedulerRunning') : t('schedule.schedulerStopped')}
          </span>
          <span className="sc__pill">{t('schedule.activeCount', { count: health.status.activeTasks })}</span>
          {/* Write health is part of the dashboard, not a save-time toast. */}
          <span className={`sc__pill${health.persistence?.ok === false ? ' sc__pill--bad' : ''}`}>
            {health.persistence?.ok === false ? t('schedule.persistenceBad') : t('schedule.persistenceOk')}
          </span>
          {!canPatch && <span className="sc__pill">{t('schedule.noPatchSupport')}</span>}
        </div>
      )}

      <ul className="sc__list">
        {tasks.map((task) => {
          const st = effectiveStatus(task)
          return (
            <li key={task.id} className="sc__item">
              <div className="sc__row">
                <span className={`sc__dot sc__dot--${st}`} />
                <span className="sc__prompt">{task.prompt}</span>
                <span className="sc__count">×{task.triggerCount}</span>
              </div>
              <div className="sc__meta">
                <code>{task.trigger.type}{task.trigger.spec ? `:${task.trigger.spec}` : ''}</code>
                {task.reviewPolicy && <code>{task.reviewPolicy}</code>}
                {task.approval && <code>approval:{task.approval}</code>}
                {task.lastTriggeredAt && <code>{t('schedule.lastRun', { time: new Date(task.lastTriggeredAt).toLocaleString() })}</code>}
                {task.cwd && <code>{task.cwd}</code>}
              </div>
              <div className="sc__actions">
                {st === 'active'
                  ? <button className="ckp__btn" disabled={busy} onClick={() => void act(() => api.pauseScheduleTask(task.id), 'schedule.pause')}>{t('schedule.pause')}</button>
                  : <button className="ckp__btn" disabled={busy} onClick={() => void act(() => api.patchScheduleTask(task.id, {}), 'schedule.resume')}>{t('schedule.resume')}</button>}
                <button className="ckp__btn ckp__btn--danger" disabled={busy} onClick={() => void act(() => api.deleteScheduleTask(task.id), 'schedule.delete')}>{t('schedule.delete')}</button>
              </div>
            </li>
          )
        })}
        {tasks.length === 0 && <li className="ckp__empty">{t('schedule.empty')}</li>}
      </ul>

      {/* Plan M2 asks for `/schedule` **and** `/tasks`: definitions are the board above,
          runs (cron firings and background bash) are this list. Status/source stay in wire
          form — they are protocol values, and translating them would make a stale row look
          like a healthy one. */}
      <div className="sc__jobs">
        <h4 className="sc__jobhead">{t('schedule.jobsTitle')}</h4>
        <ul className="sc__list">
          {jobs.map((job) => (
            <li key={job.id} className="sc__item">
              <div className="sc__row">
                <code className={`sc__pill${job.status === 'running' || job.status === 'pending' ? ' sc__pill--ok' : ''}`}>{job.status}</code>
                <span className="sc__prompt">{job.prompt}</span>
              </div>
              <div className="sc__meta">
                <code>{job.source}</code>
                <code>{new Date(job.createdAt).toLocaleString()}</code>
                {job.scheduledTaskId && <code>sched:{job.scheduledTaskId.slice(0, 8)}</code>}
                {job.sessionId && <code>sess:{job.sessionId.slice(0, 8)}</code>}
                {job.result && <code>{job.result.summary}</code>}
                {job.error && <code>{job.error}</code>}
              </div>
            </li>
          ))}
          {jobs.length === 0 && (
            <li className="ckp__empty">{jobsUnavailable ? t('schedule.jobsUnavailable') : t('schedule.jobsEmpty')}</li>
          )}
        </ul>
      </div>

      <div className="sc__new">
        <input
          className="sc__prompt-input"
          placeholder={t('schedule.promptPlaceholder')}
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />
        <div className="sc__trigger">
          <select
            className="set__select"
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as CronTriggerType })}
          >
            {TRIGGER_TYPES.map((k) => <option key={k.value} value={k.value}>{t(k.labelKey)}</option>)}
          </select>
          {needsSpec && (
            <input
              className="sc__spec"
              value={draft.spec}
              onChange={(e) => setDraft({ ...draft, spec: e.target.value })}
              placeholder="0 4 29 2 *"
            />
          )}
          <button className="ckp__btn" disabled={busy || draft.prompt.trim().length === 0} onClick={() => void create()}>{t('schedule.create')}</button>
        </div>
        <p className="ckp__empty">
          {defaultCwd ? t('schedule.workspaceSnapshotCwd', { cwd: defaultCwd }) : t('schedule.workspaceSnapshot')}
        </p>
      </div>
    </div>
  )
}
