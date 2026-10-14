# @tianshu/ui-primitives

Rendering primitives. Consumes **no protocol events** — it takes strings and shapes
handed down from `ui-chat`, so it stays testable without a sidecar.

- `MarkdownBlock` — per-block incremental parse (only the open tail re-parses).
- `DiffBlock` / `ToolOutputBlock` — unified-diff view with +/− stats.
- `AppFrame` — sandboxed embedded view + postMessage bridge (MCP Apps 预留).
- `submitsOnEnter` — the composer's Enter rule as one function, so the IME guard has a single home:
  Enter sends, Shift+Enter is a newline, and the Enter that commits an input-method candidate sends
  nothing (`submit-key.ts`). `check:layers` pins every Enter-submitting site in the host to it.
- Consumers import `@tianshu/ui-primitives/styles.css` once.

## The MCP Apps container (`app-frame.ts` + `app-frame-view.tsx`)

A tool result that **is** an HTML document gets a frame instead of a text dump.
`looksLikeHtmlDocument` only fires on a real document (`<!doctype html` / leading
`<html>`) within the first 400 chars, so a prose receipt mentioning `<b>` and every
unified diff keep rendering as text.

Trust model, and why each piece is the way it is:

- `sandbox="allow-scripts"` **without** `allow-same-origin`; also `no-referrer`, no
  top-navigation, no popups. The frame cannot read this document, cannot reach
  `localStorage`, cannot present this origin's cookies. Measured, not assumed —
  `apps/web/frame-probe.html` mounts the real component against an adversarial document
  that tries all three and reports what happened.
- Because that sandbox makes the frame an **opaque origin**, `event.origin` is useless
  for authentication (it reports the opaque value). The bridge therefore requires a
  per-frame nonce, minted from `crypto.getRandomValues` and injected into the document;
  a message without it is dropped. No CSPRNG → no frame, only a `<pre>`.
- Inbound effects are closed by construction: a clamped height (`80…4000px`, so `1e9`
  cannot blow out the layout) and an `https://`-only href handed to a callback. There is
  no path from a frame message into host DOM, host navigation, or the API client.
- Outbound (`theme`, `context`) is pushed once the view reports `ready` and again whenever
  the host changes it — measured, not asserted: `frame-probe.html` flips its own theme when
  the first push comes back and reports the whole sequence, which on the current build is
  `themes: ["dark","light"]` over 5 host messages. `context` rides in the same effect, so it
  is re-sent with the theme change; an embedded view must treat it as idempotent. Deleting
  `theme` from that effect's dependency list makes the probe report `["dark"]` and fail —
  the re-push is the claim, and the probe is the gate for it.
- `injectBridge` places the bootstrap in the **head**, ahead of the document's own
  scripts: inserting before `</body>` (the obvious choice) leaves an author script
  running with no bridge, which is the first thing a producer would trip over.

The bridge surface is `window.__tianshu__ = { nonce, resize(), ready(), open(), lastHost }`
plus an optional `window.onHostMessage`. That is the entire API an embedded view gets.

## Code highlighting (`highlight.ts`, shiki)

Plan §8's last cell. It is a **post-pass over sealed blocks only**: `MarkdownBlock`
renders micromark html immediately, then — when the block is no longer `open` and contains a
labelled fence — replaces each `<pre><code class="language-x">` with shiki's output.

- Why not inline in the parser: re-running a highlighter over the growing open tail is the
  O(n²) streaming trap §8 names, and half-typed tokens would flash anyway.
- Theme is CSS-only: `defaultColor: false` with `themes: { light: 'light-plus', dark: 'dark-plus' }`
  puts every token in `--shiki-light` / `--shiki-dark`, and `styles.css` picks per
  `[data-theme]`. Highlighted code therefore follows a theme switch **without re-running
  shiki** — no re-push seam needed (unlike `AppFrame`), and the cache key has no theme in it.
- Identity, not order: substitution is by the exact micromark html, through a **function**
  replacer, so shiki's own `$&` / `$1` sequences cannot be read as replacement patterns.
- Dedupe: cache by `language + code`, plus an in-flight map so two identical fences in the
  same message render once (this caught a real double-render — see `test/highlight.test.ts`).
- Degradation is deliberately one-directional: an unknown grammar, a blocked loader, or an
  unlabelled fence leave the block exactly as micromark emitted it. `text` / `console` /
  `output` are treated as "not a language" on purpose.
- Cost, stated: the app entry chunk is unchanged (99.67 kB); shiki is a lazy chunk (~217 kB,
  gzip 69 kB) fetched only when a labelled fence appears, and each grammar is its own chunk.

## Rules that must not erode

- `micromark(..., { allowDangerousHtml: false })`. Model output, file contents and
  tool results all land here; raw HTML must be escaped, not executed. The one place HTML
  **does** run is `AppFrame`, and it runs over there — in an opaque-origin sandbox with no
  host surface. Never move an authored document into the host DOM.
- **A sealed block is parsed exactly once.** `renderMarkdown(id, source, open)` re-parses only the
  `open` tail; everything else comes from the cache keyed by block id (ids are monotonic in
  `SessionModel` and never reused, even when history paging re-derives the timeline). The cache
  *is* plan §8's fix for the streaming O(n²) trap, so it is guarded by `markdownParseCount` plus
  two tests in `test/markdown.test.ts` — deleting the cache lookup fails those and nothing else.
- No component-library dependency (plan §8: 自研原语 + CSS token).
- Style only through `--*` semantic aliases from `@tianshu/ui-theme`.

## Not done yet (tracked in the plan)

- the Cline-style streaming diff trio (M2 — shipped in
  `ui-chat`, whose card decides intent-vs-landed; the diff parser lives here).

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
| 宿主回调 props | `onLink`、`onOpenChange` |
<!-- protocol-ledger:end -->
