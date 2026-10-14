/**
 * The agent makes a widget (interactive-widgets-in-documents, ticket 07). Jobs, kept apart:
 *
 *   checkWidgetHtml   - pure. Size cap, a <title>, and an EARLY REFUSAL of pages that obviously reach for the
 *                       network or another file. It is a courtesy to the agent, NOT the wall: see below.
 *   widgetFileName    - pure. The ONE function that produces a widget's final file name.
 *   planWidgetFile    - read-only. Where the file would go: assets/ beside the document, a free name.
 *   planWidgetCreate  - read-only. The whole proposal: the page, its hash, its path, the document with its line.
 *   writeWidgetFile   - THE write. Only the widgets.create verb calls it, and only after the writer accepted a
 *                       proposal that showed this file. Opening, listing and proposing write nothing.
 *   undoWidgetFile    - removes the file writeWidgetFile just created, and says so when it cannot.
 *
 * Links are REFUSED, not resolved: every component from the workspace root down to the document, the assets/
 * folder and the new file must be a real folder or file. The walk and the no-follow open flag are widget-file.ts's.
 *
 * What keeps a widget off the network is the sealed frame it runs in (opaque origin, a CSP with no network
 * sources, navigation refused: widget-frame code, untouched here). The text scan in this file can be defeated
 * by a page that builds its addresses at run time; such a page is accepted and then simply does not work.
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { insertWidgetInText } from '../shared/widget-insert'
import { OPEN_NOFOLLOW, walkNoFollow, walkNoFollowSync } from './widget-file'
import { isHiddenWorkspacePath, type Workspace } from './workspace'

/** Largest widget file the agent may create: 1 MiB. Hand-written pages are tens of KiB; the reader's own limit is 16 MiB. */
export const WIDGET_CREATE_MAX_BYTES = 1024 * 1024
export const WIDGET_ASSETS_DIR = 'assets'
/** Longest file-name stem, numbered suffix included. */
const WIDGET_STEM_MAX = 60

export type Refusal = { ok: false; message: string }

const NUL = String.fromCharCode(0)
const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Attribute values that load nothing: inline data, blob, an in-page anchor, an empty value, javascript:, about:blank. */
const INERT_VALUE = /^(?:data:|blob:|#|javascript:|about:blank|$)/i
const LOADING_ATTRIBUTES = /\b(src|href|action|formaction|poster|data|srcset|xlink:href|background|manifest|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi
const NETWORK_SCHEME = /\b(?:https?|wss?|ftp):\/\//i
// Trap: electron-vite's ESM shim finds static imports with a regex over the BUNDLED text, so a message string with
// the word import directly before a quote mark truncates the bundle. Keep that sequence out of literals here.
const JS_NETWORK = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|importScripts)\b|\bnavigator\s*\.\s*sendBeacon\b|\bimport\s*\(|\bimport\s*(?:[^;"'()<>]*?\sfrom\s*)?["']/

/**
 * The early refusal: the sentence for a page that OBVIOUSLY needs the network or a sibling file, or null.
 * A text scan, so it is bypassable (an address assembled from pieces, an encoded redirect) and is not a
 * security boundary; do not grow it into one. Its job is to tell the agent at once about a page that would
 * be broken inside the sealed frame, which is what actually refuses the network.
 */
function obviousNetworkUse(html: string): string | null {
  // xmlns declarations are names, not requests: http://www.w3.org/2000/svg must not trip the check.
  const scanned = html.replace(/\bxmlns(?::[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
  if (NETWORK_SCHEME.test(scanned)) {
    return 'The widget refers to a web address, but a widget runs with no network. Put everything inline (scripts, styles, data: images) and remove the web address, then try again.'
  }
  if (/["'`]\/\/[a-z0-9-]+\.[a-z]/i.test(scanned) || /@import\b/i.test(scanned) || /url\(\s*["']?\/\//i.test(scanned)) {
    return 'The widget refers to a web address (//host or @import), but a widget runs with no network. Put everything inline and try again.'
  }
  for (const match of scanned.matchAll(LOADING_ATTRIBUTES)) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim()
    if (!INERT_VALUE.test(value)) {
      return `The widget loads "${value.slice(0, 60)}" through ${match[1].toLowerCase()}=, but a widget is one self-contained file with no network. Inline it, or use a data: URL.`
    }
  }
  for (const match of scanned.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!INERT_VALUE.test(value)) return `The widget's CSS loads "${value.slice(0, 60)}" through url(), but a widget is one self-contained file with no network. Use a data: URL or inline SVG.`
  }
  const script = JS_NETWORK.exec(scanned)
  if (script) {
    return `The widget's script uses ${script[1] ?? 'an import statement'}, which needs the network or another file; a widget runs with neither. Write the logic inline.`
  }
  return null
}

/**
 * Returns the page with a <title> (from `title` when the page has none), or a plain-sentence refusal: empty,
 * over the cap, a null character, or obvious network use (see obviousNetworkUse: an early refusal, not a guarantee).
 * Deterministic, and a page it returns passes through it again unchanged.
 */
export function checkWidgetHtml(html: unknown, title: unknown): { ok: true; html: string } | Refusal {
  if (typeof html !== 'string' || html.trim() === '') return { ok: false, message: 'The widget has no HTML in it.' }
  if (Buffer.byteLength(html, 'utf8') > WIDGET_CREATE_MAX_BYTES) {
    return { ok: false, message: `The widget is larger than ${WIDGET_CREATE_MAX_BYTES / 1024 / 1024} MiB; make a smaller, more compact page.` }
  }
  if (html.includes(NUL)) return { ok: false, message: 'The widget contains a null character.' }
  const network = obviousNetworkUse(html)
  if (network) return { ok: false, message: network }
  if (/<title[\s>]/i.test(html)) return { ok: true, html }
  if (typeof title !== 'string' || title.trim() === '') return { ok: false, message: 'The widget needs a title: give a title argument or put a <title> in the page.' }
  const tag = `<title>${escapeText(title.trim().replace(/\s+/g, ' '))}</title>`
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  const titled = head
    ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    : ((root) => root
        ? `${html.slice(0, root.index + root[0].length)}<head>${tag}</head>${html.slice(root.index + root[0].length)}`
        : `<!doctype html><html><head><meta charset="utf-8">${tag}</head><body>${html}</body></html>`)(/<html(?:\s[^>]*)?>/i.exec(html))
  // The title can push a page at the cap over it; the page that is written is the one that is measured.
  if (Buffer.byteLength(titled, 'utf8') > WIDGET_CREATE_MAX_BYTES) {
    return { ok: false, message: `The widget is larger than ${WIDGET_CREATE_MAX_BYTES / 1024 / 1024} MiB; make a smaller, more compact page.` }
  }
  return { ok: true, html: titled }
}

/** The hash that binds what the writer was shown to what is written: SHA-256 of the page's UTF-8 bytes, hex. */
export function widgetFileSha256(html: string): string {
  return createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex')
}

/**
 * THE file name: a base name of lower-case letters, digits and single hyphens ending .html, from whatever the
 * agent proposed. `ordinal` 1 is the plain name; 2, 3, ... carry `-2`, `-3`, ... and the stem is shortened to make
 * room, so every name this returns is within the length limit and is accepted by isWidgetFileName as it stands.
 */
export function widgetFileName(fileName: unknown, ordinal = 1): { ok: true; name: string } | Refusal {
  if (typeof fileName !== 'string' || fileName.trim() === '' || fileName.includes(NUL)) return { ok: false, message: 'Give the widget a file name ending in .html.' }
  const base = fileName.replace(/\\/g, '/').trim().split('/').pop() ?? ''
  if (!/\.html?$/i.test(base)) return { ok: false, message: 'A widget file name must end in .html.' }
  const suffix = ordinal > 1 ? `-${ordinal}` : ''
  const clean = base.replace(/\.html?$/i, '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const stem = (clean || 'widget').slice(0, WIDGET_STEM_MAX - suffix.length).replace(/-+$/g, '') || 'widget'
  return { ok: true, name: `${stem}${suffix}.html` }
}

/** Validation only, for the writer: whether `name` is a name widgetFileName can produce. Changes nothing. */
export function isWidgetFileName(name: string): boolean {
  return name.length <= WIDGET_STEM_MAX + '.html'.length && /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(name)
}

export type WidgetFilePlan = { ok: true; /** Workspace-relative, `/` separators. */ path: string; /** What the embed line carries: `assets/<name>`. */ rawPath: string } | Refusal

type WidgetPlace = { ok: true; realRoot: string; /** Workspace-relative assets folder beside the document. */ assets: string; assetsExists: boolean } | Refusal

const assetsBeside = (documentRelative: string): string => {
  const folder = dirname(documentRelative)
  return folder === '.' ? WIDGET_ASSETS_DIR : `${folder}/${WIDGET_ASSETS_DIR}`
}

/**
 * Whether a widget may go beside `documentRelative` (workspace-relative, `/` separators, already lexically inside
 * the root): the document is a real file reached through real folders, and assets/ beside it is a real folder or
 * does not exist yet. Follows nothing; reads no file content; writes nothing.
 */
async function widgetPlace(root: string, documentRelative: string): Promise<WidgetPlace> {
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return { ok: false, message: 'The open Workspace folder cannot be read.' } }
  // A widget goes beside a Markdown document the writer can see: not into .git, .writeflex, .bridle or any hidden folder.
  if (!/\.(md|markdown|mdx)$/i.test(documentRelative) || isHiddenWorkspacePath(documentRelative) || (documentRelative.split('/').pop() ?? '').startsWith('.')) {
    return { ok: false, message: `${documentRelative} is not a Markdown document in a visible folder of the Workspace, so no widget can be made beside it.` }
  }
  const document = await walkNoFollow(realRoot, documentRelative)
  if (document.kind === 'missing') return { ok: false, message: `There is no document at ${documentRelative}.` }
  if (document.kind !== 'file') {
    return { ok: false, message: `${documentRelative} is a link, is reached through a linked folder, or is not a plain file. WriteFlex makes a widget only beside a real document in real folders of the open Workspace.` }
  }
  const assets = assetsBeside(documentRelative)
  const folder = await walkNoFollow(realRoot, assets)
  if (folder.kind === 'directory') return { ok: true, realRoot, assets, assetsExists: true }
  if (folder.kind === 'missing' && folder.last) return { ok: true, realRoot, assets, assetsExists: false }
  if (folder.kind === 'file') return { ok: false, message: `There is a file called ${assets}, so a widget cannot go into an assets folder beside this document.` }
  return { ok: false, message: `${assets} is a link, not a real folder, so WriteFlex will not write a widget into it. Replace it with a real folder, or keep the document somewhere else.` }
}

/** Where the widget would go: assets/ beside `documentRelative`, the first free `name.html`, `name-2.html`, ... Writes nothing. */
export async function planWidgetFile(root: string, documentRelative: string, fileName: unknown): Promise<WidgetFilePlan> {
  const first = widgetFileName(fileName)
  if (!first.ok) return first
  const place = await widgetPlace(root, documentRelative)
  if (!place.ok) return place
  let name = first.name
  for (let ordinal = 2; place.assetsExists; ordinal += 1) {
    // Anything at the name, a link included, means the name is taken.
    const taken = await walkNoFollow(place.realRoot, `${place.assets}/${name}`)
    if (taken.kind === 'missing') break
    if (ordinal > 999) return { ok: false, message: `There are too many widgets called ${first.name} in ${place.assets}; give this one another file name.` }
    const next = widgetFileName(fileName, ordinal)
    if (!next.ok) return next
    name = next.name
  }
  return { ok: true, path: `${place.assets}/${name}`, rawPath: `${WIDGET_ASSETS_DIR}/${name}` }
}

export type WidgetCreateRequest = { path: string; fileName: string; html: string; title: string; position?: 'start' | 'end' | number }
export type WidgetCreatePlan = {
  /** The page exactly as it will be written. */
  html: string
  sha256: string
  /** Workspace-relative path of the new file. */
  path: string
  documentPath: string
  currentDocument: string
  nextDocument: string
}

/**
 * The whole proposal, computed the same way when it is shown (agent ingest) and when it is carried out (the verb):
 * the checked page and its hash, the new file's path, and the document with its embed line. Writes nothing. The
 * place is checked (no links) BEFORE the document is read. Throws the refusal's sentence.
 * `declaredPath` is the path the proposal already named; with it, no new name is chosen.
 */
export async function planWidgetCreate(workspace: Workspace, input: WidgetCreateRequest, declaredPath?: string): Promise<WidgetCreatePlan> {
  if (!input || typeof input.path !== 'string' || input.path.includes(NUL)) throw new Error('path must name a Workspace document.')
  const checked = checkWidgetHtml(input.html, input.title)
  if (!checked.ok) throw new Error(checked.message)
  const documentPath = workspace.relative(workspace.absolute(input.path))
  const plan = await planWidgetFile(workspace.root, documentPath, declaredPath ? declaredPath.split('/').pop() : input.fileName)
  if (!plan.ok) throw new Error(plan.message)
  if (declaredPath !== undefined && plan.path !== declaredPath) {
    throw new Error(`${declaredPath} is no longer free or is not in the assets folder beside the document; nothing was written. Ask for the widget again.`)
  }
  const source = await workspace.readFile(documentPath)
  const nextDocument = insertWidgetInText(source.content, plan.rawPath, input.position ?? 'end')
  return { html: checked.html, sha256: widgetFileSha256(checked.html), path: plan.path, documentPath, currentDocument: source.content, nextDocument }
}

/** The file writeWidgetFile created: its workspace-relative path and identity, so undo removes that file and no other. */
export type CreatedWidgetFile = { path: string; dev: number; ino: number; /** assets/ did not exist and was made for this file. */ madeFolder: boolean }

const plainReason = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'the folder does not allow it'
  if (code === 'EROFS') return 'the disk is read-only'
  if (code === 'ENOSPC') return 'the disk is full'
  return typeof code === 'string' ? `the system answered ${code}` : 'an unexpected error'
}

/** What writeWidgetFile answers when the permission is found switched off at the write. */
export const WIDGET_WRITE_SWITCHED_OFF = 'Making widgets is switched off in Settings (creating files and editing prose must both be allowed), so nothing was written.'

/**
 * THE write. Creates `<document folder>/assets/<name>.html` exclusively (never overwrites) with exactly the bytes
 * of `html`, whose SHA-256 must be `expectedSha256` (the hash of the page the writer was shown). `plannedPath` is
 * the workspace-relative path the proposal named; it is taken verbatim and only validated. Nothing on the way may
 * be a link: the place is walked without following anything, the file is opened with the no-follow flag, and the
 * open descriptor is then checked to be the file at that path. Lands exactly there or says why not.
 *
 * `allowed` reads the live permission. It is called in the SAME TICK as the write: from that call to the close of
 * the file there is no await, only synchronous syscalls (mkdir of assets/ if needed, exclusive no-follow open,
 * descriptor check, write, fsync, close), so a switch turned off at any earlier moment stops the write, and nothing
 * can run between the permission read and the syscalls. A switch turned off after this block has begun does not
 * undo it: the block is not interruptible.
 */
export async function writeWidgetFile(root: string, documentRelative: string, plannedPath: string, html: string, expectedSha256: string, allowed: () => boolean): Promise<{ ok: true; created: CreatedWidgetFile } | Refusal> {
  const checked = checkWidgetHtml(html, null)
  if (!checked.ok) return checked
  if (checked.html !== html) return { ok: false, message: 'The widget page is not in its final form, so it was not written.' }
  const bytes = Buffer.from(html, 'utf8')
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    return { ok: false, message: 'The widget page is not the one that was shown for review, so it was not written.' }
  }
  const name = plannedPath.split('/').pop() ?? ''
  if (plannedPath !== `${assetsBeside(documentRelative)}/${name}` || !isWidgetFileName(name)) {
    return { ok: false, message: 'A widget can only be written into the assets folder beside its document, under a plain .html name.' }
  }
  // The last await. Everything after it runs in one tick.
  const place = await widgetPlace(root, documentRelative)
  if (!place.ok) return place
  return createWidgetFileNow(place, plannedPath, bytes, allowed)
}

/** The synchronous block of writeWidgetFile: permission read, then the syscalls, with no await anywhere. */
function createWidgetFileNow(place: Extract<WidgetPlace, { ok: true }>, plannedPath: string, bytes: Buffer, allowed: () => boolean): { ok: true; created: CreatedWidgetFile } | Refusal {
  if (!allowed()) return { ok: false, message: WIDGET_WRITE_SWITCHED_OFF }
  const assetsAbsolute = join(place.realRoot, place.assets)
  const removeMadeFolder = (): void => { try { rmdirSync(assetsAbsolute) } catch { /* not empty or already gone: not ours to force */ } }
  // The place was walked a moment ago, asynchronously; it is walked again here, inside the tick.
  const folder = walkNoFollowSync(place.realRoot, place.assets)
  let madeFolder = false
  if (folder.kind === 'missing' && folder.last) {
    // Not recursive: only assets/ itself may be missing.
    try { mkdirSync(assetsAbsolute); madeFolder = true } catch (error) {
      return { ok: false, message: `The assets folder ${place.assets} could not be made: ${plainReason(error)}.` }
    }
  } else if (folder.kind !== 'directory') {
    return { ok: false, message: `${place.assets} is not a real folder, so WriteFlex will not write a widget into it.` }
  }
  let fd: number
  try { fd = openSync(join(place.realRoot, plannedPath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | OPEN_NOFOLLOW, 0o644) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (madeFolder) removeMadeFolder()
    if (code === 'EEXIST') return { ok: false, message: `${plannedPath} already exists, and a widget never overwrites a file. Propose it again to get a free name.` }
    if (code === 'ELOOP') return { ok: false, message: `${plannedPath} is reached through a link, so WriteFlex will not write a widget there.` }
    return { ok: false, message: `${plannedPath} could not be created: ${plainReason(error)}.` }
  }
  let created: CreatedWidgetFile | null = null
  let failure = ''
  try {
    const info = fstatSync(fd)
    const walked = walkNoFollowSync(place.realRoot, plannedPath)
    if (walked.kind !== 'file' || walked.dev !== info.dev || walked.ino !== info.ino) {
      // The folder changed under the write. Nothing has been put in the file; it is not ours to chase.
      return { ok: false, message: `The folder ${place.assets} changed while the widget was being written, so the page was not written. An empty file may have been left where the folder used to lead.` }
    }
    created = { path: plannedPath, dev: info.dev, ino: info.ino, madeFolder }
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } catch (error) {
    failure = `${plannedPath} could not be written: ${plainReason(error)}.`
  } finally {
    try { closeSync(fd) } catch { /* the descriptor is gone either way */ }
  }
  if (!failure && created) return { ok: true, created }
  if (!created) return { ok: false, message: `${failure} An empty file may have been left at ${plannedPath}.` }
  const undone = removeCreatedWidgetFile(place.realRoot, created)
  return { ok: false, message: undone.removed ? failure : `${failure} The incomplete file ${created.path} could not be removed (${undone.reason}); it is still in the Workspace.` }
}

function removeCreatedWidgetFile(realRoot: string, created: CreatedWidgetFile): { removed: true } | { removed: false; reason: string } {
  const walked = walkNoFollowSync(realRoot, created.path)
  if (walked.kind === 'missing') return { removed: true }
  if (walked.kind !== 'file' || walked.dev !== created.dev || walked.ino !== created.ino) {
    return { removed: false, reason: 'what is at that path now is not the file WriteFlex wrote, so it was left alone' }
  }
  try { unlinkSync(join(realRoot, created.path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { removed: false, reason: plainReason(error) }
  }
  // An empty folder left behind is harmless; a folder with anything in it is not ours to remove.
  if (created.madeFolder) { try { rmdirSync(join(realRoot, dirname(created.path))) } catch { /* not empty */ } }
  return { removed: true }
}

/**
 * Undo writeWidgetFile when the document edit that goes with it was not written: removes the file this proposal
 * created (same path, same file identity, nothing followed) and the assets/ folder if it was made for it and is
 * empty. Never silent: when the file is still there afterwards, the answer says why.
 */
export async function undoWidgetFile(root: string, created: CreatedWidgetFile): Promise<{ removed: true } | { removed: false; reason: string }> {
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return { removed: false, reason: 'the Workspace folder cannot be read' } }
  return removeCreatedWidgetFile(realRoot, created)
}
