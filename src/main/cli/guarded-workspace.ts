import { DocumentReadRefused, asFileSystemError, readDocumentBytesGuarded, readDocumentFile } from '../guarded-document-read'
import { SEARCH_INDEX_READ_CONCURRENCY, SearchIndex } from '../search-index'
import { pieceTitle } from '../search-query'
import { Workspace, extractFrontmatterTags, type FileReadResult } from '../workspace'

/**
 * The Workspace the command line hands to the app's readers. An argument typed on the command line
 * is checked by `visiblePath`; this covers the paths a DOCUMENT names, which the shared readers
 * (plan, Folio manifest, collection, sources) work out for themselves: every `readFile` is the
 * guarded read (guarded-document-read.ts), which judges the path, opens the file once without
 * following a final link, judges the file that was opened and reads from that handle. A path that is
 * hidden or outside the Collection fails exactly as a file that is not there, so nothing at its far
 * end shows in a result, not even that it exists; a document that is itself a link is refused.
 *
 * Search reads the same way: its content cache is filled by the guarded read, so a file that is a
 * link at the moment it is read (one put at a listed name after the listing) gives search no text;
 * it is left out of the results as a file that vanished would be.
 *
 * The app's own stores under `.writeflex` do not read through `readFile` and are unaffected.
 */
export class CommandLineWorkspace extends Workspace {
  override readonly searchIndex = new SearchIndex(
    async (path) => (await readDocumentBytesGuarded(this, path)).bytes.toString('utf8'),
    extractFrontmatterTags,
    SEARCH_INDEX_READ_CONCURRENCY,
    pieceTitle,
  )

  override async readFile(path: string): Promise<FileReadResult> {
    try {
      return await readDocumentFile(this, path)
    } catch (error) {
      throw error instanceof DocumentReadRefused ? asFileSystemError(error, path) : error
    }
  }
}
