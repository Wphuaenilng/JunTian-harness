# @tianshu/ui-git

Two panels: the shadow-checkpoint timeline (`CheckpointPanel`) and the repository
workbench (`GitPanel`). Aider's lesson from plan §2.3 is why they are one package: git
**is** the review and rollback system, so the client surfaces it rather than building a
parallel one.

## Endpoints consumed

| Endpoint | Use |
|---|---|
| `GET /sessions/:id/rewind-points` | checkpoint list — `{index, content, timestamp, seq}` |
| `POST /sessions/:id/rewind` | truncate to a message index; `rollbackFiles` opt-in |
| `GET /git/workbench` | snapshot: branch / head / upstream+ahead-behind / `state` / `version` / changes / remotes |
| `GET /git/workbench/history` | bounded commit page (`hasMore`) |
| `GET /git/workbench/branches` | heads **and** remotes in one flat list (see below) |
| `GET /git/workbench/diff` | one file's diff; also the source for per-hunk staging |
| `POST /git/workbench/stage` | file-level and `hunk`-level stage / unstage |
| `POST /git/workbench/commit` | commits the index, returns `{ok, sha}` |
| `POST /git/workbench/branch` | switch, or `-c` create+switch (refused while dirty) |
| `POST /git/workbench/sync` | `fetch` / `pull` / `push`; pull+push are confirm-gated |
| `POST /sessions/:id/git/commit` | server-direct commit of the session's own index |
| `POST /sessions/:id/git/merge-back` | squash the session worktree branch into the main workspace |
| `POST /sessions/:id/git/pr` | push + open a PR via `gh` |

**Not wired, on purpose**: `client-core` also exposes `rollbackPreview()`
(`GET /sessions/:id/rollback/preview`), which hands out the `confirmationToken` that
`POST /sessions/:id/rollback` demands (`session-routes.ts:2146` refuses without it — that
route rolls a checkpoint's *disk* history back). It is not in the table above because no
panel calls it, and the ledger at the bottom of this file is generated from real call
sites, so a hand-written claim here would contradict CI. The timeline uses `/rewind`
instead, which truncates the conversation and takes `rollbackFiles` as a plain flag with
no token. Rewiring the checkpoint path would put an unexecuted destructive call behind a
button; the panel stays honest about that gap rather than closing it silently.

## Rules

- **Rewind is two steps.** Selecting a checkpoint only arms the panel; nothing is
  destroyed until 确认回滚, and 同时回滚工作区文件 is a separate opt-in.
- **Every write echoes `repository.version`** — the optimistic lock over
  head+branch+index+status (`git-workbench.ts:92-100`). A 409 `stale_snapshot` re-reads
  the tree and asks the user to confirm again; the panel never auto-retries a write,
  because a moved repository usually means the *user* has to look again too.
- **Failures branch on `code`, never on the message text.** `stale_snapshot`,
  `dirty_workspace`, `sensitive_file`, `confirmation_required`, `empty_index`,
  `invalid_hunk`… are contract (`git-workbench.ts:7-9`); the Chinese message is
  presentation and can change.
- **`isStaged` tests a trimmed column, not `!== ''`.** porcelain writes a *space* in the
  column that does not apply: `" M"` is unstaged, `"M "` is staged. Getting this wrong
  makes every file look staged — measured in the browser, not theorized.
- **The branch picker filters remote-tracking refs itself.** `GET /git/workbench/branches`
  returns `refs/heads` and `refs/remotes` as one list with no discriminator, so
  `localBranches()` (client-core) drops `<remote>` and `<remote>/**` using the
  repository's own remote names.
- **Commit means the index.** `POST /sessions/:id/git/commit` commits what is staged, not
  what changed on disk (`nothingToCommit:true` otherwise), so the label says 已暂存 and
  the button is disabled at zero staged files.
- **A session cwd is never pristine.** The runtime seeds `.rivet/skills/**` there; those
  untracked files count as dirt and the branch/sync guards fire on them. The panel shows
  the kernel's reason instead of working around it.
- `sensitive_file` is a 403 from the server — the UI surfaces it verbatim as a refusal
  rather than trying a second path.

## Verified

Against a throwaway sandbox (`client/.sidecar-data/git-sandbox/`, one bare "origin" on
disk, no network remote), `scripts/accept-gitwrite.ts` runs 30 checks green: the stale
lock, file+hunk staging, the `.env` refusal, commit validation, dirty-worktree branch
guard, remote validation, push confirm-gating, a real push the bare remote received, and
an `isolatedWorktree` session committing in its temp worktree and merging back into the
main workspace.

The same controls were then driven **through the browser**: staging flipped the row's
status and label, the commit box produced `docs: written through the client UI` on disk,
`feature/ui-made` was created and checked out, and a confirmed push landed the branch on
the remote. Two live-UI bugs came out of it — the `" "` vs `''` staged test and the
mixed heads/remotes picker.

**Not exercised:** opening a real PR (`gh` + a public target would create a shared
artifact, so it is left to you). The route was verified to refuse cleanly without one.

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 13 个：`rewind`、`rewindPoints`、`sessionCommit`、`sessionMergeBack`、`sessionOpenPr`、`workbenchBranch`、`workbenchBranches`、`workbenchCommit`、`workbenchDiff`、`workbenchHistory`、`workbenchSnapshot`、`workbenchStage`、`workbenchSync`

| 面 | 消费内容 |
|---|---|
| 端点 | `GET /git/workbench`、`GET /git/workbench/branches`、`GET /git/workbench/diff`、`GET /git/workbench/history`、`GET /sessions/:id/rewind-points`、`POST /git/workbench/branch`、`POST /git/workbench/commit`、`POST /git/workbench/stage`、`POST /git/workbench/sync`、`POST /sessions/:id/git/commit`、`POST /sessions/:id/git/merge-back`、`POST /sessions/:id/git/pr`、`POST /sessions/:id/rewind` |
| 事件类（wire 名） | — |
| 折叠块类型 | — |
| 宿主回调 props | `onRewound` |
<!-- protocol-ledger:end -->
