/**
 * Git workbench wire shapes — transcribed from the server implementations, since
 * these endpoints have no entry in the contract leaf.
 *
 * Source of truth per type is cited; the important cross-cutting one is
 * `RepositoryContext.version`: every **write** goes through
 * `checkedRepositoryWrite(cwd, data.version, …)` (git-workbench-routes.ts:22), so a
 * commit/stage/PR call must echo the version it read. That is an optimistic lock
 * against two clients mutating one working tree — do not drop it.
 */

/** src/server/git-workbench.ts:34 */
export interface GitChange {
  path: string
  /** Present for rename/copy entries (index or worktree char is R or C). */
  originalPath?: string
  /** Porcelain v1 index status char. */
  index: string
  /** Porcelain v1 worktree status char. */
  worktree: string
  conflict: boolean
}

/**
 * git-workbench.ts:28-33. `state` is the server's own enumeration: 'ready' (has a head),
 * 'unborn' (repo without commits) and 'non_repository' (the cwd is not a repo,
 * git-workbench.ts:53). Anything else should be rendered, not branched on.
 */
export interface RepositoryContext {
  id: string
  cwd: string
  commonDir: string
  /** '(detached)' is a value, not null — git-workbench.ts:82. */
  branch: string
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Optimistic-lock digest over head+branch+index+status. Echo it on writes. */
  version: string
  /**
   * Objects, not names (git-workbench.ts:31) — and the url is scrubbed of credentials
   * (`https://user@` → `https://***@`, git-workbench.ts:79), so it is safe to render.
   */
  remotes: GitRemote[]
  state: 'ready' | 'unborn' | 'non_repository' | string
}

export interface GitRemote {
  name: string
  url: string
}

/**
 * `GET /git/workbench/branches` asks for-each-ref for **both** `refs/heads` and
 * `refs/remotes` (git-workbench-routes.ts:48) and returns one flat list with no flag
 * saying which is which. Switching to `origin/main` is not what a branch picker means,
 * so the client separates them by git's own convention: a name whose first segment is a
 * known remote is a remote-tracking ref.
 */
export function localBranches(branches: readonly BranchInfo[], remotes: readonly GitRemote[]): BranchInfo[] {
  const names = remotes.map((r) => r.name)
  return branches.filter((b) => !names.some((r) => b.name === r || b.name.startsWith(`${r}/`)))
}

/**
 * Writes: every one of these must carry the `version` the caller last read
 * (`checkedRepositoryWrite`, git-workbench.ts:92-100). A mismatch is 409 `stale_snapshot`
 * — by design, because two clients can be looking at one working tree.
 */
export interface StageRequest {
  path: string
  /** Omit for whole-file staging; 0-based index into the file's hunks otherwise. */
  hunk?: number
  unstage?: boolean
}

export interface BranchRequest {
  name: string
  /** true → `git switch -c` (create), false/absent → switch to an existing branch. */
  create?: boolean
}

export type SyncAction = 'fetch' | 'pull' | 'push'

export interface SyncRequest {
  remote: string
  action: SyncAction
  ref?: string
  /** pull/push are confirm-gated (git-workbench-routes.ts:91); fetch is not. */
  confirm?: boolean
}

/** POST /git/workbench/commit — git-workbench.ts:128-135 */
export interface CommitResult {
  ok: true
  sha: string
}

/** GET /git/workbench */
export interface WorkbenchSnapshot {
  repository: RepositoryContext
  changes: GitChange[]
}

/** GET /git/workbench/history — git-workbench.ts:136-142 */
export interface CommitEntry {
  sha: string
  parents: string[]
  author: string
  /** Unix seconds. */
  time: number
  /** Refs decoration (%D), e.g. 'HEAD -> main, origin/main'. */
  refs: string
  subject: string
}

export interface HistoryPage {
  commits: CommitEntry[]
  hasMore: boolean
}

/** GET /git/workbench/branches */
export interface BranchInfo {
  name: string
  sha: string
  upstream: string
}

export interface BranchesPage {
  branches: BranchInfo[]
  /** Raw `git worktree list --porcelain` output — a string, not parsed server-side. */
  worktrees: string
}

/** GET /git/workbench/diff and /sessions/:id/git/diff */
export interface DiffResult {
  diff: string
}

/**
 * GET /sessions/:id/git/working-tree — per-file line counts against the task baseline
 * (`SessionRecord.baselineHead`), which is why mid-run commits still show up.
 */
export interface WorkingTreeFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

export interface SessionWorkingTree {
  files: WorkingTreeFile[]
  isRepo: boolean
}

/** What the workbench endpoints accept to locate a repository (git-workbench-routes.ts:8-16). */
export type GitScope = { cwd: string; sessionId?: undefined } | { sessionId: string; cwd?: undefined }
