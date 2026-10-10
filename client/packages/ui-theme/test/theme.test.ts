import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTheme, readStoredTheme, resolvedTheme, storeTheme, watchSystemTheme } from '../src/index.ts'

/**
 * The theme module touches three browser surfaces and nothing else: `dataset` on the root
 * element, `localStorage`, and the dark-mode media query. Faking them is cheaper than a DOM
 * and — the reason this file exists — it is the only way the `change` path can be executed at
 * all. Before it was a comment saying "an OS dark-mode switch restamps nothing".
 */
type Listener = () => void

class FakeBrowser {
  readonly dataset: Record<string, string> = {}
  readonly storage = new Map<string, string>()
  readonly listeners = new Set<Listener>()
  private storageBlocked = false
  private osDark = true
  private readonly uninstalls: Array<() => void> = []

  constructor(dark = true) {
    this.osDark = dark
    // `self` on purpose: inside an object-literal getter `this` is the literal, not the
    // browser, so a bare `this.osDark` here would read undefined and every assertion
    // would quietly test the light branch instead.
    const self = this
    const media = {
      get matches(): boolean { return self.osDark },
      addEventListener: (_type: string, fn: Listener): void => { self.listeners.add(fn) },
      removeEventListener: (_type: string, fn: Listener): void => { self.listeners.delete(fn) },
    }
    const store = {
      getItem: (k: string): string | null => {
        if (this.storageBlocked) throw new Error('SecurityError: storage is blocked')
        return this.storage.get(k) ?? null
      },
      setItem: (k: string, v: string): void => {
        if (this.storageBlocked) throw new Error('QuotaExceededError')
        this.storage.set(k, v)
      },
    }
    // Bare `document` / `matchMedia` / `localStorage` are what the module actually calls,
    // so these three globals are the whole environment it needs.
    const globals: Array<[string, unknown]> = [
      ['document', { documentElement: { dataset: this.dataset } }],
      ['matchMedia', (query: string): unknown => (query.includes('prefers-color-scheme') ? media : null)],
      ['localStorage', store],
    ]
    for (const [name, value] of globals) {
      const previous = (globalThis as Record<string, unknown>)[name]
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
      this.uninstalls.push(() => Object.defineProperty(globalThis, name, { value: previous, configurable: true, writable: true }))
    }
  }

  /** What the OS does when the user picks a different colour scheme. */
  osSwitchesTo(dark: boolean): void {
    this.osDark = dark
    for (const fn of [...this.listeners]) fn()
  }

  /** A privacy mode / blocked storage: the same throws the real ones raise. */
  blockStorage(blocked = true): void { this.storageBlocked = blocked }

  restore(): void {
    for (const fn of [...this.uninstalls].reverse()) fn()
    this.uninstalls.length = 0
  }
}

function inBrowser<T>(build: (b: FakeBrowser) => T, darkInitially = true): T {
  const b = new FakeBrowser(darkInitially)
  try {
    return build(b)
  } finally {
    b.restore()
  }
}

test('applyTheme stamps the concrete value and prefers an explicit choice over the OS', () => {
  inBrowser((b) => {
    assert.equal(resolvedTheme(), 'light', 'no stamp yet means the light fallback')
    applyTheme('system')
    assert.equal(b.dataset['theme'], 'dark', 'system follows the OS')
    applyTheme('light')
    assert.equal(b.dataset['theme'], 'light', 'an explicit light wins while the OS says dark')
    assert.equal(resolvedTheme(), 'light', 'resolvedTheme reads the stamp, not matchMedia')
  })
})

test('watchSystemTheme restamps, reports the concrete value, and stops on unsubscribe', () => {
  inBrowser((b) => {
    applyTheme('system')
    const seen: string[] = []
    const stop = watchSystemTheme((resolved) => { seen.push(resolved) })
    assert.equal(b.listeners.size, 1, 'exactly one media listener per subscription')

    b.osSwitchesTo(false)
    assert.deepEqual(seen, ['light'])
    assert.equal(b.dataset['theme'], 'light', 'the stamp moved with the OS')

    b.osSwitchesTo(true)
    assert.deepEqual(seen, ['light', 'dark'])

    stop()
    assert.equal(b.listeners.size, 0)
    b.osSwitchesTo(false)
    assert.deepEqual(seen, ['light', 'dark'], 'a stopped watcher must not fire')
  })
})

test('watchSystemTheme does not resurrect a forced theme — it re-applies mode system', () => {
  inBrowser((b) => {
    applyTheme('light')
    assert.equal(b.dataset['theme'], 'light')
    const seen: string[] = []
    const stop = watchSystemTheme((r) => { seen.push(r) })
    b.osSwitchesTo(true)
    // This is the documented consequence of the helper calling applyTheme('system'):
    // it is only ever correct to subscribe while the stored mode *is* 'system'.
    assert.deepEqual(seen, ['dark'])
    assert.equal(b.dataset['theme'], 'dark')
    stop()
  })
})

test('a blocked or junky storage degrades to system, never a throw during boot', () => {
  inBrowser((b) => {
    b.storage.set('tianshu.theme', 'dark')
    assert.equal(readStoredTheme(), 'dark')
    b.storage.set('tianshu.theme', 'pug')
    assert.equal(readStoredTheme(), 'system', 'an unknown value is not a theme')
    b.blockStorage()
    assert.equal(readStoredTheme(), 'system', 'getItem throwing must not break the app')
    assert.doesNotThrow(() => storeTheme('dark'), 'setItem throwing must not break the settings click')
    assert.equal(b.storage.get('tianshu.theme'), 'pug', 'a blocked setItem wrote nothing')
  })
})
