/**
 * The read-only TalkWeaver adapter (ticket 05). It reads TalkWeaver's app config
 * (`<userData>/config.json`, the `vaults` slice its VaultRegistry owns) as BYTES and parses
 * the registry's stored shape itself — it never constructs TalkWeaver's registry, whose load
 * path migrates and WRITES that config, and it never writes anything in a vault. A vault's
 * display name comes from its own `.talkweaver/vault.json` when that file's id matches the
 * registry's; a mismatch makes the vault unavailable here, exactly as TalkWeaver refuses it.
 *
 * What a vault actually offers (inspected in TalkWeaver source, vault-pictures.ts): a picture
 * pool at `_assets/img-<hex>.(webp|png|jpg|jpeg|gif)` with flat-YAML sidecars, and each talk's
 * own `<talk>/assets/` folder, where SVG and HTML files live beside its pictures. There is no
 * vault table catalogue, so tables are honestly absent from this source. Browsing is bounded:
 * the pool folder and one `assets/` level per top-level talk folder, capped counts throughout,
 * every component walked without following a link, and every result's bytes read once through
 * the contained no-follow reader so the shown version is the checked version.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { readContainedFile, walkNoFollowSync } from './widget-file'
import { scratchpadSourceHome } from './scratchpad-source-home'

export type TalkweaverVault = { id: string; root: string; open: boolean; order: number }
export type TalkweaverVaultInfo = {
  vault: TalkweaverVault
  /** The vault file's name, or the folder's name when it has no readable vault file. */
  name: string
  /** The vault root by its real path (the authority every contained read is made under). */
  realRoot: string | null
  /** Why this vault cannot be browsed now, or null when it can. */
  unavailable: string | null
}

export type TalkweaverDiscovery =
  | { state: 'found'; vaults: TalkweaverVaultInfo[] }
  | { state: 'absent'; reason: string }

export type TalkweaverCandidate = {
  vaultId: string
  vaultName: string
  /** Vault-relative, `/` separators: `_assets/img-….png` or `<talk>/assets/<file>`. */
  relPath: string
  fileName: string
  ext: string
  title: string
  detail: string
  mtimeMs: number
}

/** The largest source asset the Scratchpad will carry at all; larger files are named, not read. */
export const EXTERNAL_ASSET_MAX_BYTES = 32 * 1024 * 1024
const CONFIG_MAX_BYTES = 4 * 1024 * 1024
const VAULT_FILE_MAX_BYTES = 1024 * 1024
const SIDECAR_MAX_BYTES = 64 * 1024
const MAX_VAULTS = 50
const MAX_TALK_FOLDERS = 300
const MAX_FILES_PER_FOLDER = 500
const MAX_SCANNED_FILES = 5000

const POOL_NAME = /^(img-[0-9a-f]{7,})\.(webp|png|jpe?g|gif)$/i
const TALK_ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html', 'htm'])
const VAULT_ID = /^[A-Za-z0-9_:-]{1,200}$/

/** TalkWeaver's user-data folders (its packaged name, then its package name in dev). */
export function talkweaverUserDataDirs(home: string): string[] {
  const support = join(home, 'Library', 'Application Support')
  return [join(support, 'TalkWeaver'), join(support, 'talk-weaver')]
}

const sha256Hex = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The vault list as TalkWeaver's registry STORES it, sanitised the way its own `sanitize`
 * does (unique ids, open defaults true, renumbered by order). A config that still carries
 * only the legacy `vaultRoot` mirror (its registry never ran a multi-vault build) reads as
 * one open vault with a DETERMINISTIC synthetic id: TalkWeaver's own migration would mint a
 * random id and write it back, which a read-only adapter must never do.
 */
export function parseTalkweaverVaults(configText: string): TalkweaverVault[] | null {
  let raw: unknown
  try { raw = JSON.parse(configText) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const config = raw as { vaults?: unknown; vaultRoot?: unknown; vaultRootMirrored?: unknown }
  const out: TalkweaverVault[] = []
  const seen = new Set<string>()
  if (Array.isArray(config.vaults)) {
    config.vaults.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || out.length >= MAX_VAULTS) return
      const v = entry as { id?: unknown; root?: unknown; open?: unknown; order?: unknown }
      if (typeof v.id !== 'string' || !VAULT_ID.test(v.id) || typeof v.root !== 'string' || v.root === '' || !v.root.startsWith('/') || seen.has(v.id)) return
      seen.add(v.id)
      out.push({ id: v.id, root: v.root, open: v.open !== false, order: typeof v.order === 'number' && Number.isFinite(v.order) ? v.order : index })
    })
  }
  const legacy = typeof config.vaultRoot === 'string' && config.vaultRoot.trim() !== '' && config.vaultRoot.startsWith('/') ? config.vaultRoot : null
  if (legacy && legacy !== config.vaultRootMirrored && !out.some((v) => v.root === legacy)) {
    out.unshift({ id: `legacy:${sha256Hex(legacy).slice(0, 16)}`, root: legacy, open: true, order: -1 })
  }
  return out
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.order - b.v.order || a.i - b.i)
    .map(({ v }, order) => ({ ...v, order }))
}

/** A picture sidecar (`_assets/<id>.yml`): TalkWeaver's flat YAML, hand-parsed as it parses it. */
export function parseTalkweaverSidecar(text: string): { alt: string; caption: string; source: string; tags: string[] } {
  const out = { alt: '', caption: '', source: '', tags: [] as string[] }
  const lines = text.split('\n')
  const unquote = (s: string): string => s.replace(/^["']|["']$/g, '')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    const rawValue = m[2]
    if (key === 'tags') {
      const inline = rawValue.trim()
      if (inline.startsWith('[')) {
        out.tags = inline.replace(/^\[|\]$/g, '').split(',').map((t) => unquote(t.trim())).filter(Boolean).slice(0, 50)
      } else if (inline === '' || inline === '|') {
        const tags: string[] = []
        for (let j = i + 1; j < lines.length && tags.length < 50; j += 1) {
          const item = /^\s*-\s+(.*)$/.exec(lines[j])
          if (!item) break
          tags.push(unquote(item[1].trim()))
        }
        out.tags = tags
      }
      continue
    }
    const value = unquote(rawValue.trim()).slice(0, 2000)
    if (key === 'alt') out.alt = value
    else if (key === 'caption') out.caption = value
    else if (key === 'source') out.source = value
  }
  return out
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
/** TalkWeaver's own matching rule: every query word must start a word of the haystack. */
const matchesWords = (haystack: string, terms: readonly string[]): boolean => {
  if (terms.length === 0) return true
  const hay = wordsOf(haystack)
  return terms.every((term) => hay.some((word) => word.startsWith(term)))
}

function plainDirNames(realRoot: string, rel: string): string[] {
  // `rel` '' is the root itself (already realpathed and judged a directory by discovery).
  if (rel !== '' && walkNoFollowSync(realRoot, rel).kind !== 'directory') return []
  try {
    return readdirSync(rel === '' ? realRoot : join(realRoot, ...rel.split('/'))).slice(0, MAX_FILES_PER_FOLDER * 4)
  } catch { return [] }
}

function plainFileMtime(realRoot: string, rel: string): number | null {
  if (walkNoFollowSync(realRoot, rel).kind !== 'file') return null
  try { return lstatSync(join(realRoot, ...rel.split('/'))).mtimeMs } catch { return null }
}

export class TalkweaverAdapter {
  readonly home: string

  constructor(options: { home?: string } = {}) {
    this.home = options.home ?? scratchpadSourceHome()
  }

  /**
   * TalkWeaver's vaults as they stand NOW: its config read fresh (never cached across a
   * settings change, never written), each vault's folder and vault file judged. Called only
   * while the TalkWeaver connection is enabled — the service owns that gate.
   */
  async discover(): Promise<TalkweaverDiscovery> {
    let configText: string | null = null
    let sawConfigDir = false
    for (const dir of talkweaverUserDataDirs(this.home)) {
      let dirReal: string
      try { dirReal = await realpath(dir) } catch { continue }
      sawConfigDir = true
      const read = await readContainedFile(dirReal, 'config.json', CONFIG_MAX_BYTES)
      if (read.ok) { configText = read.bytes.toString('utf8'); break }
    }
    if (configText === null) {
      return { state: 'absent', reason: sawConfigDir ? 'TalkWeaver’s settings could not be read on this Mac.' : 'TalkWeaver was not found on this Mac.' }
    }
    const vaults = parseTalkweaverVaults(configText)
    if (vaults === null) return { state: 'absent', reason: 'TalkWeaver’s settings could not be read on this Mac.' }
    if (vaults.length === 0) return { state: 'absent', reason: 'TalkWeaver has no vaults on this Mac yet.' }
    const infos: TalkweaverVaultInfo[] = []
    for (const vault of vaults) infos.push(await this.#vaultInfo(vault))
    return { state: 'found', vaults: infos }
  }

  async #vaultInfo(vault: TalkweaverVault): Promise<TalkweaverVaultInfo> {
    const fallbackName = basename(vault.root) || vault.id
    let realRoot: string
    try {
      realRoot = await realpath(vault.root)
      if (!lstatSync(realRoot).isDirectory()) throw new Error('not a folder')
    } catch {
      return { vault, name: fallbackName, realRoot: null, unavailable: 'Its folder is not there.' }
    }
    let name = fallbackName
    const file = await readContainedFile(realRoot, '.talkweaver/vault.json', VAULT_FILE_MAX_BYTES)
    if (file.ok) {
      let parsed: { id?: unknown; name?: unknown } | null = null
      try { parsed = JSON.parse(file.bytes.toString('utf8')) as { id?: unknown; name?: unknown } } catch { parsed = null }
      if (parsed && typeof parsed.id === 'string' && parsed.id !== '' && parsed.id !== vault.id && !vault.id.startsWith('legacy:')) {
        return { vault, name: fallbackName, realRoot, unavailable: 'This folder now holds another vault’s file, so it is left as it is.' }
      }
      if (parsed && typeof parsed.name === 'string' && parsed.name.trim() !== '') name = parsed.name.trim().slice(0, 200)
    }
    return { vault, name, realRoot, unavailable: null }
  }

  /** The browsable candidates of one vault, bounded and link-free, newest first. */
  async candidates(info: TalkweaverVaultInfo, query: string): Promise<TalkweaverCandidate[]> {
    if (!info.realRoot || info.unavailable) return []
    const realRoot = info.realRoot
    const terms = wordsOf(query.slice(0, 200))
    const out: TalkweaverCandidate[] = []
    let scanned = 0
    // The picture pool, with its sidecars (TalkWeaver's search text).
    for (const name of plainDirNames(realRoot, '_assets')) {
      if (scanned >= MAX_SCANNED_FILES) break
      const pool = POOL_NAME.exec(name)
      if (!pool) continue
      scanned += 1
      const relPath = `_assets/${name}`
      const mtimeMs = plainFileMtime(realRoot, relPath)
      if (mtimeMs === null) continue
      const sidecarRead = await readContainedFile(realRoot, `_assets/${name.slice(0, name.length - pool[2].length - 1)}.yml`, SIDECAR_MAX_BYTES)
      const sidecar = sidecarRead.ok ? parseTalkweaverSidecar(sidecarRead.bytes.toString('utf8')) : null
      const title = sidecar?.caption.trim() || sidecar?.alt.trim() || name
      const haystack = [sidecar?.caption, sidecar?.alt, ...(sidecar?.tags ?? []), name].filter(Boolean).join(' ')
      if (!matchesWords(haystack, terms)) continue
      out.push({
        vaultId: info.vault.id, vaultName: info.name, relPath, fileName: name, ext: pool[2].toLowerCase(),
        title, detail: [sidecar?.tags.length ? sidecar.tags.join(', ') : '', 'picture pool'].filter(Boolean).join(' · '), mtimeMs,
      })
    }
    // Each talk's own assets folder: pictures, SVG files and HTML widgets, by name.
    const talkFolders = plainDirNames(realRoot, '')
      .filter((name) => !name.startsWith('.') && name !== '_assets' && walkNoFollowSync(realRoot, name).kind === 'directory')
      .slice(0, MAX_TALK_FOLDERS)
    for (const talk of talkFolders) {
      if (scanned >= MAX_SCANNED_FILES) break
      for (const name of plainDirNames(realRoot, `${talk}/assets`).slice(0, MAX_FILES_PER_FOLDER)) {
        if (scanned >= MAX_SCANNED_FILES) break
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
        if (!TALK_ASSET_EXTS.has(ext) || name.startsWith('.')) continue
        scanned += 1
        const relPath = `${talk}/assets/${name}`
        const mtimeMs = plainFileMtime(realRoot, relPath)
        if (mtimeMs === null) continue
        if (!matchesWords(`${name} ${talk}`, terms)) continue
        out.push({
          vaultId: info.vault.id, vaultName: info.name, relPath, fileName: name, ext,
          title: name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || name,
          detail: `Talk: ${talk}`, mtimeMs,
        })
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.relPath < b.relPath ? -1 : 1))
  }

  /** How much browsing found in a vault, in words — Settings' vault note. One bounded listing. */
  countNote(info: TalkweaverVaultInfo): string {
    if (info.unavailable) return info.unavailable
    if (!info.realRoot) return 'Its folder is not there.'
    const pool = plainDirNames(info.realRoot, '_assets').filter((name) => POOL_NAME.test(name)).length
    return pool === 1 ? '1 pooled picture, and its talks’ own assets' : `${pool} pooled pictures, and its talks’ own assets`
  }

  /**
   * The checked bytes behind one vault-relative path, re-derived from a FRESH discovery: the
   * vault must still be TalkWeaver's, at the same root, and the file a plain contained file.
   * The descriptor the walk found is the file read (no lstat-then-read adoption).
   */
  async readChecked(vaultId: string, relPath: string): Promise<{ ok: true; bytes: Buffer; vaultName: string } | { ok: false; error: string }> {
    const rel = talkweaverRelPath(relPath)
    if (!rel) return { ok: false, error: 'That TalkWeaver file cannot be read safely.' }
    const discovery = await this.discover()
    if (discovery.state === 'absent') return { ok: false, error: discovery.reason }
    const info = discovery.vaults.find((entry) => entry.vault.id === vaultId)
    if (!info) return { ok: false, error: 'That vault is not in TalkWeaver any more.' }
    if (!info.realRoot || info.unavailable) return { ok: false, error: `The vault ${info.name} cannot be read now: ${info.unavailable ?? 'its folder is not there.'}` }
    const read = await readContainedFile(info.realRoot, rel, EXTERNAL_ASSET_MAX_BYTES)
    if (!read.ok) {
      return { ok: false, error: read.reason === 'missing' ? 'That file is not in the vault any more.' : read.reason === 'too-large' ? 'That file is too large for the Scratchpad.' : 'That TalkWeaver file cannot be read safely (it may have been replaced by a link).' }
    }
    return { ok: true, bytes: read.bytes, vaultName: info.name }
  }
}

/** A vault-relative path this adapter will ever read: the pool, or one talk's `assets/` file. */
export function talkweaverRelPath(relPath: unknown): string | null {
  if (typeof relPath !== 'string' || relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) return null
  const normal = posix.normalize(relPath)
  if (normal !== relPath || normal.startsWith('../') || normal === '..') return null
  const parts = normal.split('/')
  if (parts.length === 2 && parts[0] === '_assets' && POOL_NAME.test(parts[1])) return normal
  if (parts.length === 3 && parts[1] === 'assets' && !parts[0].startsWith('.') && !parts[2].startsWith('.')) {
    const ext = parts[2].includes('.') ? parts[2].slice(parts[2].lastIndexOf('.') + 1).toLowerCase() : ''
    if (TALK_ASSET_EXTS.has(ext)) return normal
  }
  return null
}

/** `vault:<vaultId>:<relPath>` — the provider identity a collected candidate keeps. */
export const talkweaverProviderId = (vaultId: string, relPath: string): string => `vault:${vaultId}:${relPath}`

export function parseTalkweaverProviderId(providerId: string): { vaultId: string; relPath: string } | null {
  if (!providerId.startsWith('vault:')) return null
  const rest = providerId.slice('vault:'.length)
  // A legacy synthetic id itself contains ':' (`legacy:<hex>`), so the split is the first
  // colon whose suffix is a readable vault-relative path and whose prefix is a vault id.
  for (let split = rest.indexOf(':'); split > 0; split = rest.indexOf(':', split + 1)) {
    const vaultId = rest.slice(0, split)
    const relPath = talkweaverRelPath(rest.slice(split + 1))
    if (VAULT_ID.test(vaultId) && relPath) return { vaultId, relPath }
  }
  return null
}
