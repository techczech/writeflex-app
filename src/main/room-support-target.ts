// The Folio room support-file rule (isRoomSupportName, invariant I-9) judged on both names a read can
// reach: the path as requested and the file it really opens once links (symlinks, in the file and its
// parent folders) are resolved. A part file replaced by a link to `_paper_EVIDENCE-AND-NOTES.md` or a
// `.canvas` file keeps an ordinary name, so the requested name alone lets the private file through
// (Sol review r1 of Folio room ticket 03). Every boundary that reads a listed part (sharing eligibility,
// export, the Collection's rows, the Plan's candidates) asks this just before it reads.
//
// Accepted residual, as in sharing-source-eligibility.ts: the rule judges a path, so a swap between this
// check and the asynchronous open is not closed.
//
// No Electron import.
import { resolve } from 'node:path'
import { realLocation } from './document-path'
import { isRoomSupportName } from '../shared/folio-part-name'

/** `path` (relative to `root`) names a room support file, or really opens one once links are resolved. */
export function resolvesToRoomSupportFile(root: string, path: string): boolean {
  if (isRoomSupportName(path)) return true
  const real = realLocation(resolve(root, path))
  return real !== null && isRoomSupportName(real)
}
