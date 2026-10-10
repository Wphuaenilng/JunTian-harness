import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppFrame, MAX_HEIGHT, MIN_HEIGHT } from '@tianshu/ui-primitives'

/**
 * Developer probe page (not a product surface, nothing links to it).
 *
 * It mounts the real <AppFrame> and feeds it an adversarial document, so the sandbox
 * claims in `app-frame.ts`'s header are measured in a browser instead of asserted by a
 * code comment: opaque-origin isolation, nonce authentication, the height clamp, href
 * rejection and the outbound theme/context push — including the push that must follow a
 * host theme change, which this page provokes by flipping its own theme once the first
 * one comes back.
 *
 *   open http://127.0.0.1:5300/frame-probe.html   → window.__probe__
 */

const ADVERSARIAL_DOC = `<!doctype html><html><body><div id="r">…</div>
<script>
(function () {
  var B = window.__tianshu__
  var post = function (o) { parent.postMessage(o, '*') }
  var iso = '?', store = '?'
  try { void (parent.document && parent.document.title); iso = 'LEAKED' } catch (e) { iso = 'blocked' }
  try { void window.localStorage.getItem('tianshu.locale'); store = 'LEAKED' } catch (e) { store = 'blocked' }
  post({ probe: 'hello', iso: iso, store: store, origin: String(document.URL) })
  // Right envelope, wrong nonce: this must never reach the layout.
  post({ type: 'tianshu.app', kind: 'resize', nonce: 'deadbeefdeadbeefdeadbeefdeadbeef', height: 900 })
  // Same for an unregistered kind.
  post({ type: 'tianshu.app', kind: 'eval', nonce: B ? B.nonce : 'x', code: '1' })
  if (B) {
    B.open('javascript:alert(1)')
    B.resize(1e9)
    B.ready()
    window.onHostMessage = function (d) { post({ probe: 'host', theme: d.theme, sessionId: d.sessionId }) }
    setTimeout(function () { B.open('https://example.com/a'); B.resize(200) }, 250)
  }
})()
</script></body></html>`

interface Report { probe: string; iso?: string; store?: string; theme?: string; sessionId?: string }

interface Verdict {
  done: boolean
  reports: Report[]
  heights: number[]
  links: string[]
  themes: string[]
  checks: Record<string, boolean>
  pass: boolean
}

declare global {
  interface Window { __probe__: Verdict }
}

function Probe() {
  const [reports, setReports] = useState<Report[]>([])
  const [heights, setHeights] = useState<number[]>([])
  const [links, setLinks] = useState<string[]>([])
  const [done, setDone] = useState(false)
  // A real host theme the frame must follow: the page owns this state, the frame only
  // receives pushes. Flipping it once — on seeing the first push — is what turns
  // "re-push on change" from a comment in app-frame-view.tsx into a measured claim.
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const flipped = useRef(false)

  useEffect(() => {
    const on = (e: MessageEvent): void => {
      const d = e.data as Report | null
      if (d && typeof d === 'object' && d.probe) setReports((prev) => [...prev, d])
      if (d && d.probe === 'host' && typeof d.theme === 'string' && !flipped.current) {
        flipped.current = true
        setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
      }
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])

  // Record every negotiated height as it happens. A MutationObserver, not a poll:
  // timers are throttled to 1/s in a background page, and a missed sample would hide
  // exactly the transient we care about (a forged message moving the layout).
  useEffect(() => {
    const el = document.querySelector('.tp-app')
    if (!el) return
    const record = (): void => {
      const h = Number.parseFloat((el as HTMLIFrameElement).style.height)
      if (!Number.isNaN(h)) setHeights((prev) => (prev[prev.length - 1] === h ? prev : [...prev, h]))
    }
    record()
    const obs = new MutationObserver(record)
    obs.observe(el, { attributes: true, attributeFilter: ['style'] })
    return () => obs.disconnect()
  }, [])

  // Generous because a background page throttles timers to ~1s; the verdict keeps
  // recomputing while late evidence arrives, so this is a floor, not a deadline.
  useEffect(() => {
    const timer = setTimeout(() => setDone(true), 2500)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!done) return
    const themes = reports.filter((r) => r.probe === 'host' && typeof r.theme === 'string').map((r) => r.theme!)
    const checks = {
      parentDomBlocked: reports.some((r) => r.probe === 'hello' && r.iso === 'blocked'),
      hostStorageBlocked: reports.some((r) => r.probe === 'hello' && r.store === 'blocked'),
      // The whole point of sampling: 80 is the mount height, 4000 is the clamped 1e9,
      // 200 is the last honest request. Anything else that appeared was a message the
      // bridge should never have honored (forged nonce, unknown kind, spoofed height).
      onlySanitizedHeights: heights.every((h) => h === MIN_HEIGHT || h === MAX_HEIGHT || h === 200),
      forgedNonceIgnored: !heights.includes(900),
      hostileHeightClamped: heights.includes(MAX_HEIGHT),
      finalHeightHonored: heights[heights.length - 1] === 200,
      neverBelowMin: heights.every((h) => h >= MIN_HEIGHT),
      jsLinkRejected: !links.some((h) => !/^https:\/\//i.test(h)),
      httpsLinkDelivered: links.includes('https://example.com/a'),
      themePushedBack: themes.includes('dark'),
      // The second value only ever arrives if the push effect is keyed on the prop rather
      // than on mount — this is the whole M2 明暗主题 + MCP Apps interaction claim.
      themeRePushedOnHostChange: themes.includes('light'),
      // Exactly one push per value: the probe re-renders on every report, and an
      // effect without proper deps would show up here as a long repeating sequence.
      themePushedOncePerValue: JSON.stringify(themes) === JSON.stringify(['dark', 'light']),
      contextPushedBack: reports.some((r) => r.probe === 'host' && r.sessionId === 'probe-session'),
    }
    const pass = Object.values(checks).every(Boolean)
    window.__probe__ = { done, reports, heights, links, themes, checks, pass }
    const out = document.getElementById('out')
    if (out) out.textContent = `${pass ? 'PASS' : 'FAIL'}\n${JSON.stringify({ heights, links, themes, checks }, null, 2)}`
  }, [done, reports, heights, links])

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <AppFrame
        html={ADVERSARIAL_DOC}
        label="frame probe"
        theme={theme}
        sessionId="probe-session"
        onLink={(href) => setLinks((prev) => [...prev, href])}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
