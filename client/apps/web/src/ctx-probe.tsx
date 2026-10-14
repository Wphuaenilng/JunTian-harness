import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextPanel } from '@tianshu/ui-chat'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-chat/styles.css'
import './styles.css'

/**
 * Render probe for the 上下文占用 gauge. The kernel only reports a `context_budget` snapshot
 * during a run, and a run costs an upstream call — so this entry feeds the component a fixture with
 * the drawing's own numbers (210k used of a 500k window) and lets a headless browser measure what
 * actually comes out: ring radius, dash literals, bar width sum, legend rows, overflow, and the
 * queue lane's retract affordance (shown on a waiting lane, hidden on a lane the fold shows as
 * taken) — a queued message costs nothing to produce, so that whole surface measures keylessly.
 *
 * Not linked from the app; reachable at /ctx-probe.html while the serve layer is running, same as
 * frame-probe.html. Nothing here reads tokens, endpoints or disk.
 */
const FIXTURE = {
  requestId: 'ctx-probe',
  revision: 7,
  sampledAt: Date.parse('2026-10-10T09:00:00Z'),
  model: 'claude-probe',
  windowTokens: 500_000,
  inputBudget: 470_000,
  inputTokens: 90_000,
  outputReserve: 20_000,
  safetyMargin: 10_000,
  imageTokens: 15_000,
  reasoningTokens: 45_000,
  toolTokens: 60_000,
  source: 'measured',
  state: 'ready',
}

const host = document.getElementById('root')

/**
 * Two queue fixtures, because the retract button's whole rule is "waiting lanes get one, taken
 * lanes do not" — and a snapshot bag holds only one `queue_pending` and one `queue_status`, so the
 * two cases cannot live in one panel. The second panel carries no `context_budget`, so the gauge
 * readers (which address the first `.ucx`) keep seeing exactly one set of legend rows.
 */
const QUEUE_WAITING = { laneId: 'lane-probe-waiting', text: '夹具：这条还排在队列里，等下一次 prompt 才归并' }
const QUEUE_TAKEN = { laneId: 'lane-probe-taken', text: '夹具：这条已被归并进那一轮，撤回键不该再出现' }
const QUEUE_TAKEN_STATUS = { laneId: 'lane-probe-taken', status: 'steered' }

interface QueueProbe {
  waitingLane: string
  takenLane: string
  retracts: string[]
}

declare global {
  interface Window { __queueProbe__: QueueProbe }
}

window.__queueProbe__ = {
  waitingLane: QUEUE_WAITING.laneId,
  takenLane: QUEUE_TAKEN.laneId,
  retracts: [],
}

const onRetract = (laneId: string): void => { window.__queueProbe__.retracts.push(laneId) }

if (host) {
  createRoot(host).render(
    <StrictMode>
      <div style={{ width: 288, padding: 12 }}>
        <ContextPanel
          snapshots={{ context_budget: FIXTURE, queue_pending: QUEUE_WAITING }}
          onRetract={onRetract}
        />
        <ContextPanel
          snapshots={{ queue_pending: QUEUE_TAKEN, queue_status: QUEUE_TAKEN_STATUS }}
          onRetract={onRetract}
        />
      </div>
    </StrictMode>,
  )
  ;(window as unknown as { __ctx__: { fixture: typeof FIXTURE } }).__ctx__ = { fixture: FIXTURE }
}
