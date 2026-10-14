import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionList } from '@tianshu/ui-session'
import type { SessionRecord } from '@tianshu/client-core'
import '@tianshu/ui-theme/tokens.css'
import '@tianshu/ui-primitives/styles.css'
import '@tianshu/ui-chat/styles.css'
import '@tianshu/ui-session/styles.css'
import './styles.css'

/**
 * Row-composition probe for the sidebar. The badge (`pendingApprovals`) only appears after a real
 * run asks for a decision, which costs an upstream call — so this page feeds the *real*
 * `<SessionList>` the worst-case row it can be asked to draw: a title long enough to ellipsise, a
 * worktree branch longer than its cap, and a pending badge, all at once. The component and CSS are
 * the product's; only the records are fixtures.
 *
 * Width matters as much as height: the badge is `flex:none`, so an uncapped branch would push it
 * out of the 264px column and that is precisely the failure this measures.
 *
 * The fourth record is `archived` and exists for the other half of the page: the row action swaps
 * ✕ for ↩ only on archived rows, so this is the one place that affordance can be drawn without
 * paying for a live archive round-trip. Which callback the click reaches is read back from
 * `window.__rowProbe__.clicks`.
 */
const NOW = Date.parse('2026-10-11T09:00:00Z')

const RECORDS: readonly SessionRecord[] = [
  {
    id: 'probe-busy-row',
    title: '修复登录页样式回归 · 这一行同时带长标题、超长分支名和待授权徽标，用来把最坏情况量出来',
    status: 'running',
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    cwd: '/probe/work/alpha',
    workspaceSource: 'explicit',
    lastSeq: 12,
    pendingApprovals: 3,
    worktreeBranch: 'fix/login-page-style-regression-and-overflow-on-narrow-rail',
  },
  {
    id: 'probe-plain-row',
    title: '普通一行',
    status: 'completed',
    createdAt: NOW - 120_000,
    updatedAt: NOW - 30_000,
    cwd: '/probe/work/alpha',
    workspaceSource: 'explicit',
    lastSeq: 4,
    pendingApprovals: 0,
  },
  {
    id: 'probe-scratch-row',
    title: '临时会话',
    status: 'idle',
    createdAt: NOW - 90_000,
    updatedAt: NOW - 20_000,
    cwd: '',
    workspaceSource: 'scratch',
    lastSeq: 0,
    pendingApprovals: 1,
  },
  {
    id: 'probe-archived-row',
    title: '已归档的一行 · 这一行只用来量那把 ↩：入口在不在、点下去走到的是取消归档而不是归档',
    status: 'completed',
    createdAt: NOW - 240_000,
    updatedAt: NOW - 180_000,
    cwd: '/probe/work/alpha',
    workspaceSource: 'explicit',
    lastSeq: 7,
    pendingApprovals: 0,
    archived: true,
  },
]

const noop = (): void => undefined

/**
 * Fixture metadata handed to the pixel gate on the same page it renders on. The gate's
 * expectations come from here (`archivedIds`) rather than from a count someone typed into
 * the script, so adding or removing an archived fixture moves the expectation with it — and
 * `clicks` is where the gate reads back which callback the row actually invoked, with which id.
 */
interface RowProbe {
  archivedIds: string[]
  clicks: [string, string][]
}

declare global {
  interface Window { __rowProbe__: RowProbe }
}

window.__rowProbe__ = {
  archivedIds: RECORDS.filter((r) => r.archived === true).map((r) => r.id),
  clicks: [],
}

const host = document.getElementById('root')
if (host) {
  createRoot(host).render(
    <StrictMode>
      <div style={{ width: 264, height: 700 }}>
        <SessionList
          sessions={RECORDS}
          openSessionId="probe-busy-row"
          includeArchived={false}
          onToggleArchived={noop}
          onOpen={(id) => { window.__rowProbe__.clicks.push(['open', id]) }}
          onCreate={noop}
          onArchive={(id) => { window.__rowProbe__.clicks.push(['archive', id]) }}
          onUnarchive={(id) => { window.__rowProbe__.clicks.push(['unarchive', id]) }}
          onRename={noop}
          query=""
          onQueryChange={noop}
          hits={null}
        />
      </div>
    </StrictMode>,
  )
}
