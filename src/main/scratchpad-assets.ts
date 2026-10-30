/** Typed local-asset validation. Reads only; insertion itself remains an editor transaction. */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { parseMarkdown } from '../shared/markdown/dialect'
import { embedLine } from '../shared/markdown/embed-line'
import { sanitiseSvg } from '../shared/sanitise-svg'
import { documentAssets } from '../shared/scratchpad-inventory'
import type { ScratchAssetKind } from '../shared/scratchpad-items'
import { containWorkspacePath } from './wf-asset'
import { unescapeDestination } from './relative-link-rebase'
import { OPEN_NOFOLLOW, readContainedFile, readWidgetFile, walkNoFollowSync } from './widget-file'
import { checkWidgetHtml } from './widget-create'
import { widgetPageTitle } from '../shared/widget-document'

/**
 * Read a widget file ONCE through the contained widget reader and compatibility-check those
 * exact bytes. The returned `html` is the checked page itself, so a caller that mounts it can
 * never run bytes that were not the ones checked (no check/use gap, no second read).
 */
export async function readCheckedScratchWidget(root: string, origin: string, markdown: string): Promise<{ html: string; title: string }> {
  const objects = documentAssets(origin, markdown, 'disk')
  if (objects.length !== 1 || objects[0].kind !== 'widget' || objects[0].markdown !== markdown) throw new Error('Choose one complete widget. Its source was left unchanged.')
  const embed = embedLine(markdown)!
  const read = await readWidgetFile(root, origin, embed.path)
  if (!read.ok) throw new Error(`This widget cannot be used (${read.reason}). Its source file was left unchanged.`)
  const checked = checkWidgetHtml(read.bytes.toString('utf8'), null)
  if (!checked.ok) throw new Error(`This widget is incompatible: ${checked.message}`)
  return { html: checked.html, title: widgetPageTitle(checked.html) }
}

/** One rendered local resource bound to the exact bytes reviewed (ticket 04 correction, R2):
 *  a workspace-relative path and the SHA-256 of its checked bytes. Same Markdown/path is never
 *  treated as proof of same bytes. */
export type RenderedResourceProof = { path: string; sha256: string }

const RESOURCE_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

/** The workspace-relative targets of every LOCAL image `markdown` renders when it stands in
 *  `destPath`'s folder. Remote, absolute and fragment destinations render no local bytes and are
 *  skipped; an unresolved reference-style image renders nothing here either. A local destination
 *  that escapes the workspace is refused outright. */
export function localRenderedImageTargets(destPath: string, markdown: string): string[] {
  const parsed = markdown.replace(/\r\n?/g, '\n')
  const tree = parseMarkdown(parsed)
  const destDir = posix.dirname(destPath) === '.' ? '' : posix.dirname(destPath)
  const targets = new Set<string>()
  const cursor = tree.cursor()
  do {
    if (cursor.name !== 'Image') continue
    const url = cursor.node.getChild('URL')
    if (!url) continue
    let raw = parsed.slice(url.from, url.to)
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
    raw = unescapeDestination(raw)
    if (/^(?:[a-z][a-z0-9+.-]*:|[/#?]|\\)/i.test(raw)) continue
    let decoded: string
    try { decoded = decodeURIComponent(raw.split(/[?#]/)[0]) } catch { throw new Error('The picture path cannot be read.') }
    if (!IMAGE_EXT.test(decoded)) continue
    const target = posix.normalize(posix.join(destDir, decoded))
    if (target === '..' || target.startsWith('../') || target.startsWith('/') || target.includes('\0')) {
      throw new Error(`The local picture is outside this workspace: ${raw}`)
    }
    targets.add(target)
  } while (cursor.next())
  return [...targets].sort()
}

const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Freeze the checked bytes of every local image `markdown` will render in `destPath`. Each file
 *  is read through the contained no-follow reader (the descriptor is the file the walk found):
 *  a missing, linked or unreadable picture refuses the preparation, because its rendered bytes
 *  could not be the ones reviewed. */
export async function freezeRenderedResources(root: string, destPath: string, markdown: string): Promise<RenderedResourceProof[]> {
  const targets = localRenderedImageTargets(destPath, markdown)
  if (targets.length === 0) return []
  let realRoot: string
  try { realRoot = await realpath(root) } catch { throw new Error('The workspace folder could not be read.') }
  const proofs: RenderedResourceProof[] = []
  for (const path of targets) {
    const read = await readContainedFile(realRoot, path, RESOURCE_MAX_BYTES)
    if (!read.ok) throw new Error(`The local picture could not be checked, so nothing was proposed: ${path}`)
    proofs.push({ path, sha256: sha256Bytes(read.bytes) })
  }
  return proofs
}

/** Re-read every frozen resource through the same checked reader and refuse on any difference. */
export async function assertRenderedResources(root: string, proofs: readonly RenderedResourceProof[]): Promise<void> {
  if (proofs.length === 0) return
  let realRoot: string
  try { realRoot = await realpath(root) } catch { throw new Error('A picture changed since this proposal was made, so nothing was inserted.') }
  for (const proof of proofs) {
    const read = await readContainedFile(realRoot, proof.path, RESOURCE_MAX_BYTES)
    if (!read.ok || sha256Bytes(read.bytes) !== proof.sha256) {
      throw new Error(`The picture ${proof.path} changed since this proposal was made, so nothing was inserted. Ask the agent again to see it as it stands.`)
    }
  }
}

/** The same proof checked synchronously in the tick of the document commit (`beforeCommit`):
 *  no-follow walk, no-follow open, descriptor identity, bytes from the descriptor. */
export function assertRenderedResourcesSync(root: string, proofs: readonly RenderedResourceProof[]): void {
  if (proofs.length === 0) return
  let realRoot: string
  try { realRoot = realpathSync(root) } catch { throw new Error('A picture changed since this proposal was made, so nothing was inserted.') }
  for (const proof of proofs) {
    const fail = (): never => { throw new Error(`The picture ${proof.path} changed since this proposal was made, so nothing was inserted. Ask the agent again to see it as it stands.`) }
    const walked = walkNoFollowSync(realRoot, proof.path)
    if (walked.kind !== 'file') fail()
    let fd: number | null = null
    try {
      fd = openSync(join(realRoot, ...proof.path.split('/')), OPEN_NOFOLLOW)
      const info = fstatSync(fd)
      if (!info.isFile() || info.dev !== (walked as { dev: number }).dev || info.ino !== (walked as { ino: number }).ino || info.size > RESOURCE_MAX_BYTES) fail()
      if (sha256Bytes(readFileSync(fd)) !== proof.sha256) fail()
    } catch (error) {
      if (error instanceof Error && error.message.includes('changed since this proposal')) throw error
      fail()
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }
}

export async function validateScratchAsset(root: string, origin: string, kind: ScratchAssetKind, markdown: string): Promise<void> {
  // Cited-reference entries are secondary projections of chips inside a complete object (a
  // table cell's citation counts in inventory without splitting the table), so they never
  // make the one-complete-object check reject the object that contains them.
  const objects = documentAssets(origin, markdown, 'disk').filter(object => object.kind !== 'ref')
  if (objects.length !== 1 || objects[0].kind !== kind || objects[0].markdown !== markdown) throw new Error('Choose one complete picture, SVG, table or widget. Its source was left unchanged.')
  if (kind === 'widget') await readCheckedScratchWidget(root, origin, markdown)
  const parsed = markdown.replace(/\r\n?/g, '\n')
  const tree = parseMarkdown(parsed)
  if (kind === 'svg') {
    const code = tree.topNode.firstChild?.getChild('CodeText')
    const checked = sanitiseSvg(code ? parsed.slice(code.from, code.to) : '')
    if ('error' in checked) throw new Error(checked.error)
  }
  const cursor = tree.cursor()
  do {
    if (cursor.name !== 'Image') continue
    const url = cursor.node.getChild('URL')
    if (!url) throw new Error('This picture uses an unresolved reference. Use a local picture path before collecting it.')
    let raw = parsed.slice(url.from, url.to)
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
    raw = unescapeDestination(raw)
    if (/^(?:[a-z][a-z0-9+.-]*:|[/#?]|\\)/i.test(raw)) throw new Error('Only local pictures in this workspace can be kept here.')
    let decoded: string
    try { decoded = decodeURIComponent(raw.split(/[?#]/)[0]) } catch { throw new Error('The picture path cannot be read.') }
    if (!/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(decoded)) throw new Error('This picture type is not supported.')
    const target = posix.normalize(posix.join(posix.dirname(origin), decoded))
    const contained = await containWorkspacePath(root, target)
    if (!contained.ok || !(await stat(contained.realPath).then(info => info.isFile(), () => false))) throw new Error(`The local picture is missing or outside this workspace: ${raw}`)
  } while (cursor.next())
}
