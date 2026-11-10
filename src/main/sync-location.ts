/**
 * Detect a OneDrive Collection from its typed and resolved macOS location, without a service call.
 * Replica versions and duplicate reconciliation apply only to this supported provider.
 * Recognise CloudStorage mounts and the provider's standard top-level home-folder names;
 * a similarly named folder deeper in Documents does not qualify. Other providers keep their behaviour.
 */
import { realpathSync } from 'node:fs'
import { dirname, sep } from 'node:path'

const CLOUD_STORAGE_ONEDRIVE = /^OneDrive(?:FileProvider)?(?:-.+)?$/
const HOME_ONEDRIVE = /^OneDrive(?:$| - .+|-.+)/

function oneDriveByName(path: string): boolean {
  const parts = path.split(sep).filter(Boolean)
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === 'Library' && parts[i + 1] === 'CloudStorage' && CLOUD_STORAGE_ONEDRIVE.test(parts[i + 2])) return true
  }
  return parts[0] === 'Users' && parts.length >= 3 && HOME_ONEDRIVE.test(parts[2])
}

/** The real path of `path`, or of its deepest existing ancestor joined with the rest. */
function realOrDeepest(path: string): string {
  let current = path
  let rest = ''
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync.native(current)
      return rest ? `${real}${sep}${rest}` : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      rest = rest ? `${current.slice(parent.length + 1)}${sep}${rest}` : current.slice(parent.length + 1)
      current = parent
    }
  }
  return path
}

/** Whether the absolute `path` (a Collection root or a document in one) lies in a OneDrive folder. */
export function isSyncedLocation(path: string): boolean {
  return oneDriveByName(path) || oneDriveByName(realOrDeepest(path))
}
