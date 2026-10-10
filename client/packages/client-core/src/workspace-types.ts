/**
 * Workspace / timeline wire shapes — not in the contract leaf, so each field below was
 * read off a live sidecar response (see the notes) rather than inferred.
 */

/**
 * GET /sessions/:id/rewind-points → `{points:[...]}`.
 * Observed: `{"index":0,"content":"请用写文件工具…","timestamp":1791531635561,"seq":1}`.
 * `index` is the message index the rewind takes; `seq` is the timeline position, which
 * is what the UI already keys blocks by — both are needed because rewind is addressed
 * by index while rendering is addressed by seq.
 */
export interface RewindPoint {
  index: number
  content: string
  timestamp: number
  seq: number
}

/**
 * GET /sessions/:id/list-dir → `{path, entries:[{name, isDirectory}]}`.
 * Observed on `src/server`: entries mix directories and files, no size/mtime fields,
 * so the file browser cannot show metadata it doesn't have.
 */
export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface DirListing {
  path: string
  entries: DirEntry[]
}

/**
 * GET /sessions/:id/file-content → `{path, content}`.
 * Observed: content keeps the file's original line endings (package.json came back
 * with \r\n), so the preview must not normalise them away or a diff-vs-disk compare
 * would show phantom changes.
 */
export interface FileContent {
  path: string
  content: string
}
