/**
 * accept-settings.ts — settings center against a live sidecar.
 *
 * Deliberately careful with your real configuration:
 *   - the approval mode is written, verified, then **restored to its original value**;
 *   - the key-write path is exercised on a throwaway custom provider that is deleted
 *     at the end, so the in-use `deepseek` key and its slots are never touched.
 *
 *   node scripts/accept-settings.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const info = JSON.parse(readFileSync(join(clientRoot, '.sidecar-info.json'), 'utf8')) as { baseUrl: string; token: string }
const api = new SidecarClient({ baseUrl: info.baseUrl, token: info.token })

const failures: string[] = []
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// --- read paths -------------------------------------------------------------
const approval0 = await api.getApprovalConfig()
console.log(`GET /config/approval    → ${approval0.approval} (unsandboxed=${approval0.unsandboxed})`)
const model0 = await api.getDefaultModelConfig()
console.log(`GET /config/default-model → ${model0.defaultModel}`)
const domains = await api.getDomainConfig()
console.log(`GET /config/default-domain→ ${domains.defaultDomain}, ${domains.domains.length} domains`)
const checkpoint = await api.getCheckpointConfig()
console.log(`GET /config/checkpoint    → every ${checkpoint.checkpointEveryTurns} turns`)

const providers0 = await api.getProviders()
const deepseek0 = providers0.providers.find((p) => p.name === 'deepseek')
if (!deepseek0) {
  console.error('✗ deepseek provider missing — aborting before any mutation')
  process.exit(1)
}
console.log(`providers               : ${providers0.providers.map((p) => `${p.name}${p.isDefault ? '*' : ''}`).join(', ')}`)
console.log(`deepseek keyStatus      : ${deepseek0.keyStatus.source} ${deepseek0.keyStatus.ref} (server-masked)`)

check('read surfaces return the documented shapes',
  typeof approval0.approval === 'string' && Array.isArray(providers0.providers) && domains.domains.length > 0)

// --- approval write, then restore ------------------------------------------
const other = ['auto-accept', 'auto-safe', 'manual', 'dangerously-skip-permissions'].find((m) => m !== approval0.approval)!
const written = await api.setApprovalConfig({ approval: other })
check(`PUT /config/approval (${other})`, written.approval === other, `echo=${written.approval}`)
const readBack = await api.getApprovalConfig()
check('approval persisted across a fresh GET', readBack.approval === other, `read=${readBack.approval}`)
const restored = await api.setApprovalConfig({ approval: approval0.approval })
const finalApproval = await api.getApprovalConfig()
check('approval RESTORED to original', finalApproval.approval === approval0.approval, `now=${finalApproval.approval} (echo=${restored.approval})`)

// --- key write on a throwaway provider --------------------------------------
const THROWN = 'acceptance-throwaway'
let throwawayCreated = false
try {
  await api.deleteProvider(THROWN)
} catch {
  // not present yet
}
try {
  await api.createCustomProvider({
    providerName: THROWN,
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-throwaway-not-a-real-key-000000',
    model: { id: 'throwaway-model', contextWindow: 4096, maxTokens: 512 },
  })
  throwawayCreated = true
} catch (e) {
  check(`POST /config/providers/custom (${THROWN})`, false, (e as Error).message)
}

if (throwawayCreated) {
  const list = await api.getProviders()
  const thrown = list.providers.find((p) => p.name === THROWN)
  check('throwaway provider appears in the catalogue', !!thrown, thrown ? `keys=${thrown.keys.length}, models=${thrown.models.map((m) => m.id)}` : '')
  const keyId = thrown?.keys[0]?.id ?? 'default'

  // The server probes an inline apiKey against the provider baseUrl before storing it
  // (config-routes-keys.ts:150). Our throwaway baseUrl is unreachable on purpose, so
  // the write MUST be refused — a settings form that reported success here would be
  // lying about a key that cannot work.
  let refused = false
  let refusal = ''
  try {
    await api.setProviderKey(THROWN, keyId, { apiKey: 'sk-rotated-throwaway-key-111111' })
  } catch (e) {
    refused = true
    refusal = (e as Error).message
  }
  check('unverifiable apiKey is REFUSED before storage (probe path)', refused, refusal)

  // The env-var branch skips the probe, so the write itself must land. Note the
  // readback nuance, observed live: `keyStatus` reports the credential's **effective**
  // state — pointing a slot at an env var that is not set in the sidecar's process
  // yields source 'none', not 'env'. That is the runtime refusing to claim a
  // credential it cannot use, and the settings UI must show it as unset.
  try {
    const res = await api.setProviderKey(THROWN, keyId, { apiKeyEnv: 'RIVET_ACCEPTANCE_THROWAWAY_ENV' }) as { ok?: boolean }
    check('PUT keys/:keyId/key accepts apiKeyEnv without probing', res.ok === true, JSON.stringify(res).slice(0, 120))
    const after = (await api.getProviders()).providers.find((p) => p.name === THROWN)
    const slot = after?.keys.find((k) => k.id === keyId) ?? after?.keys[0]
    console.log(`  note: effective keyStatus = ${slot?.keyStatus.source ?? '?'} ${JSON.stringify(slot?.keyStatus.ref ?? '')} (env var unset in-process)`)
    const raw = JSON.stringify(after)
    check('provider readback carries no plaintext secret', !/sk-[A-Za-z0-9_-]{12,}/.test(raw))
  } catch (e) {
    check('PUT keys/:keyId/key (apiKeyEnv branch)', false, (e as Error).message)
  }

  await api.deleteProvider(THROWN)
  const gone = (await api.getProviders()).providers.find((p) => p.name === THROWN)
  check('throwaway provider deleted again (no residue)', !gone)
}

// --- the real provider is untouched ----------------------------------------
const providersEnd = await api.getProviders()
const deepseekEnd = providersEnd.providers.find((p) => p.name === 'deepseek')
check('deepseek config untouched',
  !!deepseekEnd
  && deepseekEnd.keyStatus.source === deepseek0.keyStatus.source
  && deepseekEnd.keyStatus.ref === deepseek0.keyStatus.ref
  && JSON.stringify(deepseekEnd.models.map((m) => m.id)) === JSON.stringify(deepseek0.models.map((m) => m.id))
  && providersEnd.providers.find((p) => p.isDefault)?.name === providers0.providers.find((p) => p.isDefault)?.name,
  `key=${deepseekEnd?.keyStatus.source} ${deepseekEnd?.keyStatus.ref}, models=${deepseekEnd?.models.map((m) => m.id).join(',')}`)

const modelEnd = await api.getDefaultModelConfig()
check('default model untouched', modelEnd.defaultModel === model0.defaultModel, `${modelEnd.defaultModel}`)

if (failures.length > 0) {
  console.error(`\n✗ settings acceptance FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\n✓ 设置中心读写实测通过（审批档已还原，一次性 provider 已清除，deepseek 未受影响）')
