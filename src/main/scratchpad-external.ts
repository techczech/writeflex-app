/**
 * The Scratchpad's optional source connections (ticket 05): TalkWeaver vaults and SlideWell,
 * each behind its own Settings switch, both off by default. This service is the ONE main-process
 * authority for them:
 *
 *   - While a switch is off, its adapter is never called — no registry, config, catalogue,
 *     database or socket read happens for it anywhere (status answers `off` from the switch
 *     alone). The gate is re-read at every step, and a settings change bumps the source's
 *     epoch: outstanding result handles die at once and an in-flight discovery/search/collect/
 *     import refuses rather than completing after the switch went off.
 *   - Search issues opaque handles bound to (source, epoch, provider identity, the shown
 *     version's checked digest). The renderer and the agent hold only the handle; no path,
 *     root or provider can be forged through it. Collecting stores the pointer plus a small
 *     preview — no asset bytes enter the workspace.
 *   - Insertion copies ONLY the selected checked bytes, after revalidating the pointer, the
 *     digest, the still-enabled switch and the destination: exclusively (never an overwrite)
 *     into the receiving document's `assets/`, through the same no-follow, same-tick writer
 *     discipline as `widgets.create` (which it reuses for HTML widgets). The copy is recorded
 *     on the candidate with its provenance; a later insert reuses that local copy only after
 *     a checked read proves it is still the shown bytes. Sources are never written.
 *   - Agent proposals never copy during staging: `planImport` binds the shown source version
 *     and a planned exclusive destination without writing; only Accept runs `importPlanned`.
 *
 * Widget pages keep WriteFlex's sandbox exactly: the compatibility check runs on the exact
 * bytes that would run or be copied, a page the check would change (a missing title it would
 * add) or refuse is shown as incompatible instead of silently rewritten, and Run stays a
 * sealed, on-request preview of the checked bytes. SVG files must pass the app's one SVG
 * sanitiser before they are shown or copied.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import type { SqliteDriver } from '@readflex/sqlite-driver'
import type { Workspace } from './workspace'
import { isHiddenWorkspacePath } from './workspace'
import type { ScratchpadStore } from './scratchpad-store'
import { TalkweaverAdapter, parseTalkweaverProviderId, talkweaverProviderId, EXTERNAL_ASSET_MAX_BYTES, type TalkweaverCandidate } from './scratchpad-talkweaver'
import { SlideWellAdapter, parseSlideWellProviderId, type SlideWellCandidate, type SlideWellLocation } from './scratchpad-slidewell'
import { OPEN_NOFOLLOW, readContainedFile, walkNoFollow, walkNoFollowSync } from './widget-file'
import { checkWidgetHtml, planWidgetFile, undoWidgetFile, writeWidgetFile, type CreatedWidgetFile } from './widget-create'
import { pausedMessage } from './collection-write-gate'
import { sanitiseSvg } from '../shared/sanitise-svg'
import { widgetPageTitle } from '../shared/widget-document'
import { relativeEmbedPath } from '../shared/widget-insert'
import {
  SCRATCHPAD_SLIDEWELL_KEY, SCRATCHPAD_TALKWEAVER_KEY, SCRATCHPAD_TALKWEAVER_VAULTS_KEY,
  chosenTalkweaverVaults, scratchpadSourceEnabled, type ScratchExternalSourceId,
} from '../shared/scratchpad-source-settings'
import type { ScratchExternalRef, ScratchExternalResult, ScratchExternalStatus, ScratchItem } from '../shared/scratchpad-items'

export type { ScratchExternalSourceId }

/** The three settings values this service reads, by key, fresh at every step. */
export type ScratchExternalSettings = { get(key: string): string | number | boolean | null }

const PREVIEW_MAX_BYTES = 192 * 1024
/** A generated thumbnail's longest edge, and the most source pixels one may decode. */
const THUMB_MAX_EDGE = 480
const THUMB_MAX_INPUT_PIXELS = 100_000_000
const HANDLE_TTL_MS = 10 * 60 * 1000
const MAX_HANDLES = 500
const MAX_RESULTS = 120
const ASSETS_DIR = 'assets'
const RASTER_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])
/** Picture types WriteFlex documents can keep (validateScratchAsset's own list, plus SVG files). */
const KEEPABLE_PIC_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'])

const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const dirOf = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))

/** The image format the leading bytes announce, or null — TalkWeaver's image-file rule. */
export function imageMagic(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 6 && (bytes.toString('latin1', 0, 6) === 'GIF87a' || bytes.toString('latin1', 0, 6) === 'GIF89a')) return 'gif'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') return 'avif-or-heic'
  return null
}

type CheckedAsset =
  | { ok: true; kind: 'pic'; previewDataUri?: string }
  | { ok: true; kind: 'widget'; html: string }
  | { ok: false; kind: 'pic' | 'widget'; incompatible: string; previewDataUri?: string }

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' }

/**
 * Judge the exact bytes a result would show, run and copy. A raster must be a keepable picture
 * type with picture bytes; an SVG file must pass the one sanitiser; an HTML page must pass the
 * widget compatibility check UNCHANGED (a page the check would rewrite is incompatible, never
 * silently rewritten — its source stays readable, as the design says).
 */
export function checkExternalAsset(fileName: string, bytes: Buffer): CheckedAsset {
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'html' || ext === 'htm') {
    // The writer writes .html; a .htm page is shown but cannot be copied under WriteFlex's one name rule.
    const text = bytes.toString('utf8')
    const checked = checkWidgetHtml(text, null)
    if (!checked.ok) return { ok: false, kind: 'widget', incompatible: `Needs checking: ${checked.message}` }
    if (checked.html !== text) return { ok: false, kind: 'widget', incompatible: 'Needs checking: this page has no title of its own, and WriteFlex does not rewrite a source page. Its source is kept as it is.' }
    if (ext === 'htm') return { ok: false, kind: 'widget', incompatible: 'Needs checking: WriteFlex widgets are .html files, so this .htm page cannot be copied in as it stands.' }
    return { ok: true, kind: 'widget', html: checked.html }
  }
  if (!KEEPABLE_PIC_EXTS.has(ext)) {
    return { ok: false, kind: 'pic', incompatible: `Needs checking: WriteFlex documents cannot keep a .${ext || '?'} picture, so this one cannot be inserted.` }
  }
  if (ext === 'svg') {
    const checked = sanitiseSvg(bytes.toString('utf8'))
    if ('error' in checked) return { ok: false, kind: 'pic', incompatible: `Needs checking: ${checked.error}` }
    return { ok: true, kind: 'pic', ...(bytes.length <= PREVIEW_MAX_BYTES ? { previewDataUri: `data:image/svg+xml;base64,${Buffer.from(checked.svg, 'utf8').toString('base64')}` } : {}) }
  }
  if (RASTER_EXTS.has(ext) && !imageMagic(bytes)) {
    return { ok: false, kind: 'pic', incompatible: 'Needs checking: this file’s bytes are not a picture, so it cannot be inserted.' }
  }
  return { ok: true, kind: 'pic', ...(bytes.length <= PREVIEW_MAX_BYTES && MIME[ext] ? { previewDataUri: `data:${MIME[ext]};base64,${bytes.toString('base64')}` } : {}) }
}

/**
 * One memory-only bounded thumbnail of already-checked picture bytes (TalkWeaver's
 * instant-image pattern, WriteFlex's own bounds): the input's pixel count is bounded before
 * and during decode, the output fits `THUMB_MAX_EDGE` and never exceeds the same stored-size
 * cap a small original preview obeys. No filesystem, no network; any failure is `undefined`
 * and the caller shows its honest metadata tile instead. The source bytes are never touched —
 * collecting stays pointer-only and insertion still copies the exact original.
 */
async function thumbnailDataUri(input: Buffer): Promise<string | undefined> {
  try {
    const { default: sharp } = await import('sharp')
    const source = sharp(input, { limitInputPixels: THUMB_MAX_INPUT_PIXELS })
    const metadata = await source.metadata()
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > THUMB_MAX_INPUT_PIXELS) return undefined
    for (const edge of [THUMB_MAX_EDGE, 320, 192]) {
      for (const quality of [72, 48]) {
        const { data, info } = await source.clone()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toBuffer({ resolveWithObject: true })
        if (info.width > THUMB_MAX_EDGE || info.height > THUMB_MAX_EDGE) return undefined
        if (data.length <= PREVIEW_MAX_BYTES) return `data:image/webp;base64,${data.toString('base64')}`
      }
    }
  } catch { /* undecodable or over the pixel bound: the metadata tile is the honest preview */ }
  return undefined
}

/**
 * The preview a search result carries: a small original keeps `checkExternalAsset`'s own
 * data URI; a checked picture over that cap gets a bounded generated thumbnail instead of
 * none. SVG reaches native decoding only as the sanitiser's output, never as source bytes.
 */
export async function searchResultPreviewDataUri(fileName: string, bytes: Buffer, checked: CheckedAsset): Promise<string | undefined> {
  if (!checked.ok || checked.kind !== 'pic') return undefined
  if (checked.previewDataUri) return checked.previewDataUri
  if (bytes.length <= PREVIEW_MAX_BYTES) return undefined
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'svg') {
    const sanitised = sanitiseSvg(bytes.toString('utf8'))
    if ('error' in sanitised) return undefined
    return thumbnailDataUri(Buffer.from(sanitised.svg, 'utf8'))
  }
  if (!RASTER_EXTS.has(ext)) return undefined
  return thumbnailDataUri(bytes)
}

/** A plain asset file name from a source name: lower-case, hyphenated, extension kept. */
export function importedFileName(fileName: string, ordinal = 1): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = fileName.slice(dot + 1).toLowerCase()
  if (!KEEPABLE_PIC_EXTS.has(ext)) return null
  const suffix = ordinal > 1 ? `-${ordinal}` : ''
  const clean = fileName.slice(0, dot).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const stem = (clean || 'picture').slice(0, 60 - suffix.length).replace(/-+$/g, '') || 'picture'
  return `${stem}${suffix}.${ext}`
}

type IssuedHandle = {
  source: ScratchExternalSourceId
  epoch: number
  providerId: string
  kind: 'pic' | 'widget'
  fileName: string
  title: string
  provenance: string
  detail?: string
  sha256: string
  bytes: number
  score?: number
  incompatible?: string
  previewDataUri?: string
  expiresAt: number
}

/** The plan an agent proposal binds (no writes) and Accept alone carries out. */
export type ExternalImportPlan = {
  /** Workspace-relative destination asset (planned exclusive, or the recorded local copy). */
  path: string
  /** SHA-256 of the shown source version the plan is bound to. */
  sha256: string
  /** True when the plan reuses the candidate's already-recorded local copy. */
  reuse: boolean
  /** The provider identity as collected, revalidated at Accept. */
  providerId: string
  source: ScratchExternalSourceId
}

export type ScratchExternalDeps = {
  settings: ScratchExternalSettings
  talkweaver?: TalkweaverAdapter
  slidewell?: SlideWellAdapter
  /** Lazy production driver (node:sqlite loads only when SlideWell is actually used). */
  sqliteDriver?: () => Promise<SqliteDriver>
  home?: string
  now?: () => number
  /** @internal Test seam: runs inside a search after discovery, before handles are issued. */
  seams?: { afterDiscovery?: (source: ScratchExternalSourceId) => Promise<void> | void }
}

const OFF = (source: ScratchExternalSourceId): ScratchExternalStatus => ({ source, state: 'off' })

export class ScratchpadExternalSources {
  readonly #settings: ScratchExternalSettings
  readonly #talkweaver: TalkweaverAdapter
  #slidewell: SlideWellAdapter | null
  readonly #makeSlidewell: (() => Promise<SlideWellAdapter>) | null
  readonly #now: () => number
  readonly #seams: ScratchExternalDeps['seams']
  #epochs: Record<ScratchExternalSourceId, number> = { talkweaver: 0, slidewell: 0 }
  #handles = new Map<string, IssuedHandle>()

  constructor(deps: ScratchExternalDeps) {
    this.#settings = deps.settings
    this.#talkweaver = deps.talkweaver ?? new TalkweaverAdapter(deps.home ? { home: deps.home } : {})
    this.#slidewell = deps.slidewell ?? null
    this.#makeSlidewell = deps.slidewell ? null : async () => {
      // Loaded only when SlideWell is actually used: the node driver's `node:sqlite` must
      // not become a load-time dependency of every module that imports this service
      // (the same lazy shape as pictures.ts's sharp import).
      const driver = deps.sqliteDriver
        ? await deps.sqliteDriver()
        : (await import('@readflex/sqlite-driver/node')).createNodeSqliteDriver()
      return new SlideWellAdapter({ ...(deps.home ? { home: deps.home } : {}), driver: () => driver })
    }
    this.#now = deps.now ?? Date.now
    this.#seams = deps.seams
  }

  enabled(source: ScratchExternalSourceId): boolean {
    return scratchpadSourceEnabled(this.#settings.get(source === 'talkweaver' ? SCRATCHPAD_TALKWEAVER_KEY : SCRATCHPAD_SLIDEWELL_KEY))
  }

  epoch(source: ScratchExternalSourceId): number {
    return this.#epochs[source]
  }

  /** A settings value changed (the app's settings store calls this for every key; only the
   *  three Scratchpad-source keys act). The source's handles die now, whatever the change. */
  noteSettingsChanged(key: string): void {
    if (key === SCRATCHPAD_TALKWEAVER_KEY || key === SCRATCHPAD_TALKWEAVER_VAULTS_KEY) this.#bump('talkweaver')
    if (key === SCRATCHPAD_SLIDEWELL_KEY) this.#bump('slidewell')
  }

  #bump(source: ScratchExternalSourceId): void {
    this.#epochs[source] += 1
    for (const [handle, issued] of this.#handles) if (issued.source === source) this.#handles.delete(handle)
  }

  /** The in-flight rule: still enabled, and the epoch this work started under still stands. */
  #stillAuthorised(source: ScratchExternalSourceId, epoch: number): boolean {
    return this.enabled(source) && this.#epochs[source] === epoch
  }

  async #slidewellAdapter(): Promise<SlideWellAdapter> {
    if (!this.#slidewell) this.#slidewell = await this.#makeSlidewell!()
    return this.#slidewell
  }

  /** The connection's state. Off is answered from the switch alone — zero adapter calls. */
  async status(source: ScratchExternalSourceId): Promise<ScratchExternalStatus> {
    if (!this.enabled(source)) return OFF(source)
    const epoch = this.epoch(source)
    if (source === 'talkweaver') {
      const discovery = await this.#talkweaver.discover()
      if (!this.#stillAuthorised(source, epoch)) return OFF(source)
      if (discovery.state === 'absent') return { source, state: 'unavailable', reason: discovery.reason, vaults: [], chosenVaults: [] }
      const chosen = chosenTalkweaverVaults(this.#settings.get(SCRATCHPAD_TALKWEAVER_VAULTS_KEY))
      const vaults = discovery.vaults.map((info) => ({
        id: info.vault.id,
        name: info.name,
        note: !info.vault.open ? 'Closed in TalkWeaver' : this.#talkweaver.countNote(info),
        available: info.vault.open && !info.unavailable && info.realRoot !== null,
      }))
      const chosenVaults = chosen.filter((id) => vaults.some((vault) => vault.id === id && vault.available))
      const anyAvailable = vaults.some((vault) => vault.available)
      return {
        source, state: anyAvailable ? 'connected' : 'unavailable',
        ...(anyAvailable ? {} : { reason: 'No TalkWeaver vault can be read on this Mac right now.' }),
        vaults, chosenVaults,
      }
    }
    const slidewell = await this.#slidewellAdapter()
    if (!this.#stillAuthorised(source, epoch)) return OFF(source)
    const location = await slidewell.locate()
    if (!this.#stillAuthorised(source, epoch)) return OFF(source)
    if (!location) return { source, state: 'unavailable', reason: 'SlideWell was not found on this Mac.', catalogue: false, semantic: false }
    const catalogue = await slidewell.catalogueReadable(location)
    if (!this.#stillAuthorised(source, epoch)) return OFF(source)
    const semantic = slidewell.semanticRunning(location)
    return {
      source,
      state: catalogue ? 'connected' : 'unavailable',
      ...(catalogue ? {} : { reason: 'SlideWell’s catalogue could not be read.' }),
      catalogue, semantic,
    }
  }

  /**
   * Search one enabled source and issue epoch-bound handles for the shown versions. Every
   * result's bytes are read checked once here (digest, type, compatibility, small preview);
   * a file that will not read contained, or is too large to carry, is left out rather than
   * shown on a promise. Throws the refusal's sentence.
   */
  async search(source: ScratchExternalSourceId, input: { query: string; vault?: string; mode?: 'words' | 'meaning' }): Promise<{ results: ScratchExternalResult[]; note?: string }> {
    if (!this.enabled(source)) throw new Error(`${source === 'talkweaver' ? 'TalkWeaver vaults are' : 'SlideWell is'} off in Settings › Scratchpad, so nothing was searched.`)
    const epoch = this.epoch(source)
    const query = typeof input.query === 'string' ? input.query.slice(0, 200) : ''
    const shown: Array<Omit<IssuedHandle, 'epoch' | 'expiresAt'>> = []
    let note: string | undefined
    if (source === 'talkweaver') {
      const discovery = await this.#talkweaver.discover()
      await this.#seams?.afterDiscovery?.(source)
      if (!this.#stillAuthorised(source, epoch)) throw new Error('TalkWeaver was turned off while it was being searched, so nothing was shown.')
      if (discovery.state === 'absent') throw new Error(discovery.reason)
      const chosen = chosenTalkweaverVaults(this.#settings.get(SCRATCHPAD_TALKWEAVER_VAULTS_KEY))
      const wanted = input.vault && input.vault !== 'all' ? chosen.filter((id) => id === input.vault) : chosen
      const infos = discovery.vaults.filter((info) => wanted.includes(info.vault.id) && info.vault.open && !info.unavailable && info.realRoot !== null)
      if (infos.length === 0) {
        return { results: [], note: chosen.length === 0 ? 'No vault is selected. Choose vaults in Settings.' : 'None of the chosen vaults can be read right now.' }
      }
      const candidates: TalkweaverCandidate[] = []
      for (const info of infos) candidates.push(...await this.#talkweaver.candidates(info, query))
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const candidate of candidates.slice(0, MAX_RESULTS)) {
        if (!this.#stillAuthorised(source, epoch)) throw new Error('TalkWeaver was turned off while it was being searched, so nothing was shown.')
        const read = await this.#talkweaver.readChecked(candidate.vaultId, candidate.relPath)
        if (!read.ok) continue
        const checked = checkExternalAsset(candidate.fileName, read.bytes)
        const previewDataUri = await searchResultPreviewDataUri(candidate.fileName, read.bytes, checked)
        if (!this.#stillAuthorised(source, epoch)) throw new Error('TalkWeaver was turned off while it was being searched, so nothing was shown.')
        shown.push({
          source, providerId: talkweaverProviderId(candidate.vaultId, candidate.relPath), kind: checked.kind,
          fileName: candidate.fileName, title: candidate.title,
          provenance: `TalkWeaver · ${candidate.vaultName}`,
          ...(candidate.detail ? { detail: candidate.detail } : {}),
          sha256: sha256Bytes(read.bytes), bytes: read.bytes.length,
          ...(checked.ok ? {} : { incompatible: checked.incompatible }),
          ...(previewDataUri ? { previewDataUri } : {}),
        })
      }
      const kinds = new Set(shown.map((entry) => entry.kind))
      if (!kinds.has('widget')) note = 'TalkWeaver vaults hold pictures and the SVG/HTML files in each talk’s assets; there is no vault table catalogue.'
    } else {
      const slidewell = await this.#slidewellAdapter()
      if (!this.#stillAuthorised(source, epoch)) throw new Error('SlideWell was turned off while it was being searched, so nothing was shown.')
      const location = await slidewell.locate()
      await this.#seams?.afterDiscovery?.(source)
      if (!this.#stillAuthorised(source, epoch)) throw new Error('SlideWell was turned off while it was being searched, so nothing was shown.')
      if (!location) throw new Error('SlideWell was not found on this Mac.')
      let candidates: SlideWellCandidate[]
      if (input.mode === 'meaning') {
        const result = await slidewell.searchMeaning(location, query)
        if (!this.#stillAuthorised(source, epoch)) throw new Error('SlideWell was turned off while it was being searched, so nothing was shown.')
        if ('refusal' in result) throw new Error(result.refusal)
        candidates = result.candidates
      } else {
        const found = await slidewell.searchWords(location, query)
        if (!this.#stillAuthorised(source, epoch)) throw new Error('SlideWell was turned off while it was being searched, so nothing was shown.')
        if (found === null) throw new Error('SlideWell’s catalogue could not be read.')
        candidates = found
      }
      for (const candidate of candidates.slice(0, MAX_RESULTS)) {
        if (!this.#stillAuthorised(source, epoch)) throw new Error('SlideWell was turned off while it was being searched, so nothing was shown.')
        const read = await slidewell.readChecked(location, candidate.providerId)
        if (!read.ok) continue
        const checked = checkExternalAsset(read.candidate.fileName, read.bytes)
        const previewDataUri = await searchResultPreviewDataUri(read.candidate.fileName, read.bytes, checked)
        if (!this.#stillAuthorised(source, epoch)) throw new Error('SlideWell was turned off while it was being searched, so nothing was shown.')
        // The semantic score belongs to the search answer, not the re-read; carry it over.
        const score = candidate.score ?? read.candidate.score
        shown.push({
          source, providerId: read.candidate.providerId, kind: checked.kind,
          fileName: read.candidate.fileName, title: read.candidate.title,
          provenance: score !== undefined ? `SlideWell · match ${score.toFixed(2)}` : 'SlideWell',
          ...(read.candidate.detail ? { detail: read.candidate.detail } : {}),
          ...(score !== undefined ? { score } : {}),
          sha256: sha256Bytes(read.bytes), bytes: read.bytes.length,
          ...(checked.ok ? {} : { incompatible: checked.incompatible }),
          ...(previewDataUri ? { previewDataUri } : {}),
        })
      }
    }
    if (!this.#stillAuthorised(source, epoch)) throw new Error(`${source === 'talkweaver' ? 'TalkWeaver' : 'SlideWell'} was turned off while it was being searched, so nothing was shown.`)
    const results: ScratchExternalResult[] = []
    for (const entry of shown) {
      const handle = `x_${randomBytes(12).toString('hex')}`
      this.#handles.set(handle, { ...entry, epoch, expiresAt: this.#now() + HANDLE_TTL_MS })
      if (this.#handles.size > MAX_HANDLES) this.#handles.delete(this.#handles.keys().next().value as string)
      const { providerId: _providerId, fileName: _fileName, sha256: _sha256, bytes: _bytes, ...visible } = entry
      results.push({ handle, ...visible })
    }
    return { results, ...(note ? { note } : {}) }
  }

  /** The provider identity behind a live handle — main-internal (collected-card annotation). */
  providerIdOf(handle: string): string | null {
    return this.#issued(handle)?.providerId ?? null
  }

  /** The shown identity + version behind a live handle — main-internal, never rendered. */
  identityOf(handle: string): { providerId: string; sha256: string } | null {
    const issued = this.#issued(handle)
    return issued ? { providerId: issued.providerId, sha256: issued.sha256 } : null
  }

  #issued(handle: string): IssuedHandle | null {
    if (typeof handle !== 'string') return null
    const issued = this.#handles.get(handle)
    if (!issued) return null
    if (issued.expiresAt <= this.#now() || !this.#stillAuthorised(issued.source, issued.epoch)) {
      this.#handles.delete(handle)
      return null
    }
    return issued
  }

  /** The checked bytes behind one provider identity, re-derived under the live switch. */
  async #readProvider(source: ScratchExternalSourceId, providerId: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
    if (source === 'talkweaver') {
      const parsed = parseTalkweaverProviderId(providerId)
      if (!parsed) return { ok: false, error: 'That TalkWeaver result cannot be read safely.' }
      const chosen = chosenTalkweaverVaults(this.#settings.get(SCRATCHPAD_TALKWEAVER_VAULTS_KEY))
      if (!chosen.includes(parsed.vaultId)) return { ok: false, error: 'That TalkWeaver vault is no longer selected in Settings, so its file was not read.' }
      const read = await this.#talkweaver.readChecked(parsed.vaultId, parsed.relPath)
      return read.ok ? { ok: true, bytes: read.bytes } : { ok: false, error: read.error }
    }
    if (!parseSlideWellProviderId(providerId)) return { ok: false, error: 'That SlideWell result cannot be read safely.' }
    const epoch = this.epoch(source)
    if (!this.enabled(source)) return { ok: false, error: 'SlideWell is off in Settings, so its file was not read.' }
    const slidewell = await this.#slidewellAdapter()
    if (!this.#stillAuthorised(source, epoch)) return { ok: false, error: 'SlideWell was turned off, so its file was not read.' }
    const location: SlideWellLocation | null = await slidewell.locate()
    if (!this.#stillAuthorised(source, epoch)) return { ok: false, error: 'SlideWell was turned off, so its file was not read.' }
    if (!location) return { ok: false, error: 'SlideWell was not found on this Mac.' }
    const read = await slidewell.readChecked(location, providerId)
    return read.ok ? { ok: true, bytes: read.bytes } : { ok: false, error: read.error }
  }

  /**
   * Collect one issued result as a Candidate: the handle must still stand, and the source
   * bytes are re-read checked and must still be the shown version — a changed source is
   * refused, never silently re-authorised. Stores pointer + small preview only.
   */
  async collect(store: ScratchpadStore, input: { handle: string; activePath: string; by?: 'writer' | 'agent'; group?: string | null }): Promise<ScratchItem> {
    const issued = this.#issued(input.handle)
    if (!issued) throw new Error('That result is no longer current (the connection changed, or too much time passed). Search again to see it as it stands.')
    const origin = store.documentPath(input.activePath)
    const read = await this.#readProvider(issued.source, issued.providerId)
    if (!this.#stillAuthorised(issued.source, issued.epoch)) throw new Error(`${issued.source === 'talkweaver' ? 'TalkWeaver' : 'SlideWell'} was turned off while this was being collected, so nothing was collected.`)
    if (!read.ok) throw new Error(read.error)
    if (sha256Bytes(read.bytes) !== issued.sha256) throw new Error('That file changed in its source since it was shown, so it was not collected. Search again to see it as it stands.')
    // Collecting the same shown version twice keeps the one candidate (as canonical sources do).
    const existing = (await store.listLossless([])).find((item) => item.external?.providerId === issued.providerId && item.external.sha256 === issued.sha256 && item.status === 'active')
    if (existing) return existing
    const ref: ScratchExternalRef = {
      source: issued.source, providerId: issued.providerId, kind: issued.kind, fileName: issued.fileName,
      title: issued.title, provenance: issued.provenance, sha256: issued.sha256, bytes: issued.bytes,
      ...(issued.score !== undefined ? { score: issued.score } : {}),
      ...(issued.incompatible ? { incompatible: issued.incompatible } : {}),
      ...(issued.previewDataUri ? { previewDataUri: issued.previewDataUri } : {}),
    }
    const preview = [
      `**${issued.title}**`,
      '',
      `${issued.provenance} — ${issued.fileName}`,
      '',
      'Collected to the Scratchpad. Nothing was copied yet; the file is copied into this document’s assets/ folder only when you insert it, and the source stays on the item.',
    ].join('\n')
    if (!this.#stillAuthorised(issued.source, issued.epoch)) throw new Error(`${issued.source === 'talkweaver' ? 'TalkWeaver' : 'SlideWell'} was turned off while this was being collected, so nothing was collected.`)
    return store.addExternal({ origin, markdown: preview, kind: issued.kind, external: ref, by: input.by ?? 'writer', group: input.group ?? null })
  }

  /** The checked widget page for one external candidate's sealed Run (source, or its local copy). */
  async prepareWidget(ws: Workspace, item: ScratchItem): Promise<{ html: string; title: string }> {
    const external = item.external
    if (!external || external.kind !== 'widget') throw new Error('Only a widget can be run here.')
    if (external.incompatible) throw new Error(external.incompatible)
    let bytes: Buffer | null = null
    if (external.importedPath && external.importedSha256) {
      const local = await this.#readLocalCopy(ws, external)
      if (local) bytes = local
    }
    if (!bytes) {
      if (!this.enabled(external.source)) throw new Error(`${external.source === 'talkweaver' ? 'TalkWeaver is' : 'SlideWell is'} off in Settings, and this widget has no copied file in the document yet, so it cannot run.`)
      const epoch = this.epoch(external.source)
      const read = await this.#readProvider(external.source, external.providerId)
      if (!this.#stillAuthorised(external.source, epoch)) throw new Error('The connection was turned off while the widget was being read, so it did not run.')
      if (!read.ok) throw new Error(read.error)
      if (sha256Bytes(read.bytes) !== external.sha256) throw new Error('That widget changed in its source since it was collected, so it did not run. Collect it again to see it as it stands.')
      bytes = read.bytes
    }
    const checked = checkExternalAsset(external.fileName, bytes)
    if (!checked.ok || checked.kind !== 'widget') throw new Error(checked.ok ? 'That file is not a widget.' : checked.incompatible)
    return { html: checked.html, title: widgetPageTitle(checked.html) }
  }

  /** The candidate's recorded local copy, read checked; null when it is not the shown bytes. */
  async #readLocalCopy(ws: Workspace, external: ScratchExternalRef): Promise<Buffer | null> {
    if (!external.importedPath || !external.importedSha256) return null
    let realRoot: string
    try { realRoot = await realpath(ws.root) } catch { return null }
    const read = await readContainedFile(realRoot, external.importedPath, EXTERNAL_ASSET_MAX_BYTES)
    if (!read.ok || sha256Bytes(read.bytes) !== external.importedSha256 || external.importedSha256 !== external.sha256) return null
    return read.bytes
  }

  /** The exact Markdown an insert of `assetPath` writes into `destPath`. */
  markdownFor(external: ScratchExternalRef, destPath: string, assetPath: string): string {
    const relative = relativeEmbedPath(destPath, assetPath)
    if (external.kind === 'widget') return `[Simulation: ${relative}]`
    const alt = external.title.replace(/[\[\]()<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || external.fileName
    return `![${alt}](${relative})`
  }

  /**
   * Bind an agent proposal's import WITHOUT writing: the shown source version revalidated
   * read-only (or the recorded local copy checked), and a planned exclusive destination.
   * Throws the refusal. Root readiness of the wider app is integration's, not this plan's.
   */
  async planImport(ws: Workspace, item: ScratchItem, destPath: string): Promise<ExternalImportPlan> {
    const external = item.external
    if (!external) throw new Error('That item did not come from a connected source.')
    if (external.incompatible) throw new Error(external.incompatible)
    if (external.importedPath) {
      const local = await this.#readLocalCopy(ws, external)
      if (local) return { path: external.importedPath, sha256: external.sha256, reuse: true, providerId: external.providerId, source: external.source }
    }
    if (!this.enabled(external.source)) throw new Error(`${external.source === 'talkweaver' ? 'TalkWeaver is' : 'SlideWell is'} off in Settings, so this cannot be proposed. The item stays in the Scratchpad.`)
    const epoch = this.epoch(external.source)
    const read = await this.#readProvider(external.source, external.providerId)
    if (!this.#stillAuthorised(external.source, epoch)) throw new Error('The connection was turned off while this was being prepared, so nothing was proposed.')
    if (!read.ok) throw new Error(read.error)
    if (sha256Bytes(read.bytes) !== external.sha256) throw new Error('That file changed in its source since it was collected, so nothing was proposed. Collect it again to see it as it stands.')
    const checked = checkExternalAsset(external.fileName, read.bytes)
    if (!checked.ok) throw new Error(checked.incompatible)
    const path = external.kind === 'widget'
      ? await this.#planWidgetPath(ws.root, destPath, external.fileName)
      : await planImportedPictureFile(ws.root, destPath, external.fileName)
    return { path, sha256: external.sha256, reuse: false, providerId: external.providerId, source: external.source }
  }

  async #planWidgetPath(root: string, destPath: string, fileName: string): Promise<string> {
    const plan = await planWidgetFile(root, destPath, fileName)
    if (!plan.ok) throw new Error(plan.message)
    return plan.path
  }

  /**
   * Carry out an import: the writer's own Insert (a fresh plan, after the click) or an
   * accepted proposal's bound plan. Revalidates everything, copies only the shown checked
   * bytes exclusively, records the copy on the candidate, and returns the exact Markdown.
   * `created` says whether THIS call made the file (the accept rollback's conditional half).
   */
  async importForInsert(
    ws: Workspace,
    store: ScratchpadStore,
    item: ScratchItem,
    destPath: string,
    plan?: ExternalImportPlan,
  ): Promise<{ markdown: string; copied: boolean; createdPath: string | null; created: CreatedWidgetFile | ImportedPictureFile | null }> {
    const external = item.external
    if (!external) throw new Error('That item did not come from a connected source.')
    if (item.status !== 'active') throw new Error('Move this item back to Candidates before inserting it.')
    if (external.incompatible) throw new Error(external.incompatible)
    const bound = plan ?? await this.planImport(ws, item, destPath)
    if (bound.providerId !== external.providerId || bound.sha256 !== external.sha256) {
      throw new Error('That proposal was made for a different version of this file, so nothing was copied or inserted.')
    }
    if (bound.reuse) {
      const local = await this.#readLocalCopy(ws, external)
      if (!local || external.importedPath !== bound.path) throw new Error('The copied file in this workspace changed since this was prepared, so nothing was inserted.')
      const checked = checkExternalAsset(external.fileName, local)
      if (!checked.ok) throw new Error(checked.incompatible)
      return { markdown: this.markdownFor(external, destPath, bound.path), copied: false, createdPath: null, created: null }
    }
    // A recorded local copy may have arrived since the plan (the writer inserted it directly):
    // reuse it checked, rather than making a second copy under the planned name.
    if (external.importedPath) {
      const local = await this.#readLocalCopy(ws, external)
      if (local) return { markdown: this.markdownFor(external, destPath, external.importedPath), copied: false, createdPath: null, created: null }
    }
    if (!this.enabled(external.source)) throw new Error(`${external.source === 'talkweaver' ? 'TalkWeaver was' : 'SlideWell was'} turned off, so nothing was copied or inserted. The item stays in the Scratchpad.`)
    const epoch = this.epoch(external.source)
    const read = await this.#readProvider(external.source, external.providerId)
    if (!read.ok) throw new Error(read.error)
    if (sha256Bytes(read.bytes) !== external.sha256) throw new Error('That file changed in its source since it was shown, so nothing was copied or inserted. Collect it again to see it as it stands.')
    const checked = checkExternalAsset(external.fileName, read.bytes)
    if (!checked.ok) throw new Error(checked.incompatible)
    const stillOn = (): boolean => this.#stillAuthorised(external.source, epoch)
    let created: CreatedWidgetFile | ImportedPictureFile
    if (external.kind === 'widget') {
      if (checked.kind !== 'widget') throw new Error('That file is not a widget.')
      const written = await writeWidgetFile(ws.root, destPath, bound.path, checked.html, external.sha256, stillOn)
      if (!written.ok) throw new Error(written.message)
      created = written.created
    } else {
      const written = await writeImportedPictureFile(ws.root, destPath, bound.path, read.bytes, external.sha256, stillOn)
      if (!written.ok) throw new Error(written.message)
      created = written.created
    }
    try {
      await store.recordExternalImport(item.id, created.path, external.sha256)
    } catch (error) {
      // The copy landed but its required provenance record did not: take back exactly the
      // file this call made (identity- and digest-checked), and say so truthfully.
      const undone = await this.removeCreatedImport(ws, external, created)
      throw new Error(undone
        ? `Nothing was inserted: the copied file could not be recorded on the item, so it was removed again. ${(error as Error).message}`
        : `The file was copied into ${created.path}, but it could not be recorded on the item and could not be removed again, so nothing was inserted. ${(error as Error).message}`)
    }
    if (!this.#stillAuthorised(external.source, epoch) && !external.importedPath) {
      // The switch went off after the copy was recorded: the copy is truthfully the item's
      // local copy now, but this insert does not complete under a dead authority.
      throw new Error(`The connection was turned off while this was being copied. The file is in ${created.path} and recorded on the item; nothing was inserted.`)
    }
    return { markdown: this.markdownFor(external, destPath, created.path), copied: true, createdPath: created.path, created }
  }

  /**
   * Conditionally take back a file an import created: removed only while the name still
   * holds the very bytes the import wrote (walked without following anything, digest read
   * in the same breath). A later outside asset at that name is never deleted.
   */
  async removeCreatedImport(ws: Workspace, external: ScratchExternalRef, created: CreatedWidgetFile | ImportedPictureFile): Promise<boolean> {
    if (external.kind === 'widget') {
      const undone = await undoWidgetFile(ws.root, created)
      return undone.removed
    }
    let realRoot: string
    try { realRoot = await realpath(ws.root) } catch { return false }
    if (!created.sha256) return false
    return removeImportedPictureFileSync(realRoot, { ...created, sha256: created.sha256 })
  }

}

// ── The picture half of the checked exclusive writer (widgets reuse widget-create's) ──────

export type ImportedPictureFile = { path: string; dev: number; ino: number; madeFolder: boolean; sha256: string }

const assetsBeside = (documentRelative: string): string => {
  const folder = dirOf(documentRelative)
  return folder === '' ? ASSETS_DIR : `${folder}/${ASSETS_DIR}`
}

/** Where an imported picture would go: `assets/` beside the document, first free plain name. */
export async function planImportedPictureFile(root: string, documentRelative: string, fileName: string): Promise<string> {
  const place = await importPlace(root, documentRelative)
  let name = importedFileName(fileName)
  if (!name) throw new Error('That picture type cannot be kept in a WriteFlex document.')
  for (let ordinal = 2; place.assetsExists; ordinal += 1) {
    const taken = await walkNoFollow(place.realRoot, `${place.assets}/${name}`)
    if (taken.kind === 'missing') break
    if (ordinal > 999) throw new Error(`There are too many pictures called ${name} in ${place.assets}.`)
    const next = importedFileName(fileName, ordinal)
    if (!next) throw new Error('That picture type cannot be kept in a WriteFlex document.')
    name = next
  }
  return `${place.assets}/${name}`
}

type ImportPlace = { realRoot: string; assets: string; assetsExists: boolean }

async function importPlace(root: string, documentRelative: string): Promise<ImportPlace> {
  let realRoot: string
  try { realRoot = await realpath(root) } catch { throw new Error('The open Workspace folder cannot be read.') }
  if (!/\.(md|markdown|mdx)$/i.test(documentRelative) || isHiddenWorkspacePath(documentRelative) || (documentRelative.split('/').pop() ?? '').startsWith('.')) {
    throw new Error(`${documentRelative} is not a Markdown document in a visible folder of the Workspace.`)
  }
  const document = await walkNoFollow(realRoot, documentRelative)
  if (document.kind === 'missing') throw new Error(`There is no document at ${documentRelative}. Save it first, then insert again.`)
  if (document.kind !== 'file') throw new Error(`${documentRelative} is a link, is reached through a linked folder, or is not a plain file.`)
  const assets = assetsBeside(documentRelative)
  const folder = await walkNoFollow(realRoot, assets)
  if (folder.kind === 'directory') return { realRoot, assets, assetsExists: true }
  if (folder.kind === 'missing' && folder.last) return { realRoot, assets, assetsExists: false }
  if (folder.kind === 'file') throw new Error(`There is a file called ${assets}, so a picture cannot go into an assets folder beside this document.`)
  throw new Error(`${assets} is a link, not a real folder, so WriteFlex will not write into it.`)
}

const plainReason = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'the folder does not allow it'
  if (code === 'EROFS') return 'the disk is read-only'
  if (code === 'ENOSPC') return 'the disk is full'
  return typeof code === 'string' ? `the system answered ${code}` : 'an unexpected error'
}

/**
 * Create `plannedPath` exclusively with exactly `bytes` (whose digest must be the shown
 * version's), the widget writer's discipline: place re-walked without following anything,
 * permission (`allowed`) read in the SAME TICK as the syscalls, descriptor checked to be
 * the file at the planned path before a byte lands. Never overwrites; never follows a link.
 */
export async function writeImportedPictureFile(
  root: string, documentRelative: string, plannedPath: string, bytes: Buffer, expectedSha256: string, allowed: () => boolean,
): Promise<{ ok: true; created: ImportedPictureFile } | { ok: false; message: string }> {
  if (sha256Bytes(bytes) !== expectedSha256) return { ok: false, message: 'The picture is not the one that was shown, so it was not copied.' }
  const name = plannedPath.split('/').pop() ?? ''
  if (plannedPath !== `${assetsBeside(documentRelative)}/${name}` || importedFileName(name) !== name) {
    return { ok: false, message: 'A copied picture can only go into the assets folder beside its document, under a plain name.' }
  }
  let place: ImportPlace
  try { place = await importPlace(root, documentRelative) } catch (error) { return { ok: false, message: (error as Error).message } }
  // The last await. Everything after it runs in one tick.
  if (!allowed()) return { ok: false, message: 'The connection was turned off, so nothing was copied.' }
  const paused = pausedMessage(place.realRoot)
  if (paused !== null) return { ok: false, message: paused }
  const assetsAbsolute = join(place.realRoot, place.assets)
  const folder = walkNoFollowSync(place.realRoot, place.assets)
  let madeFolder = false
  if (folder.kind === 'missing' && folder.last) {
    try { mkdirSync(assetsAbsolute); madeFolder = true } catch (error) {
      return { ok: false, message: `The assets folder ${place.assets} could not be made: ${plainReason(error)}.` }
    }
  } else if (folder.kind !== 'directory') {
    return { ok: false, message: `${place.assets} is not a real folder, so WriteFlex will not write into it.` }
  }
  const removeMadeFolder = (): void => { if (madeFolder) try { rmdirSync(assetsAbsolute) } catch { /* not empty: not ours to force */ } }
  let fd: number
  try { fd = openSync(join(place.realRoot, plannedPath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | OPEN_NOFOLLOW, 0o644) } catch (error) {
    removeMadeFolder()
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, message: `${plannedPath} already exists, and an import never overwrites a file. Insert again to get a free name.` }
    if (code === 'ELOOP') return { ok: false, message: `${plannedPath} is reached through a link, so WriteFlex will not write there.` }
    return { ok: false, message: `${plannedPath} could not be created: ${plainReason(error)}.` }
  }
  let created: ImportedPictureFile | null = null
  let failure = ''
  try {
    const info = fstatSync(fd)
    const walked = walkNoFollowSync(place.realRoot, plannedPath)
    if (walked.kind !== 'file' || walked.dev !== info.dev || walked.ino !== info.ino) {
      return { ok: false, message: `The folder ${place.assets} changed while the picture was being copied, so it was not written.` }
    }
    created = { path: plannedPath, dev: info.dev, ino: info.ino, madeFolder, sha256: expectedSha256 }
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } catch (error) {
    failure = `${plannedPath} could not be written: ${plainReason(error)}.`
  } finally {
    try { closeSync(fd) } catch { /* the descriptor is gone either way */ }
  }
  if (!failure && created) return { ok: true, created }
  if (!created) { removeMadeFolder(); return { ok: false, message: `${failure} An empty file may have been left at ${plannedPath}.` } }
  const removed = removeImportedPictureFileSync(place.realRoot, created)
  return { ok: false, message: removed ? failure : `${failure} The incomplete file ${created.path} could not be removed; it is still in the Workspace.` }
}

function removeImportedPictureFileSync(realRoot: string, created: ImportedPictureFile): boolean {
  if (pausedMessage(realRoot) !== null) return false
  const walked = walkNoFollowSync(realRoot, created.path)
  if (walked.kind === 'missing') return true
  if (walked.kind !== 'file' || walked.dev !== created.dev || walked.ino !== created.ino) return false
  let now: string | null
  try { now = sha256Bytes(readFileSync(join(realRoot, created.path))) } catch { now = null }
  if (now !== created.sha256) return false
  try { unlinkSync(join(realRoot, created.path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  if (created.madeFolder) { try { rmdirSync(join(realRoot, dirname(created.path))) } catch { /* not empty */ } }
  return true
}

/** Remove an imported picture only while it still holds exactly the imported bytes. */
export async function removeImportedPictureFile(root: string, path: string, sha256: string): Promise<boolean> {
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return false }
  const walked = walkNoFollowSync(realRoot, path)
  if (walked.kind === 'missing') return true
  if (walked.kind !== 'file') return false
  return removeImportedPictureFileSync(realRoot, { path, dev: walked.dev, ino: walked.ino, madeFolder: false, sha256 })
}

// ── The app-wide service: bound once to the real SettingsStore by the IPC layer ───────────

let shared: ScratchpadExternalSources | null = null

/**
 * Bind the shared service to the app's settings store (called once from main's IPC setup,
 * where the store lives). Re-binding replaces the reader; handles issued under the old
 * binding are dropped with it. Until bound, the shared service reads every switch as off,
 * so headless verb tables can never discover a source the app has not enabled.
 */
export function bindScratchpadExternalSettings(settings: ScratchExternalSettings & { onChange?: (listener: (key: string) => void) => () => void }): ScratchpadExternalSources {
  shared = new ScratchpadExternalSources({ settings })
  settings.onChange?.((key) => shared?.noteSettingsChanged(key))
  return shared
}

export function scratchpadExternalSources(): ScratchpadExternalSources {
  if (!shared) shared = new ScratchpadExternalSources({ settings: { get: () => null } })
  return shared
}

/** @internal Tests: drop the shared binding so the next accessor starts unbound (all off). */
export function resetScratchpadExternalForTest(): void {
  shared = null
}
