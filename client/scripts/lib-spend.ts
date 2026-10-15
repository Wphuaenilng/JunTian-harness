/**
 * 上游账单的共用读法：从会话转录（冷通道 `historyPage`）里数出这一趟真发了几发、多少 token。
 *
 * 为什么要单独一份：`accept-approval.ts` 打完上游要自己报账，而账只能有一个算法——
 * 验它的探针和交付它的脚本必须是同一份代码，否则"探针绿了"什么都不说。
 * 为什么读转录而不是 `provider-calls.jsonl`：2026-10-15 那趟真跑里，转录里有 usage，
 * 而 `provider-calls.jsonl` 根本没落盘（`.sidecar.log` 也不记 provider）。
 */
import type { SidecarClient } from '../packages/client-core/src/index.ts'

export interface Spend {
  calls: number
  inTok: number
  outTok: number
  rows: number
  /** 冷通道是否回填到磁盘头；false 意味着这个数只是窗口内的，不是全量。 */
  atHead: boolean
}

type UsageBearing = { usage?: { input_tokens?: number; output_tokens?: number } }

export async function spendOf(api: SidecarClient, sid: string, headSeq?: number): Promise<Spend> {
  const seen = new Set<number>()
  let calls = 0
  let inTok = 0
  let outTok = 0
  let atHead = false
  const hot = await api.events(sid, 0)
  let before = (headSeq ?? hot.lastSeq) + 1
  for (let hop = 0; hop < 80; hop++) {
    const page = await api.historyPage(sid, before, 200)
    if (page.events.length === 0) {
      atHead = true
      break
    }
    for (const ev of page.events) {
      if (seen.has(ev.seq)) continue
      seen.add(ev.seq)
      const u = (ev as UsageBearing).usage ?? ((ev.data ?? {}) as UsageBearing).usage
      if (u && (u.input_tokens !== undefined || u.output_tokens !== undefined)) {
        calls += 1
        inTok += Number(u.input_tokens ?? 0)
        outTok += Number(u.output_tokens ?? 0)
      }
    }
    const oldest = page.events[0]
    if (oldest && oldest.seq === page.firstSeq) {
      atHead = true
      break
    }
    if (!oldest) break
    before = oldest.seq
  }
  return { calls, inTok, outTok, rows: seen.size, atHead }
}

/**
 * 「始终允许」的机器可读判据：内核那张**按工作区存**的目录授权表里，有没有这个目录的 write 授权。
 *
 * 为什么不是"下一次还弹不弹卡"：`approvalMode:'manual'` 下每一次工具调用都要审
 * （`src/agent/tool-pipeline.ts` 的 `shouldAsk` 在 `pathGrantNeed` 之后还有一支
 * `approvalMode === 'manual' ? needsApproval`），记住了也照样弹——今天就是这张卡把我引到了
 * "把尺子量错了东西"的结论上。授权表才是 `remember` 与"允许一次"唯一分得开的地方
 * （内核写它的那行是 `persist = resolved.remember === true`）。
 * 路径比较按 Windows 口径归一：分隔符与大小写都不该决定一条授权算不算命中。
 */
export function grantRecorded(grants: readonly { path?: string; mode?: string }[], dir: string, mode = 'write'): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '')
  const target = norm(dir)
  return grants.some((g) => String(g.path ?? '') !== '' && norm(String(g.path)) === target && g.mode === mode)
}

/**
 * 一轮跑了什么——**从磁盘转录读**，不从 SSE 流读。
 *
 * 为什么要换掉流计数（2026-10-15 一次付费跑教出来的）：`drive()` 原来靠在线流里数
 * `approval_required` / `turn_complete`，而 `/stream` 在连接关闭时会补一帧空的 `done`——
 * 那个 `done` 被我算成"本轮终态"，于是**一轮什么都没看着**（`开跑=false`）却报`终态=true`，
 * 卡片数报 0。转录那边写着真相：同一会话 grant 之后那一轮确实又发了一张 `approval_required`。
 * 磁盘日志没有"客户端有没有连着"这种自由度，所以计数以它为准；流只用来**当场把第一张卡答掉**。
 */
export interface RoundFacts {
  /** 这一轮窗口里 `approval_required` 的条数（按 seq 去重）。 */
  cards: number
  answered: number
  sawRunning: boolean
  sawTerminal: boolean
  /** 这一轮有没有真的落下用户消息——没有它，整窗都是别人的历史。 */
  sawUser: boolean
  from: number
  to: number
  /** 翻到磁盘头没（false ⇒ 窗口之外的更早事件没看过，但本轮窗口内的数仍只依赖 seq>from）。 */
  rows: number
}

export async function roundFacts(api: SidecarClient, sid: string, sinceSeq: number): Promise<RoundFacts> {
  const bySeq = new Map<number, { t: string; st: string }>()
  const hot = await api.events(sid, 0)
  let before = hot.lastSeq + 1
  for (let hop = 0; hop < 80; hop++) {
    const page = await api.historyPage(sid, before, 200)
    if (page.events.length === 0) break
    for (const ev of page.events) {
      if (ev.seq <= sinceSeq || bySeq.has(ev.seq)) continue
      bySeq.set(ev.seq, { t: String(ev.type), st: String((ev.data as { status?: string } | undefined)?.status ?? '') })
    }
    const oldest = page.events[0]
    if (!oldest || oldest.seq <= sinceSeq || oldest.seq === page.firstSeq) break
    before = oldest.seq
  }
  const types = [...bySeq.entries()].sort((a, b) => a[0] - b[0])
  const seqs = types.map(([s]) => s)
  return {
    cards: types.filter(([, e]) => e.t === 'approval_required').length,
    answered: types.filter(([, e]) => e.t === 'approval_resolved').length,
    sawRunning: types.some(([, e]) => e.t === 'status' && e.st === 'running'),
    sawTerminal: types.some(([, e]) => e.t === 'turn_complete' || e.t === 'done'),
    sawUser: types.some(([, e]) => e.t === 'user' || e.t === 'user_message'),
    from: seqs[0] ?? sinceSeq,
    to: seqs[seqs.length - 1] ?? sinceSeq,
    rows: seqs.length,
  }
}
