import type { Workspace } from './workspace'

/** The three annotation kinds the jumps scanner surfaces in the outline pane's facet row. */
export type JumpKind = 'bookmark' | 'comment' | 'task'
/** One jump target: a bookmark, `//` comment, or task list item, located to a file and 1-based line. */
export type JumpEntry = { kind: JumpKind; file: string; line: number; text: string; done?: boolean }
/**
 * A single scanned target within one file's text: a jump (bookmark/comment/task) or — only when the
 * scan is asked for headings (folder scope, Task 10) — an ATX heading carrying its level. File scope
 * never asks for headings: it derives them from the Lezer parser (editor/outline.ts) against the live
 * buffer, so this scanner's simpler regex heading rule serves the disk-backed folder aggregation alone.
 */
export type ScannedEntry =
  | { kind: JumpKind; line: number; text: string; done?: boolean }
  | { kind: 'heading'; line: number; text: string; level: number }
/** A {@link ScannedEntry} tagged with the workspace-relative file it was found in ({@link scanFolder}). */
export type OutlineScanEntry = ScannedEntry & { file: string }

// A line that opens or closes a fenced code block (``` or ~~~, optionally indented, possibly with an
// info string). This mirrors word-count.ts and the render decorator: annotations inside a fence are
// real code, never WriteFlex bookmarks/comments/tasks (the T7 semantics contract). `//@ ` bookmarks
// are a subtype of `//` comment lines, so the same fence immunity applies to them.
const FENCE_LINE = /^\s*(?:```|~~~)/
// A bookmark: `//@ ` then its label. Checked BEFORE the comment rule so `//@ x` is never also counted
// as a comment (a bookmark is a `//` line, so the plain-comment test below would otherwise match it).
const BOOKMARK_LINE = /^\s*\/\/@\s*(.+)$/
// A plain WriteFlex comment: a line that starts (after optional indent) with `//`.
const COMMENT_LINE = /^\s*\/\//
// A GitHub-style task list item: `- [ ] ` / `* [x] `; the box char is the done flag, the rest the text.
const TASK_LINE = /^\s*[-*] \[( |x)\] (.+)$/
// An ATX heading (folder scope only, opt-in): 1–6 leading hashes THEN whitespace THEN the text. Level
// is the hash count; `#nospace` and seven-plus hashes are not headings. Start-anchored (no leading
// indent) — a `//` line can never match, so this never competes with the comment/bookmark rules.
const HEADING_LINE = /^(#{1,6})\s+(.+)$/
// Comment text is a marginal note, not prose — cap it so a runaway line can't bloat the outline row.
const COMMENT_MAX = 120

/**
 * Scan Markdown text for jump targets (pure — no Electron/Node imports, so it is unit-testable and can
 * also run in the renderer against the live editor buffer). Lines are scanned in order; the first rule
 * that matches wins, so a `//@` bookmark is never double-counted as a `//` comment. Fenced code blocks
 * are skipped wholesale. Returns entries without a `file` — {@link scanFolder} attaches that. Pass
 * `{ headings: true }` to also emit ATX headings (folder scope), and `headingLimit` to stop the scan at that many headings; file scope omits it so the Lezer
 * parser stays the single source of the open file's headings.
 */
export function scanText(text: string, opts?: { headings?: boolean; headingLimit?: number }): ScannedEntry[] {
  const entries: ScannedEntry[] = []
  let headingCount = 0
  let inFence = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (FENCE_LINE.test(line)) {
      inFence = !inFence // the fence marker itself is structure, never an annotation
      continue
    }
    if (inFence) continue
    const lineNumber = i + 1

    if (opts?.headings) {
      const heading = HEADING_LINE.exec(line)
      if (heading) {
        entries.push({ kind: 'heading', line: lineNumber, text: heading[2].trim(), level: heading[1].length })
        headingCount += 1
        if (opts.headingLimit !== undefined && headingCount >= opts.headingLimit) return entries // stop scanning; the caller wants no more
        continue
      }
    }

    const bookmark = BOOKMARK_LINE.exec(line)
    if (bookmark) {
      entries.push({ kind: 'bookmark', line: lineNumber, text: bookmark[1].trim() })
      continue
    }
    if (COMMENT_LINE.test(line)) {
      const text = line.replace(COMMENT_LINE, '').trim().slice(0, COMMENT_MAX)
      entries.push({ kind: 'comment', line: lineNumber, text })
      continue
    }
    const task = TASK_LINE.exec(line)
    if (task) {
      entries.push({ kind: 'task', line: lineNumber, text: task[2].trim(), done: task[1] === 'x' })
      continue
    }
  }
  return entries
}

/** True when `filePath` is `subpath` itself or nested beneath it (POSIX-relative workspace paths). */
function withinSubpath(filePath: string, subpath: string): boolean {
  const base = subpath.replace(/\/+$/, '')
  if (base === '' || base === '.') return true
  return filePath === base || filePath.startsWith(`${base}/`)
}

/**
 * Scan every Markdown file in the Workspace (optionally restricted to a `subpath` folder), aggregating
 * jump targets in path order. `Workspace.listFiles()` already returns files sorted by path, so the
 * result is deterministic and folder-grouped. Reads go through the Workspace so the same boundary and
 * symlink guards that protect every other file read apply here too. Pass `{ headings: true }` (folder
 * scope) to include each file's ATX headings alongside its jumps.
 */
export async function scanFolder(ws: Workspace, opts?: { subpath?: string; headings?: boolean }): Promise<OutlineScanEntry[]> {
  const files = await ws.listFiles()
  const scoped = opts?.subpath ? files.filter((f) => withinSubpath(f.path, opts.subpath!)) : files
  // This module stays PURE (no Node imports) so the renderer can run scanText against the live buffer.
  // Folio ordering (Task 24) therefore lives in the main-only ipc handler, which reorders these entries
  // by folio.orderEntriesByFolio — path order here is the correct non-Folio behaviour.
  const scanOpts = opts?.headings ? { headings: true } : undefined
  const entries: OutlineScanEntry[] = []
  for (const file of scoped) {
    // A file can vanish or become unreadable between the listing and this read (deleted, permission
    // denied, or rejected by the symlink guard). Skip that one file and keep scanning the rest — a
    // single bad file must never abort a whole-folder scan.
    let content: string
    try {
      ;({ content } = await ws.readFile(file.path))
    } catch {
      continue
    }
    for (const entry of scanText(content, scanOpts)) entries.push({ ...entry, file: file.path })
  }
  return entries
}
