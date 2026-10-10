#!/usr/bin/env node
/**
 * serve-client.mjs — same-origin layer (plan §4.4, §5.2 #2/#3).
 *
 * Two jobs, both deliberate:
 *   1. Static hosting of the built app so the browser and the API share one origin.
 *      The sidecar's CORS policy only reflects tauri origins by design (a wildcard
 *      next to a Bearer token removes the last cross-origin brake); same-origin
 *      serving sidesteps that entirely instead of loosening it.
 *   2. Reverse proxy /api/* → sidecar with the Authorization header injected here.
 *      The token is generated per boot and never enters the browser bundle — the
 *      VS Code extension reached the same conclusion (token stays out of the webview).
 *
 * SSE is streamed through unbuffered; a proxy that buffers turns live deltas into
 * a wall of text at the end of the run.
 *
 *   node scripts/serve-client.mjs            # production-shaped: static + proxy
 *   node scripts/serve-client.mjs --dev      # also serve the no-build spike app
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAguiState, finalizeAgui, translateToAgui } from '../packages/client-core/src/ag-ui.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(clientRoot, '..')

const args = process.argv.slice(2)
const dev = args.includes('--dev')
const portFlag = args.indexOf('--port')
const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 5300
// Must match the `--state-dir` given to launch-sidecar.mjs; the desktop shell runs a
// second, independent pair from its own state directory.
const stateFlag = args.indexOf('--state-dir')
const infoPath = stateFlag >= 0
  ? resolve(args[stateFlag + 1], '.sidecar-info.json')
  : join(clientRoot, '.sidecar-info.json')
const webRoot = resolve(clientRoot, dev ? 'apps' : join('apps', 'web', 'dist'))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ts': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
}

function loadSidecar() {
  if (!existsSync(infoPath)) {
    console.error(`✗ ${infoPath} missing — start the sidecar first:\n    node scripts/launch-sidecar.mjs`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(infoPath, 'utf8'))
}

const sidecar = loadSidecar()
const upstreamBase = sidecar.baseUrl

async function proxy(req, res, url) {
  const target = `${upstreamBase}${url.pathname.replace(/^\/api/, '') || '/'}${url.search}`
  const controller = new AbortController()
  // Browser tab closed → abort the upstream fetch, otherwise the sidecar keeps a
  // live SSE subscription (and its 30s keepalive) for a viewer that is gone.
  res.on('close', () => controller.abort())

  const chunks = []
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const c of req) chunks.push(c)
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        authorization: `Bearer ${sidecar.token}`,
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
        accept: req.headers['accept'] ?? '*/*',
      },
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `sidecar unreachable: ${err.message}` }))
    return
  }

  const headers = {}
  upstream.headers.forEach((v, k) => {
    // Let Node set content-length/encoding itself; hop-by-hop style fields
    // handed through verbatim make browsers wait for bytes that never come.
    if (['content-length', 'transfer-encoding', 'content-encoding'].includes(k)) return
    headers[k] = v
  })
  headers['x-sidecar-protocol'] = upstream.headers.get('x-tianshu-protocol') ?? '0'
  res.writeHead(upstream.status, headers)

  if (!upstream.body) {
    res.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(value)) {
        // Respect backpressure or a chatty run can grow this process unbounded.
        await new Promise((rs) => res.once('drain', rs))
      }
    }
  } catch {
    // aborted by client disconnect
  }
  res.end()
}

async function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? (dev ? '/spike/index.html' : '/index.html') : url.pathname
  // normalize + containment check: ../ must not escape webRoot.
  const filePath = resolve(join(webRoot, normalize(rel).replace(/^(\.\.[/\\])+/, '')))
  if (filePath !== webRoot && !filePath.startsWith(webRoot + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const info = await stat(filePath)
    const file = info.isDirectory() ? join(filePath, 'index.html') : filePath
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // SPA fallback: a client-side route that isn't a file still renders the app.
    try {
      const body = await readFile(join(webRoot, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`not found: ${rel}\nweb root: ${webRoot}`)
    }
  }
}

/**
 * AG-UI output endpoint (plan §3 / M3).
 *
 * Re-emits a session's sidecar stream in AG-UI vocabulary over SSE, so AG-UI
 * components can consume the same kernel without a private-protocol SDK. The
 * mapping lives in client-core/ag-ui.ts (single source), and the token still never
 * reaches the browser — this runs in the same-origin layer.
 *
 * Scope note: type/structure conformance is asserted by validateAguiStream in tests
 * and scripts/accept-agui.ts; consumption by a real CopilotKit client is NOT
 * verified (no third-party AG-UI package is installed in this workspace).
 */
async function aguiStream(req, res, sessionId) {
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  let upstream
  try {
    upstream = await fetch(`${upstreamBase}/sessions/${encodeURIComponent(sessionId)}/stream?since=0`, {
      headers: { authorization: `Bearer ${sidecar.token}` },
      signal: controller.signal,
    })
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }))
    return
  }
  if (!upstream.ok || !upstream.body) {
    res.writeHead(upstream.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `sidecar stream → ${upstream.status}` }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-agui-version': '1.0',
  })
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  let state = createAguiState()
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
        if (!data) continue
        let ev
        try { ev = JSON.parse(data) } catch { continue }
        if (typeof ev?.seq !== 'number' || typeof ev?.type !== 'string') continue
        const t = translateToAgui(ev, state)
        state = t.state
        for (const e of t.events) send(e)
      }
    }
  } catch {
    // client disconnected
  }
  for (const e of finalizeAgui(state, Date.now())) send(e)
  res.end()
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const agui = url.pathname.match(/^\/ag-ui\/sessions\/([^/]+)\/stream$/)
  if (agui) return void aguiStream(req, res, decodeURIComponent(agui[1]))
  if (url.pathname.startsWith('/api/')) return void proxy(req, res, url)
  return void serveStatic(req, res, url)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`client   http://127.0.0.1:${port}  (${dev ? 'spike/dev' : 'built app'} from ${webRoot})`)
  console.log(`sidecar  ${upstreamBase}  (token injected here, never sent to the browser)`)
  console.log(`api      /api/* → sidecar, SSE streamed unbuffered`)
})
