/**
 * Which tool calls touch a single file, and how to address that file in the sidecar's
 * git endpoints. Protocol knowledge, not presentation: the view asks "what was this
 * file before the change", and these helpers turn a wire `file_path` into the
 * session-relative path `GET /sessions/:id/git/file-base?path=` expects.
 */

/**
 * Verified against the kernel's own `input_schema` (edit.ts:107, write-file.ts:80,
 * hash-edit.ts:327): the property is `file_path`, not `path`.
 *
 * `apply_patch` (input.diff) and `ast_edit` (input.ops[]/paths[]) are deliberately
 * absent: they have no single target file, so there is no before-view to show — their
 * `uiContent` diff still renders, just without the baseline pane.
 */
const SINGLE_FILE_MUTATORS = new Set(['write_file', 'edit_file', 'hash_edit'])

export function toolFilePath(name: string, input: Record<string, unknown>): string | undefined {
  if (!SINGLE_FILE_MUTATORS.has(name)) return undefined
  const p = input.file_path
  return typeof p === 'string' && p.trim() !== '' ? p : undefined
}

/** `/`-normalized, no trailing slash. Windows separators come back from the wire as `\`. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Relative form of `filePath` inside `cwd`, or null when it cannot be addressed — the
 * sidecar's git routes refuse to escape the session cwd, so an outside path must not
 * even be asked. A path that already is relative passes through untouched.
 *
 * Case-insensitive on purpose: the same drive letter arrives as `F:` from the tool and
 * `f:` from a user-typed cwd. Pure string logic — no `node:path`, this runs in a browser.
 */
export function relativeToCwd(filePath: string, cwd: string): string | null {
  const f = normalize(filePath)
  const c = normalize(cwd)
  const absolute = /^[a-zA-Z]:\//.test(f) || f.startsWith('/')
  // No cwd to anchor on: an absolute path is unaddressable, a relative one is already fine.
  if (c === '') return absolute ? null : f
  if (f.toLowerCase() === c.toLowerCase()) return ''
  if (f.toLowerCase().startsWith(`${c.toLowerCase()}/`)) return f.slice(c.length + 1)
  return absolute ? null : f
}
