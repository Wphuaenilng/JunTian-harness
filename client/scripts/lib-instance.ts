/**
 * Shared pre-flight for the acceptance scripts (`accept-*.ts`).
 *
 * Why this exists: every acceptance script used to open `client/.sidecar-info.json` with a
 * hardcoded path and talk to whatever instance happened to be registered there. That file can
 * belong to a run from last week, or to the operator's own working instance — so "跑一次验收"
 * could create sessions, patch provider config, or (for the two scripts that send prompts)
 * spend upstream calls *on the wrong instance*, with nothing on screen saying which one it was.
 * Same class as the `verify-*` port/register false-positive bugs already fixed in this repo.
 *
 * The fix is small and behavioural: name the instance before touching it, and allow `--info=`
 * to select an isolated registration explicitly. Default path is unchanged so the intended
 * flow (`node scripts/launch-sidecar.mjs && node scripts/accept-x.ts`) keeps working verbatim.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarClient } from '../packages/client-core/src/index.ts'

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface InstanceHandle {
  api: SidecarClient
  info: { baseUrl: string; token: string; pid?: number }
  infoPath: string
}

export function openInstance(what: string, opts: { spends?: boolean } = {}): InstanceHandle {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--info='))
  const infoPath = arg ? resolve(arg.slice('--info='.length)) : join(clientRoot, '.sidecar-info.json')
  let info: InstanceHandle['info']
  try {
    info = JSON.parse(readFileSync(infoPath, 'utf8')) as InstanceHandle['info']
  } catch {
    console.error(`✗ 读不到登记文件 ${infoPath} — 先跑 node scripts/launch-sidecar.mjs，或显式 --info=<state-dir>/.sidecar-info.json`)
    process.exit(2)
  }
  console.log(`instance      ${info.baseUrl}${info.pid === undefined ? '' : ` pid=${info.pid}`}`)
  console.log(`info file     ${infoPath}${arg ? '' : '  （默认位置；要打到隔离实例请显式 --info=）'}`)
  console.log(`about to run  ${what}${opts.spends ? ' — 这一步会打真上游，产生付费调用' : ''}`)
  return { api: new SidecarClient({ baseUrl: info.baseUrl, token: info.token }), info, infoPath }
}

/**
 * A scratch workspace for a probe session — in the OS temp dir, never the repo.
 *
 * Why this is a rule instead of a detail: the runtime seeds `<session cwd>/.rivet/` (its skills plus
 * its own db) into *every* workspace a session opens, which `accept-panel.ts` measures as its judgement ⑥.
 * Three probes used `resolve(clientRoot, '..')` as their session cwd — so on any machine where a prompt
 * really runs, an acceptance run writes runtime files into the operator's checkout. `verify-accept-zero`
 * now counts that tree before and after, so a regression shows up as a red row instead of as junk.
 *
 * Fixed path per label + pre-clean, following `accept-panel`'s pattern: a falling-back-to-pid note when
 * a previous round's directory is still held open by a live instance (that is the instance's handle,
 * not a broken judgement).
 */
export function probeWorkspace(label: string): { cwd: string; note: string } {
  const base = join(tmpdir(), `tianshu-probe-${label}`)
  let note = ''
  try {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true })
  } catch (e) {
    note = `上一轮的落点没删掉（${(e as NodeJS.ErrnoException).code ?? String(e)}），退到带 pid 的新落点`
  }
  const cwd = note === '' ? base : `${base}-${process.pid}`
  mkdirSync(cwd, { recursive: true })
  return { cwd, note }
}
