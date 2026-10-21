import { existsSync, lstatSync } from 'node:fs'
import { removeFrontmatterKeys, setFrontmatterKeys } from './capabilities'
import { indexNotePath } from './folio'
import { assertRelativeWorkspacePath, DiskChangedUnderBuffer, NotADocumentPathError, type FileReadResult, type WriteReceipt, type Workspace } from './workspace'
import { basisAllows, isSaveBasis, type SaveBasis } from '../shared/save-basis'
import { isTocDepthValue, TOC_DEPTH_KEY, tocDepthOf } from '../shared/toc-depth'

/**
 * Where a Folio's or a document's contents depth is kept, and the one write that changes it.
 *
 * The file is the home of the setting (`toc_depth` in its frontmatter): a Folio's is its Index Note,
 * a single document's is the document. The Export sheet only reads it; the depth the writer chose there
 * is saved once, by main, when an HTML export runs (`saveExportTocDepth`, called from export.ts with the
 * scope the export itself resolved). The write takes the DIRECT path "Set writing goal…" takes (goal:set
 * in ipc.ts), never the staged agent `frontmatter.set`: one key changed byte-preservingly, written only
 * over the version the caller says it read (checked before and again in the tick of the rename). Every
 * way it does not write is an answer, not an exception, so the export can say it quietly.
 */

/** The file a scope's depth lives in, what it says, and the text it was read as (the write's basis). */
export type TocDepthSource = { path: string; depth: number | null; text: string }

/**
 * What the sheet names: a scope, never a file. Main derives the file itself (Sol D1, Standards P1): a
 * document is an existing Markdown document of this Workspace; a Folio is its folder, whose canonical
 * Index Note (folio.ts `indexNotePath`, the file the Plan reads and writes) holds the setting.
 */
export type TocDepthScope = { kind: 'document'; path: string } | { kind: 'folio'; dir: string }

export type TocDepthRefusal = {
  refused: 'invalid' | 'outside' | 'not-a-document' | 'missing' | 'disk-changed' | 'unwritable'
  path: string
  message: string
}

/** The file as written (with this call's receipt), or as found when it already said that depth (no receipt). */
export type TocDepthWriteResult = (FileReadResult & Partial<WriteReceipt>) | TocDepthRefusal

/** The Markdown names the app treats as documents (workspace.ts MARKDOWN_EXTENSION). */
const MARKDOWN_DOCUMENT = /\.(md|markdown|mdx)$/i

function relative(path: unknown): string | null {
  if (typeof path !== 'string' || path === '') return null
  try { assertRelativeWorkspacePath(path) } catch { return null }
  return path
}

/** The scope as named, checked for shape only; null when it is not one. */
function scopeOf(input: unknown): TocDepthScope | null {
  const scope = (input ?? {}) as Record<string, unknown>
  if (scope.kind === 'document' && relative(scope.path) !== null) return { kind: 'document', path: scope.path as string }
  if (scope.kind === 'folio' && typeof scope.dir === 'string' && (scope.dir === '' || relative(scope.dir) !== null)) return { kind: 'folio', dir: scope.dir }
  return null
}

/** The scope's file, derived here: the document itself, or the Folio's canonical Index Note. */
export function tocDepthPath(ws: Pick<Workspace, 'root'>, scope: TocDepthScope): string {
  return scope.kind === 'document' ? scope.path : indexNotePath(ws, scope.dir)
}

type Target = { path: string } | TocDepthRefusal

/**
 * The file a scope's depth may be kept in, or why there is none. Only an existing Markdown document
 * the sidebar would show qualifies (a manifest, a picture, a file in a hidden folder never does), and a
 * Folio without an Index Note has no home: one is never created here.
 */
function targetOf(ws: Workspace, input: unknown): Target {
  const scope = scopeOf(input)
  const shown = typeof (input as { path?: unknown } | null)?.path === 'string' ? (input as { path: string }).path : 'the file'
  if (!scope) return { refused: 'outside', path: shown, message: 'That is not a document or Folio in this Workspace, so the contents depth was not saved.' }
  const path = tocDepthPath(ws, scope)
  if (!MARKDOWN_DOCUMENT.test(path)) {
    return { refused: 'not-a-document', path, message: `${path} is not a Markdown document, so the contents depth was not saved in it.` }
  }
  const verdict = ws.classifyPath(path)
  if (verdict !== 'document') return { refused: 'outside', path, message: 'That file is not a document in this Workspace, so the contents depth was not saved.' }
  let info: ReturnType<typeof lstatSync> | null = null
  try { info = lstatSync(ws.absolute(path)) } catch { info = null }
  if (!info) {
    return scope.kind === 'folio'
      ? { refused: 'missing', path, message: `This Folio has no Index Note (${path}), so the contents depth was not saved.` }
      : { refused: 'missing', path, message: `${path} is no longer there, so the contents depth was not saved.` }
  }
  if (!info.isFile()) return { refused: 'not-a-document', path, message: `${path} is not a document of its own, so the contents depth was not saved in it.` }
  return { path }
}

/**
 * Read a scope's depth from disk. Null when the scope has no file to keep it in (a Folio with no Index
 * Note, a document that is gone). Throws for anything that is not a scope of this Workspace or whose
 * file is not a Markdown document.
 */
export async function readTocDepthSource(ws: Workspace, input: unknown): Promise<TocDepthSource | null> {
  const target = targetOf(ws, input)
  if ('refused' in target) {
    if (target.refused === 'missing') return null
    throw new Error(target.message)
  }
  const { content } = await ws.readFile(target.path)
  return { path: target.path, depth: tocDepthOf(content), text: content }
}

/** The depth a folder's export uses when the request names none: its Index Note's `toc_depth`. */
export async function folioTocDepth(ws: Workspace, dir: string): Promise<number | null> {
  try {
    const path = indexNotePath(ws, dir)
    if (!existsSync(ws.absolute(path))) return null
    return tocDepthOf((await ws.readFile(path)).content)
  } catch {
    return null // an unreadable Index Note is no setting; the export keeps its default
  }
}

/** `text` with `toc_depth` set to `depth`, or removed for null. Only that key's line changes. */
export function withTocDepth(text: string, depth: number | null, path = 'document'): string {
  return depth === null
    ? removeFrontmatterKeys(text, [TOC_DEPTH_KEY], path)
    : setFrontmatterKeys(text, { [TOC_DEPTH_KEY]: String(depth) }, path)
}

/**
 * Write `depth` (1-6, or null to remove the key) into the frontmatter of the file `scope` derives,
 * only over the version `basis` names. Refused, with nothing written: a scope that is not this
 * Workspace's, a file that is not a Markdown document, a Folio with no Index Note, a depth that is not
 * 1-6, a file that is gone or changed since it was read, a frontmatter block the strict writer cannot
 * safely edit, a folder swapped for a link while the write was under way. Choosing what the file
 * already says writes nothing and answers the file.
 */
export async function writeTocDepth(ws: Workspace, input: unknown): Promise<TocDepthWriteResult> {
  const request = (input ?? {}) as Record<string, unknown>
  const target = targetOf(ws, request.scope)
  if ('refused' in target) return target
  const { path } = target
  const depth = request.depth ?? null
  if (depth !== null && !isTocDepthValue(depth)) {
    return { refused: 'invalid', path, message: 'The contents depth must be a whole number from 1 to 6, so nothing was saved.' }
  }
  if (!isSaveBasis(request.basis)) return { refused: 'invalid', path, message: 'WriteFlex did not know which version of the file it read, so nothing was saved.' }
  const basis: SaveBasis = request.basis
  const outside: TocDepthRefusal = { refused: 'outside', path, message: 'That file is not a document in this Workspace, so the contents depth was not saved.' }
  let content: string
  try {
    content = (await ws.readFile(path)).content
  } catch {
    return existsSync(ws.absolute(path))
      ? outside
      : { refused: 'missing', path, message: `${path} is no longer there, so the contents depth was not saved.` }
  }
  const changed: TocDepthRefusal = { refused: 'disk-changed', path, message: `${path} changed on disk since the sheet read it, so the contents depth was not saved.` }
  if (!basisAllows(basis, content)) return changed
  let next: string
  try {
    next = withTocDepth(content, depth, path)
  } catch (error) {
    return { refused: 'unwritable', path, message: error instanceof Error ? error.message : `Could not change the frontmatter in ${path}.` }
  }
  if (next === content) return ws.readFile(path) // already says it (or clearing an absent key): no write
  try {
    // The guarded document write (guarded-document-write.ts): staged beside the file through a no-follow
    // handle whose real folder is checked, renamed through that real folder, so a folder swapped for an
    // outside link after the checks above is refused rather than followed (Sol D1, Spec P1). The basis is
    // compared again in the tick of the rename.
    return await ws.saveFile(path, next, { documentOnly: true, beforeCommit: ws.commitOnlyOver(path, basis) })
  } catch (error) {
    if (error instanceof DiskChangedUnderBuffer) return changed
    if (error instanceof NotADocumentPathError) return outside
    throw error
  }
}

/**
 * Save the depth an HTML export ran with into the scope's file, once, after the export file is written.
 * `scope` is what the export resolved (the document it read, or the folder it bundled), never a path
 * named for the purpose. `basisText` is the text the export read the document as; a Folio's Index Note
 * is read here. Never throws: a refusal or a failure comes back as a refusal with its sentence, so it
 * can never fail the export it follows.
 */
export async function saveExportTocDepth(ws: Workspace, scope: TocDepthScope, depth: number | null, basisText?: string): Promise<TocDepthWriteResult> {
  const where = scope.kind === 'document' ? scope.path : scope.dir
  try {
    let text = basisText
    if (text === undefined) {
      const source = await readTocDepthSource(ws, scope)
      if (!source) {
        return scope.kind === 'folio'
          ? { refused: 'missing', path: tocDepthPath(ws, scope), message: 'This Folio has no Index Note, so the contents depth was not saved.' }
          : { refused: 'missing', path: scope.path, message: `${scope.path} is no longer there, so the contents depth was not saved.` }
      }
      text = source.text
    }
    return await writeTocDepth(ws, { scope, depth, basis: { kind: 'disk', text } })
  } catch {
    return { refused: 'unwritable', path: where, message: 'WriteFlex could not save the contents depth with the file.' }
  }
}
