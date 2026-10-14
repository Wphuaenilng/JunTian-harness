import type { SessionRecord } from '@tianshu/client-core'

/**
 * The approved mockup's sidebar has two levels — 项目 and, under each project,
 * 最近对话. The sidecar has no project concept: `/sessions` returns one flat record per
 * session, each carrying the `cwd` it runs in (and `workspaceSource`, which says who chose
 * it). Grouping is therefore derived here, from data the protocol already ships.
 */
export interface ProjectGroup {
  /** Group key: the session cwd, or `SYNTH_PROJECT_KEY` when no folder was chosen. */
  key: string
  /** Last path segment — what the header shows. */
  name: string
  /** Full path for the hover title; null for the synthetic scratch group. */
  cwd: string | null
  /** Newest activity in the group; this is what orders the groups. */
  updatedAt: number
  sessions: SessionRecord[]
}

/** Scratch sessions each live in their own throwaway directory, and `runtime-default` ones land
 *  in whatever directory the sidecar happened to be started from — neither is a project the user
 *  chose, so both share one bucket instead of producing headers like `Tianshu-harness`. */
export const SYNTH_PROJECT_KEY = '\u0000temp'

const byNewest = (a: SessionRecord, b: SessionRecord) => b.updatedAt - a.updatedAt

/** Splits on both separators because the client runs on Windows and talks to a sidecar that
 *  reports POSIX-style paths when the session lives there. */
export function projectNameFor(cwd: string): string {
  const parts = cwd.split(/[/\\]+/).filter((p) => p.length > 0)
  const last = parts[parts.length - 1]
  return last ?? (cwd.length > 0 ? cwd : '/')
}

const groupKeyOf = (s: SessionRecord): string =>
  s.workspaceSource === 'scratch' || s.workspaceSource === 'runtime-default'
    || typeof s.cwd !== 'string' || s.cwd.length === 0
    ? SYNTH_PROJECT_KEY
    : s.cwd

/**
 * Groups by cwd, newest activity first, sessions inside each group newest first. Ties break on
 * the displayed name so the order does not shift between renders when two projects were touched
 * in the same second.
 */
export function groupSessionsByProject(sessions: readonly SessionRecord[]): ProjectGroup[] {
  const buckets = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const key = groupKeyOf(s)
    const found = buckets.get(key)
    if (found) {
      found.sessions.push(s)
      if (s.updatedAt > found.updatedAt) found.updatedAt = s.updatedAt
    } else {
      buckets.set(key, {
        key,
        name: key === SYNTH_PROJECT_KEY ? '' : projectNameFor(s.cwd),
        cwd: key === SYNTH_PROJECT_KEY ? null : s.cwd,
        updatedAt: s.updatedAt,
        sessions: [s],
      })
    }
  }
  return [...buckets.values()]
    .map((g) => ({ ...g, sessions: [...g.sessions].sort(byNewest) }))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.cwd ?? '').localeCompare(b.cwd ?? ''))
}
