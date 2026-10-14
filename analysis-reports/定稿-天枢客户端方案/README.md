# 定稿 · 天枢客户端方案

> 整理日期：2026-10-09
> 状态：设计稿与计划均已按批注定稿，可作为 M1 开工依据。

## 内容

### 整改计划

- [天枢Web桌面客户端自研计划-v2.0.md](天枢Web桌面客户端自研计划-v2.0.md) — 完整实施计划：可行性依据、协议选型（私有 sidecar + AG-UI 对齐 + ACP 后置）、架构与分包、M0–M3 里程碑、风险对策、技术选型。

### 最终设计稿（dsh 风格版，经 6 条批注修订）

| 文件 | 说明 |
|---|---|
| [design/tianshu-desktop-mockup-dsh-style.png](design/tianshu-desktop-mockup-dsh-style.png) | 展开态主图（1600×1000 @2x）：项目列表 + 最近对话侧栏、居中窄栏对话流、三态审批面板、对话输入框、折叠组右栏、底部状态条（速度/上下文/缓存命中/成本） |
| [design/tianshu-desktop-mockup-dsh-collapsed.png](design/tianshu-desktop-mockup-dsh-collapsed.png) | 右栏收起态（44px 图标细条） |
| [design/desktop-mockup-dsh-style.html](design/desktop-mockup-dsh-style.html) | HTML 源稿（纯手写零依赖，右栏开合/折叠组可点击交互） |
| [design/screenshot-dsh.cjs](design/screenshot-dsh.cjs) | 复截脚本（playwright-core + 系统 Edge 无头） |

## 设计定稿要点

- 视觉语言：dsh 真实 token（`--dsw-*` 浅色版），白底 + 蓝调灰、近黑主按钮、居中窄栏文档流；
- 信息架构：项目列表 / 最近对话 / 对话流（思考→工具→diff→流式）/ 三态审批 / composer / 折叠组右栏 / 底部状态条；
- 品牌只在侧栏头部一处；SSE/AG-UI 状态收纳进底部状态条。

## 过程稿（不在本目录）

- v1 深蓝科技风设计稿：`analysis-reports/design/*-v1.*`
- 调研报告（对比分析、dsh 前端拆解、行业调研、协议调研）：`analysis-reports/*.md`
