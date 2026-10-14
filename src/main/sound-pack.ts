import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SOUND_PACK_FILES } from '../shared/sound-pack'

/**
 * Serving the bundled sound pack to the renderer.
 *
 * The renderer cannot fetch() a file: URL from a file: page, and wf-asset is a workspace-scoped
 * image protocol — so the bytes come over IPC and are decoded once into cached AudioBuffers. The
 * shared table is the allowlist: a name that is not a pack file is refused before it touches disk,
 * so this channel can never be turned into an arbitrary-file read.
 */
export function soundPackDir(appDir: { packaged: boolean; resourcesPath: string; entryDir: string }): string {
  // Unpackaged, resolve from the BUILT ENTRY (out/main/index.js → ../../resources/sounds) for the
  // same reason bundled skills do: e2e launches Electron on out/main directly, where getAppPath()
  // is the entry directory rather than the repo root.
  return appDir.packaged
    ? join(appDir.resourcesPath, 'sounds')
    : join(appDir.entryDir, '..', '..', 'resources', 'sounds')
}

export function isPackFile(name: unknown): name is string {
  return typeof name === 'string' && SOUND_PACK_FILES.includes(name)
}

export async function readSoundFile(dir: string, name: unknown): Promise<Uint8Array | null> {
  if (!isPackFile(name)) return null
  try {
    return new Uint8Array(await readFile(join(dir, name)))
  } catch {
    return null // a missing pack file must leave the app silent, never crash a keystroke
  }
}
