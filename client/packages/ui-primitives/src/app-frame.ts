/**
 * MCP Apps reservation (plan §2.3 / M2): a tool result that *is* an HTML view gets a
 * sandboxed frame and a message bridge, instead of being dumped as text.
 *
 * No producer in this runtime emits such a payload yet — the kernel's `uiContent` is a
 * diff or a receipt today. What is reserved here is therefore the container and the
 * contract, and the contract is written so that a frame with no privileges can still
 * be trusted *enough*: an opaque-origin sandbox iframe cannot be authenticated by
 * `event.origin` (it reports "null"), so every inbound message must carry a per-frame
 * nonce the host injected into the document.
 */

export const APP_NAMESPACE = 'tianshu.app'

/** Inbound: what the embedded view asks the host to do. */
export type AppInbound =
  | { kind: 'resize'; nonce: string; height: number }
  | { kind: 'link'; nonce: string; href: string }
  | { kind: 'ready'; nonce: string }

/** Outbound: what the host tells the embedded view. */
export type AppOutbound =
  | { kind: 'theme'; nonce: string; theme: 'light' | 'dark' }
  | { kind: 'context'; nonce: string; sessionId: string }

/** A srcdoc frame reports the opaque origin; nothing useful can be keyed on it. */
export const OPAQUE_ORIGIN = 'null'

export const MIN_HEIGHT = 80
export const MAX_HEIGHT = 4000

/**
 * Cheap, conservative detection: an HTML *document*, not any string containing a tag.
 * A prose receipt that merely mentions `<b>` must keep rendering as text.
 */
export function looksLikeHtmlDocument(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase()
  return head.includes('<!doctype html') || /^\s*<html[\s>]/.test(head)
}

/**
 * 122-bit capability token. `crypto.getRandomValues` is present in every browser target
 * we ship and in node 24; the frame is worthless without it, so a missing CSPRNG means
 * "no frame", never "guess one".
 */
export function createNonce(random: Uint8Array = new Uint8Array(16)): string | null {
  const g = globalThis.crypto as Crypto | undefined
  if (!g?.getRandomValues) return null
  g.getRandomValues(random)
  return [...random].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The snippet every host-authored document is given: the nonce plus the helpers, so a
 * view posts in the shape the decoder below accepts. Deliberately no access to any host
 * object — this text is the entire surface, and it never reads from `parent` (an
 * opaque-origin frame cannot, by design).
 */
export function bridgeBootstrap(nonce: string): string {
  return `<script>(function(){var N=${JSON.stringify(nonce)},NS=${JSON.stringify(APP_NAMESPACE)};`
    + 'var api={namespace:NS,nonce:N,lastHost:null,'
    + 'resize:function(h){parent.postMessage({type:NS,kind:"resize",nonce:N,height:h},"*")},'
    + 'ready:function(){parent.postMessage({type:NS,kind:"ready",nonce:N},"*")},'
    + 'open:function(href){parent.postMessage({type:NS,kind:"link",nonce:N,href:String(href)},"*")}};'
    + 'window.__tianshu__=api;'
    + 'addEventListener("message",function(e){var d=e.data;'
    + 'if(d&&d.type===NS+"-host"&&d.nonce===N){api.lastHost=d;if(typeof window.onHostMessage==="function")window.onHostMessage(d);}});'
    + '})()</script>'
}

/**
 * Place the bootstrap so the document's own scripts can already see `__tianshu__`.
 *
 * Inserting before `</body>` (the obvious first try) is wrong: a body-level script runs
 * during parsing, before the bridge exists, and silently degrades to "no bridge" — which
 * is exactly the failure mode a producer would hit first. So the bridge goes into the
 * head, ahead of any author script.
 */
export function injectBridge(html: string, nonce: string): string {
  const boot = bridgeBootstrap(nonce)
  const lower = html.toLowerCase()
  const afterTag = (needle: string): number => {
    const at = lower.indexOf(needle)
    if (at < 0) return -1
    const gt = html.indexOf('>', at)
    return gt < 0 ? -1 : gt + 1
  }
  const beforeTag = (needle: string): number => lower.indexOf(needle)

  const spots = [
    afterTag('<head'),
    beforeTag('</head>'),
    afterTag('<html'),
    afterTag('<body'),
    beforeTag('</body>'),
  ]
  for (const spot of spots) {
    if (spot >= 0) return `${html.slice(0, spot)}${boot}${html.slice(spot)}`
  }
  // A fragment with no document shell: the bridge still has to run before it.
  return `${boot}${html}`
}

/** Height the host will honor: finite, integral, clamped — a frame cannot stretch the page. */
export function clampHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const h = Math.round(value)
  if (h <= 0) return null
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h))
}

/**
 * Validate one inbound message. Returns null for anything that is not provably ours:
 * wrong envelope, wrong nonce, unknown kind, unclamps-able height, non-http(s) link.
 */
export function decodeInbound(data: unknown, nonce: string): AppInbound | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d['type'] !== APP_NAMESPACE) return null
  if (typeof d['nonce'] !== 'string' || d['nonce'] !== nonce) return null
  switch (d['kind']) {
    case 'ready':
      return { kind: 'ready', nonce }
    case 'resize': {
      const height = clampHeight(d['height'])
      return height === null ? null : { kind: 'resize', nonce, height }
    }
    case 'link': {
      const href = d['href']
      if (typeof href !== 'string' || !/^https?:\/\//i.test(href)) return null
      return { kind: 'link', nonce, href }
    }
    default:
      return null
  }
}

/** Envelope the host posts into the frame (nonce echoed so a stray page cannot spoof it). */
export function encodeOutbound(msg: AppOutbound): Record<string, unknown> {
  return { type: `${APP_NAMESPACE}-host`, ...msg }
}
