/**
 * The Collections the app itself has opened: `recents` and `pinned` in the app's settings file. The
 * command line reads the file and never writes it. Node mode has no Electron `app`, so the location is
 * built here: `~/Library/Application Support/<variant folder>/settings.json`, for the release app and
 * the beta alike, since a folder either of them opened is one the user chose.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normaliseRoot } from '../root-resolution'

const VARIANT_FOLDERS = ['writeflex-desktop', 'writeflex-desktop-beta']
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024

export function appSettingsFiles(home: string = homedir()): string[] {
  return VARIANT_FOLDERS.map((folder) => join(home, 'Library', 'Application Support', folder, 'settings.json'))
}

/** Canonical roots listed in any of `settingsFiles`. A missing or unreadable file lists nothing. */
export function openedCollections(settingsFiles: string[]): Set<string> {
  const roots = new Set<string>()
  for (const file of settingsFiles) {
    try {
      if (lstatSync(file).size > MAX_SETTINGS_BYTES) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { recents?: unknown; pinned?: unknown }
      const recents = Array.isArray(parsed.recents) ? parsed.recents.map((entry) => (entry as { root?: unknown } | null)?.root) : []
      const pinned = Array.isArray(parsed.pinned) ? parsed.pinned : []
      for (const root of [...recents, ...pinned]) if (typeof root === 'string' && root !== '') roots.add(normaliseRoot(root))
    } catch { /* not there, or not JSON: nothing listed */ }
  }
  return roots
}
