import { useSyncExternalStore } from 'react'
import { zh, type LocaleKey } from './zh.ts'
import { en } from './en.ts'

export type Locale = 'zh' | 'en'
export type TranslateParams = Record<string, string | number>

const STORAGE_KEY = 'tianshu.locale'
const dicts: Record<Locale, Record<LocaleKey, string>> = { zh, en }

let current: Locale = 'zh'
const listeners = new Set<() => void>()

/**
 * Interpolate {name}. A missing param is left literal rather than blanked: seeing
 * `{seconds}` on screen is an obvious bug, seeing nothing is a silent one.
 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

export function detectLocale(preferred?: string): Locale {
  if (preferred === 'zh' || preferred === 'en') return preferred
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    // Blocked storage is fine; system preference still applies.
  }
  const nav = typeof navigator === 'undefined' ? '' : navigator.language ?? ''
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function getLocale(): Locale {
  return current
}

export function setLocale(next: Locale): void {
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Preference not persisting is acceptable; a throw during settings interaction is not.
  }
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
  for (const fn of listeners) fn()
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function translate(locale: Locale, key: LocaleKey, params?: TranslateParams): string {
  // en is typed as a total map over LocaleKey, so a key that exists in zh but not en
  // is a compile error, not a runtime hole. This lookup is therefore not defensive.
  return interpolate(dicts[locale][key], params)
}

/** React binding: re-renders subscribers when the language flips. */
export function useT(): Translator {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  return (key, params) => translate(locale, key, params)
}

/**
 * The shape `useT()` returns, so a helper can take a translator without re-deriving
 * the key type — `key: string` would silently accept a typo'd key.
 */
export type Translator = (key: LocaleKey, params?: TranslateParams) => string

export function cycleLocale(): Locale {
  setLocale(current === 'zh' ? 'en' : 'zh')
  return current
}

export type { LocaleKey } from './zh.ts'
