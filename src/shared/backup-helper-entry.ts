import { join } from 'node:path'

// The development bundle is also the input to the signed standalone package helper.
export const BACKUP_HELPER_ENTRY = 'out/backup-helper/writeflex-backup-helper.js'
export const BACKUP_HELPER_RESOURCE = 'backup-helper'
export const BACKUP_HELPER_EXECUTABLE = 'writeflex-backup-helper'

export function standaloneHelperPath(resources: string): string {
  return join(resources, BACKUP_HELPER_RESOURCE, BACKUP_HELPER_EXECUTABLE + (process.platform === 'win32' ? '.exe' : ''))
}
