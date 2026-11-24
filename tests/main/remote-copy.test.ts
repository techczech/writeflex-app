/**
 * Issue 257, review round 2 of PR 317: the remote-copy status per vault (src/main/remote-copy.ts). Changing the
 * records folder never hides known ignored-file gaps, and a read started under an earlier selection never publishes,
 * even when the selection comes back to the same folder.
 */
import { test, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createRemoteCopy, type ProtectionHolder } from '../../src/main/remote-copy'
import { BACKUP_TOOL_RECORDS_KEY } from '../../src/shared/git-sync-settings'
import type { IgnoreAudit } from '../../src/shared/remote-protection'
import { home } from './backup-tool-records-fixture'
import { BACKUP_TOOL_READER } from '../../src/main/backup-tool-adapter'

const GAPS: IgnoreAudit = { checkedAt: Date.now(), notes: { count: 1, examples: ['draft.notes.md'] }, recovery: { count: 0, examples: [] }, history: { count: 0, examples: [] }, sources: ['.gitignore line 1'] }
const until = async (done: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!done()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) } }
const settled = () => new Promise(r => setTimeout(r, 300))

test('known ignored-file gaps survive a change of records folder, to none and to another', async () => {
  const a = await home(), b = await home()
  try {
    let folder: string | null = a.records
    const copy = createRemoteCopy({ get: key => key === BACKUP_TOOL_RECORDS_KEY ? folder : null })
    const holder: ProtectionHolder = { gitFolder: true, discovery: { state: 'tools-missing' } }
    copy.refreshProtection(a.folder, holder, false)
    await until(() => holder.protection?.evidence.state === 'protected' && holder.ignored !== undefined)
    holder.ignored = GAPS // the audit found gaps (it is throttled for five minutes from here)
    // Cleared: in a build with no default records folder, the neutral state shows at once, gaps kept.
    folder = null
    if (BACKUP_TOOL_READER?.defaultRecords('/base/writer') === null) expect(copy.currentProtection(holder)).toMatchObject({ evidence: { state: 'unavailable', reason: 'not-connected' }, ignored: GAPS })
    // A folder with no records: read afresh, gaps kept.
    folder = '/base/writer/.missingsync'
    expect(copy.currentProtection(holder)).toBeUndefined()
    copy.refreshProtection(a.folder, holder, false)
    await until(() => holder.protection?.evidence.state === 'unavailable')
    expect(copy.currentProtection(holder)).toMatchObject({ evidence: { state: 'unavailable', reason: 'not-installed' }, ignored: GAPS })
    folder = b.records
    expect(copy.currentProtection(holder)).toBeUndefined() // checking the new folder; the old reading is gone
    copy.refreshProtection(a.folder, holder, false)
    // B's records describe another repository: a reading of it shows, with the gaps found earlier.
    await until(() => holder.protection !== undefined)
    expect(copy.currentProtection(holder)).toMatchObject({ evidence: { state: 'unavailable', reason: 'not-managed' }, ignored: GAPS })
  } finally { await rm(a.home, { recursive: true, force: true }); await rm(b.home, { recursive: true, force: true }) }
})

test('a read started under an earlier selection never publishes, even after A → B → A', async () => {
  const a = await home(), b = await home()
  try {
    let folder: string | null = a.records
    const copy = createRemoteCopy({ get: key => key === BACKUP_TOOL_RECORDS_KEY ? folder : null })
    const holder: ProtectionHolder = { gitFolder: true, discovery: { state: 'tools-missing' } }
    copy.refreshProtection(a.folder, holder, false) // read of A starts
    folder = b.records; copy.refreshProtection(a.folder, holder, false)
    folder = a.records; copy.refreshProtection(a.folder, holder, false)
    await settled(); await until(() => holder.ignored !== undefined)
    await settled()
    expect(holder.protection).toBeUndefined()
    expect(copy.currentProtection(holder)).toBeUndefined()
    copy.refreshProtection(a.folder, holder, false) // a read under the current selection publishes
    await until(() => holder.protection?.evidence.state === 'protected')
  } finally { await rm(a.home, { recursive: true, force: true }); await rm(b.home, { recursive: true, force: true }) }
})
