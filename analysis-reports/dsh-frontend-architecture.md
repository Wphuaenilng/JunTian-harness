# deepseek-harness 前端架构调查报告

> 调查对象：`F:\workspace\AI-Project\AI-Harness\deepseek-harness`（dsh，MIT）
> 范围：`apps/web`、`apps/desktop`、`packages/client/`（43 个包：6 个内核包 + 37 个 `ui-*` 包）
> 下文所有相对路径均以 deepseek-harness 仓库根为基准。

## 总览：一句话架构

dsh 的 Web 客户端是一个**由 Cordis 插件树组装起来的浏览器应用**：React 只是渲染末端，真正的骨架是四件套——**Client Modules**（插件加载/共享模块表）、**API Gateway/Connection**（类型化 RPC + 事件流）、**Client 模型层**（React-free 的 Host 状态镜像）、**Slots + Renderer**（类型化 UI 组合系统）。依赖方向严格单向：`Host 状态 → Remote 传输 → Client 模型 → UI 适配 → Conversation 装配 → Slot → React`（依据：`docs/subsystems/web-client.md` 第 7–18 行）。

---

## 1. apps/web 的组装方式

**入口极简，组装逻辑全部下沉到 `packages/client/web` 壳包。**

- `apps/web/src/main.ts` 只有 5 行有效代码：`new AppWebEntry(document.getElementById('root')).run()`，其中 `AppWebEntry` 来自 `@deepseek-ai/dsh-client-web`。
- `apps/web` 自身几乎不含业务代码，只做 Vite 构建：多入口（`index.html` + `src/preview.ts` 实验 worker 预览）、vendor 分包（katex/shiki/micromark 家族进独立 `vendor` chunk，shiki 语法懒加载进 `assets/langs/`）、React 单例 dedupe、以及给 vendored Cordis loader 的 Node API 打桩（`node:module` → stub、`process.versions.node: "0.0.0"`）。依据：`apps/web/vite.config.ts` 全文；`apps/web/index.html` 只有一个 `#root` div 和 module script。
- **关键设计：apps/web 不可独立运行**。Vite 插件 `rejectStandaloneServe()` 直接禁止 `vite dev/preview`，因为页面必须由 Host 注入 `window.__DSH_BOOT__`（boot graph）。页面永远由后端（`dsh web`）伺服。依据：`apps/web/vite.config.ts` 第 9–11、30–38 行。
- **插件不经 Vite 打包进主 bundle**。Vite 只打壳 + 静态基座库；37 个业务插件包各自经 tsdown 打成独立 `lib/client.js`，运行时由浏览器端模块系统按需加载。依据：`apps/web/vite.config.ts` 第 213–215 行注释（"Plugin packages never enter this graph"）；`docs/subsystems/client-modules.md`。
- **共享模块表**：`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES = [react, react-dom, cordis, client-store, ui-slots, ui-primitives]`——React 全家、Cordis、store、slots、primitives 由壳种子化进"惰性 CommonJS 模块表"，所有动态插件 bundle 把这些当作 implicit externals，保证 React 单例、hooks 身份一致。依据：`packages/client/web/src/platform.ts`；`packages/client/web/README.md` "The shared module table" 节。
- **两阶段启动**：module 阶段（从 Host 下发的 boot graph 建模块系统、预取 `immediately` 层）→ plugin 阶段（激活全部插件条目，Cordis 服务注入决定激活顺序）→ `ui-renderer` hydrate 启动页 DOM 并调用唯一的 `renderSlot('root')`。启动过程用一个**纯 DOM/CSS 的无框架启动页**显示每个插件的加载状态，插件失败时按名报错而不是白屏。依据：`docs/subsystems/web-client.md` 第 20–24 行；`packages/client/web/README.md` "What boot looks like"。

---

## 2. packages/client 分层

43 个包（实测 `packages/client` 下 48 个条目减去 5 个文档文件；其中 `ui-*` 前缀 37 个）分为四层，层间知识单向：

### 2.1 内核/基础设施包（6 个，非 `ui-` 前缀）

| 包 | 职责 |
|---|---|
| `web/` | 浏览器壳启动内核、无框架启动页、共享模块表 |
| `modules/` | 浏览器端模块加载（惰性 CommonJS 表），`ctx.clientModules` |
| `connection/` | 浏览器↔Host 的 RPC 载体、事件分发、连接世代、信任边界，`ctx.connection` |
| `store/` | React-free 快照 store 引擎（zustand vanilla + immer） |
| `hmr/` | 开发期插件热替换（换 UI 不动数据层） |
| `locale/` | 语言偏好、字典注册、回退链，`ctx.locale` |

依据：`packages/client/README.md` 第 27–36 行包表。

### 2.2 渲染机制包（3 个特殊 `ui-` 包）

- `ui-slots/`：React-free 的 slot 注册表与类型代数（SlotMap 声明合并）。
- `ui-renderer/`：**唯一**允许把裸 observable 经 `useSyncExternalStore` 绑成 hook、唯一拥有 React context、唯一 mount 根树的包。它是动态插件，业务包对它零运行时依赖。依据：`docs/subsystems/web-client.md`；`packages/client/AGENTS.md` "Render machinery" 条；`packages/client/ui-renderer/src/client/bind.ts`（全栈唯一的 hook 构造器 `bindSnapshotSelector`，27 行）。
- `ui-session/`：把 Session Controller 的模型适配成标准 Slot 数据源和 hook（`useSessions`/`useSession`/`useProjection`/`SessionProvider`），但不拥有业务状态。依据：`packages/client/ui-session/README.md`。

### 2.3 业务功能包（34 个 `ui-*` 插件）

一个 UI 功能 = 一个插件包（`src/client/` 浏览器半边 + 空 Node 半边 `src/index.ts`），全部通过 `ctx.slots.register()` 组合，互不 import 对方的运行时值。代表：`ui-chat`、`ui-approval`、`ui-tool`、`ui-conversation`、`ui-layout`、`ui-sidebar`、`ui-settings*`（4 个）、`ui-theme`、`ui-primitives` 等。依据：`packages/client/README.md` 第 37–72 行；`packages/client/AGENTS.md` "Directory regime" 节。

### 2.4 分层门禁（有强制，且是 CI 脚本级）

1. **导出纪律**：插件包的 `/client` 入口只允许导出 `apply`/`inject`/`Config` + store 工厂类型；实现组件禁止导出。依据：`packages/client/AGENTS.md` "Export discipline" 节。
2. **跨包隔离**：功能插件**禁止运行时 import/再导出另一个功能插件的值**；共享类型用 `import type`，行为经 Cordis 服务，UI 经 slots。由 `scripts/verify-client-packages.ts`（966 行，含 `--fix`）强制。依据：AGENTS.md "Dependency declaration" 节、`scripts/verify-client-packages.ts`。
3. **依赖分区规则**：Cordis 必须 peer+dev 双声明；动态包对内部动态依赖 peer+dev；静态输入只能 dev；动态包**禁止**把 `@deepseek-ai/dsh-*` 放进 `dependencies`；非基座共享模块必须在 manifest 的 `dsh.client.external` 里精确声明 specifier。构建预设会 externalize 基座并拒绝未声明的工作区值导入。依据：AGENTS.md 第 61–81 行。
4. **包内域图**：多域包（如 ui-conversation）内部域目录互不可 import 兄弟域，由 `scripts/verify-client-domain-graph.ts` 强制。
5. **bundle 纯度**：`scripts/client-bundle-purity.spec.ts`。
6. **三处注册缺一即败**：新包必须同时登记 `tsconfig.client.json` references、`packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` 行、web-app 的 package.json 依赖。依据：AGENTS.md "New plugin package checklist" 第 2 条。
7. 组件文案 i18n 门禁（见第 7 节）、100% 覆盖率门禁（`pnpm run test:coverage`）等。

**模块图与 DI 的分离**是一个值得单独提炼的设计：Cordis 服务 `inject` 是运行时异步等待（允许环、可替换），模块图 `external` 是物化时同步 require（禁止环、不可替换）——两种"依赖"语义被明确区分并各自校验。依据：AGENTS.md "The module graph sits below cordis DI" 表格。

---

## 3. 连接层设计（重点参考区）

**物理层：HTTP POST（unary）+ 一条 WebSocket（流与事件）。逻辑层：Typert Remote（代码生成的类型化 RPC）。**

- **unary 调用走 HTTP**：`POST /api/<namespace>/<method>`，payload 只有 `{ args }`；`rpcId` 由发起方铸造、响应方回显，严格双向关联；取消经 AbortSignal 贯通到 Host 方法签名。依据：`docs/api-gateway.md` 第 121–123 行；`packages/client/connection/README.md` 第 28 行。
- **WebSocket 复用（mux）**：`/api/remote.mux` 一条物理 WS 上跑多条逻辑 `RemoteStream`；物理断线由 Gateway mux 负责重连，**每条逻辑流各自在新世代上重开自己的数据源**。依据：`docs/subsystems/web-client.md` 第 74 行；`packages/client/connection/README.md` 第 46 行。
- **类型化 RPC 不靠手写**：Host 服务用 `@Remote`/`@RemoteScope` 装饰器标注，构建期 `dsh-typert-generator` 从 Host 的 `ts.Program` 严格分析签名，产出 Host/Client 两侧的描述符、运行期 codec、声明合并和 d.ts.map（编辑器可从 `ctx.remote.goals.create` 直接跳转到 Host 实现）。Client 侧是具体函数对象而非 Proxy。依据：`docs/api-gateway.md` 第 9–16、95–115 行。
- **连接世代（generation）模型**——这是最核心的可借鉴点：
  - 内部逻辑流 `$events` 是唯一的"世代源"；Host 先挂好全部增量监听，再发一个 `{type:'ready', clientId, host:{home}}` 开场帧，**之后** Client 才发布世代、允许任何 baseline 读取——从机制上消灭"基线与增量竞争"。
  - 世代失效（流结束/错误/开场帧畸形）→ 立即撤回世代、发布 `reconnecting`、指数退避重开。默认：base 500ms、factor 2、上限 10s、jitter 50–100%。
  - 依据：`packages/client/connection/README.md` "Connection generation" 节；`packages/client/connection/src/client/connection.ts`（`ConnectionController`，242 行：generation 计数、退避、抖动、coarse `connected|reconnecting` 状态去重发布）。
- **状态同步语义按数据类型分治**（没有一刀切的 `resync()`）：
  - 持久会话日志：`follow()` 开场帧携带 header+尾部页+游标+完整投影基线，**每个物理世代整体原子替换窗口**，随后按逻辑 seq 追加；`page()` 只用于翻旧历史和修洞。journal 校验 seq 区间不重叠。
  - 会话控制流/工作区流：断线期间保留最后值，重连后用新基线**整体替换**。
  - 普通转发通知**不重放**——有状态域必须有基线/游标/显式查询。
  - 依据：`docs/subsystems/web-client.md` 第 46、72–82 行。
- **信任边界**：随机启动 token 换签名的 HttpOnly cookie（Host/Origin 校验防 DNS rebinding，cookie 故意不带 Secure 因为只走 loopback HTTP）。依据：`packages/client/connection/README.md` "Browser authentication and request trust" 节；`packages/client/connection/src/api-request-trust.ts`。

> 对天枢的启示：你们已有 HTTP/SSE sidecar 协议，不必抄 Typert 代码生成；但**"世代 + ready 帧 + 基线原子替换 + 通知不重放"这套客户端状态同步语义**与协议无关，可直接移植到 SSE 之上（SSE 断线后事件源新开场帧带全量基线即可）。

---

## 4. 状态管理

**zustand/vanilla + immer，但包了一层自研的 React-free 契约。**

- 引擎：`packages/client/store/src/index.ts`（250 行）——`createStore()`(zustand/vanilla) + `subscribeWithSelector` + immer `produce`；手写的 rAF 批处理（一帧内 N 次变更合并为一次通知，node 测试降级为 microtask）；手写的 localStorage 持久化（弃用 zustand persist 中间件，因为它会把原始值 spread 成对象）；dev 下深冻结。
- **关键纪律：store 产品是裸 observable**（`subscribe`/`getSnapshot`/`update`/`set`），**没有 hook 成员**；hook 只在 ui-renderer 的绑定现场由 `bindSnapshotSelector`（uSES + selector 缓存）合成，按 source 身份缓存。依据：`packages/client/store/src/index.ts` 头注释；`packages/client/ui-renderer/src/client/bind.ts`。
- **三层状态分离**（这是最值得学的建模决策）：
  1. **业务数据在对象层，永不进 store**：会话事件窗口、连接状态、工作区由 React-free 的 `ClientSessions → SessionManager → Session` 对象模型持有（`packages/api/session-controller/client`）。
  2. **store 只装"跨入口共享或需跨重挂载存活的视图/交互状态"**（选中项、草稿、面板宽度），经 `defineStore({ init, persist?, actions })` 声明，actions 是唯一变更 API（immer draft mutator）；store 实例由框架按 handle × scopeKey 缓存，禁止模块级单例。
  3. 组件私有状态用普通 `useState`。
  依据：`packages/client/AGENTS.md` 第 15、50–53 行；`docs/subsystems/web-client.md` 第 52 行。
- **会话事件窗口建模**：每个 `Session` 持有一段连续逻辑事件窗口 `SessionEventLikeEntry`（判别联合 `{type:'event'} | {type:'chunks'}`，packed chunkrow 用于历史压缩）；append 热路径只做 `(kind,id)` 常数时间查表，禁止全窗口扫描。依据：`docs/subsystems/conversation.md` 第 11、225–235 行。
- **通知节拍三档**：`notifyNow`（仅用户手势直接回显）、`markDirty`（microtask 批量，结构性更新）、`markFrameDirty`（rAF 累积，可见流式 chunk）。依据：`packages/client/AGENTS.md` 第 54 行；`packages/api/session-controller/src/client/sessions/notifier.ts` 第 31–76 行。

---

## 5. 流式渲染

**事件折叠（fold）与渲染分离；增量 markdown 解析；帧级节流。**

1. **流式 token 建模**：LLM `StreamChunk`（`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`）被 `PartialAccumulator` 折叠成块级不可变的 `AssistantBlock[]`（text / reasoning / tool-call 三类块，tool-call 块累积 `argsRaw` 字符串）；`toPartial()` 只在变更时重算快照，保持引用稳定。依据：`packages/client/ui-chat/src/client/conversation-nodes/partial.ts` 全文（99 行）。
2. **Conversation 装配层**（`ui-conversation`）：业务包注册 `ConversationNodeDefinition`——`match(event)` 只做身份提取（`kind,id` + start/update 角色），`start`/`update` 是纯 fold、必须可按 seq 确定性重放；历史里连续同类 chunk 被压成 `chunkrow/*` packed 事件（仍是单个输入，防止重放时 N 倍放大）。发布节拍由 Definition 声明：`immediate` / `animation-frame` / `none`。依据：`docs/subsystems/conversation.md` 第 213–237 行；`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts`（450 行的完整实现：流式、重试重置、中断证据、首 token 计时）。
3. **视图目标（target）隔离**：同一事件家族可被 Chat 和 Trajectory 两个视图各自解释，但它们各自持有 Definition State 和最终快照，互不 import——允许"有意的平行实现"换包边界干净。依据：`docs/subsystems/web-client.md` 第 58 行。
4. **增量 markdown**：自研的块级增量解析器——追加流里只有末尾 2 个顶层块是"不稳定"的，之前的块冻结不再重解析（每个源区域整条流只解析一次，避免 O(n²)）；冻结边界用 micromark 自己的 position offset；块 key 是源偏移，跨 chunk 稳定，React 只 reconcile 不 remount。依据：`packages/client/ui-primitives/src/markdown/incremental.ts` 头注释。
5. **工具调用展示**：`ui-tool` 把 tool call 组织成树（`tool/ToolCallTree.tsx`、`ToolDetails.tsx`），每种工具有 keyed 视图（`tool/toolviews/`：bash-sample、read-row、search-row、web-row、todo-row、file-mutation-row、ask-question-row + GenericToolCard 兜底）；slot 链 `conversation.chat.node → tool.call.toolview → tool.view.cordis` 允许工具插件注册自己的视图，未知工具回退通用卡片。依据：`packages/client/ui-tool/src/client/tool/`；`docs/subsystems/slots.md` 第 133–137 行。
6. **diff 展示**：`ui-primitives/src/DiffBlock.tsx`——纯展示组件，输入是 `DiffHunk[]`（path + oldText + newText），内部铺平成行列表，超 16 行折叠中段，文案全部经 labels 注入。旁边还有 `TerminalBlock`（ansi.ts 渲染终端输出）、`ReadBlock`、`SearchBlock`、`WebBlock`、`JsonTree` 等成套内容块。
7. **视觉对齐节流**：滚动跟随等"非必要视觉对齐"用 `useThrottledVisualUpdate`（默认每 3 帧一次 rAF 节流）与数据发布节流分开。依据：`packages/client/ui-chat/src/client/chat/use-throttled-visual-update.ts`。

---

## 6. 审批 UI

**交互模型：Host 的 waterfall 事件 → 会话作用域的 pending interaction → 接管输入区（composer takeover）→ 回执。**

- 链路：Host Cordis waterfall → Remote `$events` → Client `ctx.remote.$on('approval/request', handler)`；handler 把请求包成 `PendingApproval` 对象发布到 `ctx.uiSession.registerPendingInteraction`，挂起等待用户决定，最后把结果（`'allowed-once' | 'rejected'`）作为 waterfall 的返回值送回 Host 的等待方；`next()` 可委托给链上下一个监听者（委托语义内建）。依据：`packages/client/ui-approval/src/client/index.ts` 全文（93 行）。
- 呈现：`ApprovalPanel` 注册进 `conversation.composer` 的 **chain slot**（优先级 1，`select` 命中 pendingInteraction 时接管输入区），显示"等待中"条 + 升级原因 + 可选的工具细节（再经子 slot `conversation.approval.detail` 按 callId 渲染关联工具卡）+ 拒绝/允许一次两个按钮；点击后本地置 `answered` 防重复，失败回滚。依据：`packages/client/ui-approval/src/client/ApprovalPanel.tsx`。
- **边界**：浏览器端只做一次性决定；持久权限策略归 Host 审批包管。依据：`packages/client/ui-approval/README.md` "Known Limitations"。
- 同一 waterfall 生命周期被 `ui-user-questions` 复用（agent 主动向用户提问），代码注释里明示两者是刻意镜像。依据：`packages/client/ui-approval/src/client/index.ts` 第 33 行 jscpd 注释。

---

## 7. 主题与 i18n

### 主题（ui-theme）

- **纯 CSS 变量方案，无 Tailwind、无组件库**：`ui-theme/src/styles/` 持有全部共享样式表和 `--dsw-*` 设计 token（static 色板 + 语义别名）；业务组件经 CSS Modules + `clsx` 消费语义别名，**禁止字面颜色**。依据：`packages/client/AGENTS.md` "Styling and localization" 节；`packages/client/ui-theme/src/styles/design-platform.css`。
- **防 FOUC 的启动主题**：Host 渲染 index 时内联一段脚本（`bootThemeInjection`），在壳挂载前就按持久化偏好写好 `color-scheme`、`data-ds-dark-theme` 属性与字号变量——主题属性挂在 `body` 上，插件激活后由 ui-layout 的 ThemePresenter 接管同一 DOM 字段。`system` 偏好只解析一次。依据：`packages/client/ui-theme/src/boot-theme.ts`。
- 主题/字号设置项由 ui-theme 自己注册进设置界面（`src/client/AppearanceRow.tsx`、`FontSizeRow.tsx`）——功能包拥有自己的设置面。

### 国际化（locale）

- **机制**：`ctx.locale` 服务；字典是扁平 key → 模板串（`{name}` 占位）；命名空间经 TS 声明合并（`LocaleNamespaceMap`）获得类型安全；组件从注册时的 `locale: NS` 拿到绑定好的 `t(key, params)` prop（t 函数身份稳定）；回退链 zh→en，en 是兜底；语言包可以插件形式注册新语言（id/label/fallback）。依据：`packages/client/locale/src/client/index.ts` 第 48–119 行。
- **为什么有强制门禁**：文案所有权集中在类型化字典后，任何写进 JSX/attrs 的硬编码文案都会绕过类型检查与双语同步，所以 `scripts/verify-client-ui-i18n.ts`（342 行，TS AST 级检查）强制：JSX 文本、aria/label/placeholder/title 等文案属性、及命名含 label/message/text 等后缀的变量都不允许出现自然语言字面量；只有 `locale.ts`/`locales/` 目录拥有文案。命令：`pnpm run verify-client-ui-i18n`（`package.json` 第 109 行）。决策记录见 `.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md`（AGENTS.md 第 113 行引用）。

---

## 8. Electron 壳

**桌面端是"远端 UI 的浏览器"，不内嵌后端逻辑。**

- `apps/desktop/electron-main.ts`（290 行）：Electron 主进程**从不自己启动插件树**。它 spawn `dsh --profile desktop --port 0` 子进程（用真实 Node 跑，不用 `ELECTRON_RUN_AS_NODE`，因为 Electron 内嵌 Node 版本太旧），逐行读 stdout，正则捕获 webserver 打印的 `dsh web: http://127.0.0.1:<port>/?token=...`（URL 带启动 token），然后 `BrowserWindow.loadURL()` 原样加载——渲染进程跑的就是同一套浏览器 UI，传输仍是 loopback HTTP/WebSocket。依据：`apps/desktop/electron-main.ts` 头注释与 `startHarness()`（第 81–118 行）。
- 窗口：无边框（`titleBarStyle:'hidden'` 保留 Win11 圆角/吸附），网页自绘标题栏；单实例锁；外链一律 `shell.openExternal`；窗口关闭即退出，`will-quit` 杀子进程防孤儿。
- `preload.ts`（78 行）：`contextIsolation: true` + `nodeIntegration: false`，contextBridge 只暴露固定通道的 `electronAPI`（文件对话框、系统信息、窗口控制、菜单弹层、`isElectron` 标记）。**不桥接任何模型/会话流量**——注释明说这些通道是"网页够不到的原生便利"的接缝。
- 一个特别的协议细节：`globalThis.__DSH_TRANSPORT__` 预注入 transport 时壳会跳过 HTTP 预取直接用它加载 bundle——给桌面/测试留了传输注入缝。依据：`packages/client/web/README.md` "Use this package" 节。

> 对天枢的启示：这套"**一个前端构建产物，两种宿主**"模式（Web 浏览器 + Electron 壳都消费 sidecar 伺服的同一 dist，差异只走 preload 能力缝）与天枢"sidecar 驱动同一内核"的哲学完全一致，几乎可以直接照搬到天枢桌面端。

---

## 9. 可复用性评估

### 几乎可照搬（协议无关，纯 UI/纯机制）

| 资产 | 路径 | 复用方式 |
|---|---|---|
| store 引擎（zustand+immer+rAF批处理+持久化+defineStore 契约） | `packages/client/store/src/index.ts`（250 行）+ `contract.ts`（144 行） | 直接拷贝改写，零协议耦合 |
| uSES 绑定器（唯一 hook 构造点） | `packages/client/ui-renderer/src/client/bind.ts`（27 行） | 直接照抄 |
| 连接世代控制器（退避/抖动/ready 帧/状态去重） | `packages/client/connection/src/client/connection.ts`（242 行） | 协议无关，SSE 之上直接套用 |
| 增量 markdown 块解析器 | `packages/client/ui-primitives/src/markdown/incremental.ts` + `parse.ts`/`render.tsx` | 纯算法，可整包移植 |
| 内容块组件（DiffBlock/TerminalBlock+ansi/ReadBlock/SearchBlock/WebBlock/JsonTree） | `packages/client/ui-primitives/src/` | 纯展示，labels 注入式 i18n，可直接 fork |
| 主题 token 体系与 boot 防闪烁注入 | `packages/client/ui-theme/src/styles/` + `boot-theme.ts` | 设计 token 需按天枢品牌重做，机制照搬 |
| i18n 门禁脚本思路 | `scripts/verify-client-ui-i18n.ts` | AST 检查逻辑可改造复用 |
| Electron 壳 | `apps/desktop/electron-main.ts` + `preload.ts` | 结构直接复用（spawn CLI→读 URL→loadURL） |
| PartialAccumulator 流式折叠器 | `packages/client/ui-chat/src/client/conversation-nodes/partial.ts` | chunk 类型对齐天枢协议后可复用思路与代码骨架 |
| 通知节拍三档（notifyNow/markDirty/markFrameDirty） | `packages/api/session-controller/src/client/sessions/notifier.ts` | 模式照搬 |

### 只能借鉴设计（与 dsh 后端协议/插件体系耦合深）

| 资产 | 耦合点 | 可借鉴的设计 |
|---|---|---|
| Typert Remote 代码生成（`api/gateway`、`api/typert-*`） | 深度绑定 Cordis 服务模型与 dsh 构建管线 | "从 Host 声明生成 Client 类型化调用面"的方向；天枢可对 sidecar HTTP/SSE 接口做轻量 OpenAPI/手写 SDK 替代 |
| Cordis 插件树 + Slots 组合系统（`ui-slots`/`ui-renderer`/`modules`/`web`） | 整套建立在 Cordis DI、自研模块表、dsh.client manifest 之上，体量极大 | Slot 思想（声明即授权、四种 props share、chain/single/list/keyed 四种基数、scope 分层）值得提炼为简化版；不建议照搬 Cordis |
| Conversation 装配层（`ui-conversation` + Definitions） | 事件契约是 dsh 的 `SessionEvent`/`chunkrow` | "match=身份提取 / update=确定性 fold / 发布节拍声明 / target 隔离"这套建模与协议无关，值得按天枢事件模型重写一个简化版 |
| `ClientSessions→SessionManager→Session` 对象层 | 绑定 dsh 的 follow/page/journal 协议 | "React-free 模型层持有业务数据、store 只放视图状态"的边界必须学 |
| ui-approval 的 waterfall | 绑定 Cordis waterfall 事件机制 | "pending interaction 发布→chain slot 接管 composer→回执"交互模型可移植到天枢的审批事件流 |
| hmr 包 | 绑定 dsh 插件 bundle 机制 | 若天枢不做插件化则不需要 |

---

## 10. 给天枢自研客户端的架构建议

基于 dsh 经验，按"必学 / 建议 / 不必"三档给出：

### 必学（核心价值，成本可控）

1. **三层状态边界**：React-free 模型层（会话/连接/工作区对象，subscribe/getSnapshot 裸源）→ 唯一 uSES 绑定点（一个 `bind.ts`，30 行）→ 纯 props 组件。业务组件零订阅机制、零 context、永不直接见 transport。这是 dsh 全部可测试性（组件测试直接喂 props）与 100% 覆盖率门禁的地基。
2. **连接世代 + 基线原子替换**：SSE 流开场帧带全量基线（ready 帧先于任何增量到达 Client 之后再发布"已连接"），断线保留最后值、重连整体替换，普通通知不重放。指数退避 + 50–100% 抖动。这套语义让"断线重连后状态对不对"变成可推理的属性而非运气。
3. **流式渲染三件套**：chunk fold 成块级不可变快照（PartialAccumulator 模式）+ 块级增量 markdown（尾部 2 块不稳定、其余冻结）+ 帧级发布节流（rAF 合帧）。三者分别解决"数据怎么存、markdown 怎么不重解析、React 怎么不抖"。
4. **一个前端产物两种宿主**：Vite 构建的 dist 由 sidecar 伺服；Electron 只 spawn sidecar、读带 token 的 URL、loadURL；preload 只暴露原生便利（文件对话框/窗口控制），不走业务流量。
5. **i18n 文案集中 + AST 门禁**：字典文件是唯一文案所有者，组件只拿 `t`；写个 200 行的 TS AST 检查脚本进 CI，从第一天堵住硬编码文案——事后补 i18n 的成本远高于门禁成本。
6. **CSS 变量 token + CSS Modules**，禁字面颜色；boot 时内联脚本防主题闪烁。

### 建议（做轻量版，别照搬体量）

7. **简化版 Slot 系统**：不必引入 Cordis 级插件框架，但"注册表 + 声明即授权 + 四种基数（single/list/keyed/chain）+ 组件 props 全部由注册声明推导"值得做成一个几百行的内部库。优先做 chain slot——审批接管输入区这类"竞争同一位置"的场景没有它会很难看。
8. **分包方案（pnpm monorepo，约 10 包而非 43 包）**：
   - `packages/client-core`：连接世代 + SSE 客户端 + 模型层（Session/Workspace 对象）+ store 引擎 + uSES 绑定
   - `packages/ui-primitives`：按钮/折叠/Toast + DiffBlock/TerminalBlock/Markdown 等内容块
   - `packages/ui-theme`：token、全局样式、boot 注入
   - `packages/locale`：字典与 t 绑定
   - `packages/ui-chat`、`packages/ui-approval`、`packages/ui-tool`、`packages/ui-session-sidebar`、`packages/ui-settings`：业务包，只依赖 core/primitives/theme/locale，业务包之间只允许 `import type`
   - `apps/web`（Vite 壳）+ `apps/desktop`（Electron 壳）
   用两个小型 verify 脚本（依赖方向 + i18n）替代 dsh 的 966 行大门禁。
9. **技术选型**：React 18 + Vite + zustand/vanilla + immer + CSS Modules + micromark/mdast（增量 markdown）+ shiki（懒加载语法）——与 dsh 同构即可，这些选择已被 dsh 在流式场景下验证；不需要 Tailwind（token 方案更适合品牌化的 agent UI）。
10. **工具调用展示**：通用卡片兜底 + 每工具 keyed 视图 + 树形组织子调用；diff/terminal/read/search 各一块专用展示组件。未知工具数据必须回退通用形态而不是报错（dsh 明确把这条写成纪律）。

### 不必学

11. **Cordis 插件 DI + 自研模块表 + dsh.client manifest 体系**：这是为第三方插件生态准备的，天枢自研客户端没有动态插件需求时，静态 import + 简单注册表即可，省掉整套 boot graph/HMR/共享模块表机制。
12. **Typert 代码生成 RPC**：对天枢的 sidecar HTTP/SSE，手维护一个类型化 TS client（或从 OpenAPI 生成）足够；dsh 自己也承认 Remote 只管 unary，流必须另建数据协议。
13. **100% 覆盖率门禁与庞大的 verify-* 脚本群**：取其"依赖方向"和"i18n"两个最有性价比的门禁即可。
