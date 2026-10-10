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
        target: 'http://127.0.0.1:5300',
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
      },
    },
  },
})
