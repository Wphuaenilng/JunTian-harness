# @tianshu/locale

zh/en dictionaries and the `t()` runtime. Infrastructure layer — like `ui-theme` and
`ui-primitives`, every `ui-*` package may depend on it; business packages still never
import each other (plan §4.2).

## Why this package exists

Plan §4.3 #4 keeps `client-core` React-free; this keeps it **wording-free** as well. A
model that formats a sentence owns the language of that sentence, so anything the view
must be able to re-render in another language has to arrive as data:

- `SessionModel` emits `{ kind: 'turn', truncated: true }`, not
  `'输出触顶截断（发「继续」可续）'`.
- A tool result with no `name` on the wire arrives with `name: ''` and `ui-chat` labels
  it `chat.toolUnnamed`.
- Failure states in the panels are `{ key, message }` pairs, so flipping the language
  translates an error that is already on screen instead of freezing it in whichever
  language it happened to arrive in. Server-side rejection text (`e.message`) stays
  verbatim — it is upstream data, not our copy.

`packages/locale/test/locale.test.ts` enforces all of that: it scans the eight UI
sources **and** `client-core/src` for CJK outside comments.

## Shape

Flat keys, `<package>.<name>`, one prefix per consumer:

| prefix | owner |
|---|---|
| `app.*` | `apps/web/src/App.tsx` |
| `chat.*` | `@tianshu/ui-chat` |
| `approval.*` | `@tianshu/ui-approval` |
| `session.*` | `@tianshu/ui-session` |
| `settings.*` | `@tianshu/ui-settings` |
| `git.*` | `@tianshu/ui-git` (checkpoints + workbench) |
| `files.*` | `@tianshu/ui-files` |
| `schedule.*` | `@tianshu/ui-schedule` |

`zh.ts` is the source language (`as const`, and `LocaleKey` is its key union). `en.ts`
is declared `Record<LocaleKey, string>`, so a key added on one side and forgotten on the
other is a **compile error** — the test only adds the placeholder-parity check that the
type system cannot express.

## Exports

- `useT()` → `Translator` — `(key, params?) => string`, re-renders on language flip via
  `useSyncExternalStore`
- `translate(locale, key, params)` / `interpolate` — non-React paths (e.g. a session
  title created at send time)
- `getLocale` / `setLocale` / `cycleLocale` / `subscribeLocale` / `detectLocale`
- `LocaleKey`, `Translator`, `Locale`, `TranslateParams`

## Rules

- Interpolation is `{name}`. A param the caller forgot stays as a literal `{name}` on
  screen: a loud bug beats a silently blank sentence.
- Storage key `tianshu.locale`; `main.tsx` resolves it **before** the first render so
  `<html lang>` and the dictionary agree from the first paint.
- Language names are endonyms: the switch offers `English` / `中文` in their own script
  in both dictionaries.
- Filenames, endpoints, event-type names and `provider:modelId` refs stay untranslated
  everywhere — translating a path destroys the hint it was meant to give.
- The M0 spike page (`apps/spike/index.html`) is deliberately not localized: it is a
  zero-dependency protocol proof, not the product.
