/**
 * Theme boot. Inline this in <head> before first paint: reading the stored theme
 * after React mounts produces a light→dark flash on every reload, which is the one
 * thing that makes a themed app look broken.
 */
export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'tianshu.theme'

export function readStoredTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // Private mode / blocked storage: fall through to system, never throw during boot.
  }
  return 'system'
}

/** Resolve 'system' to a concrete value and stamp data-theme before any paint. */
export function applyTheme(mode: ThemeMode = readStoredTheme()): ThemeMode {
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  return mode
}

/**
 * The concrete light/dark currently painted, read from the attribute the boot script
 * stamped. Consumers that need to hand a resolved theme to something outside the CSS
 * cascade (an embedded frame, a canvas) must ask this rather than re-deriving it from
 * matchMedia, which disagrees with a forced 'light'/'dark' preference.
 */
export function resolvedTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/**
 * Follow the OS while the stored mode is 'system'.
 *
 * `data-theme` is a stamp, not a binding: without this the app keeps whatever the boot
 * script read, so an OS dark-mode switch left the CSS, the status text and any embedded
 * MCP frame showing the old theme until reload. The callback receives the concrete value
 * now painted — callers must hold it in state rather than re-reading `resolvedTheme()`,
 * because a same-value `setTheme('system')` bails out of the re-render and nothing
 * downstream gets told. Returns an unsubscribe.
 */
export function watchSystemTheme(onChange: (resolved: 'light' | 'dark') => void): () => void {
  const mq = matchMedia('(prefers-color-scheme: dark)')
  const listener = (): void => {
    applyTheme('system')
    onChange(resolvedTheme())
  }
  mq.addEventListener('change', listener)
  return () => mq.removeEventListener('change', listener)
}

export function storeTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Non-persistent preference is acceptable; a crash during settings is not.
  }
}

/**
 * Snippet for the HTML head, kept as a string so apps/web can inline it via
 * vite-plugin-html-transform-free templating instead of shipping a second boot file.
 */
export const BOOT_SCRIPT = `<script>(function(){try{var m=localStorage.getItem('${STORAGE_KEY}')||'system';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){}})();</script>`
