# @tianshu/ui-chat

Conversation stream: block timeline, thinking collapse, tool cards (diff or terminal),
error blocks with the runtime's `guidance` line.

## Protocol surface consumed

It renders `Block`s produced by `@tianshu/client-core`'s `SessionModel` — it never
touches raw event types. The mapping it depends on:

| source events | block |
|---|---|
| `user` | user bubble |
| `text_delta` | markdown block (open tail re-parses only) |
| `thinking_delta` | collapsed `<details>` |
| `tool_use` + `tool_result` | one tool card, paired by call id |
| `error` | error block (+ `guidance` from protocol.ts:125) |
| `turn_complete` | divider when `stopReason:'max_tokens'` (the model emits the fact, this package supplies the wording) |

**Endpoints**: `GET /sessions/:id/git/file-base?path=` — and only for the lazy
before-view below. `ContextPanel` consumes no endpoint at all: it renders
`SessionModel.state.snapshots`, i.e. the `state`/`custom` events already folded from the
same stream, so it can be stale with the cockpit strip but never invents a number.

## `ContextPanel` — the snapshot exit

The rule it exists to enforce: **every `state`/`custom` snapshot has a visible exit.**
Known shapes get semantic rows (`context_budget`, `phase`, `status`/`done`, the queue
lanes, `goal_state`, `domain_usage`, `landing`, `hook_result`); everything else is dumped
raw into the last section, so a snapshot the runtime starts emitting later (e.g.
`todo_state`) shows up as data before it shows up as a design decision — never as
silence. Measured on a real archived session: `rev 4 · 29k/490k (窗口 524k) · 口径 实测 ·
预算状态 ready · 工具 17k · 输出预留 8.2k · 安全余量 26k`, bar at 6% with
`aria-valuenow="6"`, and the raw section holding exactly `delegation_snapshot`,
`job_snapshot`, `replay_window`.

Field reads go through `str`/`num` (the same total-helper style `SessionModel` uses)
rather than a cast to the contract interface: a renamed field then disappears from the
panel instead of throwing during render, which is the failure mode this app can survive.

## The streaming diff (Cline 三件套, plan §2.3)

Three pieces, each adapted to what this wire really carries:

| piece | what it is here | why not the literal Cline design |
|---|---|---|
| 增量写入 | `tool_use` open → the card takes a pending accent bar and shows what the model *asked* to write (`input.content` / `input.new_string`) | There is no input-delta event among the 56 protocol types, so a patch cannot arrive token-by-token without changing the kernel — a plan non-goal. `tool_use.input` does arrive whole and is never collapsed, so the intent is exact. |
| 实际改动 | `tool_result.uiContent` → `DiffBlock` + `+n −m` from `diffStats` | The prose receipt (`result`) **never** contains the patch. A client that renders only `result` shows "已写入 13 字节…" and drops the diff entirely — that was this client's real behavior until the uiContent capture. |
| 改前视图 | `GET /sessions/:id/git/file-base?path=<rel>`, fetched on first open of the disclosure | Asked only for a single-file mutator whose `file_path` resolves inside the session cwd. `apply_patch` / `ast_edit` have no one target file, so they get no disclosure at all. |

`toolFilePath` / `relativeToCwd` (client-core `tool-file.ts`) decide addressability;
`resolveAsk` / `loadBefore` (`before-view.ts`) do the fetch. Those live in JSX-free
modules so `node --test` can exercise all three baseline outcomes — `text`, `new`
(`exists:false`), and `failed` (the kernel answers **500**, not 403, for a path that
escapes the session cwd; treating that as an empty file would be a lie).

## Behavior worth not breaking

- Auto-follow stops as soon as the reader scrolls up; a stream that fights your scroll
  position is unreadable.
- Unknown/extra tool output renders as a terminal block; only text that actually looks
  like a unified diff renders as a diff (`looksLikePatch`, asserted in both the unit
  test and the live acceptance script).
- The server's own `outputTruncated` becomes `block.truncated` and shows the 2000-char
  wire-cap note; the client never invents its own truncation claim.

## Not in MVP

~~shiki 高亮~~ → 已接（`@tianshu/ui-primitives` 的 `highlight.ts`，MarkdownBlock 内完成后替换）。

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 1 个：`sessionFileBase`

| 面 | 消费内容 |
|---|---|
| 端点 | `GET /sessions/:id/git/file-base` |
| 事件类（wire 名） | `context_budget`、`domain_usage`、`done`、`error`、`goal_state`、`hook_result`、`landing`、`phase`、`queue_pending`、`queue_status`、`status`、`user` |
| 折叠块类型 | `error`、`text`、`thinking`、`tool`、`turn`、`user` |
| 宿主回调 props | `onLoadEarlier` |
<!-- protocol-ledger:end -->
