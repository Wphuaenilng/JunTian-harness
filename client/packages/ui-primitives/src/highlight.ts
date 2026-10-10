/**
 * shiki code highlighting for the markdown path (plan §8 — the last stack cell to land).
 *
 * Two rules from the plan shape this: (1) streaming stays O(n), so only **sealed** blocks
 * highlight, once each, cached by language + code — never the open tail; (2) theme is a CSS
 * concern, so shiki is asked for a dual theme with `defaultColor: false` and the tokens come
 * back as `--shiki-light` / `--shiki-dark`. Highlighted code therefore follows a theme switch
 * without re-running shiki (an embedded frame cannot do that; see 主题链路 in client/README.md).
 *
 * Failure stays invisible in the safe direction: an unknown grammar or a blocked loader
 * leaves the block plain. Code must never become unreadable because a highlighter is missing.
 */
export type FenceRenderer = (code: string, lang: string) => Promise<string>

/** micromark 4's fenced block with an info string. No class = no language claim = no job. */
const FENCED_BLOCK = /<pre><code class="language-([A-Za-z0-9+#._-]{1,40})">([\s\S]*?)<\/code><\/pre>/g

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** The five entities micromark emits. Unterminated forms are left verbatim, not guessed. */
export function decodeEntities(escaped: string): string {
  return escaped.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
}

/** A hint, not a gate: unknown grammars are caught per block, so a wrong guess costs a plain block. */
const NOT_A_LANGUAGE = /^(?:text|txt|plain|raw|console|output|log|none)$/i

export function languageOf(info: string): string | null {
  const lang = (info ?? '').trim()
  return !lang || NOT_A_LANGUAGE.test(lang) ? null : lang
}

const cache = new Map<string, string>()
/**
 * One render per identical block even inside the same tick. The cache alone is not enough:
 * a message with two copies of the same fence starts both renders before either writes, so
 * the second would pay shiki twice. Found by the test, not by reading.
 */
const inflight = new Map<string, Promise<string | null>>()
let renders = 0

export function resetHighlightCache(): void { cache.clear(); inflight.clear(); renders = 0 }
export function highlightStats(): { renders: number; cached: number } { return { renders, cached: cache.size } }

let loader: Promise<typeof import('shiki')> | null = null

async function renderWithShiki(code: string, lang: string): Promise<string> {
  const shiki = await (loader ??= import('shiki'))
  return shiki.codeToHtml(code, {
    lang,
    defaultColor: false,
    themes: { light: 'light-plus', dark: 'dark-plus' },
    structure: 'classic',
  })
}

/** Replace every labelled fenced block with its highlighted html; failures stay as emitted. */
export async function highlightCodeBlocks(html: string, render: FenceRenderer = renderWithShiki): Promise<string> {
  if (!html.includes('<pre><code class="language-')) return html

  const targets: Array<{ raw: string; lang: string; code: string }> = []
  for (const m of html.matchAll(FENCED_BLOCK)) {
    const lang = languageOf(m[1] ?? '')
    if (lang) targets.push({ raw: m[0] ?? '', lang, code: decodeEntities(m[2] ?? '') })
  }
  if (targets.length === 0) return html

  const done = await Promise.all(targets.map(({ lang, code }): Promise<string | null> => {
    const key = `${lang}\u0000${code}`
    const hit = cache.get(key)
    if (hit !== undefined) return Promise.resolve(hit)
    const running = inflight.get(key)
    if (running) return running

    const job = (async (): Promise<string | null> => {
      try {
        renders += 1
        const out = await render(code, lang)
        cache.set(key, out)
        if (cache.size > 2000) {
          const first = cache.keys().next().value
          if (first !== undefined) cache.delete(first)
        }
        return out
      } catch {
        return null
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, job)
    return job
  }))

  let out = html
  done.forEach((block, i) => {
    if (!block) return
    // Function replacer: shiki's html must not be interpreted for `$&`-style patterns.
    out = out.replace(targets[i]!.raw, () => block)
  })
  return out
}
