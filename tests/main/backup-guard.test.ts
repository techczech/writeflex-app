import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm, readdir, rename, chmod, utimes, symlink, mkdir } from 'node:fs/promises'
import * as crypto from 'node:crypto'
import { readFileSync, lstatSync, writeFileSync, unlinkSync, renameSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { putBackStep, stepChanges } from '../../src/main/standard-widgets/step-put-back'
import { join } from 'node:path'
import { rollBackOperationWrites } from '../../src/main/operation-rollback'
import { Workspace, atomicWriteSeams, type OperationWrite } from '../../src/main/workspace'
import { backupManifestDocument } from '../../src/main/plan'
import * as backups from '../../src/main/backup-guard'

let root: string
let ws: Workspace
const file = '_report-structure.json'
const backup = `${file}.writeflex-backup`
const original = '{"files": []}\n'
beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dir, '.backup-guard-'))
  ws = new Workspace(root)
  await writeFile(join(root, file), original)
})
afterEach(async () => {
  delete atomicWriteSeams.afterCommit
  await rm(root, { recursive: true, force: true })
})
const read = (path: string) => readFile(join(root, path), 'utf8')
const make = () => backupManifestDocument(ws, '', original)

test('new backup stays a byte copy and records path, hash and time before publication', async () => {
  atomicWriteSeams.afterCommit = async (path) => {
    if (path === join(root, backup)) {
      const record = JSON.parse(await read(`${backup}.json`))
      expect(record.path).toBe(file)
      expect(record.hash).toMatch(/^[a-f0-9]{64}$/)
      expect(Number.isFinite(Date.parse(record.createdAt))).toBe(true)
    }
  }
  await make()
  expect(await read(backup)).toBe(original)
  expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
})

test('WriteFlex edit then restore is allowed, including after reopening', async () => {
  await make()
  await ws.saveFile(file, '{"files": [], "title": "New"}\n')
  ws = new Workspace(root)
  expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
  await backups.restoreBackup(ws, backup)
  expect(await read(file)).toBe(original)
})

test('outside replacement after a WriteFlex edit is refused without changing bytes', async () => {
  await make()
  await ws.saveFile(file, '{"files": [], "title": "New"}\n')
  await writeFile(join(root, 'replacement'), 'different file\n')
  await rename(join(root, 'replacement'), join(root, file))
  expect((await backups.inspectBackup(ws, backup)).status).toBe('stale')
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe('different file\n')
})

test('outside replacement followed by a WriteFlex save cannot manufacture lineage', async () => {
  await make()
  await writeFile(join(root, file), 'outside replacement\n')
  await ws.saveFile(file, 'later app edit\n')
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe('later app edit\n')
})

test('legacy restore requires explicit confirmation showing both files', async () => {
  await writeFile(join(root, backup), 'legacy copy\n')
  expect((await backups.inspectBackup(ws, backup)).status).toBe('confirmation-required')
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('confirmation')
  expect(await read(file)).toBe(original)
  await backups.restoreBackup(ws, backup, async (comparison) => {
    expect(comparison).toEqual({ path: file, backupPath: backup, current: original, backup: 'legacy copy\n' })
    return true
  })
  expect(await read(file)).toBe('legacy copy\n')
})

test('legacy confirmation is invalidated by either file changing', async () => {
  await writeFile(join(root, backup), 'legacy copy\n')
  await expect(backups.restoreBackup(ws, backup, async () => {
    await writeFile(join(root, file), 'outside change\n')
    return true
  })).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe('outside change\n')
})

test('wrong recorded path and missing target list as stale and preserve all files', async () => {
  await make()
  const record = JSON.parse(await read(`${backup}.json`))
  await writeFile(join(root, `${backup}.json`), JSON.stringify({ ...record, path: 'another.md' }))
  expect((await backups.listBackups(ws)).map((item) => item.status)).toEqual(['stale'])
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  await rm(join(root, file))
  expect((await backups.listBackups(ws))[0].status).toBe('stale')
  expect(await read(backup)).toBe(original)
})

test('record failure publishes no backup or temporary files', async () => {
  const save = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = async (path, content, options) => {
    if (path === `${backup}.json`) throw new Error('record refused')
    return save(path, content, options)
  }
  await expect(make()).rejects.toThrow('record refused')
  expect(await readdir(root)).toEqual([file])
})

test('backup publication failure removes its record and leaves the source untouched', async () => {
  const save = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = async (path, content, options) => {
    if (path === backup) throw new Error('backup refused')
    return save(path, content, options)
  }
  await expect(make()).rejects.toThrow('backup refused')
  expect(await readdir(root)).toEqual([file])
  expect(await read(file)).toBe(original)
})

test('an in-place outside edit after an app save is stale, and tampered backup bytes are refused', async () => {
  await make()
  await ws.saveFile(file, 'app version\n')
  await writeFile(join(root, file), 'outside in-place version\n')
  expect((await backups.inspectBackup(ws, backup)).status).toBe('stale')
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  await writeFile(join(root, file), original)
  await writeFile(join(root, backup), 'tampered copy\n')
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe(original)
})

test('corrupt provenance is stale rather than eligible for legacy confirmation', async () => {
  await make()
  await writeFile(join(root, `${backup}.json`), '{invalid')
  expect((await backups.inspectBackup(ws, backup)).status).toBe('stale')
  await expect(backups.restoreBackup(ws, backup, async () => true)).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe(original)
})

test('cancelling legacy confirmation preserves both files', async () => {
  await writeFile(join(root, backup), 'legacy copy\n')
  await expect(backups.restoreBackup(ws, backup, async () => false)).rejects.toThrow('confirmation')
  expect(await read(file)).toBe(original)
  expect(await read(backup)).toBe('legacy copy\n')
})

test('a current-file change after restore staging refuses the commit', async () => {
  await make()
  await ws.saveFile(file, 'app version\n')
  const save = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = async (path, content, options) => {
    if (path === file) await writeFile(join(root, file), 'racing replacement\n')
    return save(path, content, options)
  }
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe('racing replacement\n')
})


test('orphan records stay hidden at their exact raw name and list as stale', async () => {
  await make()
  const evidence = await read(`${backup}.json`)
  await rm(join(root, backup))
  expect((await backups.listBackups(ws)).map((item) => item.status)).toEqual(['stale'])
  const uuid = '12345678-1234-4234-8234-123456789abc'
  const random = spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
  try { await make() } finally { random.mockRestore() }
  const aside = `.writeflex/backup-records-set-aside/${backup}.json.${uuid}.json`
  expect(await readdir(join(root, '.writeflex/backup-records-set-aside'))).toEqual([`${backup}.json.${uuid}.json`])
  expect(await read(aside)).toBe(evidence)
  expect(await ws.listFiles()).toEqual([])
  expect((await backups.listBackups(ws)).find((item) => item.recordPath === aside)?.status).toBe('stale')
  expect((await backups.listBackups(ws)).find((item) => item.recordPath === aside)).toMatchObject({ path: file, recordPath: aside })
  expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
})

test('operation rollback restores the orphan record bytes under the sidecar name', async () => {
  await make()
  const evidence = await read(`${backup}.json`)
  await rm(join(root, backup))
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, make)
  expect(log.find((write) => write.path === `${backup}.json`)?.before).toBe(evidence)
  const outcome = await rollBackOperationWrites(ws, log)
  expect(outcome.changed).toEqual([])
  expect(outcome.failed).toEqual([])
  expect(await read(`${backup}.json`)).toBe(evidence)
  expect(await readdir(root)).not.toContain('.writeflex')
  expect((await backups.listBackups(ws)).map((item) => item.status)).toEqual(['stale'])
})

test('record removed between inspection and capture requires confirmation', async () => {
  await make()
  const absolute = ws.absolute.bind(ws)
  let reads = 0
  ws.absolute = (path) => {
    if (path === `${backup}.json` && ++reads === 1) queueMicrotask(() => {
      writeFileSync(absolute(file), 'outside replacement\n')
      unlinkSync(absolute(`${backup}.json`))
    })
    return absolute(path)
  }
  let asked = false
  await expect(backups.restoreBackup(ws, backup, async (comparison) => {
    asked = true
    expect(comparison.current).toBe('outside replacement\n')
    return false
  })).rejects.toThrow('confirmation')
  expect(asked).toBe(true)
  expect(await read(file)).toBe('outside replacement\n')
})

test('rollback restores lineage for later WriteFlex saves and restore', async () => {
  await make()
  await ws.saveFile(file, 'first app version\n')
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, () => ws.saveFile(file, 'failed operation version\n'))
  const outcome = await rollBackOperationWrites(ws, log)
  expect(outcome.changed).toEqual([])
  expect(outcome.failed).toEqual([])
  expect(await read(file)).toBe('first app version\n')
  expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
  await ws.saveFile(file, 'later app version\n')
  expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
  await backups.restoreBackup(ws, backup)
  expect(await read(file)).toBe(original)
})

test('metadata-only changes do not invalidate lineage', async () => {
  await make()
  await ws.saveFile(file, 'app version\n')
  await chmod(join(root, file), 0o600)
  await utimes(join(root, file), new Date(0), new Date(0))
  expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
  await ws.saveFile(file, 'later app version\n')
  await backups.restoreBackup(ws, backup)
  expect(await read(file)).toBe(original)
})

test('lineage sidecar is marked as an own write before it lands', async () => {
  await make()
  ws.forgetOwnWrites(`${backup}.json`)
  const record = ws.recordOwnWrite.bind(ws)
  let markedBeforeLanding = false
  const before = await read(`${backup}.json`)
  ws.recordOwnWrite = (path, expected, at) => {
    if (path === `${backup}.json`) {
      markedBeforeLanding = true
      expect(readFileSync(join(root, path), 'utf8')).toBe(before)
      expect(expected).toBeDefined()
    }
    record(path, expected, at)
  }
  await ws.saveFile(file, 'app version\n')
  expect(markedBeforeLanding).toBe(true)
  expect(ws.wasRecentlyWrittenByApp(`${backup}.json`)).toBe(true)
})

test('legacy confirmation lets an unrelated editor save complete before the person answers', async () => {
  await writeFile(join(root, backup), 'legacy copy\n')
  let entered!: () => void
  const opened = new Promise<void>((resolve) => { entered = resolve })
  let answer!: (value: boolean) => void
  const confirmed = new Promise<boolean>((resolve) => { answer = resolve })
  const restoring = backups.restoreBackup(ws, backup, async () => { entered(); return confirmed })
  await opened
  let saved = false
  const saving = ws.saveFile('other.md', 'editor text\n').then(() => { saved = true })
  try {
    await Promise.race([saving, new Promise((resolve) => setTimeout(resolve, 1000))])
    expect(saved).toBe(true)
  } finally {
    answer(true)
    await restoring
    await saving
  }
})


test('extended attributes do not invalidate a WriteFlex version', () => {
  if (process.platform !== 'darwin') return
  return (async () => {
    await make()
    await ws.saveFile(file, 'app version\n')
    execFileSync('/usr/bin/xattr', ['-w', 'com.writeflex.backup-test', 'metadata', join(root, file)])
    expect((await backups.inspectBackup(ws, backup)).status).toBe('ready')
  })()
})

test('widget put-back preserves lineage for subsequent saves', async () => {
  const path = `folio/${file}`
  const copy = `${path}.writeflex-backup`
  await mkdir(join(root, 'folio'))
  await writeFile(join(root, path), original)
  await backups.createBackup(ws, path, original)
  await ws.saveFile(path, 'first app version\n')
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, () => ws.saveFile(path, 'step version\n'))
  const { dev, ino } = lstatSync(join(root, 'folio'))
  const outcome = await putBackStep(ws, root, stepChanges(log), new Map([['folio', { dev, ino }]]))
  expect(outcome.changed).toEqual([])
  expect(outcome.failed).toEqual([])
  expect((await backups.inspectBackup(ws, copy)).status).toBe('ready')
  await ws.saveFile(path, 'later app version\n')
  await backups.restoreBackup(ws, copy)
  expect(await read(path)).toBe(original)
})

test('moved sidecars list as stale and listing never changes bytes or names', async () => {
  await make()
  await rename(join(root, `${backup}.json`), join(root, 'moved.md.writeflex-backup.json'))
  await writeFile(join(root, 'legacy.md.writeflex-backup'), 'legacy\n')
  const names = (await readdir(root)).sort()
  const before = await Promise.all(names.map(read))
  expect((await backups.listBackups(ws)).find((item) => item.path === 'moved.md')?.status).toBe('stale')
  expect((await readdir(root)).sort()).toEqual(names)
  expect(await Promise.all(names.map(read))).toEqual(before)
})

test('a symlinked current file or backup refuses restore and leaves its target untouched', async () => {
  await make()
  await rename(join(root, file), join(root, 'target'))
  await symlink(join(root, 'target'), join(root, file))
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  expect(await read('target')).toBe(original)
  await rm(join(root, file))
  await rename(join(root, 'target'), join(root, file))
  await rename(join(root, backup), join(root, 'target'))
  await symlink(join(root, 'target'), join(root, backup))
  await expect(backups.restoreBackup(ws, backup)).rejects.toThrow('Nothing was written')
  expect(await read('target')).toBe(original)
})

test('legacy confirmation is invalidated when its backup changes', async () => {
  await writeFile(join(root, backup), 'legacy\n')
  await expect(backups.restoreBackup(ws, backup, async () => {
    await writeFile(join(root, backup), 'changed backup\n')
    return true
  })).rejects.toThrow('Nothing was written')
  expect(await read(file)).toBe(original)
})

test('rollback removes a newly created backup pair without lineage interfering with cleanup', async () => {
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, async () => {
    await make()
    await ws.saveFile(file, 'operation version\n')
  })
  const outcome = await rollBackOperationWrites(ws, log)
  expect(outcome.changed).toEqual([])
  expect(outcome.failed).toEqual([])
  expect(await readdir(root)).toEqual([file])
  expect(await read(file)).toBe(original)
})


test('set-aside refuses a taken exact name without replacing either record', async () => {
  await make()
  const evidence = await read(`${backup}.json`)
  const aside = '.writeflex/backup-records-set-aside/existing.json'
  await mkdir(join(root, '.writeflex/backup-records-set-aside'), { recursive: true })
  await writeFile(join(root, aside), 'older evidence\n')
  await expect(ws.setAsideBackupRecord(`${backup}.json`, aside)).rejects.toThrow()
  expect(await read(`${backup}.json`)).toBe(evidence)
  expect(await read(aside)).toBe('older evidence\n')
})

test('set-aside refuses linked storage and destinations outside the workspace', async () => {
  await make()
  const evidence = await read(`${backup}.json`)
  await mkdir(join(root, 'storage'))
  await symlink(join(root, 'storage'), join(root, '.writeflex'))
  await expect(ws.setAsideBackupRecord(`${backup}.json`, '.writeflex/backup-records-set-aside/record.json')).rejects.toThrow()
  await expect(ws.setAsideBackupRecord(`${backup}.json`, '../record.json')).rejects.toThrow()
  expect(await read(`${backup}.json`)).toBe(evidence)
  expect(await readdir(join(root, 'storage'))).toEqual([])
})


test('rollback keeps set-aside evidence when an outside writer replaces the new sidecar', async () => {
  await make()
  const evidence = await read(`${backup}.json`)
  await rm(join(root, backup))
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, make)
  const aside = log.find((write) => write.path.startsWith('.writeflex/backup-records-set-aside/'))!.path
  await writeFile(join(root, `${backup}.json`), 'outside record\n')
  const outcome = await rollBackOperationWrites(ws, log)
  expect(outcome.changed).toContain(`${backup}.json`)
  expect(await read(aside)).toBe(evidence)
  expect(await read(`${backup}.json`)).toBe('outside record\n')
})


for (const swapped of ['.writeflex', '.writeflex/backup-records-set-aside']) {
  test(`set-aside refuses ${swapped} swapped for a link just before publication`, async () => {
    await make()
    const evidence = await read(`${backup}.json`)
    await mkdir(join(root, '.writeflex/backup-records-set-aside'), { recursive: true })
    await mkdir(join(root, 'outside-store/backup-records-set-aside'), { recursive: true })
    const recordOwnWrite = ws.recordOwnWrite.bind(ws)
    ws.recordOwnWrite = (path, expected, at) => {
      if (path.startsWith('.writeflex/backup-records-set-aside/')) {
        const originalFolder = join(root, swapped)
        renameSync(originalFolder, `${originalFolder}-held`)
        symlinkSync(join(root, swapped === '.writeflex' ? 'outside-store' : 'outside-store/backup-records-set-aside'), originalFolder)
      }
      recordOwnWrite(path, expected, at)
    }
    await expect(ws.setAsideBackupRecord(`${backup}.json`, '.writeflex/backup-records-set-aside/record.json')).rejects.toThrow('folder changed')
    expect(await read(`${backup}.json`)).toBe(evidence)
    expect(await readdir(join(root, 'outside-store/backup-records-set-aside'))).toEqual([])
  })
}

test('rollback keeps pre-existing evidence folders', async () => {
  await make()
  await rm(join(root, backup))
  await mkdir(join(root, '.writeflex/backup-records-set-aside'), { recursive: true })
  const log: OperationWrite[] = []
  await ws.recordingOperationWrites(log, make)
  await rollBackOperationWrites(ws, log)
  expect(await readdir(join(root, '.writeflex/backup-records-set-aside'))).toEqual([])
})
