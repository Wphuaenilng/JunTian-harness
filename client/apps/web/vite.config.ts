import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Workspace packages are consumed as source (no per-package build step yet), so they
 * are aliased straight to their src entry. Bare imports hit `entry`, subpaths like
 * `@tianshu/ui-theme/tokens.css` map onto the same src directory.
 */
const PACKAGES: Array<{ name: string; entry: string }> = [
  { name: 'client-core', entry: 'index.ts' },
  { name: 'store', entry: 'index.ts' },
  { name: 'locale', entry: 'index.ts' },
  { name: 'ui-theme', entry: 'index.ts' },
  { name: 'ui-primitives', entry: 'index.ts' },
  { name: 'ui-session', entry: 'index.tsx' },
  { name: 'ui-chat', entry: 'index.tsx' },
  { name: 'ui-approval', entry: 'index.tsx' },
  { name: 'ui-settings', entry: 'index.tsx' },
  { name: 'ui-git', entry: 'index.tsx' },
  { name: 'ui-files', entry: 'index.tsx' },
  { name: 'ui-schedule', entry: 'index.tsx' },
]

const alias = PACKAGES.flatMap(({ name, entry }) => [
  { find: new RegExp(`^@tianshu/${name}$`), replacement: resolve(here, `../../packages/${name}/src/${entry}`) },
  { find: new RegExp(`^@tianshu/${name}/(.*)$`), replacement: resolve(here, `../../packages/${name}/src/$1`) },
])

/**
 * Dev runs against the same-origin layer (scripts/serve-client.mjs), not against a
 * bare vite server: the sidecar's CORS allowlist reflects tauri origins by design,
 * so a lone vite dev server would need RIVET_DEV_CORS_ORIGINS and a browser-held
 * token — the two things plan §5.2 says not to do. /api is therefore proxied to
 * serve-client, which injects the token.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  server: {
    port: 5310,
    proxy: {
      '/api': {
        // 默认打 5300；`RIVET_DEV_UPSTREAM` 让验证脚本能挑一个空闲端口，而不必去撞
        // 操作者正在用的那台 serve-client——撞上了会拿到**别人实例**的 200，
        // 把"没验成"读成"验过了"。
        target: process.env.RIVET_DEV_UPSTREAM ?? 'http://127.0.0.1:5300',
        changeOrigin: false,
        // SSE must not be buffered by the dev proxy either.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // frame-probe.html is a developer page for the sandboxed frame's security
      // behavior; it is built so it can be opened against the same-origin server.
      input: {
        main: resolve(here, 'index.html'),
        probe: resolve(here, 'frame-probe.html'),
        ctx: resolve(here, 'ctx-probe.html'),
        bubble: resolve(here, 'bubble-probe.html'),
        row: resolve(here, 'row-probe.html'),
        // hl-probe.html: developer page proving shiki actually painted tokens in the browser
        // (MarkdownBlock swallows highlight failures, so plain code looks like correct code).
        hl: resolve(here, 'hl-probe.html'),
        // stall-probe.html: developer page that finally *renders* the approval stall alarm §5.2-5
        // promised — same panel and CSS, only the threshold prop differs between the two columns.
        stall: resolve(here, 'stall-probe.html'),
        // ime-probe.html: developer page that measures the Enter-to-send rule in a real browser —
        // a composing Enter (IME candidate commit) must not send, a plain Enter must.
        ime: resolve(here, 'ime-probe.html'),
        // git-probe.html: developer page that counts how often the Git workbench re-reads itself
        // (a render-period `scope` object made that loop), and whether a late diff can overwrite
        // the file the user actually selected.
        git: resolve(here, 'git-probe.html'),
        // settings-probe.html: developer page that mounts the real <SettingsPanel> (no verifier
        // ever opened the settings modal, so its reads had no browser evidence at all) and makes
        // the latest-wins gate observable: a config read that lands late must not overwrite the
        // mode the user just saved.
        settings: resolve(here, 'settings-probe.html'),
      },
    },
  },
})
