/**
 * A strict, read-only view of a zip held in memory.
 *
 * The container is parsed here, not by a library, because a Word file is untrusted input and the
 * checks that matter (names, counts, declared against real sizes, one name once) are short and must
 * not depend on a library's idea of lenient. The only library work is the deflate step (`fflate`'s
 * streaming `Inflate`), which is fed small chunks so its output can be counted and cut off the moment
 * it passes what the entry said it would be. No part is ever written anywhere.
 */
import { Inflate } from 'fflate'
import { WordRefusalError } from './refusal'
import type { WordReaderLimits } from './types'

export type ZipEntry = {
  name: string
  method: 0 | 8
  compressedSize: number
  size: number
  crc32: number
  /** Where the packed bytes start in the file. */
  dataStart: number
}

export type ZipView = {
  entries: ZipEntry[]
  /** Exact-name lookup. Parts are matched without regard to case (as Word does); names that differ only by case are refused, so this is unambiguous. */
  byName: Map<string, ZipEntry>
  bytes: Uint8Array
}

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff
/** Only the check "is the packed size believable" needs this: past it a part is a bomb on its face. */
const RATIO_FLOOR_BYTES = 1024 * 1024

function u16(d: DataView, o: number): number {
  return d.getUint16(o, true)
}
function u32(d: DataView, o: number): number {
  return d.getUint32(o, true)
}

/** A part name Word would never write and a path trick would: refused for every part, read or not. */
export function isUnsafePartName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return true
  if (name.includes('\0') || name.includes('\\')) return true
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return true
  if (name.startsWith('/')) return true
  if (/^[a-zA-Z]:/.test(name)) return true
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.') return true
  }
  return false
}

export function openZip(bytes: Uint8Array, limits: WordReaderLimits): ZipView {
  if (bytes.length > limits.maxFileBytes) throw new WordRefusalError('too-large')
  if (bytes.length < EOCD_MIN) throw new WordRefusalError('not-a-word-file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // The end record sits within the last 64 KiB (it can be followed by a comment). Search backwards.
  let eocd = -1
  const stop = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT)
  for (let i = bytes.length - EOCD_MIN; i >= stop; i--) {
    if (u32(view, i) === EOCD_SIG && i + EOCD_MIN + u16(view, i + 20) === bytes.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new WordRefusalError('not-a-word-file')

  const diskNumber = u16(view, eocd + 4)
  const cdDisk = u16(view, eocd + 6)
  const entriesOnDisk = u16(view, eocd + 8)
  const total = u16(view, eocd + 10)
  const cdSize = u32(view, eocd + 12)
  const cdOffset = u32(view, eocd + 16)
  // Zip64 markers: a Word file never needs them under the size limit, and refusing them closes a class of size lies.
  if (eocd >= 20 && u32(view, eocd - 20) === EOCD64_LOCATOR_SIG) throw new WordRefusalError('too-large')
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new WordRefusalError('too-large')
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== total) throw new WordRefusalError('damaged')
  if (total > limits.maxEntries) throw new WordRefusalError('too-many-parts')
  if (total === 0) throw new WordRefusalError('not-a-word-file')
  if (cdOffset + cdSize > eocd) throw new WordRefusalError('damaged')

  const entries: ZipEntry[] = []
  const byName = new Map<string, ZipEntry>()
  const seenLower = new Set<string>()
  const nameDecoder = new TextDecoder('utf-8', { fatal: false })
  let declaredTotal = 0
  let p = cdOffset
  for (let n = 0; n < total; n++) {
    if (p + 46 > cdOffset + cdSize || u32(view, p) !== CD_SIG) throw new WordRefusalError('damaged')
    const flags = u16(view, p + 8)
    const method = u16(view, p + 10)
    const crc32 = u32(view, p + 16)
    const compressedSize = u32(view, p + 20)
    const size = u32(view, p + 24)
    const nameLen = u16(view, p + 28)
    const extraLen = u16(view, p + 30)
    const commentLen = u16(view, p + 32)
    const localOffset = u32(view, p + 42)
    const next = p + 46 + nameLen + extraLen + commentLen
    if (next > cdOffset + cdSize) throw new WordRefusalError('damaged')
    const name = nameDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))

    if (isUnsafePartName(name)) throw new WordRefusalError('unsafe-part-name')
    if (flags & 0x1 || flags & 0x40) throw new WordRefusalError('password-protected')
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new WordRefusalError('too-large')
    // One name once, compared without case: two parts a reader could confuse is how a checked part and a read part differ.
    const lower = name.toLowerCase()
    if (seenLower.has(lower)) throw new WordRefusalError('damaged')
    seenLower.add(lower)

    declaredTotal += size
    if (declaredTotal > limits.maxDeclaredTotalBytes) throw new WordRefusalError('zip-bomb')
    if (size > RATIO_FLOOR_BYTES && size / Math.max(compressedSize, 1) > limits.maxRatio) throw new WordRefusalError('zip-bomb')

    // The local header gives where the packed bytes start; its name must agree with the directory's.
    if (localOffset + 30 > cdOffset) throw new WordRefusalError('damaged')
    if (u32(view, localOffset) !== LOCAL_SIG) throw new WordRefusalError('damaged')
    const lNameLen = u16(view, localOffset + 26)
    const lExtraLen = u16(view, localOffset + 28)
    const lName = nameDecoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + lNameLen))
    if (lName !== name) throw new WordRefusalError('damaged')
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compressedSize > cdOffset) throw new WordRefusalError('damaged')

    if (method !== 0 && method !== 8) {
      // Not unpackable here; it only matters if something asks for it.
      entries.push({ name, method: 8, compressedSize, size, crc32, dataStart: -1 })
    } else {
      entries.push({ name, method, compressedSize, size, crc32, dataStart })
    }
    const entry = entries[entries.length - 1]
    byName.set(lower, entry)
    p = next
  }
  if (p !== cdOffset + cdSize) throw new WordRefusalError('damaged')
  return { entries, byName, bytes }
}

let crcTable: Uint32Array | null = null
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Unpack one part. The part may not unpack to more than it declared (a lie is a bomb), nor to less
 * (a damaged file), nor past `maxPartBytes`, and its checksum must match. Nothing is returned for a
 * part that fails any of these.
 */
export function readPart(zip: ZipView, entry: ZipEntry, limits: WordReaderLimits): Uint8Array {
  if (entry.size > limits.maxPartBytes) throw new WordRefusalError('zip-bomb')
  if (entry.dataStart < 0) throw new WordRefusalError('damaged')
  const packed = zip.bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
  let out: Uint8Array
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new WordRefusalError('damaged')
    out = packed.slice()
  } else {
    out = inflateBounded(packed, entry.size)
  }
  if (out.length !== entry.size) throw new WordRefusalError('damaged')
  if (crc32(out) !== entry.crc32) throw new WordRefusalError('damaged')
  return out
}

/** Inflate in small chunks so a few kilobytes of input can never ask for gigabytes at once. */
function inflateBounded(packed: Uint8Array, declared: number): Uint8Array {
  if (declared === 0 && packed.length === 0) return new Uint8Array(0)
  const out = new Uint8Array(declared)
  let written = 0
  let finished = false
  let overrun = false
  const inflater = new Inflate((chunk, final) => {
    if (written + chunk.length > declared) {
      overrun = true
      return
    }
    out.set(chunk, written)
    written += chunk.length
    if (final) finished = true
  })
  const CHUNK = 4096
  try {
    for (let i = 0; i < packed.length && !overrun && !finished; i += CHUNK) {
      inflater.push(packed.subarray(i, Math.min(i + CHUNK, packed.length)), i + CHUNK >= packed.length)
    }
  } catch {
    throw new WordRefusalError(overrun ? 'zip-bomb' : 'damaged')
  }
  if (overrun) throw new WordRefusalError('zip-bomb')
  if (!finished) throw new WordRefusalError('damaged')
  return out
}
