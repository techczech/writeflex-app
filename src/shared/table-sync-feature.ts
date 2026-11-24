export type TableSyncAvailability = { available: true } | { available: false; reason: string }

export function tableSyncAvailability(_env: Readonly<Record<string, string | undefined>>): TableSyncAvailability {
  return { available: false, reason: 'Table sync is not available in this build.' }
}

export const isTableSyncCommand = (_id: string): boolean => false
