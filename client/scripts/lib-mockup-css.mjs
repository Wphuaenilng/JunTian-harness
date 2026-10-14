/**
 * Shared reader for the approved mockup's `<style>` block. Extracted because two gates need it
 * (`check:geometry` reads CSS text, `check:liverender` compares rendered pixels), and because the
 * first versions of this logic produced two real false alarms worth remembering:
 *
 *  - the drawing separates sections with block comments whose opener is slash-star and closer is
 *    star-slash (e.g. a "② 项目行" banner), so an unstripped comment becomes part of the selector
 *    text and rules that plainly exist get reported as missing;
 *  - a composite selector (`.ckp__item + .ckp__item { … }`) contains the same selector text, so
 *    without a line anchor the wrong rule wins.
 *
 * Both are handled here, in one place, so the gates cannot drift apart.
 */
import { readFileSync } from 'node:fs'

/** selector → declaration map, later rules overriding earlier ones, in source order. */
export function parseMockupStyle(source) {
  // The mockup keeps its CSS inside `<style>`; a plain .css file has no such wrapper, and reading
  // one through this function is the other gate's normal path. Falling back to the whole text
  // matters: matching zero `<style>` blocks used to yield zero rules, which the caller then read
  // as "the product declares nothing at all" — 20 false drifts out of one parser assumption.
  const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
  const style = (blocks.length > 0 ? blocks.map((m) => m[1]).join('\n') : source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const rules = []
  for (const m of style.matchAll(/(?:^|\n)[ \t]*([^{}\n]+)\{([^}]*)\}/gm)) {
    const sel = m[1].trim().replace(/\s+/g, ' ')
    const decls = {}
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i < 0) continue
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    rules.push({ sel, decls })
  }
  return rules
}

export function readMockup(path) {
  return parseMockupStyle(readFileSync(path, 'utf8'))
}

/** The last rule whose selector matches exactly, like the cascade would resolve it. */
export function ruleFor(rules, selector) {
  const want = selector.trim().replace(/\s+/g, ' ')
  const hits = rules.filter((r) => r.sel === want)
  return hits.length > 0 ? hits[hits.length - 1].decls : undefined
}

export function declOf(rules, selector, prop) {
  return ruleFor(rules, selector)?.[prop]
}

/** px value out of a declaration, or NaN. `idx` picks one token of a shorthand like a track list. */
export function pxOf(value, idx) {
  if (typeof value !== 'string') return NaN
  const token = idx === undefined ? value : value.split(/[\s/]+/)[idx]
  const m = /(-?[\d.]+)px/.exec(token ?? '')
  return m ? Number(m[1]) : NaN
}
