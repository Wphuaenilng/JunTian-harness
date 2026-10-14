/**
 * SSE 分帧的唯一一份实现：把 `ReadableStream<Uint8Array>` 切成一帧一帧的 `data:` 载荷。
 *
 * 为什么要抽出来：客户端有两条流，`session-stream.ts` 的 `readSse` 里有一份分帧循环，
 * `server-events.ts` 里又内联了一份**行为相同**的循环（字节流 → 找 `\n\n` → 取 `data:` 行）。
 * 两份家意味着字节边界那五个坑（半截帧 / 分隔符跨块 / 多字节切断 / 心跳行 / 坏 JSON）
 * 只被测过一半——`readSse` 有 `test/sse-frames.test.ts`，全局流那条什么都没有。
 *
 * 但**解析器不能合成一份**：两条流的事件形状根本不同。会话流是 `{seq, type, data}`，
 * `readSse` 靠 `seq`+`type` 判定要不要吐给调用方；全局流是 `{kind, ts, …}`，**没有 seq**
 * （内核 `src/server/server-events-route.ts:59-60` 就那么发）。把那个判定搬进共用件，
 * 结果不是崩溃而是**全局流每一帧都被静默丢掉**——那正是"看起来一切正常"的失效形状。
 * 所以共用件只到"一帧的 data 文本"为止，事件形状留给调用方自己判。
 *
 * 帧的写法取自内核：`src/server/sse-stream.ts:48` 写 `event: <type>\ndata: <json>\n\n`，
 * 第 76 行是 `: ping\n\n` 心跳，第 91 行收尾 `event: done\ndata: {}`。
 */

/**
 * 读 `body` 直到流自然结束（done）或 `signal` 被 abort。每凑齐一帧调用一次 `onData`，
 * 参数是这一帧所有 `data:` 行拼起来的文本（已去掉 `data:` 前缀）；没有 `data:` 行的帧
 * （纯心跳、纯注释）不调用。解析失败**不**在这里处理——那是调用方的事件形状问题。
 */
export async function forEachSseFrame(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done || signal.aborted) return
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) onData(data)
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
