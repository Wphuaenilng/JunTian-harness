# 天枢 Web/桌面客户端自研计划

> 版本：v2.0 · 2026-10-09（v1.0 于 2026-10-08，本次纳入行业调研后修订）
> 依据：天枢 v3.28.0 公开仓源码实证（sidecar 协议）+ deepseek-harness 开源前端（MIT）+ 2026-10-09 行业调研（9 个开源 Agent 项目 + 协议标准）
> 配套调研：
> - `analysis-reports/项目文档与对比报告.md`
> - `analysis-reports/dsh-frontend-architecture.md`
> - `analysis-reports/2026-10-09-开源Agent客户端架构调研.md`
> - `analysis-reports/2026-10-09-agent-client-protocols.md`

---

## 1. 背景与目标

天枢（Tianshu-harness）的 agent 内核与 sidecar 接口完整开源（Apache-2.0），官方桌面端闭源、无 Web 端。sidecar（`rivet serve`，HTTP + SSE + Bearer token）完整暴露内核能力，VS Code 插件是现成的客户端范本。自研客户端 = 做一个 sidecar 前端，不碰内核。

| 阶段 | 目标 |
|---|---|
| MVP | 浏览器 Web 客户端：会话列表 + 对话 + 流式渲染 + 审批 |
| v1.0 | 完整工作台：历史分页、文件预览、Git 工作台、设置中心、定时任务看板 |
| v2.0 | 桌面化：Electron 壳（一个前端产物，两种宿主）+ AG-UI 适配端点 |

**非目标**：不修改天枢内核与 sidecar 源码；不引入 dsh 的 Cordis/Typert；不自造协议标准。

---

## 2. 行业调研结论（2026-10-09，本次新增）

调研了 9 个开源 Agent 项目（OpenCode、Aider、Cline/Roo Code、OpenHands、Gemini CLI、Codex CLI、Goose、Crush 等）与 5 个协议标准（ACP、AG-UI、Vercel AI SDK、MCP Apps、ChatKit）。四条核心判断：

### 2.1 sidecar 路线被行业验证为主流 ✅

OpenCode（Hono HTTP + SSE 事件总线）、OpenHands（REST + Socket.IO）、Goose（goosed REST+SSE，103 端点）全部收敛到「内核 + HTTP/SSE 服务 + 多客户端」形态。天枢的 sidecar 架构与 2026 年行业主流完全一致，自研客户端的路线没有方向性风险。

### 2.2 最大的反面教材：Goose 双轨制

Goose 的 CLI 进程内直调 + 桌面端走 REST 的双轨，导致每个功能做两遍，官方正在删 goosed、统一到 ACP 单协议；Codex CLI 的经验是**五种前端（含 TUI）全部走同一协议，不直连内核**。
→ **对我们的铁律：自研客户端只走 sidecar 协议，绝不引入任何旁路通道**（如直接读 `~/.rivet` 文件、直连 SQLite）。

### 2.3 直接可用的设计资产

| 来源 | 设计点 | 采纳优先级 |
|---|---|---|
| OpenHands | **last-event-id 断线续传 + REST 历史/SSE 增量在 store 去重合并**——与我们 seq 重连设计同构，验证可行 | P0（已入设计） |
| OpenCode / Codex | **schema/类型先行**：单一事实源生成客户端 TS 类型（Codex 用 ts-rs，OpenCode 用 OpenAPI） | P0：从 `src/server/protocol.ts` 半自动生成类型镜像，替代纯手工抄 |
| Cline | **流式 diff 三件套**（virtual document 改前视图 + 增量写入 + 行进度装饰）；**影子 git checkpoint** | P1：天枢内核已有 checkpoint/rewind，客户端只需做展示与触发（`/rewind-points` + `/rewind` 端点现成） |
| Cline / Roo | 审批三态 **once / always / reject**；Roo「Mode = 权限集」 | P1：天枢审批回执已支持 `remember`，UI 做三态即可 |
| Aider | git 即审批/回滚体系，不自建 diff 面板 | 参考：客户端 diff 展示从简，深度操作交给 Git 工作台 |
| Crush | 渲染美学是差异化竞争力 | P2：自研原语 + CSS token，视觉不凑合 |
| OpenCode | `/tui` 反向控制端点（server 驱动客户端 UI） | P2（可选） |
| OpenCode | 已知坑：headless 模式下 ask 权限静默挂死（issue #16367） | 规避：客户端审批挂起时必须有可见的超时/提醒 UI |

### 2.4 协议标准格局：分层已定，选型收敛

- **ACP**（Zed 主导，JSON-RPC over stdio）：编辑器↔agent 垂直标准，25+ agent 接入、JetBrains 全系原生，但 **VS Code 无官方实现**是天花板。dsh 官方 ACP 阉割成「仅自动化」被社区完整版取代——教训：要么不做，要么做全。
- **AG-UI**（CopilotKit）：**2026-09-30 刚发 1.0**，~16 事件 5 大类（lifecycle/text/tool/state/custom）over HTTP POST + SSE，与天枢 sidecar（44 事件 + seq 重连 + 审批回执）**架构同构**；微软贡献 .NET SDK、AWS AgentCore 原生支持。
- **Vercel AI SDK**：「每消息一次 POST、流随请求生灭」模型与天枢常驻连接 + seq 重连根本不合——**只借渲染层（UIMessage.parts 分块模型），不借协议**。
- **MCP Apps**（SEP-1865，2026-01-26 转正）：工具返回沙箱 iframe UI 的标准——对客户端是一个**功能需求**（预留 iframe 容器 + postMessage 桥），不是协议选型。
- ChatKit 绑定 OpenAI 生态且 Agent Builder 已宣布弃用，不构成选项。

---

## 3. 协议选型定案（v2.0 核心修订）

**选项 B：私有协议为主 + 事件模型向 AG-UI 1.0 对齐 + ACP 后置。**

```
┌─ client-core ────────────────────────────────┐
│  传输层：天枢 sidecar REST + SSE（唯一通道）    │
│  事件层：44 种 sidecar 事件                    │
│    → 适配为 AG-UI 五大类内部管线：              │
│      lifecycle / text / tool / state / custom │
│  类型层：从 protocol.ts 半自动生成镜像          │
└───────────────────────────────────────────────┘
```

- **传输绑定私有协议**（不动 sidecar）：seq 重连、审批回执等核心语义 AG-UI 没有等价物，强套会丢能力；
- **内部事件管线按 AG-UI 五大类组织**：44 种事件在 client-core 边界处映射归类，UI 层只面对五类——降低 UI 复杂度，且为未来输出 AG-UI 兼容端点留好结构；
- **v2.0 交付 AG-UI 适配端点**：在客户端同源伺服层把内部五类事件反向序列化为标准 AG-UI 流，让 CopilotKit 生态组件可直接消费；
- **ACP 适配层后置**：作为面向 Zed/JetBrains 的独立分发项目（参照社区版 `deepseek-harness-acp` 的完整映射路线），不进本计划主线；VS Code 场景已有官方插件，ACP 边际价值低。

---

## 4. 架构设计

### 4.1 总体结构

```
┌─────────────────────────────────────────────┐
│  apps/web（浏览器）   apps/desktop（Electron）│  ← 同一前端产物
├─────────────────────────────────────────────┤
│  ui-* 业务包：chat / approval / session-list │
│  / tool-card / settings / git（v1.0 起）      │
│  只面对 AG-UI 五类事件，不见 sidecar 原始协议  │
├─────────────────────────────────────────────┤
│  client-core：sidecar REST/SSE + 连接世代     │
│  + seq 去重重连 + 44→5 事件适配 + 类型镜像    │
│  （唯一耦合天枢协议处）                        │
├─────────────────────────────────────────────┤
│  同源伺服层：静态伺服 + 反代 sidecar          │
│  + token 注入 + （v2.0）AG-UI 端点输出        │
├─────────────────────────────────────────────┤
│  rivet serve（天枢 sidecar，不动它）          │
└─────────────────────────────────────────────┘
```

### 4.2 分包方案（pnpm monorepo，约 10 包）

| 包 | 职责 | 借鉴对象 |
|---|---|---|
| `client-core` | sidecar REST/SSE 客户端、连接世代、seq 去重、44→5 事件适配、类型镜像生成器 | dsh `connection` + 天枢插件 `client.ts` + Codex ts-rs 思路 |
| `store` | zustand/vanilla + immer、rAF 合帧、持久化 | dsh `store` |
| `ui-primitives` | 增量 markdown、shiki 高亮、DiffBlock、TerminalBlock、iframe 沙箱容器（MCP Apps 预留） | dsh `ui-primitives` |
| `ui-theme` | CSS 变量 token、boot 防闪烁脚本 | dsh `ui-theme` + Crush 美学标准 |
| `locale` | 扁平字典 zh/en | dsh `locale` |
| `ui-chat` | PartialAccumulator 流式折叠、工具调用树、thinking 折叠、流式 diff（Cline 三件套思路） | dsh `ui-chat` + Cline |
| `ui-approval` | 三态审批面板（允许一次/始终允许/拒绝）、挂起超时提醒 | dsh `ui-approval` + Roo |
| `ui-session` | 会话列表、新建/归档、全局失效订阅 | dsh `ui-session` |
| `ui-settings` | provider/密钥/模型/审批档（Mode 权限集思路）（v1.0） | dsh `ui-settings-*` + Roo |
| `apps/web` + `apps/desktop` | 组装入口与 Electron 壳 | dsh `apps/*` |

依赖纪律：业务包禁止互相 import，共享只走 `import type` 与 client-core 服务。

### 4.3 状态同步核心设计

融合 dsh 连接世代、天枢 seq 语义、OpenHands 重连范式（三者同构，互为印证）：

1. **连接世代**：每次 SSE 建连为一个世代。建连序列：`replay_window`（seq=0）→ 回放事件**原子替换**会话窗口 → `approval_snapshot`（seq=0）→ live。世代切换旧订阅整体作废。
2. **断线重连**：lastSeq 记录（seq=0 不推进），断开按 `?since=<lastSeq>` 重连，指数退避 500ms→10s 加抖动；`seq<=lastSeq` 丢弃；REST 兜底快照与 SSE 增量在 Session 对象层去重合并（OpenHands 范式）。
3. **流式渲染**：增量事件 fold 成不可变块数组（PartialAccumulator）；markdown 只重解析尾部 2 个不稳定块；通知三档节拍（立即/微任务/rAF）。
4. **业务数据不进全局 store**：会话消息流在 React-free 的 Session 对象层，组件经唯一 uSES 绑定订阅；store 只放视图状态。
5. **事件五类化**：44 种 sidecar 事件在 client-core 边界映射为 lifecycle（`phase`/`done`/`status`/`error`…）、text（`text_delta`/`thinking_delta`/`user`）、tool（`tool_use`/`tool_result`/`artifact`…）、state（`todo_state`/`context_budget`/`plan_*`…）、custom（星域/zen 等天枢特有）——UI 组件按类订阅。

### 4.4 部署形态

| 形态 | 方案 |
|---|---|
| 开发 | `vite dev` + proxy 转发 `/api/*` 并注入 `Authorization` |
| Web 生产 | `serve-client.mjs`：同源静态伺服 + 反代 sidecar（无 CORS、token 不出 Node 进程） |
| 桌面 | Electron 壳：spawn `rivet serve`（随机端口/token，env 注入）→ 内嵌同源伺服 → `loadURL`；preload 只暴露窗口控制/文件对话框（dsh 壳模式） |

---

## 5. 可行性依据与已识别的坑

### 5.1 sidecar 协议面（已实证，详见 v1.0 调研）

- 启动：`RIVET_SERVER_TOKEN=<hex> RIVET_DESKTOP_DIR=<独立目录> node dist/cli/entry.js serve --port <空闲端口>`；
- 握手：`GET /health` → `protocolVersion` + `capabilities`（**问能力不问版本**）；
- MVP 必需 10 个端点：`GET /health`、`GET|POST /sessions`、`GET /sessions/:id`、`POST /sessions/:id/prompt`（409 busy 配 `/queue`）、`GET /sessions/:id/stream?since=N`、`POST /sessions/:id/abort`、`GET|POST /sessions/:id/interventions(/:requestId/answer)`、`GET /sessions/:id/events`、`GET /events`；
- 可直接移植：`vscode-extension/src/sidecar/client.ts`（457 行）、`protocol.ts`、`stream-accept.ts`（9 行去重）。

### 5.2 已识别的坑

1. **StoreLock 单写者独占**：必须 `RIVET_DESKTOP_DIR` 隔离（启动脚本固化）；
2. **CORS**：白名单只反射 tauri origin——生产用同源伺服彻底绕开；
3. **token 不落前端**：由同源伺服层注入（插件经验：token 不进 webview）；
4. **无正式 API 文档**：`src/server/protocol.ts` 是唯一契约事实源——类型镜像做半自动生成 + CI 漂移检测；
5. **审批挂死**（OpenCode 教训）：审批挂起超过阈值时 UI 必须有显式提醒，不能静默等待；
6. **绝不旁路**：不读 `~/.rivet` 文件、不直连 SQLite（Goose 双轨教训）。

---

## 6. 里程碑与任务分解

### M0 验证 spike（1–2 天）

- [ ] 启动脚本固化（随机端口/token + `RIVET_DESKTOP_DIR` 隔离 + CORS 开发开关）；
- [ ] `GET /health` 握手确认 `protocolVersion`/`capabilities`；
- [ ] 单 HTML 页直连 SSE 收发一条真实消息（先配好一个 provider API key）；
- [ ] 验收：浏览器看到流式 `text_delta` 与 `turn_complete`。

### M1 MVP（1–2 周）：会话 + 对话 + 流式 + 审批

- [ ] `client-core`：REST + SSE + 世代/去重/重连 + **44→5 事件适配层** + 类型镜像半自动生成脚本（读 `protocol.ts` 产出 TS 类型 + 漂移 diff 报告）；
- [ ] `ui-session`：会话列表（`/sessions` + `/events` 失效刷新）、新建、归档；
- [ ] `ui-chat`：PartialAccumulator、增量 markdown、工具调用卡片、thinking 折叠、busy 走 `/queue`（输入不丢）；
- [ ] `ui-approval`：**三态面板**（允许一次/始终允许=remember/拒绝）+ 挂起 30s 显式提醒 + 冷启动补 `approval_snapshot`；
- [ ] `/abort` 中止、错误条、`status` 事件展示；
- [ ] 验收：完整跑通「建会话 → 改一个文件 → 审批放行 → 看到工具结果 diff」。

### M2 v1.0（2–4 周）：工作台

- [ ] 历史向上分页（`/events?before=`，由 `replay_window` 触发）；
- [ ] **流式 diff**（Cline 三件套思路：改前视图 + 增量写入 + 行进度装饰）；
- [ ] **影子 checkpoint 面板**（`/rewind-points` + `/rewind`，时间旅行可视化）；
- [ ] 会话搜索、改名、文件预览、@file 候选；
- [ ] Git 工作台（`/git/workbench/*`）、PR 流；
- [ ] 设置中心（`/config/*`，审批档做「Mode 权限集」式预设）；
- [ ] 定时任务看板（`/schedule` + `/tasks`）；
- [ ] Cockpit 快照条（`/sessions/:id/cockpit`）；
- [ ] **MCP Apps 预留**：工具结果区支持沙箱 iframe + postMessage 桥；
- [ ] i18n 双语 + 明暗主题。

### M3 v2.0（1–2 周）：桌面化 + 协议输出

- [ ] Electron 壳（spawn sidecar + 同源伺服 + loadURL）、托盘、单实例锁；
- [ ] electron-builder 出 Windows 安装包；
- [ ] **AG-UI 适配端点**：同源伺服层输出标准 AG-UI 事件流，CopilotKit 组件可直挂；
- [ ] （可选）E4 客户端工具委托：原生 diff 接受/拒绝、可见终端（照插件 `delegation/executor.ts`）；
- [ ] （可选，独立项目）ACP 适配层，面向 Zed/JetBrains 分发——**做就做完整版**，不重复 dsh 阉割版的教训。

### 贯穿项

- 协议漂移监控 CI：类型镜像 diff + 「握手 + 建会话 + 发消息」冒烟（sidecar 无 key 可起）；
- 每个 `ui-*` 包 README 记录消费的端点与事件类（协议消费台账）。

---

## 7. 风险与对策（v2.0 更新）

| 风险 | 等级 | 对策 |
|---|---|---|
| sidecar 协议无正式文档，未来 breaking | 中 | 类型镜像半自动生成 + CI 漂移检测；capabilities 协商；未知事件忽略 |
| StoreLock 与官方端抢会话库 | 高（必踩） | `RIVET_DESKTOP_DIR` 隔离，启动脚本固化 |
| CORS 限制浏览器直连 | 中 | 同源伺服，不依赖 `RIVET_DEV_CORS_ORIGINS` |
| 审批静默挂死（OpenCode 同款坑） | 中 | 挂起超时显式提醒 + `/interventions` 快照兜底轮询 |
| 44 种事件渲染工作量低估 | 中 | 五类化适配 + MVP 只消费 12 种最小集，其余容错忽略 |
| AG-UI 1.0 刚发布，治理为单一公司 | 低 | 只做内部事件模型对齐 + 适配端点输出，不做协议绑定；适配层可整体摘除 |
| 官方桌面端未来开源/协议剧变 | 低 | Web 端价值独立成立；ACP 适配层作为独立项目隔离风险 |

---

## 8. 技术选型定案

| 层 | 选型 | 理由 |
|---|---|---|
| 构建 | pnpm monorepo + Vite + tsdown | 与 dsh 同栈，参考成本最低 |
| UI | React 18 + CSS Modules（禁组件库） | 自研原语 + CSS token，视觉差异化（Crush 启示） |
| 状态 | zustand/vanilla + immer，业务数据在 React-free 对象层 | dsh 三层状态边界 |
| markdown | micromark 系（块级增量解析） | 流式渲染 O(n²) 陷阱的唯一解法 |
| 高亮 | shiki | 与增量 markdown 兼容好 |
| 消息模型 | 内部借鉴 Vercel AI SDK `UIMessage.parts` 分块 | 生态事实标准，仅借渲染模型不借协议 |
| 桌面壳 | Electron | dsh 壳模式可直接平移；Tauri 需 Rust 工具链，超范围 |
| 语言 | TypeScript strict，全 ESM | 与两侧上游一致 |

---

## 9. 验收标准（Definition of Done）

- **MVP**：无官方桌面端参与，浏览器完成一次完整编码任务（含三态审批），断网 10 秒恢复后事件不丢不重；
- **v1.0**：日常开发可完全替代官方桌面端核心流程（会话/审批/Git/设置/定时任务）；协议漂移 CI 全绿；
- **v2.0**：Windows 安装包双击即用，与 CLI 共享配置但会话库隔离；AG-UI 端点被 CopilotKit 示例消费成功。

---

## 附：调研证据索引

- sidecar 协议面：`src/server/protocol.ts`（44 种事件契约事实源）、`serve.ts`、`session-routes.ts`、`approval-routes.ts`、`auth.ts`、`cors.ts`
- 客户端范本：`vscode-extension/src/sidecar/`（launcher/client/protocol/stream-accept/subscription-gate）、`src/chat/`、`src/delegation/`
- dsh 前端：`deepseek-harness/packages/client/`、`apps/web`、`apps/desktop`；详见 `analysis-reports/dsh-frontend-architecture.md`
- 行业调研：`analysis-reports/2026-10-09-开源Agent客户端架构调研.md`（9 个项目拆解）、`analysis-reports/2026-10-09-agent-client-protocols.md`（协议标准）
