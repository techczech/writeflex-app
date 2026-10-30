/** Section page is a file mark, never a Plan/manifest role. Reuses the strict one-key editor and guarded,
 * basis-checked atomic document write. The ordinary role writer still owns any role/boundary change.
 * Undo keeps the exact affected documents and refuses stale content; a partial write rolls back only
 * over its own bytes, never over a later edit. Tokens are bounded and scoped to one Workspace/Folio.
 */
import { randomUUID } from 'node:crypto'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { withFolioDetail } from './folio-details'
import { parseFrontmatter } from './frontmatter'
import { readDocumentGuarded } from './guarded-document-read'
import { recordAdd, undoRecordedAdd } from './folio-add-undo'
import { indexNotePath, MANIFEST_NAME } from './folio'
import type { PlanCommitReceipt } from './plan'
import type { Workspace } from './workspace'
import { withPlanLock } from './plan-lock'
import { folioKey } from './folio-dir'

type RecordOfChange = { scope: string; path: string; before: string; after: string; orderToken: string | null }
const records = new Map<string, RecordOfChange>()
const scopeOf = (ws: Workspace, dir: string) => JSON.stringify(folioKey(ws.root, dir))

export function withSectionPage(source: string, section: boolean, path: string): string {
  const keys = Object.keys(parseFrontmatter(source)?.extra ?? {}).filter(key => key.toLocaleLowerCase() === 'folio')
  // Preserve the author's key spelling. The strict helper handles duplicate lines of the same key.
  if (!section) return keys.reduce((text, key) => withFolioDetail(text, key, null, path), source)
  const key = keys[0] ?? 'folio'
  const base = keys.length > 1 ? keys.slice(1).reduce((text, key) => withFolioDetail(text, key, null, path), source) : source
  const next = withFolioDetail(base, key, 'section', path)
  if (frontmatterBlock(base)) return next
  // The Details helper inserts a separating blank line for a new header. Section-role cycles
  // keep the original body verbatim so removing that header returns exactly the bare source.
  return next.slice(0, frontmatterBlock(next)!.end) + base.replace(/^\uFEFF/, '')
}

async function put(ws: Workspace, path: string, before: string, after: string) {
  await ws.saveFileWithoutReadBack(path, after, { documentOnly: true, allowExplicitEmpty: true, beforeCommit: ws.commitOnlyOver(path, { kind: 'disk', text: before }) })
}

export async function sectionRoleChange<T>(ws: Workspace, dir: string, path: string, section: boolean, run: (committed: (receipt: PlanCommitReceipt) => void) => Promise<T>, checkpoint?: (path: string) => Promise<void>): Promise<{ result: T; token: string | null }> {
  const source = (await readDocumentGuarded(ws, path)).content
  const next = withSectionPage(source, section, path)
  if (source !== next) { await checkpoint?.(path); await put(ws, path, source, next) }
  let result: T
  let orderToken: string | null = null
  const committed = (receipt: PlanCommitReceipt) => {
    const { index, manifest } = receipt
    const documents = (side: 'before' | 'after') => ({ indexPath: index.path, manifestPath: manifest.path, texts: new Map([[index.path, index[side]], [manifest.path, manifest[side]]]) })
    orderToken = recordAdd(ws, dir, documents('before'), documents('after'))
  }
  try { result = await run(committed) } catch (error) {
    // A refresh can fail AFTER the ordinary role writer committed. Undo its exact receipt first;
    // restoring only the page mark would leave it inconsistent with its new front-matter role.
    if (orderToken) {
      const restored = await undoRecordedAdd(ws, dir, orderToken)
      if (!restored.ok) throw new Error(`The role change was made, but its outline could not be read or restored. ${restored.message}`)
    }
    if (source !== next) await put(ws, path, next, source)
    throw new Error(`The role change could not be completed and was put back. ${error instanceof Error ? error.message : String(error)}`)
  }
  if (source === next && !orderToken) return { result, token: null }
  const token = `sr:${randomUUID()}`
  records.set(token, { scope: scopeOf(ws, dir), path, before: source, after: next, orderToken })
  for (const [old] of [...records].slice(0, Math.max(0, records.size - 40))) records.delete(old)
  return { result, token }
}

export async function undoSectionRole(ws: Workspace, dir: string, token: string, checkpoint?: (path: string) => Promise<void>): Promise<{ ok: boolean; message: string; paths?: string[] }> {
  return withPlanLock(ws, dir, async () => {
    const record = records.get(token)
    if (!record || record.scope !== scopeOf(ws, dir)) return { ok: false, message: 'That role change can no longer be undone.' }
    const { path, before, after, orderToken } = record
    let pageRestored = false
    try {
      if ((await readDocumentGuarded(ws, path)).content !== after) throw new Error('That part changed since its role was changed. Nothing was undone.')
      await checkpoint?.(path)
      if (before !== after) { await put(ws, path, after, before); pageRestored = true }
      if (orderToken) {
        const answer = await undoRecordedAdd(ws, dir, orderToken, { beforeIndexWrite: checkpoint, beforeManifestWrite: checkpoint })
        if (!answer.ok) {
          if (pageRestored) { await put(ws, path, before, after); pageRestored = false }
          return { ok: false, message: answer.message }
        }
      }
      records.delete(token)
      return { ok: true, message: 'Undone.', paths: [path, indexNotePath(ws, dir), dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME] }
    } catch (error) {
      if (pageRestored) {
        try { await put(ws, path, before, after) } catch { return { ok: false, message: 'The role Undo stopped and its page could not be restored. Check the Folio history.', paths: [path] } }
      }
      return { ok: false, message: error instanceof Error ? error.message : 'Could not undo that role change.' }
    }
  })
}
