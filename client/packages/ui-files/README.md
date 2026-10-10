# @tianshu/ui-files

Workspace file browser + preview for the current session, plus the candidate source for
`@file` mentions in the composer.

## Endpoints consumed

| Endpoint | Use |
|---|---|
| `GET /sessions/:id/files?q=` | ranked name search. **The server** applies gitignore filtering and relevance — this panel must not re-implement ignore rules, or the UI would offer files the agent cannot see |
| `GET /sessions/:id/list-dir?path=` | directory walk — `{path, entries:[{name, isDirectory}]}` (no size/mtime, so none are shown) |
| `GET /sessions/:id/file-content?path=` | preview — content comes back **as stored**, CRLF included |

## Rules

- Preview is capped (60KB) and says so, rather than piping a whole lockfile into the DOM.
- `onPick` inserts a path into the composer; the panel never edits the composer's state
  directly (business packages talk only to client-core, plan §4.2 依赖纪律).
- Depends on `@tianshu/ui-primitives` for rendering — that is the allowed direction
  (primitive layer below, business packages never import each other).

## Not here yet

PDF preview (`/file-preview/pdf`) and image attachments.

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 3 个：`fileContent`、`listDir`、`listFiles`

| 面 | 消费内容 |
|---|---|
| 端点 | `GET /sessions/:id/file-content`、`GET /sessions/:id/files`、`GET /sessions/:id/list-dir` |
| 事件类（wire 名） | — |
| 折叠块类型 | — |
| 宿主回调 props | `onPick` |
<!-- protocol-ledger:end -->
