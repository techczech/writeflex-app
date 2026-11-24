/** The backup tool is named only as "the backup tool", and its records are read only from the folder set in
 *  Settings › Advanced › Backup: with that empty, a Git vault's remote copy shows "No backup tool connected". */
import { BACKUP_TOOL } from '../shared/remote-protection'
import type { BackupToolReader } from './backup-tool'
import { recordsReader } from './backup-tool-records'

export const BACKUP_TOOL_READER: BackupToolReader | null = recordsReader(BACKUP_TOOL, () => null)
