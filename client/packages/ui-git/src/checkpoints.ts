/** The row title in the 检查点 timeline: one collapsed line, capped, never an empty row. */
export const TITLE_MAX = 60

export function checkpointTitle(content: string, fallback: string): string {
  const line = (content ?? '').replace(/\s+/g, ' ').trim()
  if (line.length === 0) return fallback
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

/** Which checkpoint is the current head: the kernel numbers them ascending per turn. */
export function newestIndex(points: readonly { index: number }[]): number | null {
  if (points.length === 0) return null
  return points.reduce((m, p) => (p.index > m ? p.index : m), points[0]!.index)
}
