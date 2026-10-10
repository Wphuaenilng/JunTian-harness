import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeToCwd, toolFilePath, localBranches, SessionModel } from '../src/index.ts'
import type { Block, BranchInfo, GitRemote, SessionEvent, SessionEventType } from '../src/index.ts'

function evt(seq: number, type: string, data: Record<string, unknown>): SessionEvent {
  return { seq, ts: `2026-10-09T00:00:${String(seq).padStart(2, '0')}Z`, type: type as SessionEventType, data }
}

const tool = (b: Block): Extract<Block, { kind: 'tool' }> => {
  assert.equal(b.kind, 'tool')
  return b as Extract<Block, { kind: 'tool' }>
}

/**
 * Captured verbatim from `GET /sessions/202610096378c068b12a/events` — the M1 approval
 * run that really wrote m1-approval-probe.txt. The unified diff lives in `uiContent`
 * and **never** in `result`: a client that reads only `result` shows the prose receipt
 * and silently drops the patch, which is exactly the bug this test pins closed.
 */
const realCallId = 'call_00_F6sqxqoxHL3R3Jv0Pz5P3983'
const realToolUse = {
  id: realCallId,
  name: 'write_file',
  input: {
    file_path: 'F:\\workspace\\AI-Project\\AI-Harness\\Tianshu-harness\\m1-approval-probe.txt',
    content: 'ok-approved\n',
  },
}
const realToolResult = {
  outputId: '202610099222ec8438f4',
  outputTruncated: false,
  id: realCallId,
  name: 'write_file',
  isError: false,
  result: '已写入 13 字节（2 行）到 F:/workspace/AI-Project/AI-Harness/Tianshu-harness/m1-approval-probe.txt——内容与你提交的一致',
  uiContent: '--- m1-approval-probe.txt\n+++ m1-approval-probe.txt\n@@ -0,0 +1,1 @@\n+ok-approved',
}

test('tool_use keeps the diff-bearing payload the kernel actually sends', () => {
  const m = new SessionModel()
  m.loadEvents([evt(1, 'tool_use', realToolUse)])
  const pending = tool(m.current.blocks[0]!)
  assert.equal(pending.name, 'write_file')
  assert.equal(pending.open, true, 'an open call is the intent state')
  assert.equal(pending.filePath, realToolUse.input.file_path, 'file_path, not path (write-file.ts:80)')
  assert.equal(pending.uiContent, undefined)

  m.loadEvents([evt(2, 'tool_result', realToolResult)])
  const landed = tool(m.current.blocks[0]!)
  assert.equal(landed.open, false)
  assert.equal(landed.uiContent, realToolResult.uiContent, 'uiContent must survive into the block')
  assert.match(landed.uiContent!, /^\+\+\+ /m)
  assert.equal(landed.result, realToolResult.result, 'the prose receipt stays alongside the patch')
  assert.equal(landed.truncated, undefined, 'outputTruncated:false is not a truncation flag')
})

test("the server's own outputTruncated flag becomes block.truncated", () => {
  const m = new SessionModel()
  m.loadEvents([
    evt(1, 'tool_use', realToolUse),
    evt(2, 'tool_result', { ...realToolResult, outputTruncated: true, uiContent: 'x'.repeat(2000) }),
  ])
  assert.equal(tool(m.current.blocks[0]!).truncated, true)
})

test('toolFilePath only names single-file mutators', () => {
  assert.equal(toolFilePath('edit_file', { file_path: 'a.ts' }), 'a.ts')
  assert.equal(toolFilePath('hash_edit', { file_path: 'a.ts', anchors: ['L1:deadbeef'] }), 'a.ts')
  // apply_patch carries a whole multi-file diff and ast_edit an op list: no one file to
  // show a baseline for, so the before-view must not be offered.
  assert.equal(toolFilePath('apply_patch', { diff: '--- a\n+++ b' }), undefined)
  assert.equal(toolFilePath('ast_edit', { ops: [{ find: 'x', replace: 'y' }] }), undefined)
  assert.equal(toolFilePath('read_file', { file_path: 'a.ts' }), undefined, 'a read is not a mutation')
  assert.equal(toolFilePath('write_file', { path: 'a.ts' }), undefined, '`path` is the wrong field name')
})

test('relativeToCwd anchors a wire path into the session cwd', () => {
  const cwd = 'F:\\workspace\\AI-Project\\AI-Harness\\Tianshu-harness'
  assert.equal(relativeToCwd(`${cwd}\\m1-approval-probe.txt`, cwd), 'm1-approval-probe.txt')
  assert.equal(relativeToCwd('F:/workspace/AI-Project/AI-Harness/Tianshu-harness/src/a.ts', cwd), 'src/a.ts')
  assert.equal(relativeToCwd('f:/workspace/ai-project/ai-harness/tianshu-harness/README.md', cwd), 'README.md', 'drive letter case differs')
  assert.equal(relativeToCwd(`${cwd}\\client\\README.md`, `${cwd}\\`), 'client/README.md', 'trailing separator on cwd')
})

test('relativeToCwd refuses paths it cannot address', () => {
  const cwd = 'F:\\workspace\\proj'
  assert.equal(relativeToCwd('F:\\other\\secret.txt', cwd), null, 'outside cwd — the git routes reject it anyway')
  assert.equal(relativeToCwd('/etc/passwd', cwd), null)
  assert.equal(relativeToCwd('src/a.ts', cwd), 'src/a.ts', 'already relative')
  assert.equal(relativeToCwd('F:\\workspace\\proj', cwd), '', 'the cwd itself')
  assert.equal(relativeToCwd('F:\\workspace\\proj\\a.ts', ''), null, 'no cwd to anchor on')
  assert.equal(relativeToCwd('a.ts', ''), 'a.ts')
})

test('a tool_result with no matching tool_use still keeps its patch', () => {
  const m = new SessionModel()
  // The call can be absent when it scrolled out of the replay window (or on an older
  // runtime); the result must still render, patch included.
  m.loadEvents([evt(9, 'tool_result', realToolResult)])
  const b = tool(m.current.blocks[0]!)
  assert.equal(b.name, 'write_file')
  assert.equal(b.uiContent, realToolResult.uiContent)
})

/**
 * Captured live from `GET /git/workbench/branches` on the sandbox repo: the route asks
 * for-each-ref for refs/heads **and** refs/remotes and returns one flat list, so a
 * picker built straight from it offers `origin/main` as a branch to switch to.
 */
const capturedBranches: BranchInfo[] = [
  { name: 'main', sha: 'c65528ec', upstream: 'origin/main' },
  { name: 'feature/ui-made', sha: 'c65528ec', upstream: '' },
  { name: 'origin', sha: 'ff2b061e', upstream: '' },
  { name: 'origin/main', sha: 'ff2b061e', upstream: '' },
]
const remotes: GitRemote[] = [{ name: 'origin', url: 'F:\\…\\origin.git' }]

test('localBranches separates the mixed heads+remotes list the route returns', () => {
  const local = localBranches(capturedBranches, remotes).map((b) => b.name)
  assert.deepEqual(local, ['main', 'feature/ui-made'])
})

test('only the exact remote name and its namespace are treated as tracking refs', () => {
  // A local branch may legally be named `upstream/fix`; it survives unless `upstream`
  // itself is a configured remote. A near-miss like `originish` never does.
  const odd: BranchInfo[] = [
    { name: 'upstream/fix', sha: 'a', upstream: '' },
    { name: 'originish', sha: 'b', upstream: '' },
    { name: 'origin/dev', sha: 'c', upstream: '' },
  ]
  assert.deepEqual(localBranches(odd, [{ name: 'origin', url: 'x' }]).map((b) => b.name), ['upstream/fix', 'originish'])
  assert.deepEqual(localBranches(odd, [{ name: 'upstream', url: 'x' }]).map((b) => b.name), ['originish', 'origin/dev'])
  assert.deepEqual(localBranches(odd, []).map((b) => b.name), ['upstream/fix', 'originish', 'origin/dev'], 'no remotes → nothing to strip')
})
