/**
 * One question to main about a file's place in its Folio. The answer is applied only while it is
 * still the newest question; a refused question (main rejects a path that is not workspace-relative)
 * clears the controls exactly like a null answer, and is never left as an unhandled rejection. A late
 * answer or a late refusal for an earlier file changes nothing.
 */
export function askFolioPlace<T>(
  read: () => Promise<T | null>,
  isCurrent: () => boolean,
  apply: (next: T | null) => void,
): Promise<void> {
  return Promise.resolve()
    .then(read)
    .then((next) => { if (isCurrent()) apply(next) })
    .catch(() => { if (isCurrent()) apply(null) })
}
