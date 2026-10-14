import type { ReactNode } from 'react'

export interface SectionGroupProps {
  /** Stable id; the host uses it to remember which group was opened last. */
  id: string
  title: string
  /** Right-aligned readout, the drawing's `.sec-head .v`. */
  badge?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}

/**
 * The 定稿 right rail is a stack of collapsible groups (`.sec` + `.sec-head` + `.sec-body`), not a
 * set of mutually exclusive tabs. Built on a native `<details>/<summary>` so keyboard focus,
 * `aria-expanded` and the toggle state machine come from the platform rather than from hand-rolled
 * state — the drawing's own `data-sec` click handler is exactly the kind of thing that drifts.
 */
export function SectionGroup({ id, title, badge, open, onOpenChange, children }: SectionGroupProps) {
  return (
    <details
      className={`tp-sec${open ? ' tp-sec--open' : ''}`}
      data-sec={id}
      open={open}
      onToggle={(e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="tp-sec__head">
        <span className="tp-sec__chev" aria-hidden="true">▸</span>
        <span className="tp-sec__t">{title}</span>
        {badge !== undefined && badge !== '' && <span className="tp-sec__v">{badge}</span>}
      </summary>
      <div className="tp-sec__body">{children}</div>
    </details>
  )
}
