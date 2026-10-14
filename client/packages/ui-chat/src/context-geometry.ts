import type { ContextBudgetSnapshot } from '@tianshu/client-core'

/**
 * Pure geometry for the 上下文占用 group in the right rail: one ring (fraction used) and one
 * segmented bar (what the used tokens are made of). Every number comes from the kernel's own
 * `ContextBudgetSnapshot`, and nothing is invented when a field is missing: the segment is dropped
 * rather than shown as zero, because "0 tokens of tools" and "the runtime did not report tools"
 * are different statements to a user.
 */

/** The drawing's ring: 44px box, r=19, stroke 2.5, giving circumference 119.38. */
export const RING_RADIUS = 19
export const RING_CIRCUMFERENCE = Number((2 * Math.PI * RING_RADIUS).toFixed(2))

export interface RingGeometry {
  /** Fraction of the window in use, clamped to [0,1]. */
  fraction: number
  dashArray: number
  dashOffset: number
  /** Whole percent for the centre label. */
  percent: number
}

export function ringFor(used: number, windowTokens: number): RingGeometry {
  const fraction = windowTokens > 0 ? Math.min(1, Math.max(0, used / windowTokens)) : 0
  return {
    fraction,
    dashArray: RING_CIRCUMFERENCE,
    dashOffset: Number((RING_CIRCUMFERENCE * (1 - fraction)).toFixed(2)),
    percent: Math.round(fraction * 100),
  }
}

/**
 * Named union instead of an inline literal list, so the locale scanner — which reads
 * key-and-literal pairs as translation references — never mistakes a type position for one.
 */
export type SegmentKey = 'input' | 'tool' | 'reasoning' | 'image'

export interface BudgetSegment {
  key: SegmentKey
  tokens: number
  /** Share of the used total: the bar widths, which sum to 100 percent. */
  share: number
  /** Share of the whole window: what the drawing prints in its legend rows (18/15/9 at a 42% ring). */
  windowShare: number
}

/**
 * Two percentage scales on purpose, read off the drawing: its bar segments 43/36/21 sum to the whole
 * while the ring says 42 percent, so the bar decomposes what is used; its rows 18/15/9 sum to that
 * 42, so they are shares of the window. With no windowTokens there is no window scale, and the rows
 * fall back to the used share rather than inventing a denominator.
 *
 * Only the four things that actually consume context are decomposed. `outputReserve` / `safetyMargin`
 * are budget reservations, not usage: the drawing's rows (18/15/9) sum to the ring (42%), and mixing
 * the reservations into the legend broke that on real data (rows summed to 16% against a 9% ring).
 * They stay visible as plain numbers in the panel's value list below the gauge.
 */
export function budgetSegments(
  b: Partial<Pick<ContextBudgetSnapshot,
    'inputTokens' | 'toolTokens' | 'reasoningTokens' | 'imageTokens' | 'windowTokens'>>,
): BudgetSegment[] {
  const raw: Array<[SegmentKey, number | undefined]> = [
    ['input', b.inputTokens],
    ['tool', b.toolTokens],
    ['reasoning', b.reasoningTokens],
    ['image', b.imageTokens],
  ]
  const present = raw.filter((entry): entry is [SegmentKey, number] => typeof entry[1] === 'number' && entry[1] > 0)
  const total = present.reduce((n, [, tokens]) => n + tokens, 0)
  if (total <= 0) return []
  const windowTokens = typeof b.windowTokens === 'number' && b.windowTokens > 0 ? b.windowTokens : 0
  return present.map(([key, tokens]) => ({
    key,
    tokens,
    share: tokens / total,
    windowShare: windowTokens > 0 ? tokens / windowTokens : tokens / total,
  }))
}

/**
 * A row label for a share: rounding 28 tokens against a 524k window yields "0%", which reads as
 * "nothing here" while the segment is genuinely non-zero. Sub-one-percent stays visible.
 */
export function sharePercent(share: number): string {
  if (share <= 0) return '0%'
  if (share < 0.005) return '<1%'
  return `${Math.round(share * 100)}%`
}

/** Used tokens for the ring: the four things that actually occupy the window. */
export function usedTokens(b: Partial<Pick<ContextBudgetSnapshot,
  'inputTokens' | 'toolTokens' | 'reasoningTokens' | 'imageTokens'>>): number {
  return [b.inputTokens, b.toolTokens, b.reasoningTokens, b.imageTokens]
    .reduce<number>((n, v) => n + (typeof v === 'number' && v > 0 ? v : 0), 0)
}

const positive = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)

/**
 * The ring's number straight from a snapshot bag entry, for surfaces that never see the typed
 * snapshot (the collapsed rail's tooltip). `null` means "no reading yet" — a missing budget must
 * not render as 0%, which is the same lie as the `<1%` case above in the other direction.
 */
export function contextPercentOf(snap: Record<string, unknown> | undefined): number | null {
  const window = positive(snap?.windowTokens)
  if (!snap || !window) return null
  const used = usedTokens({
    inputTokens: positive(snap.inputTokens),
    toolTokens: positive(snap.toolTokens),
    reasoningTokens: positive(snap.reasoningTokens),
    imageTokens: positive(snap.imageTokens),
  })
  return Math.min(100, Math.round((used / window) * 100))
}
