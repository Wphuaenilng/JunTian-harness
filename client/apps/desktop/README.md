# @tianshu/app-desktop

The M3 shell: an Electron window around the **same** `apps/web` bundle, with the sidecar
and the same-origin layer as its own child processes. It is a host, not a fork — no
protocol code lives here, and the kernel is untouched (plan §1 non-goals).

```
node scripts/launch-sidecar.mjs --state-dir apps/desktop/.runtime ...   # sidecar (detached)
node scripts/serve-client.mjs --port <free> --state-dir apps/desktop/.runtime
electron .                        # window → loadURL(http://127.0.0.1:<free>/)
node scripts/verify-desktop.mjs   # CDP proof it actually rendered
node scripts/verify-single-instance.mjs   # 真起两份进程，证明第二份在 boot 之前就退出
```

## Boot order (`src/main.mjs`)

1. **Reclaim, then start.** The sidecar is detached by design, so a crashed previous
   boot can leave one holding the single-writer StoreLock; the shell stops the recorded
   pid first when its own state dir still answers `/health`.
2. `launch-sidecar.mjs` (random port + token, health-gated, its **own** `--state-dir`)
   → `apps/desktop/.runtime/.sidecar-info.json`.
3. `serve-client.mjs` on a free port → static built app + `/api` reverse proxy that
   injects `Authorization`. The renderer never holds the token.
4. `BrowserWindow.loadURL(...)`, and quit tears both children down (`--stop` kills by
   recorded pid, never by image name).

One `--state-dir` flag moves both bookkeeping files, which is why the desktop shell and a
dev browser can run at the same time instead of fighting over one info file and one log.

## Security posture (measured, not claimed)

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, **no preload at
  all** — the renderer needs no Node, it talks HTTP to 127.0.0.1. A preload is where a
  shell usually widens its own surface.
- `will-navigate` and `will-frame-navigate` are pinned to the shell's own loopback
  origin; `setWindowOpenHandler` returns `deny` rather than handing a URL to the system
  browser, because the click may come from a tool result or an embedded MCP view.
- `requestSingleInstanceLock()` so a second window cannot start a second sidecar against
  the same store — **measured with two real processes**, see the next section.

`scripts/verify-desktop.mjs` drives it over CDP (`--remote-debugging-port`) and asserts:
READY logged → window on the served origin → React mounted (title `天枢`) → sidebar +
status bar present → `/api/health` from inside the page answers
`{status:200, protocolVersion:1, readiness:ready, configured:true}` → the boot token
appears in neither the HTML nor the 84 KB JS bundle → `process`/`require`/`module` are
all `undefined` in the renderer → an attempted cross-origin `location.assign` did not
take the window away → the tray icon decodes (`icon=32x32`) → the tray self-test's
hide / show / close-to-tray all report `true`. Eleven checks on the happy path, all green. (A twelfth `check()` call exists only in the catch
branch — the "12 checks" the docs used to quote counted it; corrected 2026-10-10 when the two
daemon-runtime guards below were added, which makes the happy path thirteen.)

## 单实例锁：真起两份进程量出来的（`scripts/verify-single-instance.mjs`）

`main.mjs` 在 `app.whenReady()` **之前**要锁，整个 boot（sidecar + serve + 窗口）都在拿到锁
那一支里。这个顺序才是这条锁有意义的理由，也正是「代码评审里读起来永远是对的」那一类断言
——所以要跑两份真进程看它到底怎么办。本机 2026-10-10 两轮结果一致：

| 观察项 | 实测 |
|---|---|
| A 拿到锁并 boot | `SINGLE-INSTANCE acquired` → `READY http://127.0.0.1:59526/ sidecar=…:59517 protocol=1` |
| B 在 boot 之前就退出 | `SINGLE-INSTANCE refused …`，全程没有 `READY`、没有 `acquired`，`exit=0`（干净退出，不是崩溃） |
| A 收到通知并把窗抬起来 | `SECOND-INSTANCE shown=true` |
| 没人改写过登记 | 前后两次读 `.sidecar-info.json`：token / port / pid / mtime 完全相同（`pid 15544 → 15544`，`port 59517 → 59517`）——第二份若真起过 sidecar，这里必然被抢写 |
| A 仍是唯一持有者 | 收尾时 A 进程还活着，随后按 SIGTERM + `launch-sidecar.mjs --stop` 收干净 |

顺带修了一处真实的时序缺陷：`second-instance` 监听原先注册在 `boot()` **之后**，也就是说在
sidecar 起来那几秒钟里再点一次图标，事件会落进没有监听器的空气里——不报错，只是窗没抬起来。
现在监听在拿锁那一支的最开头注册，窗还没建时打
`SECOND-INSTANCE shown=false (no window yet — still holding the only lock)`。

**反向变异验过这两条断言不是空喜**：把拒绝分支的日志文本改掉（锁本身不动）→ 只有
「B refused before booting」见红；去掉 `second-instance` 的回执日志 → 只有
「A was told about it」见红。各恰好一条红、其余全绿，还原后 8/8 复绿。

## daemon 的运行时：electron-as-node 只能给脚本，不能给内核

`run()` 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 起 `launch-sidecar.mjs` 和
`serve-client.mjs`——在 Electron 主进程里 `process.execPath` 是 app 本体，而这两条是纯 JS 脚本，
这么跑是对的。**问题在下一代交接**：`launch-sidecar.mjs` 再 spawn daemon 时用的还是同一个二进制，
而内核要加载按 Node ABI 编译的 `better-sqlite3`，在 Electron 的 ABI 上直接 dlopen 失败，
`apps/desktop/.runtime/.sidecar.log` 里就是这一行：
`Session registry schema failed: … NODE_MODULE_VERSION 137 vs 149 (ERR_DLOPEN_FAILED)`。

**而 `/health` 照样回 `readiness=ready`。** READY、托盘、同源代理那 11 项全绿（单实例锁是另一条
验法），坏的只是「记得住会话」那一层。2026-10-10 是因为写了 `scripts/verify-desktop-store.mjs`（起壳 → 建会话 →
列表读回 → 单条读回 → 归档）才抓到的——它是第一个真去用会话库的验法。

修法在 `scripts/launch-sidecar.mjs`：`daemonRuntime()` 发现自己是 electron-as-node 时，按
`RIVET_NODE_BIN` → PATH 里的 `node(.exe)` 顺序找一个 **major ≥ 24** 的真 node 起 daemon，并打出
用的哪一个（`daemon: D:\environment\nvm\v24.13.0\node.exe (v24.13.0, electron-as-node)`）；
一个都没有就**拒绝启动**并给出可操作的报错，而不是带病起飞。浏览器路径不受影响（那里
`process.execPath` 本来就是真 node，同一行日志报 `inherited`）。daemon 的 env 里
`ELECTRON_RUN_AS_NODE` 被删掉——那是给脚本的开关，不该继续往下一代传。

两条守卫已进常驻的 `verify-desktop.mjs`（happy path 11 → 13 项）：daemon 行必须是非 electron.exe 的真 node；
`.sidecar.log` 不得出现 `ERR_DLOPEN_FAILED` / `Session registry schema failed` /
`NODE_MODULE_VERSION`。**反向变异三条各自只红一条**：删掉那条 `console.log` → 红 daemon 行；
把 spawn 改回 `process.execPath`（诚实的日志留着）→ 只红日志那条，也就是守卫盯的是**实际子进程**
而不是措辞；把 PATH 清空 → 启动器 exit=1 报「needs a real Node >= 24 … Set RIVET_NODE_BIN」。

**对安装包那一格（已搁置）有实际影响**：桌面壳现在要求机器上有 Node ≥ 24，或者显式给
`RIVET_NODE_BIN`。真要出包，就得随包带一个 node 运行时，或者把内核的 native 按 Electron ABI
重编——这是 §9 v2.0「双击即用」底下一块真实的砖，不是配置细节。

## 托盘（`--tray-check`）

Closing the window **hides** it; the sidecar this shell owns keeps running scheduled jobs
and any unfinished turn, so an accidental X must not kill them. Only 退出天枢 in the tray
menu (or the smoke timer) sets `quitting`, which is what lets a close through the gate.

- Icon: `assets/tray.png`, 32×32 RGBA, generated by `npm run icon`
  (`scripts/make-icon.mjs` writes the PNG itself — signature, IHDR, one zlib IDAT, IEND,
  each chunk with its own CRC32 — because this workspace has no image library and adding
  one for 192 bytes would be silly). Mark colour is the product's `--ds-500`, pivot
  `--nb-1000`: a mid-blue reads on both the light and the dark Windows taskbar, white and
  black each vanish on one of them.
- Menu follows the **OS** locale (`app.getLocale()`), not the renderer's: the language
  toggle lives in `localStorage` inside a sandboxed page the main process cannot read.
  Labels are 显示主窗口 / 隐藏到托盘 / 退出天枢.
- Click toggles show/hide, double-click shows. If the PNG ever fails to decode the shell
  logs `TRAY FAILED` and **degrades to no tray** rather than throwing at boot.
- What the self-test really drives: `win.hide()` → `showWindow()` → `win.emit('close',
  {preventDefault})`, reading back `isVisible()` and whether the gate cancelled it. A
  headless run cannot click the taskbar, so **the click handler itself is unverified** —
  the functions it calls are.

**A finding worth knowing**: the first DOM probe went red (`root.children === 0`) while the
self-test had the window hidden, then passed with a wait loop. A hidden Electron window does
not finish mounting — so any "is the shell alive" probe has to poll, never sample once. Same
class of trap as the in-app browser being a hidden page.

## Not done

- **No installer.** The plan's `electron-builder` Windows package needs a second
  dependency set (and a code-signing decision); shipping an unsigned `.exe` is not
  something to do quietly. `apps/desktop/release/` is reserved as its output path.
- No auto-updater, no window-state persistence (size/position are not remembered).
- The store starts empty by design (isolated `sidecar-data`), so the desktop shell shows
  "还没有会话" on first boot rather than the dev browser's sessions. Provider config is
  deliberately shared with the dev state dir so a fresh shell can run sessions at all.

## Environment caveat (this machine)

`github.com/electron/.../releases` is unreachable here (TLS timeout/ECONNRESET — the same
reason git push needs the local proxy), while `registry.npmjs.org` and
`npmmirror.com/mirrors/electron/` answer fine. pnpm's build script did **not** land the
binary even with `electron: true` in `pnpm-workspace.yaml` `allowBuilds`; the working
invocation was the package's own installer with the mirror set explicitly:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ corepack pnpm install
cd apps/desktop/node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

The second line is the part to remember: `pnpm install` alone left `path.txt` and
`dist/electron.exe` missing, and `electron .` fails on that silently.
