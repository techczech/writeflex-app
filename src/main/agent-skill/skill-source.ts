// The skill as the app carries it: a folder with SKILL.md and references/. Read once into memory, with
// the hash of every file, so a write is exactly what was read. Refuses an unstamped or foreign skill
// (the build stamps metadata.app and metadata.app-version into SKILL.md). No Electron import.
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

export const MARKER_FILE = '.app-skill.json'

export interface SkillSource {
  appId: string
  version: string
  files: Map<string, Buffer>
  hashes: Record<string, string>
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** `metadata.app` and `metadata.app-version` from SKILL.md's frontmatter (a small reader for exactly those two keys). */
export function readSkillMetadata(skillMd: string): { app: string | null; version: string | null } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
  if (!fm) return { app: null, version: null }
  const lines = fm[1].split(/\r?\n/)
  let inMetadata = false
  const out: { app: string | null; version: string | null } = { app: null, version: null }
  for (const line of lines) {
    if (/^metadata:\s*$/.test(line)) { inMetadata = true; continue }
    if (inMetadata && !/^\s+\S/.test(line)) inMetadata = false
    if (!inMetadata) continue
    const m = /^\s+(app|app-version):\s*(.*?)\s*$/.exec(line)
    if (m) {
      const value = m[2].replace(/^(["'])(.*)\1$/, '$2')
      if (m[1] === 'app') out.app = value || null
      else out.version = value || null
    }
  }
  return out
}

const SAFE_REL = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\\]+$/

export async function loadSkillSource(dir: string, appId: string): Promise<SkillSource> {
  const files = new Map<string, Buffer>()
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name)
      const childRel = rel ? posix.join(rel, entry.name) : entry.name
      if (entry.isSymbolicLink()) throw new Error(`The skill holds a link (${childRel}); it is not installed.`)
      if (entry.isDirectory()) await walk(childAbs, childRel)
      else if (entry.isFile()) {
        if (childRel === MARKER_FILE || !SAFE_REL.test(childRel)) throw new Error(`The skill holds a file that cannot be installed (${childRel}).`)
        files.set(childRel, await readFile(childAbs))
      }
    }
  }
  const top = await lstat(dir)
  if (!top.isDirectory()) throw new Error('The skill folder is not a folder.')
  await walk(dir, '')
  const skillMd = files.get('SKILL.md')
  if (!skillMd) throw new Error('The skill has no SKILL.md.')
  const meta = readSkillMetadata(skillMd.toString('utf8'))
  if (meta.app !== appId || !meta.version) throw new Error('The skill is not stamped with this app and its version (run the build).')
  const hashes: Record<string, string> = {}
  for (const [rel, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) hashes[rel] = sha256(data)
  return { appId, version: meta.version, files, hashes }
}
