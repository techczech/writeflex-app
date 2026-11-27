import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { standsAsPinnedFolder, type FolderIdentity } from './guarded-document-write'
import type { FileIdentity } from './workspace-watcher'
import type { Workspace } from './workspace'

const DAY_MS = 24 * 60 * 60 * 1000
const AREA_PATH = /^assets\/pasted-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.png$/
const RECEIPT_NAME = /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.json$/
const DOCUMENT = /\.(?:md|markdown|mdx|html?|csv|tsv|txt|org|rst|adoc|svg|css|json|ya?ml|xml)$/i
const PRIVATE_FOLDERS = new Set(['.git', '.bridle', '.writeflex', 'node_modules'])
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

type AreaImage = { path: string; folder: FolderIdentity; file: FileIdentity }
type Receipt = AreaImage & { name: string; journalFile: FileIdentity }
type Observed = FileIdentity & { ctimeNs: bigint }

/** Discard and startup sweep use the same pinned parent and exact file identity. */
export function removeAreaImage(root: string, { path, folder, file }: AreaImage): boolean {
  const assets = join(realpathSync.native(root), 'assets')
  if (!AREA_PATH.test(path) || !standsAsPinnedFolder(assets, folder)) {
    throw new Error('The Area image folder changed after the drop wrote it.')
  }
  const absolute = join(assets, basename(path))
  const current = lstatSync(absolute, { bigint: true, throwIfNoEntry: false })
  if (!current) return false
  if (!current.isFile() || current.nlink !== 1n || !sameIdentity(current, file)) {
    throw new Error(path + ' changed after the Area drop wrote it.')
  }
  unlinkSync(absolute)
  return true
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
}

function syncFolder(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function decodeReceipt(raw: string, name: string, journalFile: FileIdentity, root: string, before: number): Receipt | null {
  try {
    const record = JSON.parse(raw)
    if (record.root !== root || !Number.isSafeInteger(record.createdAt) || record.createdAt >= before
      || typeof record.path !== 'string' || !AREA_PATH.test(record.path)
      || !Number.isSafeInteger(record.folderDev) || !Number.isSafeInteger(record.folderIno)) return null
    const numbers = [record.dev, record.ino, record.size, record.mtimeNs]
    if (!numbers.every(value => typeof value === 'string' && /^\d{1,24}$/.test(value))) return null
    const [dev, ino, size, mtimeNs] = numbers.map(value => BigInt(value))
    return {
      name, journalFile, path: record.path,
      folder: { real: join(root, 'assets'), dev: record.folderDev, ino: record.folderIno },
      file: { dev, ino, size, mtimeNs },
    }
  } catch { return null }
}

/** A basename mention is enough to keep the image, including escaped Markdown and encoded URLs. */
function searchableText(content: Buffer): string {
  const text = content[0] === 0xff && content[1] === 0xfe ? content.toString('utf16le')
    : content[0] === 0xfe && content[1] === 0xff
      ? content.subarray(0, content.length - content.length % 2).swap16().toString('utf16le')
      : content.toString('utf8')
  return text.toLowerCase()
    .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});?/g, (match, digits: string) => {
      const code = digits.startsWith('x') ? parseInt(digits.slice(1), 16) : Number(digits)
      return code < 128 ? String.fromCharCode(code) : match
    })
    .replace(/&hyphen;|&period;|&percnt;/g, match => ({ '&hyphen;': '-', '&period;': '.', '&percnt;': '%' })[match]!)
    .replace(/%([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([.-])/g, '$1')
    .toLowerCase()
}

/** Read the Collection's text documents, including hidden drafts. If any could not be checked, keep
 * the images. Recheck the walked files and directories before deleting anything. */
async function findReferences(root: string, candidates: Receipt[]): Promise<{ unlinked: Receipt[]; stillCurrent: () => boolean }> {
  const pending = new Map(candidates.map(receipt => [basename(receipt.path), [] as Receipt[]]))
  for (const receipt of candidates) pending.get(basename(receipt.path))!.push(receipt)
  const observed = new Map<string, Observed>()
  const walk = async (directory: string): Promise<void> => {
    const folder = await lstat(directory, { bigint: true })
    if (!folder.isDirectory() || realpathSync.native(directory) !== directory) throw new Error('A Collection folder changed during the Area sweep.')
    observed.set(directory, folder)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!pending.size) return
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!PRIVATE_FOLDERS.has(entry.name)) await walk(path)
      } else if (entry.isSymbolicLink()) {
        // An asset alias can also be the link a document uses. Leave the sweep for a later
        // open when the entire Collection can be checked without following symlinks.
        throw new Error('A linked file or folder could not be checked for Area images.')
      } else if (DOCUMENT.test(entry.name)) {
        if (!entry.isFile()) throw new Error('A Collection document is not a regular file.')
        const handle = await open(path, READ_FLAGS)
        try {
          const info = await handle.stat({ bigint: true })
          if (!info.isFile() || info.size > BigInt(MAX_DOCUMENT_BYTES)) throw new Error('A Collection document could not be checked for Area images.')
          const named = lstatSync(path, { bigint: true })
          if (!sameIdentity(info, named) || realpathSync.native(path) !== path) {
            throw new Error('A Collection document moved during the Area sweep.')
          }
          const bytes = Buffer.alloc(Number(info.size) + 1)
          let read = 0
          while (read < bytes.length) {
            const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read)
            if (bytesRead === 0) break
            read += bytesRead
          }
          if (BigInt(read) !== info.size) throw new Error('A Collection document changed during the Area sweep.')
          observed.set(path, info)
          const text = searchableText(bytes.subarray(0, read))
          for (const name of pending.keys()) {
            if (text.includes(name)) pending.delete(name)
          }
        } finally { await handle.close() }
      }
    }
  }
  await walk(root)
  return {
    unlinked: [...pending.values()].flat(),
    stillCurrent: () => {
      for (const [path, before] of observed) {
        const now = lstatSync(path, { bigint: true, throwIfNoEntry: false })
        if (!now || !sameIdentity(now, before) || now.ctimeNs !== before.ctimeNs) return false
      }
      return true
    },
  }
}

/** One instance per app run. Receipts live in local app data, outside the Collection and its sync.
 * A receipt is written before the staged image can take its final name. The sweep ignores receipts
 * from this run, including any whose renderer still owns an in-flight drop. */
export class AreaImageJournal {
  readonly #run = randomUUID()

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  #folder(root: string, create: boolean): string {
    if (create) mkdirSync(this.directory, { mode: 0o700, recursive: true })
    const parent = join(realpathSync.native(dirname(this.directory)), basename(this.directory))
    const folder = join(parent, createHash('sha256').update(root).digest('hex'))
    if (!lstatSync(parent).isDirectory()) throw new Error('The Area image journal is not a folder.')
    if (create) mkdirSync(folder, { mode: 0o700, recursive: true })
    if (!lstatSync(folder).isDirectory()) throw new Error('The Area image receipts are not in a folder.')
    return folder
  }

  remember(root: string, { path, folder, file }: AreaImage): () => void {
    const dir = this.#folder(root, true)
    const name = this.#run + '.' + randomUUID() + '.json'
    const absolute = join(dir, name)
    const fd = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify({
        root, path, createdAt: this.now(), folderDev: folder.dev, folderIno: folder.ino,
        dev: String(file.dev), ino: String(file.ino), size: String(file.size), mtimeNs: String(file.mtimeNs),
      }))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    syncFolder(dir)
    syncFolder(dirname(dir))
    syncFolder(dirname(dirname(dir)))
    return () => this.#retire(root, name)
  }

  #retire(root: string, name: string): void {
    const dir = this.#folder(root, false)
    unlinkSync(join(dir, name))
    syncFolder(dir)
  }

  async #expire(root: string): Promise<Receipt[]> {
    const dir = this.#folder(root, false)
    const before = this.now() - DAY_MS
    const receipts: Receipt[] = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !RECEIPT_NAME.test(entry.name) || entry.name.startsWith(this.#run + '.')) continue
      const handle = await open(join(dir, entry.name), READ_FLAGS)
      try {
        const info = await handle.stat({ bigint: true })
        if (!info.isFile() || info.nlink !== 1n || info.size > 4096n) continue
        const receipt = decodeReceipt(await handle.readFile('utf8'), entry.name, info, root, before)
        if (receipt) receipts.push(receipt)
      } finally { await handle.close() }
    }
    return receipts
  }

  async sweep(
    workspace: Pick<Workspace, 'root' | 'exclusiveAll' | 'assertWritable' | 'recordOwnWrite'>,
    stillBound: () => boolean,
  ): Promise<string[]> {
    const { root } = workspace
    try {
      const resolved = realpathSync.native(root)
      const expired = await this.#expire(resolved)
      if (!expired.length) return []
      const { unlinked, stillCurrent } = await findReferences(resolved, expired)
      return await workspace.exclusiveAll(async () => {
        if (!stillBound() || !stillCurrent()) return []
        workspace.assertWritable()
        const dir = this.#folder(resolved, false)
        const removed: string[] = []
        const unlinkedNames = new Set(unlinked.map(receipt => receipt.name))
        for (const receipt of expired) {
          try {
            const record = lstatSync(join(dir, receipt.name), { bigint: true, throwIfNoEntry: false })
            if (!record?.isFile() || record.nlink !== 1n || !sameIdentity(record, receipt.journalFile)) continue
            if (unlinkedNames.has(receipt.name) && removeAreaImage(root, receipt)) {
              removed.push(receipt.path)
              workspace.recordOwnWrite(receipt.path, 'absent')
            }
          } catch { continue }
          // A confirmed link makes this receipt ineligible permanently, even if the document
          // later stops referencing it. An image already gone has no more cleanup to do.
          try { this.#retire(resolved, receipt.name) } catch { /* leave it for the next sweep */ }
        }
        return removed
      })
    } catch {
      return [] // An unavailable journal or unchecked document gives no permission to delete.
    }
  }
}
