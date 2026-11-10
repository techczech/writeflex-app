// A workspace's portable, non-secret identity. Conflict copies are evidence, never removed.
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { readStoreFile, StoreFileChanged, StoreFileExists, writeStoreFile } from './checked-store-write'
import { workspaceIdentity, type WorkspaceIdentity } from '../../sharing-service/share-record-protocol.ts'

const REL = '.writeflex/sharing-workspace.json'
export async function sharingWorkspace(root: string, canonical?: WorkspaceIdentity, options: { readOnly?: boolean; fresh?: boolean } = {}): Promise<WorkspaceIdentity[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const primary = await readStoreFile(root, REL)
    let independent = options.fresh === true
    const identities = new Map<string, WorkspaceIdentity>()
    const take = (text: string | null): boolean => {
      if (!text) return false
      try {
        const raw = JSON.parse(text), id = workspaceIdentity(raw)
        if (id) identities.set(id.id, id)
        if (id && Array.isArray(raw.aliases)) for (const alias of raw.aliases.slice(0, 63)) {
          const w = workspaceIdentity(alias)
          if (w) identities.set(w.id, w)
        }
        return id !== null
      } catch { return false }
    }
    if (primary.state === 'refused') throw new Error(primary.message)
    if (primary.state === 'present' && (!take(primary.bytes.toString('utf8')) || primary.bytes.byteLength > 32768)) throw new Error('The workspace sharing identity is unreadable.')
    if (primary.state === 'present') independent ||= JSON.parse(primary.bytes.toString('utf8')).independent === true
    const names = await readdir(`${root}/.writeflex`).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    if (names.filter((name) => /^sharing-workspace.*\.json$/.test(name)).length > 64) throw new Error('Too many workspace identity copies.')
    for (const name of names.filter((name) => /^sharing-workspace.*\.json$/.test(name) && name !== 'sharing-workspace.json').sort()) {
      const copy = await readStoreFile(root, `.writeflex/${name}`)
      if (copy.state === 'refused') throw new Error(copy.message)
      if (!independent) take(copy.state === 'present' ? copy.bytes.toString('utf8') : null)
    }
    if (options.fresh) identities.clear()
    if (canonical) identities.set(canonical.id, canonical)
    if (options.readOnly) return [...identities.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    if (!identities.size) { const w = { id: randomUUID(), createdAt: Date.now() }; identities.set(w.id, w) }
    const all = [...identities.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const winner = canonical ?? all[0]
    const content = `${JSON.stringify({ ...winner, aliases: all.filter((w) => w.id !== winner.id), ...(independent ? { independent: true } : {}) })}\n`
    if (primary.state === 'present' && primary.bytes.toString('utf8') === content) return [winner, ...all.filter((w) => w.id !== winner.id)]
    try {
      await writeStoreFile(root, REL, content, primary.state === 'present' ? { mode: 'replace', expect: primary } : { mode: 'create' })
      return [winner, ...all.filter((w) => w.id !== winner.id)]
    } catch (error) { if (!(error instanceof StoreFileChanged || error instanceof StoreFileExists)) throw error }
  }
  throw new Error('The workspace identity kept changing.')
}
