# DeepSeek Harness 项目深度分析

> 调查对象：`F:\workspace\AI-Project\AI-Harness\deepseek-harness`
> 调查方式：只读静态分析（README / AGENTS.md / package.json / pnpm-workspace.yaml / docs / 目录统计）
> 注意：本地副本**不含 `.git`**（`git log` 报 "not a git repository"），git 提交历史不可查，成熟度信号以代码量、测试与文档设施代替。

## 1. 项目类型判定

- **名称**：DeepSeek Harness，CLI 命令 `dsh`，npm 包 `@deepseek-ai/dsh`，当前版本 `0.1.2-alpha.1`（根 package.json、apps/cli/package.json）。
- **定位**：DeepSeek AI 官方开源的 **agent harness（智能体运行时/脚手架）**，README 原文："an open-source agent harness developed by DeepSeek AI"，"built on an everything-is-a-plugin architecture and powered by Cordis"。处于 **developer preview**，明确警告会有破坏性变更。
- **技术栈**：TypeScript（strict + noImplicitAny）+ Node.js（engines `^22.19.0 || >=24.0.0`），**pnpm 11.7 monorepo**（workspaces：`vendor/*`、`packages/*/*`、`apps/*`、`native/landlock-run`、`python/sdk-runtime`、`website`）。ESM everywhere（`"type": "module"`）。
- **License**：MIT（根 LICENSE、THIRD_PARTY_NOTICES.md）。
- **不是**纯 CLI、也不是评测框架：它是一个"万物皆插件"的 agent 运行时，上层装配出 Web UI、headless 一次性运行器、SDK JSON-RPC server、ACP server、Electron 桌面端等多种应用形态。仓库内**无 TUI**——前端是浏览器 Web UI（React 18 + Vite，apps/web/package.json）与 Electron 桌面壳（apps/desktop，electron-builder.yml）；没有任何 ink/ blessed 类依赖。

## 2. 定位与核心架构

- **框架底座**：Cordis（上游 cordiverse/cordis，vendored 到 `vendor/cordis`，rescope 为 `@deepseek-ai/cordis`），README 引用其设计论文《A Programming Paradigm for Spatiotemporal Composability》。架构文档（docs/architecture.md）明确："Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself"。
- **组合模型**：运行实例 = 启动时按序叠加的插件树。两层概念：
  - **Profile**（命名组合）：`web`、`headless`、`sdk`、`sdk-minimal`、`acp` 五个出厂 profile（docs/architecture.md#profiles）。
  - **Bundle**（可分发配置层）：`packages/bundle/` 下 `base`（共享首层：模型适配器、工具、持久化、沙箱、审批、设置、凭据、遥测）、`web-app`、`headless`、`sdk-app`、`sdk-minimal`、`acp-app`、`desktop-app` 共 7 个。
  - 用户可用 `cordis.patch.yml` / `--patch` 覆盖任意行；`dsh --profile web --dump-config` 可 dump 整棵树。
- **唯一入口**：`apps/cli/src/bin.ts`（`dsh` bin，package.json `bin: { dsh: "lib/bin.js" }`）。AGENTS.md 硬性规定："Only `dsh` profiles launch supported Node apps"，并由 `scripts/verify-application-entrypoints.ts` 静态门禁强制。
- **能力缝（capability seam）模型**：每项能力 = Service Definition（接口）/ Service Provider（实现）/ Consumer（消费方，通常是模型工具）三角，缺一不可。fs/subprocess 共享一个"执行世界"，指向远程沙箱即可整体迁移 bash/PTY/LSP（docs/architecture.md#capability-seams）。
- **核心包**（ctx 键）：`core/session`（append-only SessionEvent 日志，`ctx.sessions`）、`core/system-prompt`、`core/tools`（`ctx.tools`）、`core/agent` / `core/agent-loop`（`ctx.agentLoop`）、`llm/llm`（`ctx.llm`）、`webhook/webhook`（`ctx.webhookRuntime`）。
- **事件驱动**：session 事件（持久事实）/ agent 事件（`agent/*` 在飞工作）/ capability 事件（`fs/*`、`tools/*`）三域；turn/step 流程在 docs/architecture.md 有完整流水图；铁律"Model-visible ⟺ logged"（到达模型请求的一切必须可从 session 日志重建，且有运行时不变量断言）。
- **Session 持久化**：`packages/session/` 14 个包——JSONL 与 SQLite 两种持久化（`session-persistence-jsonl` / `-sqlite`）、投影、投影缓存、标题生成（含 LLM 版本）、遥测（含 OTel）、checkpoint 策略。SQLite 用单调 `SCHEMA_VERSION`，`SESSION_FORMAT_VERSION` 钉在 0 且无兼容承诺（pre-release 策略）。
- **Typert**：自研类型图生成/加载/运行时注册（`packages/typert/`），用于 RPC gateway（`packages/api/gateway`）。
- **SDK 双语言**：TypeScript SDK（`packages/sdk/`：protocol/client/server，JSON-RPC）+ Python SDK（`python/sdk`：`deepseek-harness-sdk`，通过 stdio 换行 JSON-RPC 驱动打包的 `dsh --profile sdk` 运行时；`python/sdk-runtime` 把 dsh CLI 打成按平台分发的 wheel）。

## 3. 源码结构与规模

| 区域 | 内容 | 量化 |
|---|---|---|
| `packages/` | 46 个包组，约 **221 个 workspace 包**（`packages/*/*` 目录 406 个含 README 子目录；package.json 全库 268 个含 vendor/python） | 例：client 43 包、session 14、subagent 11、shell 10 |
| `apps/` | `cli`（dsh 入口）、`web`（React+Vite 前端，dist 由 `dsh web` 伺服）、`desktop`（Electron 壳） | 3 个应用 |
| `vendor/` | Cordis 框架及其基础库源码 vendor（cordis、loader、include、group、timer、hmr、logger-console、cosmokit、schemastery），全部 rescope 到 `@deepseek-ai/*`，带上游 SHA 清单 | 9 个 vendored 包 |
| `native/landlock-run/` | Linux Landlock 沙箱"自限权后 exec"启动器，3 个 npm 包族，独立发布流水线 | — |
| `python/` | SDK + 运行时打包，约 **2,946 行 Python** | pytest.ini 在根 |
| `scripts/` | 仓库门禁与生成器 | **179 个脚本文件** |
| `docs/` + `website/` | 双语（en/zh）文档 + VitePress 站点投影 | **238 个 .md** |
| `snapshots/` | 录制会话回放测试夹具（acp/sdk/session/web 四域） | — |

**代码量**：`packages/` + `apps/` 下 TypeScript 源（排除 node_modules/lib/dist）**2,806 个 .ts 文件，约 59.5 万行**（`cat | wc -l` 全量统计）。其中测试/规格文件约 **842 个 `.spec.ts`**（另有 1,140 个文件位于 tests 路径下，与 spec 有重叠）。

## 4. 功能特性清单

### 4.1 LLM provider / API 协议
- `llm/llm-deepseek`：直连 DeepSeek chat-completions（路由名 `deepseek-official`），支持 thinking/reasoning effort、图片输入、模型目录；连接参数按请求解析，改设置文档免重启。
- `llm/llm-pi-ai`：基于 `@earendil-works/pi-ai` 的**多 provider 适配器**——pi-ai 目录内 provider（README 示例含 openai、anthropic）直接继承端点/协议/模型目录；目录外的 OpenAI 兼容网关/自建服务纯配置接入；支持 OAuth 登录流与跨进程锁刷新。
- `llm/llm-retry`、`llm/token-meter`、`llm/deepseek-llm-api-extensions`（DeepSeek 私有 wire 扩展，文档见 docs/deepseek-llm-api-wire-extensions.md）。
- 外部 agent 作 subagent provider：`subagent-claude-code`（经 `@anthropic-ai/claude-agent-sdk`）、`subagent-codex`（经 OpenAI Codex app-server 协议）、`subagent-acp`、`subagent-dsh-sdk`、in-process fork/spawn。
- 测试侧有 `packages/test-support/llm-mock-server`（`pnpm run mock:llm`）。

### 4.2 工具/能力（docs/tool-catalog.md 为**生成**目录，枚举了出厂工具）
`bash`、`pwsh`（Windows PowerShell 方言）、持久 PTY 版 bash/pwsh、`edit`/`read`/`write`/`read_image`（read-before-write 策略由独立插件挂接）、`glob`/`grep`（内置 @vscode/ripgrep 二进制）、`str_replace_editor`、6 个 terminal_* 工具、`lsp`（语言服务器缝）、`skill`、`subagent`/`subagent_fork`、`send_message`/`interrupt_agent`/`list_agents`/`report`、`job_kill`/`job_list`/`job_output`（统一后台任务控制）、`session_event_read/search/trace` + `session_search/trace`、`schedule_create/delete/list`、`create_goal/get_goal/update_goal`（goal 机制）、`exit_plan_mode`（plan mode）、`ask_user_question`、`web search/fetch`（DeepSeek/Exa/Perplexity 三个搜索 provider + HTTP fetch）、`cordis_*` 自修改工具集（opt-in，vm 沙箱内动态包）、`ralph`（workflow 驱动多轮）、`run_code`（PTC 模式：程序化工具调用）、`todo_write`，以及实验性 Agent Teams 10 工具（`spawn_teammate`、`team_task_*`、`wait_agent` 等）。
- **MCP**：`packages/mcp/mcp-client`（MCP 客户端接入）。
- **Hooks**：`packages/hooks/` 含 Claude Code 与 Codex 的 hook 桥 + wire-protocol 库。

### 4.3 界面 / 服务形态
- **Web UI**（主形态）：`npx @deepseek-ai/dsh web`，默认 `http://127.0.0.1:3080`，React 18 + Vite；`packages/client/` 43 个 UI 包（chat、approval、settings、model-selection、plan、trajectory、deliverables、theme、locale 等），UI 文案强制走 i18n 字典（verify-client-ui-i18n 门禁）。
- **Electron 桌面端**：apps/desktop（electron-builder，有 `dev:desktop`/`build:desktop`/`electron:build` 脚本；根目录还有 `dsh-desktop-launcher.cmd`）。
- **Server/API**：`packages/api/` 5 包（Typert RPC gateway、remotes、session/settings/workspace controller）；`packages/host/` 7 包（webserver、静态前端伺服、目录选择器等）。
- **ACP**：automation-only 的 Agent Client Protocol server（`packages/acp/`）。
- **Webhook ingress**：认证投递 + Workspace Session 创建。
- 实验性：浏览器 WebWorker 内运行的 preview（`experimental/webworker-*`）、inspector。

### 4.4 插件/扩展机制
- 一切皆 Cordis 插件；bundle 是可安装的分发格式（`dsh plugin` 命令管理，apps/cli/src/plugin.ts）；第三方插件用 GitHub topic `dsh-plugin` 发现。
- preset 机制（`packages/preset/`）：按 session 从 preset cordis.yml 组合 agent。
- self-modification：agent 可检查/挂载自己的插件（AGENTS.md 仓库布局中列出）。

### 4.5 Session / 上下文管理
append-only 事件日志为唯一事实源；fork/resume/transcript/telemetry 全部从日志派生；compaction 能力（`compaction-basic`、`compaction-tool-result-pruner`）；context 请求上下文插件 6 个；spill（超长结果溢出存储）3 包；attachment 2 包。

### 4.6 沙箱 / 安全
`sandbox`（Service Definition）、`sandbox-local`、`sandbox-policy`、`sandbox-windows-acl`（Windows ACL 实现）、`native/landlock-run`（Linux Landlock 原生启动器）、`e2b/`（E2B 远程沙箱 POC 及 fs/subprocess 适配器）。SAFETY.md 明确：未经安全审计，不保证隔离。

### 4.7 评测 / benchmark
无独立 benchmark 框架；BENCHMARK.md 仅一页：用 Python SDK 的 `jsonrpc-agent` minimal variant 跑独立任务。质量保障靠测试矩阵（见下节）而非跑分。

## 5. 构建 / 测试 / 发布

- **构建**：`pnpm run build`（tsc 双 face——host/client 分别 `tsconfig.host.json`/`tsconfig.client.json` + tsdown 打包）；web 前端 Vite 构建；桌面端 electron-builder；官方 profile `build:official`。
- **测试**（vitest 4，矩阵极厚）：
  - `test` 单元测试；`test:coverage` 是 CI 门禁——**`packages/*/*/src` 逐文件 100% 覆盖**（AGENTS.md 明写；vitest.config.ts 有自研 uncovered-locations reporter 精确到行列）。
  - `test:e2e` 
  - `test:e2e` 真实 API 测试，无 `DEEPSEEK_API_KEY` 自动跳过；另有 pi-ai provider e2e、E2B e2e 独立 workflow。
  - `test:snapshot` 无密钥录制会话回放（snapshots/ 树有专属 AGENTS.md 治理）；`test:web`/`test:web:perf`/`test:web:stress` Web 快照/性能/压力；`test:expected` owner-local 期望。
- **静态门禁**：oxlint（+tsgolint）、knip、publint、jscpd 克隆检测，以及 **60+ 个 `verify-*`/`gen-*` 自定义门禁/生成器**（工具目录、配置目录、模块图、文档图、i18n 配对、JSDoc 完整性、vendor 链接、Cordis 配置……），由 `scripts/run-gates.ts` 编排；lefthook git hooks。
- **CI**：GitHub Actions 19 个 workflow（ci-master、e2e、sandbox、python-release、release-publish、landlock-run 等）+ 根 `.gitlab-ci.yml`（双 CI 并存）；Windows 有 wine 门禁与 blocking/complete/observational 三档。
- **发布**：`scripts/release/`（bump/verify/pack/publish + packed-install 验证），npm `@deepseek-ai/dsh`；Python 端 wheel 按平台分发；landlock-run 三包族独立发布；VitePress 文档站发 GitHub Pages（docs-pages.yml，站点 https://deepseek-harness.github.io/deepseek-harness/）。

## 6. 文档情况（异常完善）

- **238 个 markdown**，全部**中英双语配对**（`.i18n.yaml` 配对清单 + `verify-translation-pairing` 等门禁保证同步）。
- 架构级：architecture.md、cordis-primer、cordis-tutorial、agent-lifecycle、tool-execution-pipeline、capability-seams、event-producer-consumer、graph-atlas、module-graph。
- **docs/subsystems/ 约 40 个子系统页**（session、persistence、llm-streaming、sandbox、subagent、approval……每个子系统一页）。
- **生成目录**：tool-catalog（启动真实上下文 dump 工具 schema）、config-catalog、cordis-api、cordis-inspect、persistence-catalog、module-graph、third-party-notices——全部由生成器产出并由 verify 门禁保鲜。
- 用户文档 docs/user/（guide + develop）、cookbook（如 adding-a-tool、adding-a-vendored-package）、postmortem 目录。
- 每个包都有 README.md + README.zh.md + i18n.yaml（三件套）。
- `.agents/notes/` **1,624 个 Agent Notes**（带日期的决策记录，如 `2026-07-02-tool-schema-catalog.md`），且 AGENTS.md 强制"非平凡变更必须同 PR 附 Agent Note"。

## 7. 成熟度信号

| 信号 | 事实 |
|---|---|
| 版本 | 0.1.2-alpha.1，自我声明 developer preview，"THERE WILL BE COMPATIBILITY-BREAKING CHANGES" |
| 规模 | ~59.5 万行 TS、2,806 个源文件、约 220+ 个 workspace 包（`packages/*/*` 二级目录 406 个含说明文件目录；package.json 总数 268 含 vendor/python）、46 个包组 |
| 测试 | 842 个 spec 文件；CI 覆盖率门禁=逐文件 100%；真实 API e2e + 录制回放 + Web 快照/性能/压力五层 |
| 工程门禁 | 179 个 scripts、60+ 自定义 verify/gen 门禁、knip/publint/jscpd/oxlint 全家桶 |
| 文档 | 238 篇双语 md + 40 子系统页 + 生成目录 + 1,624 篇决策记录；文档同步有机器门禁 |
| git 历史 | **本地无 .git，无法统计提交数**；Agent Notes 日期（2026-07 起）显示持续高强度迭代 |
| 供应链治理 | pnpm strictDepBuilds 白名单、minimumReleaseAge 策略、vendor 源码带上游 SHA 清单、patchedDependencies 明示 |
| 安全姿态 | SAFETY.md 声明未经审计；沙箱/审批/权限分层存在但官方声明不能作为唯一安全控制 |

## 8. 功能特性总结清单（速查）

| 维度 | DeepSeek Harness |
|---|---|
| 形态 | Web UI（主）+ headless 一次性 + TS/Python SDK(JSON-RPC) + ACP server + Electron 桌面；**无终端 TUI** |
| 架构 | 万物皆 Cordis 插件；profile+bundle+patch 分层组合；capability seam 三角 |
| LLM | DeepSeek 直连 + pi-ai 多 provider（OpenAI/Anthropic/兼容网关，含 OAuth）；重试、token 计量 |
| 工具 | bash/pwsh/持久 PTY、文件读写编辑、glob/grep（内置 ripgrep）、LSP、web 搜索抓取（3 provider）、subagent（含 Claude Code/Codex 委派）、后台任务、调度、goal/plan/todo、skill、session 查询、MCP 客户端、自修改 cordis_*（opt-in）、PTC run_code、实验 Agent Teams |
| 会话 | append-only 事件日志唯一事实源；JSONL/SQLite 双持久化；fork/resume；compaction；OTel 遥测 |
| 安全 | sandbox 缝 + Landlock 原生 + Windows ACL + E2B 远程沙箱 POC；审批/权限预设 |
| 扩展 | bundle 分发、`dsh plugin`、preset、Claude Code/Codex hooks 桥、webhook |
| 测试 | vitest；逐文件 100% 覆盖门禁；真实 API e2e；录制回放快照；Web 快照/性能/压力 |
| 文档 | 双语 238 篇 + 生成目录 + VitePress 站点 + 1,624 篇 Agent Notes |
| 成熟度 | 0.1.2-alpha，developer preview，工程纪律极高、兼容性无承诺 |
