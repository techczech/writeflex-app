/** Read-only move evidence. Shared with backup capture; never appends or settles an intent. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import { MAX_GUARDED_DOCUMENT_BYTES } from './guarded-document-read'
import type { Evidence, MoveState } from '../engine/version-move-projection'
export function historyPath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path === '..' || path.startsWith('../') || posix.normalize(path) !== path || path.endsWith('/')) throw new Error('History paths must be normalised workspace-relative paths.')
  return path
}

/** Refuse links in every component before reading journal data or move evidence. */
export function ordinary(root: string, path: string): string {
  historyPath(path)
  let current = realpathSync(root)
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    const info = lstatSync(current)
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) throw Object.assign(new Error('History cannot use a linked path.'), { code: 'ELOOP' })
  }
  return current
}

/** Only copy evidence needs bytes on reads; bound both allocation and bytes read, even if it grows. */
export function fileHash(path: string): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_GUARDED_DOCUMENT_BYTES) return undefined
    const digest = createHash('sha256')
    const chunk = Buffer.alloc(64 * 1024)
    let total = 0
    while (total <= MAX_GUARDED_DOCUMENT_BYTES) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_GUARDED_DOCUMENT_BYTES + 1 - total), null)
      if (!count) return digest.digest('hex')
      total += count
      digest.update(chunk.subarray(0, count))
    }
    return undefined
  } finally { closeSync(fd) }
}

export function moveEvidence(root: string, e: Evidence): MoveState {
  let sourceMatches = false
  let targetMatches = false
  try {
    const source = lstatSync(ordinary(root, e.from))
    sourceMatches = source.dev === e.dev && source.ino === e.ino
  } catch { /* Missing, linked or unreadable grants no identity. */ }
  try {
    const path = ordinary(root, e.to)
    const target = lstatSync(path)
    targetMatches = e.hash ? fileHash(path) === e.hash : target.dev === e.dev && target.ino === e.ino
    if (sourceMatches && targetMatches && !e.hash && e.from.toLowerCase() === e.to.toLowerCase()) {
      try {
        const actual = relativeHistoryPath(root, realpathSync.native(path))
        return actual === e.to ? 'happened' : actual === e.from ? 'not-happened' : 'held-back'
      } catch { return 'held-back' }
    }
  } catch { /* Existence alone never establishes ownership. */ }
  return targetMatches ? 'happened' : sourceMatches ? 'not-happened' : 'held-back'
}

export function relativeHistoryPath(root: string, absolute: string): string { return historyPath(relative(realpathSync(root), absolute).split('\\').join('/')) }

