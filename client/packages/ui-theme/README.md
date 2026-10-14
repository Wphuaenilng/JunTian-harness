# @tianshu/ui-theme

Design tokens and theme boot. No components, no runtime deps.

## Consumed by every ui-* package

- `tokens.css` — the `:root` ramp; each value is reconciled against the approved mockup by
  `node scripts/check-mockup-tokens.mjs`（结论：真值差 0 条；6 条改名后相等、4 条仅写法差、
  7 条是我们自定而 mockup 从未声明的 —— 所以「与定稿一致」只对**值**成立，不对命名与几何成立）
  事实源：`analysis-reports/定稿-天枢客户端方案/design/desktop-mockup-dsh-style.html`。
  Components must reference the **semantic aliases** (`--bg-base`, `--label-primary`,
  `--accent`, …), never a raw ramp value like `--nb-700`. That is what keeps a dark
  theme a one-file change instead of a sweep through every stylesheet.
- `applyTheme` / `BOOT_SCRIPT` — anti-flash boot; inline `BOOT_SCRIPT` in `<head>`.
- `resolvedTheme()` — the concrete `light`/`dark` **currently painted**, read off the
  attribute rather than re-derived from `matchMedia`. Anything outside the CSS cascade
  that has to agree with the paint (an embedded frame's theme push, a canvas) must ask
  this; `matchMedia` disagrees with a forced `light`/`dark` preference.
- `watchSystemTheme(cb)` — the mode-`system` follow-up: `data-theme` is a stamp, not a
  binding, so without a `change` subscription the app keeps the value the boot script
  read and an OS switch paints nothing. Only correct to subscribe while the mode *is*
  `system` (the helper re-applies `system`, which would resurrect it over a forced choice).

## 主题链路的三条纪律（2026-10-10 起 `node scripts/check-theme.mjs` 逐条判定）

1. **一套真相**：`tokens.css` 只按 `[data-theme]` 上色，不写 `@media (prefers-color-scheme)`；
   媒体查询只在 boot 脚本与 `watchSystemTheme` 里出现一次。
2. **mode='system' 必须订阅媒体变化**，并且把解析出的具体值**放进 React state**。
   存 mode 而现读 `resolvedTheme()` 是不行的：mode 一直是 `'system'` 时 `setTheme('system')`
   被 React 判等跳过渲染，下游（含沙箱帧）什么都收不到。
3. **帧的推送跟随 prop**：`app-frame-view.tsx` 的推送 effect 依赖必须是
   `[ready, nonce, theme, sessionId]`；只依赖 mount 的版本会在宿主换主题后把帧留在旧色。

实测留档：`apps/web` 点三次主题按钮走完一圈，`(stored, stamp)` 依次为
`dark→dark`、`system→light`（此时浏览器/系统偏好是浅色）、`light→light`、回到 `dark→dark`——
forced 值赢过系统偏好，system 值跟随偏好，两者都不脏。

行为判定：`test/theme.test.ts` 4 条（`FakeBrowser` 伪造 dataset / localStorage / matchMedia，
真发 `change` 事件，验重盖章、回调值、退订后不再回调、存储被封时不抛）。
`check-theme.mjs` 静态 14 + 委托 3 + 人工留档 0，已接入 `ci-smoke` 第一阶段。第三条委托是**帧内主题重推的浏览器实测**：由 `scripts/check-live-geometry.mjs` 开 `/frame-probe.html` 读回 `window.__probe__` 的 13 条判定与 `pass`（该门故意不接 CI、且要本机 Edge，所以口径是"门能测、CI 不跑"，不是"测不了"）。人工留档现在只剩真测不了的那一眼：在 Windows 里翻系统深色。
8 条反向变异全部见红（漏依赖、现读值、不订阅、同值陷阱、双真相、probe 不翻转、不退订、不盖章）。

**仍未实测**：真人在 Windows 设置→颜色→深色 里翻转系统主题。内置浏览器无法 emulate 媒体
（`matchMedia` 每次调用返回新实例，脚本自造的 `change` 事件也到不了 app 的监听器），
所以这条只能靠眼睛看；见 `client/README.md` 的人工清单。

## Protocol surface consumed

None. This package is theme-only and must stay that way.

## Open items

- The dark ramp here is **derived**, not design-reviewed: the 定稿 mockup is light-only.
  Any specific dark value is provisional until a dark mockup exists.

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
| 宿主回调 props | — |
<!-- protocol-ledger:end -->
