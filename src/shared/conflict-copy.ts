/**
 * Sync conflict copies (ticket 09 prerequisite). A sync service that finds two edits of one file
 * keeps both, naming the second after the machine it came from: `00_intro.md` beside
 * `00_intro-Studio Mac.md`. The copy usually keeps the original's `# Title`, so a title lookup
 * matches both. These helpers let a resolver prefer the original whenever both match.
 *
 * The rule is relative, never a list of machine names: a file is a conflict copy OF another file in
 * the same folder when its name is the other's name, then `-` or a space, then a suffix that
 * contains a letter (a machine name, or a sync service's "(… conflicted copy …)"). A bare numeric suffix
 * such as `-2` is a deliberate sibling, not a copy.
 */

function split(path: string): { folder: string; stem: string } {
  const slash = path.lastIndexOf('/')
  const folder = slash < 0 ? '' : path.slice(0, slash)
  const name = slash < 0 ? path : path.slice(slash + 1)
  return { folder, stem: name.replace(/\.(?:md|markdown|mdx)$/i, '') }
}

/** Whether `copy` is a sync conflict copy of `original` (same folder, name plus a machine suffix). */
export function isConflictCopyOf(copy: string, original: string): boolean {
  const a = split(copy)
  const b = split(original)
  if (a.folder !== b.folder || !b.stem || a.stem.length <= b.stem.length + 1) return false
  if (a.stem.slice(0, b.stem.length).toLocaleLowerCase() !== b.stem.toLocaleLowerCase()) return false
  const separator = a.stem[b.stem.length]
  if (separator !== '-' && separator !== ' ') return false
  return /\p{L}/u.test(a.stem.slice(b.stem.length + 1))
}

/** Whether `path` is a conflict copy of any other path in `among`. */
export function isConflictCopyAmong(path: string, among: readonly string[]): boolean {
  return among.some((other) => other !== path && isConflictCopyOf(path, other))
}

/**
 * The preferred path from an ordered list of equally matching paths: the first one that is not a
 * conflict copy of another in the list. When every entry is a copy (which cannot happen for a
 * finite list, but guards the shape), the first entry stands.
 */
export function preferOriginal(ordered: readonly string[]): string | null {
  if (!ordered.length) return null
  return ordered.find((path) => !isConflictCopyAmong(path, ordered)) ?? ordered[0]
}
