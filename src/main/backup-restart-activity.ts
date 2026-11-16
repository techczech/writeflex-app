// Updating in place (ADR-0054 "What differs" 1): whether the backup helper is running a cycle, as the restart's
// admission reads it. The helper (a child process, backup-helper/supervisor.ts) runs scheduled cycles on its own
// timer, which WriteFlex does not see begin; only its status answer says whether a vault is cycling. The admission
// reads synchronously, so the answer is read asynchronously beforehand (`refresh`, before the hand-over, before the
// commit and every 10 s while an update waits) and kept with the time the read began.
//  - No helper process of this app, and none about to start: no cycle can run ('none').
//  - A helper is (or may be) there: its last answer, if it began within FRESH_MS and said idle ('none') or cycling
//    ('cycling'). No answer, a failed read or an old one is 'unknown', and 'unknown' holds the restart like a cycle.
// At the commit the app stops the helper itself after the windows have closed (index.ts), so no new scheduled cycle
// can begin before the install; no Electron here.

export type BackupActivity = 'idle' | 'cycling' | 'unknown'
export type BackupHold = 'none' | 'cycling' | 'unknown'

/** How long a read of the helper's activity counts as current. */
export const BACKUP_ACTIVITY_FRESH_MS = 15_000

export interface BackupRestartActivityPorts {
  /** A helper process of this app is running, or may start on its own (a retry timer): anything but stopped. */
  helperMayRun(): boolean
  /** Asks the helper about every vault it serves: 'cycling' if any is, 'unknown' if any answer is missing. */
  read(): Promise<BackupActivity>
  now(): number
}

export function createBackupRestartActivity(ports: BackupRestartActivityPorts) {
  let last: { value: BackupActivity; at: number } | null = null
  let reading: Promise<void> | null = null

  return {
    /** Synchronous: whether backup work holds a restart now. */
    hold(): BackupHold {
      let mayRun: boolean
      try { mayRun = ports.helperMayRun() } catch { return 'unknown' }
      if (!mayRun) return 'none'
      if (!last || ports.now() - last.at > BACKUP_ACTIVITY_FRESH_MS || ports.now() < last.at) return 'unknown'
      return last.value === 'idle' ? 'none' : last.value
    },
    /** Reads the helper's activity again, unless a read is running or the last one began within `maxAgeMs`. */
    refresh(maxAgeMs = 0): Promise<void> {
      if (reading) return reading
      if (last && maxAgeMs > 0 && ports.now() - last.at < maxAgeMs) return Promise.resolve()
      let mayRun: boolean
      try { mayRun = ports.helperMayRun() } catch { mayRun = true }
      if (!mayRun) return Promise.resolve()
      const began = ports.now()
      reading = (async () => {
        let value: BackupActivity
        try { value = await ports.read() } catch { value = 'unknown' }
        last = { value, at: began }
      })().finally(() => { reading = null })
      return reading
    },
  }
}
export type BackupRestartActivity = ReturnType<typeof createBackupRestartActivity>
