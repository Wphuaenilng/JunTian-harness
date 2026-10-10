# @tianshu/ui-approval

Three-state approval panel: **允许一次 / 始终允许 / 拒绝**.

## Protocol surface consumed

- **Shapes**: `ApprovalRequest { requestId, toolName, input, pathGrant? }`
  (`protocol-types.ts`), answer body `{ decision, editedInput?, remember? }`
  (`request-types.ts:ApprovalAnswerBody`, validated at
  `src/server/approval-routes.ts:17-20`).
- **Endpoints**: `GET /sessions/:id/interventions` (cold-start authority),
  `POST /sessions/:id/interventions/:requestId/answer`.
- **Event categories**: `lifecycle` — `approval_required`, `approval_resolved`,
  `approval_snapshot`.

## Mapping to the wire

| UI | request |
|---|---|
| 允许一次 | `{decision:'approve'}` |
| 始终允许 | `{decision:'approve', remember:true}` |
| 拒绝 | `{decision:'deny'}` |

`remember` is the sidecar's own grant-forward mechanism — the third state is not a
client-side invention, and there is no local "always" list to keep in sync.

## The stall rule

An approval that is not visible is a hung session (OpenCode #16367). Two tiers, both computed
by `describeWait` in `wait.ts` (so they are testable rather than observably-by-payment):

- **> 8 s** — a quiet `ua__hint`: 「已等待 N 秒」. This is the one a live run has actually shown
  (the real gate was answered at ~9 s).
- **>= 30 s (`stallAfterMs`, inclusive)** — the card turns loud: red border and 「这个会话正卡在这里，
  模型不会自己继续」. Worth saying out loud: **nothing had ever rendered this branch**, because
  seeing it meant reaching a real gate and deliberately not answering it, i.e. paying for a run
  and leaving it hanging. It is now pinned by `test/wait.test.ts` at 7 999 / 8 000 / 8 001 /
  29 999 / 30 000 ms, including "the alarm replaces the hint, never both" and "the threshold is
  a parameter". `syncArrivals` is tested alongside it because an id that is answered and later
  reappears must start a fresh clock — otherwise the panel would paint a brand-new gate as
  already stalled.

Silent waiting is not an option here.

`approval_snapshot` with an **empty** list must still clear the panel — pending state
survives event-ring eviction, so the snapshot, not the log, is ground truth.

## Verification status

Rendered and unit-tested through `SessionModel` (snapshot replace/clear, resolve); the three
button payloads are pinned by `test/answer.test.ts`. **Live-exercised on 2026-10-10**: a real
`write_file` gate reached this panel, 允许一次 was clicked, the server accepted it
(`approval_resolved` appears in that session's event log) and the tool result rendered with
its `+1 −0` diff. **Still not live**: 始终允许 (does `remember` really move the session's
approval mode?) and 拒绝 (is the tool genuinely not executed?) — each needs one more paid
upstream call, or the user clicking them while the event log is read afterwards.

- **兜底轮询不在本包**：宿主 `apps/web` 在一次 run 期间每 20 秒打一次 `GET /sessions/:id/interventions`
  （计划 §7 对 OpenCode #16367 那类静默挂死的另一半对策），快照经 `SessionModel.applySnapshot`
  落进来。轮询会带出一个纯事件流没有的顺序问题：在途响应可能来自用户点击**之前**的服务端状态，
  于是刚批准的闸会复活一个轮询周期。抑制逻辑在 client-core（本视图已 `approval_resolved` 的
  `requestId` 不再被任何入口放行），本包只渲染 `approvals`，不做自己的计时器去猜服务端状态。
- **三个按钮 → 什么字节，写在 `answer.ts` 里并被 5 条单测钉住**：服务端的回答路由是
  `const decision = data.decision ?? 'approve'`（`src/server/approval-routes.ts:16-21`）——
  **漏写 `decision` 就是放行**，所以「拒绝」必须显式带字段，这条不是一个风格问题而是安全语义。
  `answerFor('once'|'always'|'deny')` 因此单独成模块（无 JSX，`node:test` 进得来，沿用
  `before-view.ts` / `stall-watch.ts` 的做法）：一次 = `{decision:'approve'}` 且**完全不出现
  `remember` 键**；只有「始终允许」带 `remember:true`；三态载荷两两不同；渲染顺序 primary→always→deny。
  面板本身不持有计时器去猜服务端状态，也不在这里做二次确认。
- **仍然只在真会话里才能验的**：`remember` 是否真的把会话档位改了、拒绝后工具是否确实没执行。
  那是任务 #27，需要再打一发上游。

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 0 个（本包不直接打端点：数据与动作全部由宿主经 props 传入）

| 面 | 消费内容 |
|---|---|
| 端点 | — |
| 事件类（wire 名） | — |
| 折叠块类型 | — |
| 宿主回调 props | `onAnswer` |
<!-- protocol-ledger:end -->
