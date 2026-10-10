# @tianshu/ui-session

Session list, create, archive. Dumb props — it fetches nothing.

## Protocol surface consumed

- **Records**: `SessionRecord` (`id`, `title`, `status`, `lastSeq`, `pendingApprovals`,
  `worktreeBranch`, `archived`).
- **Endpoints** (called by the app, rendered here): `GET /sessions`, `POST /sessions`,
  `DELETE /sessions/:id`.
- **Event categories**: none directly; the row reflects the record, which the app
  refreshes off the `GET /events` health heartbeat signature (`sessionCount:runningCount`).

## Deliberate choices

- `pendingApprovals` renders as a badge: a session waiting on a human decision is not
  "running", and a sidebar that hides that is lying about what needs attention.
- Archived rows are excluded by default (`includeArchived` is a filter, not a reload).
- Brand appears once, in the sidebar header (定稿 设计要点：品牌只在侧栏头部一处).

## Not in MVP (plan M2)

搜索、改名、@file 候选、worktree 分支操作。

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
| 宿主回调 props | `onArchive`、`onCreate`、`onOpen`、`onQueryChange`、`onRename`、`onToggleArchived` |
<!-- protocol-ledger:end -->
