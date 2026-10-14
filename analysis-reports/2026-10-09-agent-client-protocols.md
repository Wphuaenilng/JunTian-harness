# 2026 AI Agent 客户端-服务端通信协议标准与 SDK 调研

> 调研日期：2026-10-09
> 目的：为天枢（Tianshu-harness）自研 sidecar（HTTP+SSE，44 种事件、seq 重连、审批回执）开发 Web/桌面客户端时，决定 client-core 层采用私有协议绑定还是适配开放标准。
> 方法：WebSearch + FetchURL，关键结论均附来源 URL。

---

## 0. TL;DR

2026 年的 agent 协议栈已经明显分层定型：**MCP（agent↔工具）、A2A（agent↔agent）、AG-UI（agent↔用户界面）** 三层各归其位；**ACP（Agent Client Protocol）** 则是「编辑器↔编码 agent」这条垂直赛道的独立标准，业内称「agent 版 LSP」。对天枢 Web 客户端而言：**AG-UI 是与天枢 sidecar 协议同构度最高、最值得对齐的标准；ACP 解决的是编辑器分发问题而非 Web 客户端问题；Vercel AI SDK 的 UI 流协议是 React 生态的事实标准但与会话模型不匹配**。最终建议见第 8 节：**私有协议为主 + 事件模型向 AG-UI 对齐 + ACP 适配层作为独立的编辑器分发项目后置**。

---

## 1. ACP（Agent Client Protocol，Zed 主导）

### 1.1 状态与治理

- Zed 创建，2025 年 8 月正式发布，Apache-2.0 许可；JetBrains 于 2025 年 10-12 月加入共同开发。被称为「AI 编码的 LSP」。
  来源：https://rywalker.com/research/zed-agent-client-protocol ；https://tech-insider.org/zed-vs-vscode-2026/
- 2026 年 1 月 28 日 Zed 与 JetBrains 联合上线 **ACP Agent Registry**（agent 分发注册表），首批包括 Kimi CLI、goose、Augment Code、Factory Droid、Gemini CLI、GitHub Copilot CLI、Mistral Vibe、OpenCode、Qwen Code 等；2026 年 3 月 Cursor 也以 ACP agent 身份进入 JetBrains IDE。
  来源：https://blog.csdn.net/github_38592071/article/details/160907640 ；https://www.buildthisnow.com/blog/tools/extensions/claude-code-vs-zed
- 注意命名冲突：IBM 的 Agent Communication Protocol（也叫 ACP）已于 2025 年 8 月并入 Google 的 A2A 并归档，「ACP」这个缩写现在事实上归 Zed 的协议。
  来源：https://rywalker.com/research/zed-agent-client-protocol

### 1.2 采用度（2026 年中实际出货情况）

- **编辑器侧**：Zed 原生（参考实现，Zed 1.0 于 2026-04-29 发布）；JetBrains 全系 IDE（IntelliJ/PyCharm/WebStorm 等，经 AI Assistant）；Neovim（CodeCompanion、avante.nvim 等多个社区插件）；Emacs（agent-shell）；Sublime/Qt Creator/Obsidian/Pulsar 有社区客户端。**VS Code 只有第三方扩展，微软官方未实现**——这是一个重要的边界。
- **Agent 侧**：Gemini CLI（首发伙伴+参考实现）、Claude Code（经 Zed 官方维护的 `@zed-industries/claude-code-acp` 适配器）、Codex CLI（适配器）、Goose（原生）、GitHub Copilot CLI（2026 年 1 月 public preview）、Cursor、Kimi CLI 等，合计 25+ agent。
  来源：https://www.ayautomate.com/blog/agent-client-protocol-vs-mcp ；https://awesomeagents.ai/tools/best-ai-coding-ides-2026/ ；https://tech-insider.org/zed-vs-vscode-2026/

### 1.3 协议核心模型（官方规范已核实）

- **JSON-RPC 2.0**，方法（请求-响应）+ 通知（单向）；agent 通常作为 client 的**子进程经 stdio** 通信。
- 流程：`initialize`（版本与能力协商）→（可选 `authenticate`）→ `session/new` 或 `session/load` → `session/prompt` 发起一轮；agent 侧经 **`session/update` 通知**推送进度（文本块、工具调用、计划、思考），经 **`session/request_permission`** 向客户端请求权限，可调用客户端的 fs 读写与 terminal 方法；`session/cancel` 中断；`session/prompt` 响应携带 stop reason 结束本轮。
- 扩展机制：`_meta` 字段、下划线前缀自定义方法、能力声明。官方提供 Test Compatibility Kit。
  来源（官方规范，本轮 FetchURL 直接核实）：https://agentclientprotocol.com/protocol/overview

### 1.4 天枢竞品参照：deepseek-harness 的 ACP 实践

- 官方 `@deepseek-ai/dsh-acp` 定位为**仅自动化**的 ACP server（JSON-RPC stdio）：刻意不暴露流式 token、工具展示、MCP、会话回放、权限弹窗等交互能力，主要供进程外 subagent 用。官方曾做过完整编辑器桥接，2026-07-24 因产品定位主动移除。
- 社区随即出现 `@openma/deepseek-harness-acp` 等**完整编辑器适配器**，把流式文本、推理、工具 diff、权限请求、斜杠命令、MCP 全部映射到 ACP 词表，可接入 Zed。
- **教训**：① ACP 适配层的工作量是有界的、社区可复制的；② 能力阉割的官方实现会被社区 fork 取代——要么不做，要么做全。
  来源：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md ；https://github.com/xintaofei/deepseek-acp ；https://blog.yeyupiaoling.cn/article/1786985943234

### 1.5 若天枢要兼容 ACP，需要做什么

实现一个 ACP server（stdio JSON-RPC 2.0）：把天枢的会话生命周期映射到 `session/new|load|prompt|cancel`，把 44 种 sidecar 事件映射到 `session/update` 的 content block 词表（agent_message_chunk、tool_call、plan、thought 等），把审批回执映射到 `session/request_permission` 的 allow_once/allow_always 选项模型。注意 ACP 假设 agent 是**编辑器拉起的子进程**（stdio），与天枢「常驻 sidecar + 多客户端连接」的模型存在架构差异——适配层需要处理「每客户端一进程 vs 共享 sidecar」的阻抗匹配。**ACP 是编辑器分发渠道，不是 Web 客户端协议**（无浏览器传输、无 SSE、会话模型绑定编辑器能力）。

### 1.6 成熟度风险

治理方是 Zed Industries + JetBrains 两家公司（非基金会）；协议演进快但已有 Registry 和兼容测试套件；VS Code 缺位是最大生态变量——若微软长期不接，ACP 天花板是「JetBrains + 开源编辑器圈」。

---

## 2. AG-UI（Agent-User Interaction Protocol，CopilotKit 主导）

### 2.1 状态与治理

- 2025 年 5 月 12 日发布，MIT 许可，独立仓库 `ag-ui-protocol/ag-ui`；**2026 年 9 月 30 日发布 AG-UI 1.0**（JSON Schema 背书规范，TS/Python/.NET SDK，其中 .NET SDK 由微软 2026-09-25 官方贡献）。GitHub ~15.7k stars，日活提交。
- 治理方是 CopilotKit（西雅图创业公司，2026 年 5 月完成 2700 万美元 A 轮）——**单一风投支持公司主导是主要的治理风险**，但 MIT 许可 + 多方 SDK 贡献（微软直接进仓）缓解了锁定担忧。
  来源：https://devblogs.microsoft.com/dotnet/ag-ui-dotnet-sdk/ ；https://www.whetstoneai.io/ ；https://rywalker.com/research/ag-ui ；https://agenticweb.wiki/protocols/ag-ui/

### 2.2 采用度

第一方集成：Microsoft Agent Framework、Google ADK、AWS Strands Agents、**Amazon Bedrock AgentCore（2026 年 3 月原生支持）**、Oracle（Open Agent Specification）、LangGraph、CrewAI、Mastra、PydanticAI、Agno、LlamaIndex、AG2、Vercel AI SDK。CopilotKit 宣称周下载量数百万、大量财富 500 强生产使用（注：采用数据来自项目方自述）。
  来源：https://alatirok.com/what-is-ag-ui-protocol/ ；https://info.datadowell.com/rgzn/0-1779268374735.html ；https://ai.miraheze.org/wiki/Agent-User_Interaction_Protocol

### 2.3 协议核心模型

- **一次 HTTP POST 输入 → 一条有序类型化事件流出**，默认 SSE，可选 WebSocket/二进制/webhook。
- ~16 种标准事件、5 大类：
  - Lifecycle：`RUN_STARTED / RUN_FINISHED / RUN_ERROR / STEP_STARTED / STEP_FINISHED`
  - Text Message：`TEXT_MESSAGE_START / CONTENT / END`
  - Tool Call：`TOOL_CALL_START / ARGS / END / RESULT`
  - State：`STATE_SNAPSHOT / STATE_DELTA / MESSAGES_SNAPSHOT`（共享状态双向同步）
  - Special：`RAW / CUSTOM`（逃生舱）
- 1.0 新增：subagent 追踪、多模态工具结果（图/音/视频/文档）、HITL interrupt（暂停 run 等人工输入）、token 用量上报、reasoning/activity 事件。
  来源：https://alatirok.com/what-is-ag-ui-protocol/ ；https://www.smfclearinghouse.com/blog/ag-ui-1-0-the-open-protocol-connecting-ai-agents-to-your-app/

### 2.4 与天枢 sidecar 协议的同构性（本调研的核心发现之一）

天枢的「HTTP+SSE + 44 种事件 + seq 重连 + 审批回执」与 AG-UI 在架构上是**同构**的：都是「POST 触发 + SSE 有序事件流 + 状态同步 + 人在回路」。差异在词表和细节：AG-UI 没有内建的 seq 断线重连语义（依赖传输层/客户端自己管）和审批回执的一等事件（1.0 的 interrupt 是最接近的概念）。**44 种私有事件可以按 AG-UI 五大类做无损分组映射**，私有细节放进 `CUSTOM`/`RAW` 事件。

### 2.5 若天枢 Web 客户端要兼容 AG-UI，需要做什么

两条路（可叠加）：
1. **客户端侧对齐**：client-core 内部事件模型按 AG-UI 五大类重命名/分组，sidecar 协议不变——零服务端成本，换来未来互操作空间；
2. **服务端适配端点**：sidecar 增加一个 `/ag-ui` 适配端点，把天枢事件流实时转译为 AG-UI 事件流——之后 CopilotKit 的 React 组件库、assistant-ui 及任何 AG-UI 客户端可直接接入，天枢 agent 也能被 AG-UI 生态的工具链（可观测性、测试）消费。

### 2.6 成熟度风险

1.0 刚发布（2026-09-30），词表仍在吸收新事件类型；治理集中于一家创业公司；「Google/微软/AWS 采用」的口径主要来自项目方。但整体是 agent↔UI 层目前采用面最广、动力最足的候选。

---

## 3. Vercel AI SDK 的 UI 协议（useChat / UI Message Stream）

### 3.1 状态

- AI SDK 5（2025-07-31）起流式传输**标准化为 SSE**（此前是自定义行协议）；当前主版本已到 `ai@^7`（@ai-sdk/react@^4）。协议标识：响应头 `x-vercel-ai-ui-message-stream: v1`，事件为 SSE `data:` 帧（`start`、`text-delta`、`tool-input-*`、`finish`、自定义 `data-*` 部分），`[DONE]` 结束。
- 架构要点：`ModelMessage`（喂给模型）与 `UIMessage`（前端状态，含 parts：text/tool/data/reasoning）分离；服务端 `toUIMessageStreamResponse()` 是协议转换点；前端 `useChat` + **可插拔 Transport**（`DefaultChatTransport` 或自定义）。
  来源：https://vercel.com/blog/ai-sdk-5 ；https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol ；https://www.assistant-ui.com/docs/runtimes/ai-sdk/overview ；https://www.joyehuang.me/en/notes/0426-vercel-ai-sdk-message-types

### 3.2 采用度

React/Next.js 生态 Web 聊天前端的**事实标准**；Pydantic AI 官方提供 `VercelAIAdapter`（Python 后端直接吐 Vercel 协议）；assistant-ui 等组件库以其为主要 runtime。Vue/Svelte/Angular 均已对齐。
  来源：https://pydantic.dev/docs/ai/integrations/ui/vercel-ai/

### 3.3 与天枢的匹配度评估

- **契合点**：SSE 传输一致；UIMessage.parts 的 typed parts 模型（text/tool/data）对天枢前端渲染层有参考价值。
- **不契合点**：① 其模型是**「每次发消息一次 POST、流随请求生灭」**——没有常驻连接、没有跨请求的事件序号与断线重放，与天枢 seq 重连模型根本不同；② 审批/HITL 不是协议一等公民；③ 强绑定「前端驱动对话」的聊天场景，不覆盖 agent 自主长跑、多客户端旁观等场景。
- **若要兼容**：sidecar 增加一个把「一次 prompt」投影为「一次 UI message stream」的适配端点（Pydantic AI 即此模式），供前端直接用 `useChat`；或者保留私有协议、给 `useChat` 写自定义 Transport。**前者会失去 seq 重连与审批回执，后者则只是借用其 UI 状态管理**。

---

## 4. MCP UI / MCP Apps（MCP 的 UI 扩展）

### 4.1 状态与模型

- 谱系：社区项目 mcp-ui（Ido Salomon、Liad Yosef）+ OpenAI Apps SDK（2025 年 10 月 DevDay）两条线汇合 → **SEP-1865「MCP Apps」**，2025-11-21 并入规范，**2026-01-26 作为 MCP 首个官方扩展转正**（扩展标识 `io.modelcontextprotocol/ui`）。MCP 2026-07-28 规范把扩展机制升为一等能力。
- 模型：工具在定义的 `_meta.ui.resourceUri` 里声明 UI 资源（`ui://` URI scheme，MIME `text/html;profile=mcp-app`）；host 在**沙箱 iframe** 中渲染（CSP 声明 + 权限白名单）；UI 与 host 之间走 MCP 自己的 JSON-RPC（postMessage）。注意扁平键 `_meta["ui/resourceUri"]` 已废弃，用嵌套式。
- Host 支持：Claude（web/桌面/移动）、ChatGPT、VS Code、Goose、Postman；连接器生态（Asana、Figma、Canva、Hex、Slack 等）已上线。
  来源：https://www.ayautomate.com/blog/mcp-apps ；https://mcp.directory/blog/mcp-apps-spec-2026-when-should-your-server-render-ui ；https://ecorpit.com/mcp-apps-server-rendered-ui-extension-build-guide-2026/ ；https://note.com/ai_driven/n/nb84a6fa13b64

### 4.2 对天枢的意义

MCP Apps 解决的是 **agent↔工具** 的「工具结果需要富交互界面」问题，不是 client↔server 协议。对天枢的相关性在于：若天枢作为 MCP host（或计划支持），其 Web/桌面客户端就是天然的 MCP Apps 渲染面——**客户端需要预留沙箱 iframe + postMessage JSON-RPC 桥的能力**，这是 client-core 的一个功能需求而非协议选型。

---

## 5. OpenAI ChatKit / Apps SDK

- 2025-10-06 随 AgentKit 发布：Agent Builder（可视化画布）、**ChatKit**（可嵌入聊天 UI + 开源 Python SDK，可接自研后端）、Connector Registry。Apps SDK 构建在 MCP 之上，经 `window.openai` API 让 widget 与 ChatGPT 交互。
- 2026 年重大变化：**Agent Builder 于 2026-06-03 宣布弃用、2026-11-30 关停**；ChatKit 保留，官方指引是「ChatKit 前端 + 你自己的服务端 agent」。OpenAI 的 UI 标准化努力事实上已并入 MCP Apps。
  来源：https://developers.openai.com/api/docs/guides/chatkit ；https://gravity.fast/blog/openai-agent-builder-explained/ ；https://www.eesel.ai/blog/chatkit-js-methods-events ；https://o-mega.ai/articles/mcp-2026-spec-stateless-apps-and-tasks
- 对天枢的意义：**不构成可选协议**——ChatKit 绑定 OpenAI 生态（Python SDK + OpenAI 后端假设），Apps SDK 的正统继承者是 MCP Apps。值得借鉴的是其 widget 目录式设计（agent 返回受限组件而非任意 HTML 的安全模型）。

---

## 6. 其他标准简评

- **A2A（Google → Linux Foundation/AAIF）**：agent↔agent 协议。2025-04 发布、2025-06 捐给 LF、**v1.0 于 2026-03-12 发布**（签名 Agent Card、多租户、JSON-RPC/gRPC/HTTP+JSON 三种绑定）、2026-08 进入 AAIF 与 MCP 同屋檐下；150+ 支持组织、22k+ stars，但生产深度使用仍以 PoC/早期企业为主。**与客户端协议无关**，仅当天枢未来做跨组织 agent 委派时相关。
  来源：https://cryptothreads.io/insights/a2a-protocol-linux-foundation/ ；https://www.sentra.app/articles/mcp-vs-a2a ；https://agentndx.ai/blog/a2a-protocol-adoption-mid-2026/
- **ANP（Agent Network Protocol）**：社区主导、W3C DID 去中心化身份、面向开放 agent 网络，仍属研究/实验阶段，无主流厂商背书。**忽略**。
  来源：https://www.torchproxies.com/blog/ai-agent-protocols-mcp-a2a-acp-vs-anp/ ；https://unifiedplatforms.com/blogs/web-development/ai-agent-protocols-mcp-a2a-acp/
- **A2UI（Google，2025-12-15 公开，Apache-2.0，格式 v0.8）**：agent 用声明式 JSON 描述 UI、客户端用**自己的原生组件目录**渲染（非 iframe），Flutter GenUI SDK 为首发实现，Web Components/Angular 客户端早期。理念（「UI as data」+ 组件白名单）对天枢未来做 generative UI 有参考价值，但尚处 alpha。
  来源：https://ecorpit.com/flutter-genui-sdk-a2ui-server-driven-agent-ui-2026/ ；https://rywalker.com/research/ag-ui
- **IBM ACP（Agent Communication Protocol）**：已于 2025-08 并入 A2A，归档，不要再混淆。

---

## 7. 横向对比速查表

| 标准 | 边界 | 传输 | 会话/事件模型 | 治理 | 2026 成熟度 | 与天枢 Web 客户端相关性 |
|---|---|---|---|---|---|---|
| **ACP**（Zed） | 编辑器↔编码 agent | JSON-RPC 2.0 over **stdio** | session/* + session/update + request_permission | Zed + JetBrains（公司） | 生态快速扩张（Registry、25+ agents），VS Code 缺位 | **低**（形态不匹配）；但对「编辑器分发」价值高 |
| **AG-UI** | agent↔用户界面 | HTTP POST + SSE（WS 可选） | ~16 事件 5 大类 + state 同步 + interrupt | CopilotKit（创业公司，MIT） | 1.0 刚发布，大厂集成背书（部分自述） | **高**（与天枢 sidecar 同构） |
| **Vercel AI SDK UI 流** | Web 聊天前后端 | SSE（x-vercel-ai-ui-message-stream: v1） | 每消息一 POST 的请求级流，UIMessage.parts | Vercel | React 生态事实标准，ai@^7 | **中**（渲染层可借，会话模型不合） |
| **MCP Apps** | 工具→host 富 UI | MCP JSON-RPC + iframe postMessage | ui:// 资源 + _meta.ui.resourceUri | AAIF 旗下 MCP 官方扩展 | 2026-01 转正，主流 host 已支持 | **中**（客户端功能需求，非协议选型） |
| **ChatKit/Apps SDK** | OpenAI 生态内部 | 私有 | widget + window.openai | OpenAI | Agent Builder 弃用，方向并入 MCP Apps | **低** |
| **A2A / ANP** | agent↔agent | JSON-RPC/gRPC/HTTP | Agent Card + Task 生命周期 | LF/AAIF；ANP 社区 | A2A v1.0；ANP 实验性 | **无**（不同层） |

---

## 8. 协议选型建议（天枢 Web 客户端 client-core）

### 选项 A：纯私有绑定

client-core 直接绑定现有 sidecar 协议（44 事件、seq、审批回执），不参照任何标准。

- 优点：零映射成本、语义无损、迭代自由。
- 缺点：① 事件分类/命名随功能野蛮生长，TUI、桌面、Web 三端容易各自漂移；② 无法接入任何生态组件（CopilotKit、assistant-ui、AG-UI 工具链）；③ 未来若想进编辑器或第三方客户端，所有协议工作一次性偿还。

### 选项 B：私有为主 + 事件模型借鉴 AG-UI ✅

保留私有 HTTP+SSE 传输、seq 重连、审批回执（这些是天枢的差异化能力，AG-UI 并没有等价物），但把 44 种事件按 AG-UI 五大类（lifecycle / text message / tool call / state / custom）做分类归位，命名与载荷结构向 AG-UI 词表靠拢，私有语义放入 custom 通道；预留一个 sidecar 侧 AG-UI 适配端点作为后续里程碑。

- 优点：① 不损失任何现有能力（seq 重连、审批回执原样保留）；② 事件模型获得经过行业验证的分类学，三端（TUI/桌面/Web）共享同一心智模型；③ 未来接 AG-UI 生态只需写一个无状态的流转换器（deepseek-harness 案例证明此类适配层工作量有界）；④ 治理风险可控——不依赖 CopilotKit 任何代码，只借鉴公开的 MIT 词表。
- 缺点：需要一次性的事件审计与重命名成本；需要在文档中维护「天枢事件 ↔ AG-UI 事件」对照表。

### 选项 C：加 ACP 适配层

- 作为 Web 客户端的 client-core 基础：**不推荐**。ACP 是 stdio 子进程模型、面向编辑器能力（fs/terminal/diff 审查），无浏览器传输，与天枢「常驻 sidecar + 多客户端 + seq 重连」架构存在根本阻抗不匹配。强行为之会让 Web 客户端背上编辑器协议的能力协商包袱。
- 作为**独立的编辑器分发项目**：**值得做，但后置**。ACP + Registry 是 2026 年编码 agent 进入 JetBrains/Zed/Neovim 用户桌面的标准通道，竞品 deepseek-harness 已通过官方+社区两条线占位。建议在天枢内核稳定后单独立项（参照 `@openma/deepseek-harness-acp` 的完整映射路线，不要重蹈官方阉割版被社区 fork 取代的覆辙），与 Web 客户端共用同一 client-core 事件源。

### 明确推荐

> **选项 B：私有协议为主、事件模型向 AG-UI 1.0 对齐。** Web 客户端 client-core 按「lifecycle / text / tool / state / custom」五类组织事件处理管线；sidecar 协议本身（44 事件、seq、审批回执）不动。第二个里程碑交付 sidecar 的 AG-UI 适配端点；ACP 适配层作为面向 Zed/JetBrains 的独立分发项目排在其后。渲染层可参考 Vercel AI SDK 的 UIMessage.parts（typed parts）设计与 A2UI 的组件目录理念，但不引入其请求级流模型。
