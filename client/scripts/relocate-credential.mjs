#!/usr/bin/env node
/**
 * relocate-credential.mjs — move a provider key out of the tracked example config.
 *
 * WHY THIS EXISTS: `provider.providers.<name>.apiKeyEnv` is an *environment variable
 * name*, not the secret. A key pasted there never loads (the runtime looks up
 * process.env['sk-…']), and it leaves plaintext inside a tracked file of a repo that
 * syncs to a public projection. The literal belongs in `apiKey`, in a config the repo
 * does not see.
 *
 * Run this yourself rather than asking an agent to read and rewrite your credential.
 * Nothing here prints the key.
 *
 *   cd client && node scripts/relocate-credential.mjs
 *   cd .. && git checkout -- config.example.json     # only after the above succeeds
 *
 * Target: client/.sidecar-data/config.json — gitignored, and picked up automatically
 * by launch-sidecar.mjs via RIVET_CONFIG_PATH (see src/config/paths.ts:38).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const examplePath = join(clientRoot, '..', 'config.example.json')
const outDir = join(clientRoot, '.sidecar-data')
const outPath = join(outDir, 'config.json')

const KEY_LIKE = /^sk-[A-Za-z0-9_-]{16,}$/

if (!existsSync(examplePath)) {
  console.error(`✗ ${examplePath} not found — nothing to relocate`)
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(examplePath, 'utf8'))
const providers = cfg.provider?.providers
if (!providers) {
  console.error('✗ config.example.json has no provider.providers block')
  process.exit(1)
}

let found = null
for (const [name, entry] of Object.entries(providers)) {
  // A secret pasted into the env-var-name field, or into an apiKey field, both count.
  for (const field of ['apiKeyEnv', 'apiKey']) {
    const value = entry?.[field]
    if (typeof value === 'string' && KEY_LIKE.test(value)) {
      found = { name, field, value }
      delete entry.apiKeyEnv
      entry.apiKey = value
    }
  }
}

if (!found) {
  console.log('✓ no literal key found in config.example.json — nothing to move.')
  console.log('  (If it already says "DEEPSEEK_API_KEY", the example file is clean;')
  console.log('   set the env var instead, or write apiKey into the target config by hand.)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outPath, JSON.stringify(cfg, null, 2), { mode: 0o600 })

const verify = JSON.parse(readFileSync(outPath, 'utf8'))
const written = verify.provider.providers[found.name].apiKey
console.log(`✓ moved provider "${found.name}" from .${found.field} → .apiKey`)
console.log(`  target : ${outPath}`)
console.log(`  mode   : 0600, length ${written.length}, prefix ${written.slice(0, 3)}… (value not printed)`)
console.log(`\n下一步（示例文件里还留着明文，搬完才能还原）：`)
console.log(`  cd .. && git checkout -- config.example.json`)
console.log(`  cd client && node scripts/launch-sidecar.mjs   # 应打印 config: …config.json 且 configured 变 true`)
