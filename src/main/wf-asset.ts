import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allStates } from './state'

/** The one containment rule: where `relativePath` really lands, or why it may not be used. */
export async function containWorkspacePath(
  root: string,
  relativePath: string,
): Promise<{ ok: true; realPath: string } | { ok: false; reason: 'missing' | 'outside' }> {
  if (!relativePath || relativePath.includes('\0')) return { ok: false, reason: 'missing' }
  const candidate = resolve(root, relativePath)
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return { ok: false, reason: 'outside' }
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return { ok: false, reason: 'missing' } }
  let realCandidate: string
  try { realCandidate = await realpath(candidate) } catch { return { ok: false, reason: 'missing' } }
  const realRel = relative(realRoot, realCandidate)
  return realRel !== '..' && !realRel.startsWith(`..${sep}`) && !realRel.startsWith(sep) && !isAbsolute(realRel)
    ? { ok: true, realPath: realCandidate }
    : { ok: false, reason: 'outside' }
}

export async function resolveWorkspaceAsset(root: string, relativePath: string): Promise<string | null> {
  const contained = await containWorkspacePath(root, relativePath)
  return contained.ok ? contained.realPath : null
}

export async function registerAssetProtocol(): Promise<void> {
  const { protocol, net } = await import('electron')
  protocol.handle('wf-asset', async (request) => {
    const url = new URL(request.url)
    // Isolation is the per-window 128-bit random token in the hostname — protocol.handle requests
    // carry no webContents identity (the field Codex reached for does not exist; every request
    // matched nothing and every local image 404'd — C1 review find, 2026-07-11).
    const state = allStates().find((entry) => entry.assetToken === url.hostname)
    if (!state?.workspace) return new Response(null, { status: 404 })
    const file = await resolveWorkspaceAsset(state.workspace.root, decodeURIComponent(url.pathname.replace(/^\//, '')))
    return file ? net.fetch(pathToFileURL(file).href) : new Response(null, { status: 404 })
  })
}
