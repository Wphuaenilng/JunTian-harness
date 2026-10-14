/**
 * lib-css-rules.mjs — one parser for the shipped stylesheets, because two gates now read the same
 * rules for opposite reasons:
 *
 *  - `check-nongoals` 5c asks which rules paint a colour with a **ramp member the dark block never
 *    overrides** (those silently refuse to follow the theme);
 *  - `check-contrast` asks which rules **stack a literal colour against a token colour** — the pairs
 *    that no fixture can render (error banners, diff washes) and that the hand-declared 36-pair AA
 *    table therefore never measures.
 *
 * Both questions are about the same facts, so the parse lives here. Two copies would mean one gate
 * can be right while the other is quietly wrong about what the stylesheet actually says — and the
 * failure mode of a broken CSS parser is an empty rule set, which reads as "nothing to report".
 *
 * `rulesOf` mirrors the shape `check-nongoals` was already using: a top-level-ish `selector { decls }`
 * match, comments blanked out so `/* … *\/` can never smuggle a colour into a judgement made about
 * product code. One rule per **comma-separated selector part** — a grouped rule like
 * `.a, .b { color: var(--x) }` yields two entries. It used to yield only `.a`, which silently deleted
 * every selector after the first from both gates' face; measured 2026-10-13: 3 grouped product rules
 * paint a ramp member on their 2nd selector and none of the three was registered anywhere
 * (`.app__dot--connecting`, `.ucx__sw--input`, `.sc__spec:focus`). Splitting on commas is safe for the
 * shipped stylesheets: no `:is()` / `:where()` / comma-bearing `:not()`, no comma inside `[...]`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Blank comments without removing newlines, so a comment's content can never match. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every `.css` under the given client-relative dirs (node_modules / dist / dot-dirs skipped). */
export function cssFilesUnder(clientRoot, ...relDirs) {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.css$/.test(e.name)) out.push(p)
    }
  }
  for (const rel of relDirs) walk(join(clientRoot, rel))
  return out.sort()
}

/** Declarations that actually paint a colour (shorthands included — `border: 1px solid X` counts,
 *  and so do the side forms `border-left:` / `border-top-color:`; they were not, which left three
 *  `border-left: 2px solid var(--nb-200)` rules outside both gates' face — 2026-10-14). */
export const COLORISH_PROP = /^(background|color|border|outline-color|fill)(-color)?(-top|-right|-bottom|-left)?$/i

/** @returns [{ file, selector, decls: [{ prop, value }] }] — one entry per comma-separated selector. */
export function rulesOf(text, file = '') {
  const rules = []
  for (const rule of text.matchAll(/([^\n{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1] ? String(rule[1]).split(',').map((s) => s.trim()).filter(Boolean) : []
    const decls = []
    for (const decl of String(rule[2] ?? '').matchAll(/([A-Za-z-]+)\s*:\s*([^;{}]*)/g)) {
      decls.push({ prop: decl[1].trim(), value: (decl[2] ?? '').trim() })
    }
    for (const selector of selectors) rules.push({ file, selector, decls })
  }
  return rules
}

/** Read + strip + parse, for a list of absolute paths. */
export function parseCssFiles(files) {
  const out = []
  for (const f of files) out.push(...rulesOf(stripComments(readFileSync(f, 'utf8')), f))
  return out
}

/** Is this value a colour literal (hex / rgb(a)) rather than a var() reference? */
export function literalColor(value) {
  const m = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/.exec(value)
  return m ? m[0] : null
}

/** The first `var(--token)` in a value, or null. */
export function tokenColor(value) {
  const m = /var\((--[a-z0-9-]+)\)/.exec(value)
  return m ? m[1] : null
}
