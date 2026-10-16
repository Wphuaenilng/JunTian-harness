# 外部 PR 处置说明（External PRs）

> **English TL;DR** — This repo is the single source of truth. To keep the runtime
> safe, external PRs are never merged directly: their content is reworked by the
> maintainer against the current code, verified here, and landed as our own commit.
> Your PR is closed with a `sync-merged` label — closed **≠** rejected; credit and
> listing are independent of the merge state.

> **一句话**：本仓就是唯一事实源。**为了运行时不被改坏，外部 PR 的内容不会在本仓
> 直接 merge，而是由维护者按当前代码现状重写（收编）、验证通过后，以本仓自己的提交落地。**
> 你的 PR 会以 `sync-merged` 标签关闭——关闭不等于拒绝。

## 为什么不在本仓直接 merge

- 单仓：本仓之上没有第二层不公开的仓可供 sync，落地形态就是一笔普通提交；
- 直接 merge 外部分支的后果：
  1. 本仓的历史与外部分支分叉，后续改动会覆盖你的版本或制造冲突；
  2. 未经维护者验证与适配的代码进入本体，**运行时**（CLI、agent 内核、桌面端 sidecar）
     可能被改坏——公开 CI 只覆盖它跑得起来的那部分，剩下的要靠落地前那一趟完整门禁；
  3. 历史出现两个源，回滚与追责都变困难。
- 因此内容**全部由维护者按本仓现状重写**：接口/类型/测试结构对齐、去重、
  必要的拆分，保持 PR 的语义与意图，然后跑完整门禁。

## 一个外部 PR 的一生（四步）

1. **评审并收编**——改写发生在维护者本地，原 PR 不做 merge；
2. **以本仓自己的提交落地**——`feat:` / `fix:` 一笔，提交说明里带上 PR 编号；
3. **`sync-merged` 标签 + 关闭 + 说明**——说明里写清「以 sync 形态合入」；
4. **署名落账（两本账）**：
   - `credit: PR #N` 提交（`Co-authored-by` trailer）——每个 PR 一笔，提交页显示共同作者；
   - `CREDITS.md` 每个 PR 一行，以该 PR 作者为 `--author` 提交——GitHub 仓库的
     Contributors 面板只统计「非空提交 + author 是本人账号关联邮箱」，空提交与 co-author
     都不计入，所以这一本才是让账号出现在面板里的账。

维护者侧工具：`scripts/dispose-community-pr.sh <PR#>`（四步固化，幂等）。

## 收编时会做什么、不会做什么

- **会**：适配当前接口与命名、补测试、按仓库结构拆分、去掉与本仓现有实现重复或冲突的部分、
  合并同族改动。
- **不会**：改变你贡献的语义与意图；不会丢掉你的署名（名单与台账都会记录）。

## 你能看到的痕迹

- PR 上的关闭说明与 `sync-merged` 标签；
- 本仓历史里的 `credit: PR #N` 与 `credit(PR #N): …` 提交；
- `CONTRIBUTORS.md`（完整名单，含人工撰写的贡献描述）与 `CREDITS.md`（署名台账，按 PR 逐行）。

## 相关文件

- [CONTRIBUTING.md](CONTRIBUTING.md)——贡献总入口与四个步骤
- [CONTRIBUTORS.md](CONTRIBUTORS.md)——外部贡献者名单（按首次贡献时间排序）
- [CREDITS.md](CREDITS.md)——署名台账（供 GitHub Contributors 面板收录）
