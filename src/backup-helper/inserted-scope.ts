/**
 * Which working files a Folio version may carry as frozen per-file version objects (ADR-0052 amendment 3 Nov 2026, option A).
 *
 * The ordinary backup scope (`WRITEFLEX_SCOPE`) sends Markdown only. A Folio version's INSERTED files (a table, an image, a widget
 * page) are not Markdown, and the owner decided the backup carries them with the version: as the per-file version's saved copy
 * (`.bridle/objects/<sha256>` and its journal entry), never as the working file. Working folders such as `data/` and `assets/` stay
 * out of ordinary backup scope.
 *
 * This is the ordinary scope's exclusions with every include, and `.writeflex/` (the app's own records, never a document):
 * a file in the bin, in `.bridle`, `node_modules`, a `.venv` or `.cache` folder, or in `.writeflex` is not carried.
 */
import { ordinaryScopeTest } from '@app-patterns/vault-sync/helper/host'

export function insertedFileScopeTest(scope: { exclude?: readonly string[] }): (path: string) => boolean {
  return ordinaryScopeTest({ include: ['**'], exclude: [...(scope.exclude ?? []), '.writeflex'] })
}
