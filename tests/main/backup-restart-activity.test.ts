// Updating in place (ADR-0054), review round 1 finding 4: the backup helper's own cycles, scheduled ones too, hold an
// update's restart (src/main/backup-restart-activity.ts); an activity that cannot be read holds it as well. And
// finding 1's window closing (src/main/restart-windows.ts): false as soon as one window is kept open.
import { expect, test } from 'bun:test'
import { BACKUP_ACTIVITY_FRESH_MS, createBackupRestartActivity, type BackupActivity } from '../../src/main/backup-restart-activity'
import { restartBlockers } from '../../src/shared/update-install'
import { closeEveryWindow } from '../../src/main/restart-windows'

function rigActivity() {
  const r = { mayRun: true, t: 1_000, answers: [] as Array<BackupActivity | Error>, reads: 0, hold: null as null | ((v: BackupActivity) => void) }
  const activity = createBackupRestartActivity({
    helperMayRun: () => r.mayRun,
    read: () => {
      r.reads += 1
      const next = r.answers.shift()
      if (next === undefined) return new Promise<BackupActivity>((resolve) => { r.hold = resolve })
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    now: () => r.t,
  })
  return { r, activity }
}
/** The blockers as index.ts reads them, for the backup part only. */
const blockersFor = (hold: string, syncNow = false) => restartBlockers({
  focus: false, unsaved: false, diskChoice: false, agent: false, exporting: false, sharing: false,
  backup: syncNow || hold === 'cycling', backupUnknown: hold === 'unknown', finishing: false,
})

test('no helper process (backup off, or stopped): nothing holds and nothing is asked', async () => {
  const { r, activity } = rigActivity()
  r.mayRun = false
  expect(activity.hold()).toBe('none')
  await activity.refresh()
  expect(r.reads).toBe(0)
  expect(blockersFor(activity.hold())).toEqual([])
})

test('a scheduled cycle the helper reports holds the restart, like a Sync now', async () => {
  const { r, activity } = rigActivity()
  r.answers.push('cycling')
  await activity.refresh()
  expect(activity.hold()).toBe('cycling')
  expect(blockersFor(activity.hold())).toEqual(['backup'])
  r.answers.push('idle')
  await activity.refresh()
  expect(activity.hold()).toBe('none')
  expect(blockersFor(activity.hold())).toEqual([])
  expect(blockersFor(activity.hold(), true)).toEqual(['backup'])
})

test('activity that cannot be read holds the restart with a plain reason: never read, a failed read, an old read', async () => {
  const { r, activity } = rigActivity()
  expect(activity.hold()).toBe('unknown')
  expect(blockersFor(activity.hold())).toEqual(['backup-unknown'])
  r.answers.push(new Error('socket gone'))
  await activity.refresh()
  expect(activity.hold()).toBe('unknown')
  r.answers.push('unknown')
  await activity.refresh()
  expect(activity.hold()).toBe('unknown')
  r.answers.push('idle')
  await activity.refresh()
  expect(activity.hold()).toBe('none')
  r.t += BACKUP_ACTIVITY_FRESH_MS + 1
  expect(activity.hold()).toBe('unknown')
  r.mayRun = true
  r.t -= 2 * BACKUP_ACTIVITY_FRESH_MS // a clock that went backwards: not current either
  expect(activity.hold()).toBe('unknown')
})

test('the freshness of a read is the time it began (a cycle may start while it is answered)', async () => {
  const { r, activity } = rigActivity()
  const reading = activity.refresh()
  r.t += BACKUP_ACTIVITY_FRESH_MS - 5
  r.hold!('idle')
  await reading
  r.t += 10
  expect(activity.hold()).toBe('unknown')
})

test('one read at a time; refresh(maxAge) reads again only when the last one is older', async () => {
  const { r, activity } = rigActivity()
  const first = activity.refresh()
  const second = activity.refresh()
  expect(r.reads).toBe(1)
  r.hold!('idle')
  await Promise.all([first, second])
  await activity.refresh(10_000)
  expect(r.reads).toBe(1)
  r.t += 10_001
  r.answers.push('idle')
  await activity.refresh(10_000)
  expect(r.reads).toBe(2)
})

test('closing every window for a restart: true once all have closed, false as soon as one is kept open (or cannot start closing)', async () => {
  expect(await closeEveryWindow([], async () => true)).toBe(true)
  expect(await closeEveryWindow([1, 2, 3], async () => true)).toBe(true)
  let release!: (closed: boolean) => void
  const slow = new Promise<boolean>((resolve) => { release = resolve })
  // Window 1 is kept open while window 2 is still closing: the answer is false at once, not after window 2.
  const answer = closeEveryWindow([1, 2], (w) => (w === 1 ? Promise.resolve(false) : slow))
  expect(await answer).toBe(false)
  release(true)
  expect(await closeEveryWindow([1, 2], (w) => { if (w === 2) throw new Error('destroyed'); return Promise.resolve(true) })).toBe(false)
  expect(await closeEveryWindow([1], () => Promise.reject(new Error('gone')))).toBe(false)
})
