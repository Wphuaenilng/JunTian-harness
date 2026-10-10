/**
 * Cockpit snapshot — the subset this client renders, typed from
 * `src/tui/cockpit/types.ts:48` (the TUI and the sidecar share one builder,
 * `buildCockpitSnapshot`). Fields we do not render are left out on purpose; the type
 * is not `unknown` because a typo in a rendered key must fail typecheck, not show a
 * blank readout.
 *
 * Availability is the important constraint: the endpoint answers **only while an agent
 * exists for the session**. A never-run or archived session returns
 * 404 `Session agent not built yet`, so absence is normal and must not be surfaced as
 * an error.
 */
export interface CockpitSnapshot {
  model: {
    name: string
    /** 0..1 prefix-cache hit rate. */
    cacheHitRate: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    /** Money. Rendered as-is; the client does not recompute pricing. */
    cost: number
    reasoningEffort: string
    starDomain: string
  }
  context: {
    estimatedTokens: number
    maxTokens: number
    rounds: number
    compactionState: string
  } | null
  verification: {
    filesRead: number
    filesModified: number
    deliveryStatus: 'verified' | 'failed' | 'blocked' | 'unverified'
    impactedFiles: number
  }
  mcp: {
    servers: Array<{ serverId: string; status: string; toolCount: number }>
    totalTools: number
    connectedServers: number
  }
}

export interface CockpitReadout {
  model: string
  /** Percentage of the context window in use, or null when no context is reported. */
  contextPct: number | null
  contextLabel: string
  cachePct: number
  costLabel: string
  /** Compact token ledger, e.g. `28.7k↑ 0.6k↓`. */
  tokensLabel: string
  compactionState: string | null
}

const kfmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * Pure formatter so the readout can be tested without a live agent — the snapshot
 * itself is unobtainable when idle, but the rendering rules must still be pinned.
 */
export function formatCockpit(s: CockpitSnapshot): CockpitReadout {
  const ctx = s.context
  const pct = ctx && ctx.maxTokens > 0 ? Math.min(100, Math.round((ctx.estimatedTokens / ctx.maxTokens) * 100)) : null
  return {
    model: s.model.name,
    contextPct: pct,
    contextLabel: ctx ? `${kfmt(ctx.estimatedTokens)}/${kfmt(ctx.maxTokens)}${pct === null ? '' : ` · ${pct}%`}` : '—',
    cachePct: Math.round(s.model.cacheHitRate * 100),
    costLabel: `$${s.model.cost.toFixed(4)}`,
    tokensLabel: `${kfmt(s.model.inputTokens)}↑ ${kfmt(s.model.outputTokens)}↓`,
    compactionState: ctx?.compactionState ?? null,
  }
}
