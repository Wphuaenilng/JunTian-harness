import { useEffect, useMemo, useRef, useState } from 'react'
import { createNonce, decodeInbound, encodeOutbound, injectBridge, MAX_HEIGHT, MIN_HEIGHT } from './app-frame.ts'

export interface AppFrameProps {
  /** The tool's HTML document, verbatim from the wire. */
  html: string
  /** Accessible name — supplied by the caller, because this package holds no copy. */
  label: string
  theme?: 'light' | 'dark' | undefined
  sessionId?: string
  /** Only http(s) hrefs reach this — a frame cannot make the host navigate elsewhere. */
  onLink?: (href: string) => void
}

/**
 * Sandboxed embedded view for a tool result that is itself an HTML document
 * (MCP Apps, plan §2.3 预留).
 *
 * The sandbox is `allow-scripts` **without** `allow-same-origin`: the frame runs in an
 * opaque origin, so it cannot read this document, cannot reach `localStorage`, and
 * cannot present cookies for this origin. That same opacity is why authentication is a
 * per-frame nonce rather than `event.origin` — a null-origin message carries no usable
 * identity, and "anyone who can postMessage" is not a trust boundary.
 *
 * Nothing is piped from the frame into the host DOM: the only effects an inbound message
 * may have are a clamped height and a callback carrying a validated href.
 */
export function AppFrame({ html, label, theme, sessionId, onLink }: AppFrameProps) {
  // One nonce per mounted frame: recycling it across documents would let a previously
  // mounted (or navigated-away) frame keep speaking to this host.
  const nonce = useMemo(() => createNonce() ?? '', [])
  const host = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const [ready, setReady] = useState(false)

  const srcdoc = useMemo(() => injectBridge(html, nonce), [html, nonce])

  useEffect(() => {
    if (nonce === '') return
    const onMessage = (e: MessageEvent): void => {
      // No origin test on purpose: an opaque-origin frame always reports "null"; the
      // nonce inside the payload is the only identity this bridge has.
      const msg = decodeInbound(e.data, nonce)
      if (!msg) return
      if (msg.kind === 'resize') setHeight(msg.height)
      if (msg.kind === 'link') onLink?.(msg.href)
      if (msg.kind === 'ready') setReady(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [nonce, onLink])

  // Push the host's state once the view says it is listening, and again on every change.
  useEffect(() => {
    if (!ready || nonce === '') return
    const win = host.current?.contentWindow
    if (!win) return
    if (theme) win.postMessage(encodeOutbound({ kind: 'theme', nonce, theme }), '*')
    if (sessionId) win.postMessage(encodeOutbound({ kind: 'context', nonce, sessionId }), '*')
  }, [ready, nonce, theme, sessionId])

  if (nonce === '') {
    // No CSPRNG available: a frame we cannot authenticate is not a frame we should mount.
    return <pre className="tp-term">{html}</pre>
  }

  return (
    <iframe
      ref={host}
      className="tp-app"
      title={label}
      srcDoc={srcdoc}
      // allow-same-origin is deliberately absent — see the header comment.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={{ height: `${height}px`, minHeight: `${MIN_HEIGHT}px`, maxHeight: `${MAX_HEIGHT}px` }}
    />
  )
}
