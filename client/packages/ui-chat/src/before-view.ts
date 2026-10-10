import { relativeToCwd, type SidecarClient } from '@tianshu/client-core'

/**
 * The before-view's non-rendering half, kept in a JSX-free module so it runs under
 * `node --test` (ui-primitives and ui-chat have no bundler in the test path).
 */

/** The addressable triple, or null when there is no baseline to ask for. */
export type Ask = { client: SidecarClient; sessionId: string; rel: string }

export function resolveAsk(
  api: SidecarClient | undefined,
  sessionId: string | undefined,
  filePath: string | undefined,
  cwd: string | null | undefined,
): Ask | null {
  if (!api || !sessionId || !filePath) return null
  const rel = relativeToCwd(filePath, cwd ?? '')
  return rel && rel !== '' ? { client: api, sessionId, rel } : null
}

export type BeforeState =
  | { state: 'text'; text: string }
  | { state: 'new' }
  | { state: 'failed'; message: string }

export async function loadBefore(ask: Ask, set: (s: BeforeState) => void): Promise<void> {
  try {
    const base = await ask.client.sessionFileBase(ask.sessionId, ask.rel)
    set(base.exists ? { state: 'text', text: base.content } : { state: 'new' })
  } catch (e) {
    // Non-200 on this route means "no baseline to show" (the kernel answers 500 for a
    // path that escapes the session cwd) — it stays in the pane, not in the error bar.
    set({ state: 'failed', message: (e as Error).message })
  }
}
