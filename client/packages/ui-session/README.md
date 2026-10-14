# @tianshu/ui-session

Session list, create, archive. Dumb props — it fetches nothing.

## Protocol surface consumed

- **Records**: `SessionRecord` (`id`, `title`, `status`, `lastSeq`, `pendingApprovals`,
  `worktreeBranch`, `archived`, plus `cwd` / `workspaceSource` / `updatedAt` for the project level).
- **Endpoints** (called by the app, rendered here): `GET /sessions`, `POST /sessions`,
  `DELETE /sessions/:id`.
- **Event categories**: none directly; the row reflects the record, which the app
  refreshes off the `GET /events` health heartbeat signature (`sessionCount:runningCount`).

## Deliberate choices

- `pendingApprovals` renders as a badge: a session waiting on a human decision is not
  "running", and a sidebar that hides that is lying about what needs attention.
- Archived rows are excluded by default (`includeArchived` is a filter, not a reload).
- Brand appears once, in the sidebar header (定稿 设计要点：品牌只在侧栏头部一处).
- The sidebar has two levels because the approved mockup draws two: sessions group by `cwd`
  (`groupSessionsByProject`, a pure function in `src/projects.ts`), newest activity first.
  `scratch` and `runtime-default` sessions do **not** get their own header — the first has a
  throwaway directory per session, the second points at wherever the sidecar was started from,
  and either would turn an implementation detail into a fake project. They share 未指定目录.
  Collapse state is component-local and resets on reload; remembering it across sessions would
  need a store key, which is an IA decision rather than a bug.

## 已做（原计划 M2 那一格，现已实现）

搜索（`GET /sessions/search`，端点由宿主 `apps/web` 调用）、改名（`PATCH /sessions/:id`）、
@file 候选、worktree 分支显示与 Git 面板。搜索那条空态文案在 2026-10-11 被实测改过两次：先否证「搜索按项目本地取文件、不覆盖 sidecar 会话库」
（`session-search.ts:114` 走的是 `~/.rivet/sessions/<项目 slug>/`），再否证「只是没跑过的会话才搜不到」——
搜索打开 `<slug>/<id>.jsonl`，而写入侧存的是 `<slug>/<id>/` 目录（正文在 `<id>/events.jsonl`），
**两头对不上，所以这台内核上任何正文都查不到**；`meta.scannedFiles` 数的是尝试，不是读到。
空态因此明说这条不一致（上游缺陷，客户端只报告不绕道）。短于 2 个字符的查询根本不出网
（`q.length < 2` 时 sidecar 回 400）。

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 0 个（本包不直接打端点：数据与动作全部由宿主经 props 传入）

| 面 | 消费内容 |
|---|---|
| 端点 | — |
| 事件类（wire 名） | `status` |
| 折叠块类型 | — |
| 宿主回调 props | `onArchive`、`onCreate`、`onOpen`、`onQueryChange`、`onRename`、`onToggleArchived`、`onUnarchive` |
<!-- protocol-ledger:end -->
