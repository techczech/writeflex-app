/**
 * The one way a document's bytes are read when they are about to DECIDE something or be COPIED
 * somewhere else: into the review ledger (the inbox validator in outside-change.ts, the in-app agent's
 * staging of a proposal), into another document (duplicate), into the undo journal or the history
 * store (a before-image), out through the command line (`read`, export), or into the text an accepted
 * Change is placed in (agent.ts). `readDocumentBytesGuarded` is the read; the others here are its
 * shapes for their callers.
 *
 * The danger is a check that names a path and a read that names it again. Between the two, a program
 * can put a link where the document was; the read then follows it, and another file's content (one
 * outside the Collection, or the app's own stores) becomes the `oldText` of a Change, in a ledger that
 * a synced folder carries to other machines. So here WHAT IS CHECKED IS WHAT IS READ:
 *
 *  1. the path is judged as typed (`Workspace.classifyPath`);
 *  2. the file is opened ONCE, without following a final link (a link fails to open) and without
 *     waiting on a pipe;
 *  3. the opened file must be a regular file;
 *  4. the opened file's REAL location is found (links in the folders above it resolved), it must be
 *     the very file that was opened (same device and file number), and that location must itself be
 *     a document of this Collection: inside it, under no dot-folder or ignored folder;
 *  5. the text is read from that open handle, never from the name again.
 *
 * A document that is itself a link is refused, with a reason: its text is whatever the link points at
 * when it is read. A swap after step 2 changes nothing: the handle is the file that was opened, and
 * step 4 says where that file really is. A swap before step 2 is a link (refused at 2) or, for a
 * folder above the file, a file somewhere else (refused at 4).
 */
import { constants, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import type { FileReadResult, Workspace } from './workspace'

export type GuardedReadCode = 'not-a-document' | 'missing' | 'is-a-folder' | 'is-a-link' | 'not-a-file' | 'moved' | 'too-large' | 'unreadable'

/** Why a document could not be read. `code` is stable; the message is for the writer. */
export class DocumentReadRefused extends Error {
  override readonly name = 'DocumentReadRefused'
  constructor(readonly code: GuardedReadCode, message: string) {
    super(message)
  }
}

/** A document larger than this is never copied into the ledger. */
export const MAX_GUARDED_DOCUMENT_BYTES = 16 * 1024 * 1024

/** @internal Test seam: runs after the path is judged and before the file is opened, where a swap would go. */
export const guardedReadSeams: { beforeOpen?: (absolute: string) => Promise<void> } = {}

/** The fingerprint of a document's bytes: what a content-checked save is given and compares. */
export const fingerprintOf = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

type GuardedWorkspace = Pick<Workspace, 'classifyPath' | 'absolute' | 'relative' | 'root'>

/** What one guarded read found: the canonical path, the bytes, and the opened file's own size and time. */
export type GuardedBytes = { path: string; bytes: Buffer; size: number; modifiedAt: number }

/**
 * The bytes of the document at Collection-relative `path`, read as the top of this file says: one
 * handle, opened without following a final link, judged, then read. Throws `DocumentReadRefused` for
 * every way it is not a readable document. `maxBytes` refuses a larger file before reading it;
 * `beforeOpen` is a caller's own test seam at the same place as `guardedReadSeams.beforeOpen`.
 */
export async function readDocumentBytesGuarded(ws: GuardedWorkspace, path: string, options: { maxBytes?: number; beforeOpen?: (absolute: string) => Promise<void> } = {}): Promise<GuardedBytes> {
  const verdict = ws.classifyPath(path)
  if (verdict !== 'document') {
    throw new DocumentReadRefused('not-a-document', verdict === 'hidden'
      ? `${path} is under a dot-folder or an ignored folder, which is not part of the Collection.`
      : `${path} is outside the Collection.`)
  }
  const absolute = ws.absolute(path)
  const rel = ws.relative(absolute)
  await guardedReadSeams.beforeOpen?.(absolute)
  await options.beforeOpen?.(absolute)
  let handle: FileHandle
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DocumentReadRefused('missing', `${rel} does not exist (it may have been renamed, moved or put in the Trash).`)
    // O_NOFOLLOW on a link: ELOOP (EMLINK on some systems).
    if (code === 'ELOOP' || code === 'EMLINK' || (await lstat(absolute).then((info) => info.isSymbolicLink(), () => false))) {
      throw new DocumentReadRefused('is-a-link', `${rel} is a link, not a document of its own, so a change to it is not shown for review. Name the document it points to.`)
    }
    throw new DocumentReadRefused('unreadable', `${rel} could not be read (${code ?? 'unknown error'}).`)
  }
  try {
    const opened = await handle.stat()
    if (opened.isDirectory()) throw new DocumentReadRefused('is-a-folder', `${rel} is a folder, not a document.`)
    if (!opened.isFile()) throw new DocumentReadRefused('not-a-file', `${rel} is not an ordinary file.`)
    // Where the opened file really is, and that it is the opened file that is there.
    const real = await realpath(absolute).catch(() => null)
    const there = real === null ? null : await lstat(real).catch(() => null)
    if (real === null || !there?.isFile() || there.ino !== opened.ino || there.dev !== opened.dev) {
      throw new DocumentReadRefused('moved', `${rel} changed while it was being read. Try again.`)
    }
    const realRel = relative(realpathSync(ws.root), real)
    if (realRel === '' || realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel) || ws.classifyPath(realRel) !== 'document') {
      throw new DocumentReadRefused('not-a-document', `${rel} does not lie inside the Collection as a document (a link stands in its path), so it was not read.`)
    }
    if (options.maxBytes !== undefined && opened.size > options.maxBytes) throw new DocumentReadRefused('too-large', `${rel} is too large to be changed through review (${opened.size} bytes).`)
    const buffer = Buffer.alloc(opened.size)
    let read = 0
    while (read < buffer.length) {
      let bytesRead: number
      try {
        ({ bytesRead } = await handle.read(buffer, read, buffer.length - read, read))
      } catch (error) {
        throw new DocumentReadRefused('unreadable', `${rel} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`)
      }
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { path: rel, bytes: buffer.subarray(0, read), size: opened.size, modifiedAt: opened.mtimeMs }
  } finally {
    await handle.close()
  }
}

/**
 * The text of the document at Collection-relative `path` for the review ledger, and the path in its
 * canonical form. Throws `DocumentReadRefused` for every way it is not a readable document.
 */
export async function readDocumentGuarded(ws: GuardedWorkspace, path: string): Promise<{ path: string; content: string }> {
  const read = await readDocumentBytesGuarded(ws, path, { maxBytes: MAX_GUARDED_DOCUMENT_BYTES })
  return { path: read.path, content: read.bytes.toString('utf8') }
}

const FINGERPRINT = Symbol('fingerprint of the bytes read')

/**
 * A guarded read in the shape `Workspace.readFile` returns. The fingerprint of the bytes read rides
 * on the result out of sight (it is not a field: nothing that copies, sends or prints the result
 * carries it); `fingerprintOfRead` gives it to the save that follows.
 */
export async function readDocumentFile(ws: GuardedWorkspace, path: string): Promise<FileReadResult> {
  const read = await readDocumentBytesGuarded(ws, path)
  const directory = dirname(read.path)
  const result: FileReadResult = {
    file: { path: read.path, name: basename(read.path), directory: directory === '.' ? '' : directory, modifiedAt: read.modifiedAt, size: read.size },
    content: read.bytes.toString('utf8'),
  }
  Object.defineProperty(result, FINGERPRINT, { value: fingerprintOf(read.bytes), enumerable: false })
  return result
}

/**
 * The fingerprint a content-checked save should expect after `read`: of the very bytes a guarded read
 * returned, or, for a read made any other way, of its text (the same thing whenever the file is
 * valid UTF-8, and otherwise a fingerprint the file does not have, so the save refuses).
 */
export function fingerprintOfRead(read: FileReadResult): string {
  const kept = (read as { [FINGERPRINT]?: unknown })[FINGERPRINT]
  return typeof kept === 'string' ? kept : fingerprintOf(read.content)
}

/**
 * A refused guarded read as the error a read by name would have raised, for callers that tell "not
 * there" from other failures by `code`: a path that is not a document fails exactly as a file that is
 * not there, so nothing at its far end shows, not even that it exists.
 */
export function asFileSystemError(refusal: DocumentReadRefused, path: string): NodeJS.ErrnoException {
  const [code, message] = refusal.code === 'missing' || refusal.code === 'not-a-document' ? ['ENOENT', `ENOENT: no such file or directory, open '${path}'`]
    : refusal.code === 'is-a-folder' ? ['EISDIR', 'EISDIR: illegal operation on a directory, read']
    : refusal.code === 'is-a-link' ? ['ELOOP', `${path} is a link, not a document of its own, so it was not read. Name the document it points to.`]
    : refusal.code === 'moved' ? ['EAGAIN', refusal.message]
    : refusal.code === 'not-a-file' ? ['EINVAL', refusal.message]
    : ['EIO', refusal.message]
  return Object.assign(new Error(message), { code })
}
