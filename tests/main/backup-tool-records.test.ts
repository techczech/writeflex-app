/**
 * Issue 257: a writer relying on a backup tool sees whether this folder's writing is known to have reached its
 * remote, read from synthetic copies of the tool's own records (src/main/backup-tool-records.ts) and never inferred
 * from a save. Includes one regression per review finding. Runs in every build.
 */
import { test, expect, describe } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, unlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedRecord, readRecordEvidence, recordFolders, statusFolder } from '../../src/main/backup-tool-records'
import type { BackupToolEvidence } from '../../src/shared/remote-protection'
import { HEAD, ID, NOW, TREE, home, s, type Over } from './backup-tool-records-fixture'

test('the status folder sits beside the settings folder: ~/.tool keeps its status in ~/.local/state/tool', () => {
  expect(statusFolder('/base/writer/.examplesync')).toBe('/base/writer/.local/state/examplesync')
})

async function read(over: Over = {}, sub = ''): Promise<BackupToolEvidence> {
  const h = await home(over)
  try { return await readRecordEvidence(join(h.folder, sub), { records: h.records, home: h.home, now: NOW }) } finally { await rm(h.home, { recursive: true, force: true }) }
}
const verified = s(NOW - 60_000) * 1000

describe('backup tool records, each state', () => {
  test('protected: a complete verified agreement, pending the local comparison; a plain subfolder Collection shares it', async () => {
    const top = await read()
    expect(top).toEqual({ state: 'protected', unit: '02_writing-creation/book', verifiedAt: verified, head: HEAD, root: expect.stringMatching(/\/repos\/02_writing-creation\/book$/), branch: 'main', coverage: { kind: 'unchecked' } })
    // Each read has its own synthetic home; the subfolder names the same repository root.
    expect(await read({}, 'chapters')).toEqual({ ...top, root: expect.stringMatching(/\/repos\/02_writing-creation\/book$/) })
  })
  test('the tool’s own record of newer writing is kept as waiting', async () => {
    expect(await read({ entry: e => { e.clean = false; e.dirty_count = 2 } })).toMatchObject({ state: 'protected', coverage: { kind: 'waiting', since: null } })
  })
  test('excluded: deselected for this Mac, or not in the bucket default (the incident); explicit selection wins', async () => {
    expect(await read({ catalogue: c => { c.accepted.repositories[ID].selections = { air: 'deselected' } } }))
      .toEqual({ state: 'excluded', unit: '02_writing-creation/book', machine: 'Desk Mac' })
    expect(await read({ catalogue: c => { c.accepted.buckets['bucket-02'].default_selected_machines = ['macbook-pro'] } })).toMatchObject({ state: 'excluded' })
    expect(await read({ catalogue: c => { c.accepted.buckets['bucket-02'].default_selected_machines = []; c.accepted.repositories[ID].selections = { air: 'selected' } } })).toMatchObject({ state: 'protected' })
    expect((await read({ catalogue: c => { delete c.accepted.machines.air } })).state).toBe('excluded')
  })
  test('stale: silent worker, settings not applied, not eligible, retrying, failed upload, overdue, paused, unhealthy Git, expired, placement', async () => {
    const cases: Array<[Over, RegExp]> = [
      [{ status: st => { st.generated_at = s(NOW - 3 * 3600_000) }, entry: e => { e.last_agreement.evidence.observed_at = e.last_successful_remote_check.evidence.observed_at = s(NOW - 3 * 3600_000) } }, /not checked this Mac recently/],
      [{ status: st => { st.generated_at = s(NOW - 3 * 3600_000) } }, /inconsistent/],
      [{ status: st => { st.accepted_config_revision = 31 } }, /latest folder settings/],
      [{ entry: e => { e.eligible_current = false } }, /no longer counts/],
      [{ entry: e => { e.retry = { condition: 'remote_unreachable', since: s(NOW) } } }, /retrying: its remote could not be reached/],
      [{ entry: e => { e.retry = { condition: '<script>odd</script>', since: s(NOW) } } }, /^the backup tool is retrying an upload$/],
      [{ entry: e => { e.pending_remote_failure = { at: s(NOW) } } }, /last upload attempt failed/],
      [{ entry: e => { e.blocker = { code: 'protection_overdue' } } }, /not been confirmed uploaded/],
      [{ status: st => { st.scheduler = 'paused' } }, /paused/],
      [{ status: st => { st.git.healthy = false } }, /Git check/],
      [{ entry: e => { e.last_agreement.evidence.observed_at = s(NOW - 86_400_000); e.last_successful_remote_check.evidence.observed_at = s(NOW - 86_400_000) } }, /not confirmed this folder recently/],
      [{ status: st => { st.folder_readiness[ID].state = 'waiting_space' } }, /waiting for disk space/],
    ]
    for (const [over, why] of cases) {
      const e = await read(over)
      expect(e.state).toBe('stale')
      if (e.state === 'stale') expect(e.why).toMatch(why)
    }
  })
  test('conflicts: named only inside this folder, counted elsewhere; a blocker other than overdue', async () => {
    const e = await read({ entry: e => { e.conflict_paths = ['chapters/one (conflict).md', 'other/secret plan.md']; e.eligible_current = false } }, 'chapters')
    expect(e).toMatchObject({ state: 'conflicts', count: 2, examples: ['one (conflict).md'], elsewhere: 1 })
    expect(JSON.stringify(e)).not.toContain('secret plan')
    expect(await read({ entry: e => { e.blocker = { code: 'manual_changes' } } })).toMatchObject({ state: 'conflicts', count: 1 })
  })
  test('unavailable: no records, outside them, unmanaged, missing or foreign record, unknown schema', async () => {
    expect(await read({ noConfig: true })).toMatchObject({ state: 'unavailable', reason: 'not-installed' })
    expect(await read({ catalogue: c => { c.accepted.repositories = {} } })).toMatchObject({ reason: 'not-managed' })
    expect(await read({ catalogue: c => { c.accepted.repositories[ID].unmanaged = true } })).toMatchObject({ reason: 'not-managed' })
    expect(await read({ noStatus: true })).toMatchObject({ reason: 'unreadable' })
    expect(await read({ status: st => { st.machine_id = 'macbook-pro' } })).toMatchObject({ reason: 'unreadable' })
    expect(await read({ status: st => { st.schema = 2 } })).toMatchObject({ reason: 'unreadable' })
    expect(await read({ catalogue: c => { c.accepted.schema = 4 } })).toMatchObject({ reason: 'unreadable' })
    expect(await read({ status: st => { delete st.repositories[ID] } })).toMatchObject({ reason: 'not-verified' })
  })
})

describe('review P1: proof is bound to this exact checkout and destination', () => {
  test('a nested repository inside a managed one is not credited with its parent’s proof', async () => {
    const e = await read({ setup: async ({ folder }) => { await mkdir(join(folder, 'chapters', '.git'), { recursive: true }); await writeFile(join(folder, 'chapters', '.git', 'HEAD'), 'ref: refs/heads/main\n') } }, 'chapters')
    expect(e).toMatchObject({ state: 'unavailable', reason: 'not-managed' })
  })
  test('a status row for another path, a readiness record for another place, or another branch is not proof', async () => {
    expect(await read({ entry: e => { e.relative_path = '02_writing-creation/other' } })).toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect(await read({ status: st => { st.folder_readiness[ID].observed_path = '/somewhere/else' } })).toMatchObject({ state: 'stale' })
    expect(await read({ setup: async ({ folder }) => writeFile(join(folder, '.git', 'HEAD'), 'ref: refs/heads/drafts\n') })).toMatchObject({ state: 'stale', why: expect.stringMatching(/different branch/) })
    expect(await read({ setup: async ({ folder }) => writeFile(join(folder, '.git', 'HEAD'), HEAD + '\n') })).toMatchObject({ state: 'stale', why: expect.stringMatching(/not on a branch/) })
  })
  test('an in-tree alias keeps the proof; a link escaping the managed folders fails closed', async () => {
    const h = await home()
    try {
      await symlink(h.folder, join(h.home, 'repos', 'alias'))
      expect((await readRecordEvidence(join(h.home, 'repos', 'alias'), { records: h.records, home: h.home, now: NOW })).state).toBe('protected')
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-outside-')))
      try {
        await mkdir(join(outside, '.git')); await writeFile(join(outside, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        await symlink(outside, join(h.home, 'repos', '02_writing-creation', 'escape'))
        expect(await readRecordEvidence(join(h.home, 'repos', '02_writing-creation', 'escape'), { records: h.records, home: h.home, now: NOW })).toMatchObject({ state: 'unavailable', reason: 'not-managed' })
      } finally { await rm(outside, { recursive: true, force: true }) }
    } finally { await rm(h.home, { recursive: true, force: true }) }
  })
})

describe('round 2: the status row must describe this checkout and branch, completely', () => {
  test('a different or missing path or branch in the row, or a different accepted target branch, fails closed', async () => {
    expect(await read({ entry: e => { delete e.relative_path } })).toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect(await read({ entry: e => { e.managed_branch = 'other'; e.branch = 'other' } })).toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect(await read({ entry: e => { e.branch = 'other' } })).toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect(await read({ entry: e => { delete e.managed_branch } })).toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect(await read({ entry: e => { e.branch = null } })).toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect(await read({ setup: async ({ home }) => writeFile(join(home, '.local', 'state', 'examplesync', 'accepted-sync-targets.json'), JSON.stringify({ schema: 1, targets: { [ID]: { remote_url: 'x', managed_branch: 'other' } } })) }))
      .toMatchObject({ state: 'unavailable', reason: 'not-verified' })
    expect((await read({ setup: async ({ home }) => writeFile(join(home, '.local', 'state', 'examplesync', 'accepted-sync-targets.json'), JSON.stringify({ schema: 1, targets: { [ID]: { remote_url: 'x', managed_branch: 'main' } } })) })).state).toBe('protected')
  })
  test('files held back by the tool’s secret check need the writer', async () => {
    expect(await read({ entry: e => { e.held_back_paths = ['chapters/keys.md', 'elsewhere/x.md'] } }, 'chapters'))
      .toMatchObject({ state: 'conflicts', count: 2, elsewhere: 1, examples: ['keys.md held back by the backup tool’s secret check'] })
  })
})

describe('review P1: partial, future-dated, expired or manual proof is never green', () => {
  test('partial proof: missing tree, non-commit head, no remote check, or a check older than the agreement', async () => {
    for (const over of [
      { entry: (e: any) => { delete e.last_agreement.tree } },
      { entry: (e: any) => { e.head = e.last_agreement.head = e.last_agreement.remote_head = e.last_successful_remote_check.head = 'main' } },
      { entry: (e: any) => { e.last_successful_remote_check = null } },
      { entry: (e: any) => { e.last_successful_remote_check.evidence.sequence = 2 } },
      { entry: (e: any) => { e.last_agreement.remote_head = 'd'.repeat(40) } },
    ]) expect((await read(over)).state).toBe('unavailable')
    expect(await read({ catalogue: c => { delete c.accepted.revision } })).toMatchObject({ reason: 'unreadable' })
  })
  test('a record dated ahead of the clock is stale', async () => {
    const ahead = s(NOW + 86_400_000)
    expect(await read({ status: st => { st.generated_at = ahead }, entry: e => { e.last_agreement.evidence.observed_at = ahead; e.last_successful_remote_check.evidence.observed_at = ahead } }))
      .toMatchObject({ state: 'stale', why: expect.stringMatching(/ahead of this Mac’s clock/) })
  })
  test('manual mode, explicit, inherited from the bucket, from a missing bucket or from the unbucketed default, is not proof', async () => {
    expect(await read({ catalogue: c => { c.accepted.repositories[ID].mode = 'manual' } })).toMatchObject({ reason: 'not-verified' })
    expect(await read({ catalogue: c => { c.accepted.buckets['bucket-02'].default_mode = 'manual' } })).toMatchObject({ reason: 'not-verified' })
    expect(await read({ catalogue: c => { c.accepted.repositories[ID].bucket = 'gone' } })).toMatchObject({ reason: 'not-verified' })
    expect(await read({ catalogue: c => { delete c.accepted.repositories[ID].bucket; c.accepted.unbucketed_default_mode = 'manual' } })).toMatchObject({ reason: 'not-verified' })
    // Absent, the unbucketed default is the tool's own default: automatic.
    expect((await read({ catalogue: c => { delete c.accepted.repositories[ID].bucket } })).state).toBe('protected')
    expect(await read({ entry: e => { e.mode = 'manual' } })).toMatchObject({ reason: 'not-verified' })
  })
})

describe('review P1 (PR 317): only the four records, directly inside their folders, are read', () => {
  const outside = async (h: { home: string }, name: string) => { const away = join(h.home, 'elsewhere'); await mkdir(away, { recursive: true }); return join(away, name) }
  test('a record replaced by a link is never followed, even to a valid copy of itself', async () => {
    expect(await read({ setup: async h => {
      const real = join(h.home, '.local', 'state', 'examplesync', 'sync-status.json'), copy = await outside(h, 'sync-status.json')
      await writeFile(copy, await Bun.file(real).text()); await unlink(real); await symlink(copy, real)
    } })).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
    expect(await read({ setup: async h => {
      const real = join(h.home, '.examplesync', 'config.toml'), copy = await outside(h, 'config.toml')
      await writeFile(copy, await Bun.file(real).text()); await unlink(real); await symlink(copy, real)
    } })).toMatchObject({ state: 'unavailable' })
  })
  test('round 2: a selected records folder that is itself a link is refused, not followed', async () => {
    const h = await home()
    try {
      const link = join(h.home, '.linkedsync'); await symlink(h.records, link)
      expect(await recordFolders(link)).toBeNull()
      expect(await readRecordEvidence(h.folder, { records: link, now: NOW })).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
      expect((await readRecordEvidence(h.folder, { records: h.records, now: NOW })).state).toBe('protected')
    } finally { await rm(h.home, { recursive: true, force: true }) }
  })
  test('a status folder that is a link, or a settings folder not named like one, is refused', async () => {
    expect(await read({ setup: async h => {
      const state = join(h.home, '.local', 'state', 'examplesync'), moved = await outside(h, 'state')
      execFileSync('/bin/mv', [state, moved]); await symlink(moved, state)
    } })).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
    const h = await home()
    try {
      const plain = join(h.home, 'records'); execFileSync('/bin/cp', ['-R', h.records, plain])
      expect(await recordFolders(plain)).toBeNull()
      expect(await recordFolders(h.records)).toEqual({ settings: h.records, status: join(h.home, '.local', 'state', 'examplesync'), home: h.home })
    } finally { await rm(h.home, { recursive: true, force: true }) }
  })
  test('a pipe in place of a record does not block, and a record over the size cap is not read', async () => {
    const started = Date.now()
    expect(await read({ setup: async h => {
      const real = join(h.home, '.local', 'state', 'examplesync', 'sync-status.json'); await unlink(real); execFileSync('/usr/bin/mkfifo', [real])
    } })).toMatchObject({ state: 'unavailable', reason: 'unreadable' })
    expect(Date.now() - started).toBeLessThan(5000)
    const h = await home()
    try {
      const file = join(h.records, 'config.toml')
      expect(await boundedRecord(file)).toContain('machine_id')
      await expect(boundedRecord(file, 10)).rejects.toThrow()
    } finally { await rm(h.home, { recursive: true, force: true }) }
  })
})
