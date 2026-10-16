---
title: 安装与平台说明
type: guide
status: active
date: 2026-09-17
tags: [install, platform]
related: [../user-guide.md, troubleshooting.md]
---

# 安装与平台说明

> 天枢全部安装路径与各平台注意事项。装完后的使用引导见 [用户手册](../user-guide.md)；装不上、起不来见 [排障与 FAQ](troubleshooting.md)。
> 本项目最初的开发代号为 **Rivet**；为保持向后兼容，已安装的 CLI 命令名仍为 `rivet`。

## 环境要求

- **Node.js ≥ 24**（`engines` 钉定）—— 用 `node --version` 检查。低版本 npm 安装时仅告警但不在支持范围；一键安装脚本会直接拦截并给出升级指引。
- **Git**（强烈建议）—— 可选。没有它天枢仍可运行（就地修改），但 git 能解锁：委派 worktree 隔离、检查点回滚、`commit`/`diff` 审查、每个 worker 的 diff 审查。安装：<https://git-scm.com/downloads>。

## 方式 A：桌面端（从源码跑）

桌面端在本仓 `client/`：`apps/web`（Web 端）+ `apps/desktop`（Electron 壳）+ `packages/ui-*` 组件包，经 `src/server/` 的 sidecar 用 HTTP/SSE 驱动与 CLI 同一个 agent 内核。

**安装包尚未发布**：桌面端暂时只能从源码跑——构建与启动步骤、门禁清单与已知边界见 [../../client/README.md](../../client/README.md)。本文件不重抄命令，也不写「当前有几个 Release」这种会过期的数。

> 旧版桌面端各平台的安装包注意事项（macOS Gatekeeper 与 `xattr -cr`、Linux AppImage 免装、Windows WebView2 与平板模式）随旧交付链一起停用。照那些步骤做，是在改一个**本仓发不出来的应用**的系统属性，所以从本手册移除；相关记载仍留在 `docs/releases/` 的各版本说明里，不删档。自动更新链目前同样没有可用产物，口径见 `docs/decisions/0001-单仓与全栈自主可控.md`。

## 方式 B：一键安装脚本（推荐）

校验 Node ≥ 24 → 全局安装 `tianshu-harness`（默认 npmmirror 镜像加速，`NPM_CONFIG_REGISTRY` 可覆盖）→ 启动 `rivet`；幂等可重复执行：

```bash
# macOS / Linux（bash）
bash <(curl -fsSL https://raw.githubusercontent.com/Wphuaenilng/JunTian-harness/main/scripts/install-tui.sh)
# 只安装不启动：
bash <(curl -fsSL https://raw.githubusercontent.com/Wphuaenilng/JunTian-harness/main/scripts/install-tui.sh) --no-launch

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Wphuaenilng/JunTian-harness/main/scripts/install-tui.ps1 | iex"
# 只安装不启动（克隆仓库后本地跑）：
powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch
```

## 方式 C：npm 手动安装

已发布为 `tianshu-harness`，无需本地构建，且每次启动自动检查更新：

```bash
npm install -g tianshu-harness
rivet
```

> **从旧包 `tianshu-tui` 迁移**：旧包（v3.23.1 前）占着 `rivet` 命令链接，直接装新包会报 `EEXIST: file already exists`——先卸再装：`npm uninstall -g tianshu-tui && npm install -g tianshu-harness`。命令名 `rivet` 不变，另新增 `tianshu` 别名。一键安装脚本已内置该迁移。

> **Windows 提示**：装完提示 `rivet 无法识别` 时——先**新开一个终端**（装 Node 时开着的窗口拿的是旧 PATH）；仍不行，把 `npm prefix -g` 输出的目录加进用户 PATH 再开新终端。官方安装器装的 Node 默认无此问题，nvm/fnm/scoop 安装的需手动加一次。

## Android（Termux）

官方支持路径是 **proot-distro（glibc 发行版）**，裸 Termux（bionic）缺少必需原生依赖（`@ast-grep/napi` / `esbuild`）的 Android 平台二进制，安装守卫会直接拦截并给出指引。

```bash
# 1. 容器准备（Termux 内）
pkg install proot-distro && proot-distro install ubuntu && proot-distro login ubuntu
# 2. 容器内：基础工具 + Node >= 24（nodesource 或 nvm）
apt update && apt install -y curl ripgrep git
# 3. 安装天枢 CLI
npm install -g tianshu-harness
rivet
```

> 手机端能力说明：沙箱自动降级为无沙箱（走正常审批流）、`better-sqlite3` 拿不到预编译时退化为内存库、LSP/语音等按缺失静默降级——核心对话与编码工具链完整可用。`rivet -p "..."` 无头模式同样可跑。实验性强行安装可设 `RIVET_ALLOW_MOBILE_INSTALL=1`（自担风险）。

**手机端使用技巧**：

- **回看输出**：流式期间终端会把视口拽到底部（任何新输出都会）。`Ctrl+S` 冻结输出——冻结期零写入，随便往上翻；`Ctrl+S`/`Ctrl+Q` 解冻后新内容按序补上，不丢。`/scroll` 打开全屏翻页器看最近 1000 行。源码构建用 pnpm 的用户：仓库根目录的 `pnpm-workspace.yaml` 已声明构建放行白名单（`allowBuilds`），`pnpm install` 会自动放行必需原生依赖的构建脚本（老版本 pnpm 用 `pnpm approve-builds`）。注意白名单**不能**写在 `package.json` 的 `pnpm` 字段里——pnpm ≥10 已不再读取该字段，写了也不生效（issue #57）。
- **字形缺字/对齐错位**：Termux 默认字体缺部分装饰字形时设 `RIVET_ASCII_UI=1` 强制 ASCII 边框；中文用户遇 `—`/`…` 撑破对齐设 `RIVET_AMBIGUOUS_WIDTH=wide`。
- **软键盘占半屏**：终端高度 < 14 行时自动隐藏状态行与键位提示行，输入框优先。

## 方式 D：从源码构建

```bash
git clone https://github.com/Wphuaenilng/JunTian-harness.git
cd Tianshu-Tui
npm install
npm run build      # 生成 dist/cli/entry.js
npm start          # 或：node dist/cli/entry.js
```

## Shell 补全（可选）

仓库自带 `completions/` 目录，覆盖 bash / zsh / fish / Windows PowerShell 四种 shell。按你的 shell 安装对应文件：

**bash** —— 任选其一：

```bash
source /path/to/rivet.bash                                   # 追加到 ~/.bashrc
cp completions/rivet.bash ~/.local/share/bash-completion/completions/rivet
sudo cp completions/rivet.bash /usr/share/bash-completion/completions/rivet
```

**zsh** —— 把 `rivet.zsh` 以 `_rivet` 名字放入 `$fpath`：

```bash
mkdir -p ~/.zsh/completions
cp completions/rivet.zsh ~/.zsh/completions/_rivet
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc   # 需在 compinit 之前
```

**fish**：

```bash
mkdir -p ~/.config/fish/completions
cp completions/rivet.fish ~/.config/fish/completions/rivet.fish
```

**Windows PowerShell** —— 在 `$PROFILE` 里 dot-source：

```powershell
Add-Content $PROFILE ". C:\path\to\rivet.ps1"
```

> 补全内容与 CLI 保持一致：顶层命令（`config` / `serve` / `sessions` / `browser` / `logs`）、全局 flags、`config` 全部子命令，以及从 `~/.rivet/config.json` 动态读取的 provider 名。

## 配置 API Key（首次必做）

**直接安装的用户无需手动配置**——首次运行 `rivet` 会先进入主界面，再自动打开 `/connect`；在那里选择服务商并完成认证。之后随时输入 `/connect` 添加或调整 Provider；桌面端也可在 Settings → Provider 管理配置。

**开发者拉源码启动**（或想在启动前预先配好）才需要手动来：

```bash
rivet config set-key deepseek sk-xxx   # 密钥写入 secrets.json（0600），config.json 只留 keyRef
export DEEPSEEK_API_KEY=sk-xxx         # 或：环境变量（仅当前 shell 有效）
```

> 其他提供商（Claude、GLM、Codex、MiniMax、MiMo）用法相同，详见 [模型配置](../user-guide-provider-config.md)。

## 启动

```bash
rivet            # 或：npm start / node dist/cli/entry.js
```

你会看到带有 `〉` 提示符的 TUI。输入需求后按回车即可。

## 自动更新

通过 npm 安装时，天枢每 24 小时在启动时检查新版本并弹出提示。`/update` 会执行 `npm install -g tianshu-harness@latest` 并重启（包名从当前安装的 `package.json` 读取，不写死）；源码安装则用 `git pull && npm install && npm run build`。用 `RIVET_NO_UPDATE_CHECK=1` 可关闭检查。
