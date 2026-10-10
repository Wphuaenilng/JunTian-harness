#!/usr/bin/env node
/**
 * check-health.mjs — M0 #2: handshake probe.
 *
 * Asks capabilities, not version (plan §5.1 / issue #266): the sidecar and this
 * client upgrade independently, so a hardcoded "version >= x" threshold is how
 * "click does nothing" bugs are born. `capabilities` is the runtime self-reporting
 * what it can serve; `protocolVersion` is only a breaking-change fence.
 *
 * Exits non-zero when the fence or the self-report is missing, so CI can gate on it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_PROTOCOL_VERSION = 1

function loadInfo() {
  try {
    return JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8'))
  } catch {
    throw new Error('no .sidecar-info.json — run: node scripts/launch-sidecar.mjs')
  }
}

const info = loadInfo()
const res = await fetch(`${info.baseUrl}/health`, {
  // Anonymous /health is deliberately thin ({ok, version}) — the rich fields
  // including readiness and storeLockHolder only come back with the token.
  headers: { authorization: `Bearer ${info.token}` },
  signal: AbortSignal.timeout(5000),
})
if (!res.ok) throw new Error(`GET /health → ${res.status}`)
const health = await res.json().catch(() => {
  throw new Error('GET /health returned non-JSON')
})

const rest = await fetch(`${info.baseUrl}/sessions`, {
  headers: { authorization: `Bearer ${info.token}` },
  signal: AbortSignal.timeout(5000),
})
const headerProtocol = Number(rest.headers.get('x-tianshu-protocol') ?? 0)

const lines = [
  `sidecar        ${info.baseUrl}  pid=${info.pid}`,
  `version        ${health.version}`,
  `readiness      ${health.readiness}`,
  `capabilities   ${JSON.stringify(health.capabilities)}`,
  `protocol       body=${health.protocolVersion} header=${headerProtocol} expected=${EXPECTED_PROTOCOL_VERSION}`,
  `sessions       ${health.sessionCount} (running ${health.runningCount})`,
  `data dir       ${info.desktopDir}`,
  `configured     ${health.configured} (provider API key)`,
]
console.log(lines.join('\n'))

const failures = []
if (health.readiness !== 'ready') {
  failures.push(`readiness=${health.readiness} (initializationError: ${health.initializationError ?? 'n/a'})`)
}
if (typeof health.protocolVersion !== 'number') failures.push('protocolVersion missing')
if (health.protocolVersion !== EXPECTED_PROTOCOL_VERSION) failures.push(`protocolVersion ${health.protocolVersion} != expected ${EXPECTED_PROTOCOL_VERSION}`)
if (!health.capabilities || typeof health.capabilities !== 'object') failures.push('capabilities missing (old runtime? fall back to version compare)')
if (headerProtocol !== EXPECTED_PROTOCOL_VERSION) failures.push(`x-tianshu-protocol header ${headerProtocol} != ${EXPECTED_PROTOCOL_VERSION}`)

if (failures.length > 0) {
  console.error(`\n✗ handshake failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\n✓ handshake OK — ${Object.keys(health.capabilities).length} capabilities advertised`)
if (health.configured === false) {
  console.log('⚠ no provider key: send/receive (M0 #3) needs one configured.')
}
