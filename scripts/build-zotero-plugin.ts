/**
 * Build the WriteFlex plugin for Zotero: `zotero-plugin/dist/writeflex-zotero-<version>.xpi`.
 *
 * An xpi is a zip with `manifest.json` at its root. Its two files are stored uncompressed with a
 * fixed timestamp, so the same sources always give the same bytes. The app bundles the result
 * (electron-builder `extraResources`) so WriteFlex can show him the file to install in Zotero.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'zotero-plugin')

/** Sources, root-relative name → path. The xpi holds `manifest.json` and one bundled `bootstrap.js`. */
export function pluginFiles(directory = pluginDirectory): Array<{ name: string; path: string }> {
  return [
    { name: 'manifest.json', path: join(directory, 'manifest.json') },
    { name: 'writeflex-bridge.js', path: join(directory, 'src', 'writeflex-bridge.js') },
    { name: 'bootstrap.js', path: join(directory, 'src', 'bootstrap.js') },
  ]
}

/**
 * The xpi's `bootstrap.js`: the logic (`writeflex-bridge.js`, defining `WriteFlexZotero`) followed by
 * the lifecycle, in one file. Zotero loads `bootstrap.js` itself; nothing is loaded at run time, so
 * Gecko's refusal of `jar:file:` URLs in the plain subscript loader never comes into it.
 */
export function bundledBootstrap(directory = pluginDirectory): string {
  const bridge = readFileSync(join(directory, 'src', 'writeflex-bridge.js'), 'utf8')
  const lifecycle = readFileSync(join(directory, 'src', 'bootstrap.js'), 'utf8')
  return `// Built by scripts/build-zotero-plugin.ts from zotero-plugin/src. Do not edit.\n${bridge}\n${lifecycle}`
}

/** The xpi's entries, in order. */
export function xpiEntries(directory = pluginDirectory): Array<{ name: string; data: Uint8Array }> {
  return [
    { data: readFileSync(join(directory, 'manifest.json')), name: 'manifest.json' },
    { data: Buffer.from(bundledBootstrap(directory), 'utf8'), name: 'bootstrap.js' },
  ]
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 1 January 2026, 00:00, in MS-DOS date/time form. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

/** A zip archive of `entries`, every entry stored (method 0). */
export function storedZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, Buffer.from(entry.data))
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + entry.data.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

export function pluginVersion(directory = pluginDirectory): string {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('zotero-plugin/manifest.json has no plain x.y.z version')
  }
  return manifest.version
}

export function buildZoteroPlugin(directory = pluginDirectory): string {
  const version = pluginVersion(directory)
  const output = join(directory, 'dist')
  // Only the current version ships: an older xpi left beside it would be bundled too.
  rmSync(output, { force: true, recursive: true })
  mkdirSync(output, { recursive: true })
  const target = join(output, `writeflex-zotero-${version}.xpi`)
  writeFileSync(target, storedZip(xpiEntries(directory)))
  return target
}

if (import.meta.main) {
  const target = buildZoteroPlugin()
  console.log(`Built ${target} (${readdirSync(dirname(target)).length} file in dist)`)
}
