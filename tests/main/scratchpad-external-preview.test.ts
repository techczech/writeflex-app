import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'
import { checkExternalAsset, searchResultPreviewDataUri } from '../../src/main/scratchpad-external'

// The bounded search-result thumbnail (defect: a valid 788,425-byte PNG showed no preview).
// A checked picture over the small-preview cap gets a memory-only thumbnail within the same
// stored-size cap and a 480px edge; the original bytes/hash are never touched, an input over
// the pixel bound or an undecodable one honestly gets no preview (the metadata tile shows).

const PREVIEW_MAX_BYTES = 192 * 1024
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const decode = (dataUri: string): Buffer => Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64')

/** The proven synthetic repro bytes: 512×512 of deterministic noise, so PNG cannot shrink them. */
async function largePng(): Promise<Buffer> {
  const pixels = Buffer.alloc(512 * 512 * 3)
  let state = 0x5ac12
  for (let i = 0; i < pixels.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state >>> 24 }
  return sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()
}

test('a valid large PNG gets a bounded webp thumbnail and its bytes are untouched', async () => {
  const bytes = await largePng()
  expect(bytes.length).toBeGreaterThan(PREVIEW_MAX_BYTES)
  const digest = sha(bytes)
  const checked = checkExternalAsset('synthetic-large.png', bytes)
  expect(checked.ok).toBe(true)
  expect(checked.ok && checked.kind === 'pic' && checked.previewDataUri).toBeUndefined()

  const preview = await searchResultPreviewDataUri('synthetic-large.png', bytes, checked)
  expect(preview).toStartWith('data:image/webp;base64,')
  const thumb = decode(preview!)
  expect(thumb.length).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)
  const meta = await sharp(thumb).metadata()
  expect(meta.format).toBe('webp')
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(480)
  expect(sha(bytes)).toBe(digest)
})

test('an already-small picture keeps the original-bytes preview, exactly as before', async () => {
  const small = await sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer()
  const checked = checkExternalAsset('small.png', small)
  expect(checked.ok && checked.kind === 'pic' && checked.previewDataUri).toBe(`data:image/png;base64,${small.toString('base64')}`)
  expect(await searchResultPreviewDataUri('small.png', small, checked)).toBe(checked.ok && checked.kind === 'pic' ? checked.previewDataUri : undefined)
})

test('a large SVG is thumbnailed from the sanitised markup, within the same bounds', async () => {
  const rects = Array.from({ length: 4000 }, (_, i) => `<rect x="${i % 80}" y="${Math.floor(i / 80) % 40}" width="1" height="1" fill="#80ac91"/>`).join('')
  const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">${rects}</svg>`, 'utf8')
  expect(bytes.length).toBeGreaterThan(PREVIEW_MAX_BYTES)
  const checked = checkExternalAsset('big.svg', bytes)
  expect(checked.ok).toBe(true)
  const preview = await searchResultPreviewDataUri('big.svg', bytes, checked)
  expect(preview).toStartWith('data:image/webp;base64,')
  expect(decode(preview!).length).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)
})

test('no thumbnail for an unchecked, incompatible or widget result', async () => {
  const notAPicture = Buffer.alloc(PREVIEW_MAX_BYTES + 1, 7)
  const bad = checkExternalAsset('fake.png', notAPicture)
  expect(bad.ok).toBe(false)
  expect(await searchResultPreviewDataUri('fake.png', notAPicture, bad)).toBeUndefined()
  const widget = checkExternalAsset('page.html', Buffer.from('<!doctype html><html><head><title>T</title></head><body>x</body></html>'))
  expect(await searchResultPreviewDataUri('page.html', Buffer.alloc(0), widget)).toBeUndefined()
})

/** A PNG whose header claims 120 megapixels: refused on the pixel bound without a full decode. */
function hugeHeaderPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const idat = deflateSync(Buffer.alloc(64))
  // Pad past the small-preview cap so the thumbnail path is the one under test.
  const filler = chunk('tEXt', Buffer.alloc(PREVIEW_MAX_BYTES, 65))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), filler, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ])
}

test('an input over the pixel bound gets no preview rather than a huge decode', async () => {
  const bytes = hugeHeaderPng(20_000, 6_000) // 120,000,000 pixels > the 100,000,000 bound
  const checked = checkExternalAsset('huge.png', bytes)
  expect(checked.ok).toBe(true) // magic bytes pass the type check; the bound is the thumbnail's job
  // Control: the decoder accepts this header without the pixel cap, so a corrupt CRC is not
  // what makes the thumbnail disappear. Metadata needs no full 120-megapixel raster allocation.
  const metadata = await sharp(bytes, { limitInputPixels: false }).metadata()
  expect([metadata.width, metadata.height]).toEqual([20_000, 6_000])
  await expect(sharp(bytes, { limitInputPixels: 100_000_000 }).metadata()).rejects.toThrow(/pixel limit/i)
  expect(await searchResultPreviewDataUri('huge.png', bytes, checked)).toBeUndefined()
})
