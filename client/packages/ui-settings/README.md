# @tianshu/ui-settings

Settings center: approval mode, default model, providers/keys, star domains.

It receives a `SidecarClient` (a client-core **service**) rather than a bag of props —
plan §4.2 allows exactly two cross-package channels, `import type` and client-core
services, and settings has a dozen independently-loading fields.

## Endpoints consumed

| Endpoint | Use |
|---|---|
| `GET/PUT /config/approval` | 审批档 (4 modes = permission sets) |
| `GET/PUT /config/default-model` | default model, `provider:modelId` form |
| `GET /config/providers` | provider list, baseUrl, **masked** key status |
| `POST /config/providers/:name/default` | 设为默认 |
| `PUT /config/providers/:name/keys/:keyId/key` | write a key into one slot |
| `GET /config/default-domain` | 星域 default + catalogue |

## Rules

- **Never read a key back.** The server masks it (`keyStatus.ref` observed as
  `***11c8`); there is no GET-plaintext path to misuse, and none should be added.
- Key inputs are `type=password`, `autoComplete=off`, and go straight to the sidecar —
  a key must not land in the view store, `localStorage`, or any log line.
- `apiKey` / `apiKeyEnv` are mutually exclusive server-side
  (`config-routes-keys.ts:137`); `SetKeyRequest` encodes that instead of letting the UI
  discover it via a 400.
- Approval vocabulary is the contract's `ApprovalMode` (`src/server/protocol.ts:71`); a session may
  still override it via `SessionRecord.approvalMode`.

## Verified

Read paths and approval/model/default-provider writes were exercised against a live
sidecar; the key-write path was exercised against a throwaway custom provider that was
deleted afterwards, so the in-use `deepseek` key was never touched.

<!-- protocol-ledger:start -->
## 协议消费台账（由 `node scripts/protocol-ledger.mjs --write` 从代码生成，勿手改）

口径说明：这里记的是**本包源码里的直接调用点**。面板常经 props 拿数据和触发动作，那种情况下端点由宿主 `apps/web` 或
`@tianshu/client-core` 消费，本表如实显示为空——不是缺口。正文里手写的端点表可以描述周边界面，但它不构成台账。

调用点 8 个：`getApprovalConfig`、`getDefaultModelConfig`、`getDomainConfig`、`getProviders`、`setApprovalConfig`、`setDefaultModelConfig`、`setDefaultProvider`、`setProviderKey`

| 面 | 消费内容 |
|---|---|
| 端点 | `GET /config/approval`、`GET /config/default-domain`、`GET /config/default-model`、`GET /config/providers`、`POST /config/providers/:name/default`、`PUT /config/approval`、`PUT /config/default-model`、`PUT /config/providers/:name/keys/:keyId/key` |
| 事件类（wire 名） | — |
| 折叠块类型 | — |
| 宿主回调 props | `onClose`、`onSave` |
<!-- protocol-ledger:end -->
