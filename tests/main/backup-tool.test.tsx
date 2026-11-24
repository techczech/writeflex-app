/**
 * Issue 257: the remote copy of a Git vault, told from a backup tool's evidence and never from a save. These tests
 * run in every build: the wording with any backup tool, this checkout compared with a verified commit, Git ignore
 * rules that leave writing out, and the grey "No backup tool connected" state a build without a reader shows.
 */
import { test, expect, describe } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderToStaticMarkup } from 'react-dom/server'
import { OFFLINE_GIT_ENV, localCoverage } from '../../src/main/local-writing'
import { ignoredWriting, ignoredKind } from '../../src/main/backup-coverage'
import { syncGit } from '../../src/main/git-vault-sync-git'
import { NOT_CONNECTED, backupToolInfo, backupToolRecords, readBackupToolEvidence, readingForSource, singleFlight, type BackupToolReader } from '../../src/main/backup-tool'
import { BACKUP_TOOL_READER } from '../../src/main/backup-tool-adapter'
import { recordsReader } from '../../src/main/backup-tool-records'
import { home } from './backup-tool-records-fixture'
import { BACKUP_TOOL, NO_BACKUP_TOOL, presentProtection, type RemoteProtection, type BackupToolEvidence } from '../../src/shared/remote-protection'
import { ProtectionSection } from '../../src/renderer/src/sync/GitSync'
import type { GitView } from '../../src/shared/git-sync-view'
import { maintainedInstructionsBody } from '../../src/main/folio-agent-instructions'

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
/** This machine's real Git inside its developer folder; never the `/usr/bin/git` installer stub. */
const realGit = (() => { try { return join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr', 'bin', 'git') } catch { return null } })()
const git = (cwd: string, ...args: string[]) => execFileSync(realGit!, args, { cwd, env: gitEnv, stdio: 'pipe' }).toString().trim()
const withGit = test.skipIf(!realGit)

const NOW = Date.now()
const HEAD = 'b'.repeat(40)
const TOOL = { name: 'Example backup', remote: 'its remote' }
const AUDITED: RemoteProtection['ignored'] = { checkedAt: NOW, notes: { count: 0, examples: [] }, recovery: { count: 0, examples: [] }, history: { count: 0, examples: [] }, sources: [] }

describe('no backup tool connected', () => {
  const fake: BackupToolReader = { info: TOOL, defaultRecords: () => null, read: async (_folder, records) => ({ state: 'unavailable', reason: 'not-installed', detail: `read ${records}` }) }
  test('nothing set and no reader, or a reader with no default place: not connected, nothing read', async () => {
    expect(await readBackupToolEvidence('/any/folder', '', null)).toEqual(NOT_CONNECTED)
    expect(await readBackupToolEvidence('/any/folder', '   ', fake)).toEqual(NOT_CONNECTED)
    expect(backupToolInfo(null)).toEqual(NO_BACKUP_TOOL)
  })
  test('a folder set in Settings is what the reader reads; ~ is the home folder', async () => {
    expect(await readBackupToolEvidence('/any/folder', '~/records', fake, { home: '/base/writer' })).toMatchObject({ detail: 'read /base/writer/records' })
    expect(backupToolRecords('/elsewhere', fake)).toBe('/elsewhere')
    // A folder set but no reader in this build: still not connected, and says why.
    expect(await readBackupToolEvidence('/any/folder', '/elsewhere', null)).toMatchObject({ state: 'unavailable', reason: 'not-connected', detail: expect.stringContaining('saved on this Mac only') })
  })
  test('shown grey: No backup tool connected, saved on this Mac only, never backed up', () => {
    const view = presentProtection({ tool: NO_BACKUP_TOOL, evidence: NOT_CONNECTED, ignored: AUDITED, readAt: NOW }, { enabled: false, state: null }, NOW)
    expect(view).toMatchObject({ tone: 'grey', label: 'Saved on this Mac only', heading: 'No backup tool connected' })
    expect(view.routes).toEqual([{ name: 'Backup tool', tone: 'grey', text: NOT_CONNECTED.detail }])
    expect(view.routes[0].text).toContain('Your writing is saved on this Mac only.')
    expect(view.lines).toEqual(['WriteFlex saves your writing on this Mac. That alone is not a backup.'])
    expect(presentProtection(null, { enabled: false, state: null }, NOW).routes).toEqual([{ name: 'Backup tool', tone: 'grey', text: 'Reading the backup tool’s records…' }])
  })
  test('the Sync tab section draws that grey state', () => {
    const view = { root: '/v', gitFolder: true, busy: false, wait: 3, discovery: { state: 'ready' }, result: { enabled: false, state: 'idle', pending: [], internalPending: [], incoming: [], pairs: [], warnings: [] },
      backupTool: NO_BACKUP_TOOL, protection: { tool: NO_BACKUP_TOOL, evidence: NOT_CONNECTED, ignored: AUDITED, readAt: NOW } } as unknown as GitView
    const html = renderToStaticMarkup(<ProtectionSection view={view} />)
    expect(html).toContain('aria-label="Remote copy"')
    expect(html).toContain('data-protection="grey"')
    expect(html).toContain('No backup tool connected')
    expect(html).toContain('saved on this Mac only')
  })
  // The public build's reader has no default place: with nothing set, a Git vault reads as not connected.
  test.skipIf(BACKUP_TOOL_READER?.defaultRecords('/base/writer') !== null)('a build with no default records folder: the empty setting is not connected', async () => {
    expect(await readBackupToolEvidence('/any/folder', '', BACKUP_TOOL_READER)).toEqual(NOT_CONNECTED)
  })
  test('the records folder set in Settings is read: a verified upload shows as backed up by the backup tool', async () => {
    const h = await home()
    try {
      const generic = recordsReader(BACKUP_TOOL, () => null)
      expect(await readBackupToolEvidence(h.folder, '', generic)).toEqual(NOT_CONNECTED)
      const evidence = await readBackupToolEvidence(h.folder, h.records, generic, { now: NOW })
      expect(evidence).toMatchObject({ state: 'protected', coverage: { kind: 'unchecked' } })
      // This build's own reader reads the same folder when it is set.
      expect((await readBackupToolEvidence(h.folder, h.records, BACKUP_TOOL_READER, { now: NOW })).state).toBe('protected')
      const shown = presentProtection({ tool: BACKUP_TOOL, evidence: { ...evidence, coverage: { kind: 'current' } } as BackupToolEvidence, ignored: AUDITED, readAt: NOW }, { enabled: false, state: null }, NOW)
      expect(shown).toMatchObject({ tone: 'green', heading: 'Backed up by the backup tool' })
      expect(shown.routes[0]).toMatchObject({ name: 'Backup tool', text: expect.stringMatching(/^The backup tool last verified an upload of this folder to its remote today \d\d:\d\d, and nothing here is newer\.$/) })
      const stale = presentProtection({ tool: BACKUP_TOOL, evidence: await readBackupToolEvidence(h.folder, h.records, generic, { now: NOW + 3 * 86_400_000 }), ignored: AUDITED, readAt: NOW }, { enabled: false, state: null }, NOW + 3 * 86_400_000)
      expect(stale.routes[0].text).toMatch(/^The backup tool’s record for this folder cannot be relied on: the backup tool has not checked this Mac recently\./)
    } finally { await rm(h.home, { recursive: true, force: true }) }
  })
})

describe('one reading of both routes', () => {
  const ev = (evidence: BackupToolEvidence, ignored: RemoteProtection['ignored'] = { checkedAt: NOW, notes: { count: 0, examples: [] }, recovery: { count: 0, examples: [] }, history: { count: 0, examples: [] }, sources: [] }): RemoteProtection => ({ tool: TOOL, evidence, ignored, readAt: NOW })
  const off = { enabled: false, state: null }
  const proof = (coverage: any, at = NOW - 60_000): BackupToolEvidence => ({ state: 'protected', unit: 'u', verifiedAt: at, head: HEAD, coverage })
  test('only a current, fresh proof with nothing newer here and a completed audit is plain green', () => {
    expect(presentProtection(ev(proof({ kind: 'current' })), off, NOW)).toMatchObject({ tone: 'green', label: expect.stringMatching(/^Backed up today \d\d:\d\d$/) })
    expect(presentProtection(ev(proof({ kind: 'unchecked' })), off, NOW)).toMatchObject({ tone: 'amber', label: 'Backed up · could not check newer writing' })
    expect(presentProtection(ev(proof({ kind: 'current' })), off, NOW + 20 * 60_000)).toMatchObject({ tone: 'amber', label: 'Backup record out of date' })
    expect(presentProtection(ev(proof({ kind: 'current' }, NOW + 86_400_000)), off, NOW)).toMatchObject({ tone: 'amber' })
    expect(presentProtection(null, off, NOW)).toMatchObject({ tone: 'grey', label: 'Checking backup…' })
  })
  test('review P1: newer writing waits green for a while, then turns amber', () => {
    expect(presentProtection(ev(proof({ kind: 'waiting', since: NOW - 60_000 })), off, NOW)).toMatchObject({ tone: 'green', label: 'Backed up · newer writing waiting' })
    const late = presentProtection(ev(proof({ kind: 'waiting', since: NOW - 20 * 60_000 })), off, NOW)
    expect(late).toMatchObject({ tone: 'amber', label: 'Newer writing not backed up' })
  })
  test('each state with WriteFlex sync off has its own words and colour', () => {
    expect(presentProtection(ev({ state: 'excluded', unit: 'u', machine: 'DomAir' }), off, NOW)).toMatchObject({ tone: 'red', label: 'Not backed up from this Mac' })
    expect(presentProtection(ev({ state: 'stale', unit: 'u', verifiedAt: NOW - 21 * 86_400_000, why: 'x' }), off, NOW).routes[0].text).toMatch(/\(21 days ago\)/)
    expect(presentProtection(ev({ state: 'conflicts', unit: 'u', count: 1, verifiedAt: null, examples: [], elsewhere: 0 }), off, NOW)).toMatchObject({ tone: 'amber', label: 'Backup needs attention' })
    const none = presentProtection(ev({ state: 'unavailable', reason: 'not-installed', detail: 'Example backup is not set up on this Mac.' }), off, NOW)
    expect(none).toMatchObject({ tone: 'grey', label: 'Backup not verified' })
    expect(none.lines.join(' ')).toContain('That alone is not a backup.')
  })
  test('review P2: WriteFlex sync and the backup tool each keep their own colour; a red backup tool is never hidden', () => {
    const view = presentProtection(ev({ state: 'excluded', unit: 'u', machine: 'DomAir' }), { enabled: true, state: 1, lastSentAt: NOW - 120_000 }, NOW)
    expect(view.tone).toBe('green')
    expect(view.routes.map(r => [r.name, r.tone])).toEqual([['WriteFlex sync', 'green'], ['Example backup', 'red']])
    expect(presentProtection(ev({ state: 'excluded', unit: 'u', machine: 'DomAir' }), { enabled: true, state: 4, lastSentAt: NOW - 120_000 }, NOW).tone).toBe('red')
  })
  test('review P2: gaps, a pending audit and an unavailable audit are told apart', () => {
    const gaps = presentProtection(ev(proof({ kind: 'current' }), { checkedAt: NOW, notes: { count: 1, examples: ['draft.notes.md'] }, recovery: { count: 0, examples: [] }, history: { count: 1, examples: ['.writeflex/'] }, sources: ['.gitignore line 1'] }), off, NOW)
    expect(gaps).toMatchObject({ tone: 'amber', label: 'Backed up, with gaps' })
    expect(gaps.gaps.join(' ')).toContain('The rules are in .gitignore line 1.')
    expect(presentProtection(ev(proof({ kind: 'current' }), 'pending'), off, NOW)).toMatchObject({ tone: 'green', label: 'Backed up · still checking', gaps: ['Checking this folder’s Git ignore rules…'] })
    expect(presentProtection(ev(proof({ kind: 'current' }), 'unavailable'), off, NOW)).toMatchObject({ tone: 'amber', label: expect.stringMatching(/ignore rules not checked$/) })
  })
})

describe('review P1: this checkout compared with the verified commit', () => {
  withGit('clean at the verified commit is current; a save, an outside edit, a new note or a later commit is waiting with its time', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-local-')))
    try {
      git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'T'); git(root, 'config', 'user.email', 'writer')
      await writeFile(join(root, 'draft.md'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'A'); git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const head = git(root, 'rev-parse', 'HEAD'), run = (args: readonly string[], ms: number) => syncGit(root, {}, ms).run(args), at = Date.now()
      expect(await localCoverage(root, head, at, run)).toEqual({ kind: 'current' })
      expect(await localCoverage(root, head, at, run, at + 1000)).toEqual({ kind: 'waiting', since: at + 1000 })
      await writeFile(join(root, 'draft.md'), 'two\n'); const edited = new Date(at - 5 * 60_000); await utimes(join(root, 'draft.md'), edited, edited)
      expect(await localCoverage(root, head, at, run)).toEqual({ kind: 'waiting', since: edited.getTime() })
      git(root, 'checkout', '--', 'draft.md'); await writeFile(join(root, 'note.md'), 'new\n')
      expect((await localCoverage(root, head, at, run)).kind).toBe('waiting')
      git(root, 'add', '.'); git(root, 'commit', '-m', 'B')
      const c = await localCoverage(root, head, at, run)
      expect(c.kind).toBe('waiting')
      // Git cannot answer: never current.
      expect(await localCoverage(root, head, at, async () => ({ code: 128, out: Buffer.alloc(0), rejected: false, auth: false }))).toEqual({ kind: 'unchecked' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  withGit('round 2: the comparison runs no filter and never writes the index', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-nowrite-')))
    try {
      git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'T'); git(root, 'config', 'user.email', 'writer')
      await writeFile(join(root, '.gitattributes'), '*.md filter=mark\n'); await writeFile(join(root, 'draft.md'), 'one\n')
      git(root, 'add', '.'); git(root, 'commit', '-m', 'A'); git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const marker = join(root, '..', `${root.split('/').at(-1)}-filter-ran`)
      git(root, 'config', 'filter.mark.clean', `sh -c 'echo ran > "${marker}"; cat'`)
      const head = git(root, 'rev-parse', 'HEAD'), at = Date.now()
      await writeFile(join(root, 'draft.md'), 'two\n')
      const index = join(root, '.git', 'index'), before = await readFile(index), stamp = (await stat(index)).mtimeMs
      const c = await localCoverage(root, head, at, (args, ms) => syncGit(root, {}, ms).run(args))
      expect(c.kind).toBe('waiting')
      expect(await readFile(index)).toEqual(before)
      expect((await stat(index)).mtimeMs).toBe(stamp)
      expect(await stat(marker).then(() => true, () => false)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  withGit('round 2: an edit hidden by assume-unchanged or skip-worktree still counts as newer writing', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-hidden-')))
    try {
      git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'T'); git(root, 'config', 'user.email', 'writer')
      await writeFile(join(root, 'draft.md'), 'one\n'); await writeFile(join(root, 'other.md'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'A'); git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const head = git(root, 'rev-parse', 'HEAD'), at = Date.now(), run = (args: readonly string[], ms: number) => syncGit(root, {}, ms).run(args)
      git(root, 'update-index', '--assume-unchanged', 'draft.md'); await writeFile(join(root, 'draft.md'), 'two\n')
      expect(git(root, 'status', '--porcelain')).toBe('')
      expect((await localCoverage(root, head, at, run)).kind).toBe('waiting')
      git(root, 'update-index', '--no-assume-unchanged', 'draft.md'); git(root, 'checkout', '--', 'draft.md')
      git(root, 'update-index', '--skip-worktree', 'other.md'); await writeFile(join(root, 'other.md'), 'three\n')
      expect((await localCoverage(root, head, at, run)).kind).toBe('waiting')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('round 2: the deadline stops the comparison: no Git call starts after it, and the result is unchecked', async () => {
    const calls: number[] = []
    const slow = async (_args: readonly string[], ms: number) => { calls.push(ms); await new Promise(r => setTimeout(r, ms + 20)); return { code: -1, out: Buffer.alloc(0), rejected: false, auth: false } }
    const started = Date.now()
    expect(await localCoverage('/nowhere', HEAD, NOW, slow, undefined, 200)).toEqual({ kind: 'unchecked' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBeLessThanOrEqual(200)
    expect(Date.now() - started).toBeLessThan(600)
    // A call that answers just after the deadline is not believed.
    const late = async (_args: readonly string[], ms: number) => { await new Promise(r => setTimeout(r, ms + 10)); return { code: 0, out: Buffer.from('/x\n' + HEAD + '\n'), rejected: false, auth: false } }
    expect(await localCoverage('/nowhere', HEAD, NOW, late, undefined, 100)).toEqual({ kind: 'unchecked' })
  })
})

describe('review (PR 317): records alone never make a folder green; the comparison stays offline', () => {
  const repo = async (name: string) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), `writeflex-${name}-`)))
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'T'); git(root, 'config', 'user.email', 'writer')
    await writeFile(join(root, 'draft.md'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'A')
    return { root, head: git(root, 'rev-parse', 'HEAD'), run: (args: readonly string[], ms: number) => syncGit(root, {}, ms).run(args, OFFLINE_GIT_ENV) }
  }
  withGit('P1: no remote-tracking ref holding the verified commit, or another root or branch, is unconfirmed; Git’s own ref confirms it', async () => {
    const { root, head, run } = await repo('trust')
    try {
      const at = Date.now() + 5000
      expect(await localCoverage(root, head, at, run, undefined, 8000, { root, branch: 'main' })).toEqual({ kind: 'unconfirmed' })
      git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      expect(await localCoverage(root, head, at, run, undefined, 8000, { root, branch: 'main' })).toEqual({ kind: 'current' })
      expect(await localCoverage(root, head, at, run, undefined, 8000, { root, branch: 'drafts' })).toEqual({ kind: 'unconfirmed' })
      expect(await localCoverage(root, head, at, run, undefined, 8000, { root: tmpdir(), branch: 'main' })).toEqual({ kind: 'unconfirmed' })
      // Round 2: only the backup destination's ref for this branch counts. Another remote or branch holding the
      // commit confirms nothing.
      git(root, 'update-ref', '-d', 'refs/remotes/origin/main'); git(root, 'update-ref', 'refs/remotes/review/topic', 'HEAD'); git(root, 'update-ref', 'refs/remotes/origin/other', 'HEAD')
      expect(await localCoverage(root, head, at, run, undefined, 8000, { root, branch: 'main' })).toEqual({ kind: 'unconfirmed' })
      expect(await localCoverage(root, head, at, run)).toEqual({ kind: 'unconfirmed' })
      git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      // A commit no ref here holds (a record describing history this copy never had) is never green either.
      expect((await localCoverage(root, 'f'.repeat(40), at, run)).kind).not.toBe('current')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('P1: unconfirmed shows amber, and a save does not turn it into "newer writing waiting"', () => {
    const view = presentProtection({ tool: BACKUP_TOOL, evidence: { state: 'protected', unit: 'u', verifiedAt: NOW - 60_000, head: HEAD, root: '/r', branch: 'main', coverage: { kind: 'unconfirmed' } }, ignored: AUDITED, readAt: NOW }, { enabled: false, state: null }, NOW)
    expect(view).toMatchObject({ tone: 'amber', label: 'Backup not confirmed here', heading: 'Backup not confirmed by this copy' })
  })
  withGit('P2: a partial clone is not compared, and every Git call forbids network protocols', async () => {
    const { root, head } = await repo('offline')
    try {
      git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
      const seen: string[][] = []
      const run = (args: readonly string[], ms: number) => { seen.push([...args]); return syncGit(root, {}, ms).run(args, OFFLINE_GIT_ENV) }
      expect(await localCoverage(root, head, Date.now() + 5000, run)).toEqual({ kind: 'current' })
      expect(seen.length).toBeGreaterThan(2)
      for (const args of seen) expect(args.join(' ')).toContain('protocol.allow=never')
      expect(OFFLINE_GIT_ENV).toMatchObject({ GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' })
      git(root, 'config', 'remote.origin.promisor', 'true')
      expect(await localCoverage(root, head, Date.now() + 5000, run)).toEqual({ kind: 'unchecked' })
      git(root, 'config', '--unset', 'remote.origin.promisor'); git(root, 'config', 'extensions.partialClone', 'origin')
      expect(await localCoverage(root, head, Date.now() + 5000, run)).toEqual({ kind: 'unchecked' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('P2 (source): a reading shows only for the records folder it came from; cleared, the neutral state shows at once', () => {
    const green = { source: '/a/.tool', reading: 'green' }
    expect(readingForSource(green, '/a/.tool', () => 'not connected')).toBe('green')
    expect(readingForSource(green, '/b/.tool', () => 'not connected')).toBeUndefined()
    expect(readingForSource(green, null, () => 'not connected')).toBe('not connected')
    expect(readingForSource(undefined, '/a/.tool', () => 'not connected')).toBeUndefined()
  })
  test('P1 (time): a stalled read of a folder is never started again until it settles', async () => {
    const flight = singleFlight()
    let release!: () => void, runs = 0
    const first = flight('root\0/a/.tool', () => { runs++; return new Promise<void>(done => { release = done }) })
    expect(first).not.toBeNull()
    expect(flight('root\0/a/.tool', async () => { runs++ })).toBeNull()
    expect(flight('root\0/b/.tool', async () => { runs++ })).not.toBeNull()
    release(); await first
    expect(flight('root\0/a/.tool', async () => { runs++ })).not.toBeNull()
    expect(runs).toBe(3)
  })
})

describe('ignore rules that silently leave writing out', () => {
  withGit('the incident’s rules and an ignored Folio bin are all found with their sources; tooling and machine-local files are not', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-ignored-')))
    try {
      git(root, 'init', '-b', 'main')
      const put = async (path: string, text = 'x') => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text) }
      await put('.gitignore', '*.notes.md\nnode_modules/\n.folio-bin/\n')
      await put('draft.md'); await put('draft.notes.md')
      await put('folio/.gitignore', '*.writeflex-backup\n*.writeflex-backup.json\n.bridle/\n.writeflex/versions.jsonl\n.writeflex/*.lock\n')
      await put('folio/_report-structure.json.writeflex-backup'); await put('folio/_report-structure.json.writeflex-backup.json')
      await put('folio/.bridle/journal.jsonl'); await put('folio/.writeflex/versions.jsonl'); await put('folio/.writeflex/owner.lock')
      await put('.folio-bin/old part.md'); await put('node_modules/pkg/readme.md')
      const found = await ignoredWriting(root, args => syncGit(root).run(args), NOW)
      expect(found).not.toBeNull()
      expect(found!.notes).toEqual({ count: 1, examples: ['draft.notes.md'] })
      expect(found!.recovery.count).toBe(3)
      expect(found!.recovery.examples).toContain('.folio-bin/old part.md')
      expect(found!.history.examples.sort()).toEqual(['folio/.bridle/', 'folio/.writeflex/'])
      expect(found!.sources).toEqual(expect.arrayContaining(['.gitignore line 1', '.gitignore line 3', 'folio/.gitignore line 1']))
      await put('.git/info/exclude', 'drafts/\n'); await put('drafts/one.md')
      const again = await ignoredWriting(root, args => syncGit(root).run(args), NOW)
      expect(again!.notes.examples).toContain('drafts/one.md')
      expect(again!.sources).toContain('.git/info/exclude line 1')
      expect(await ignoredWriting(root, async () => ({ code: 128, out: Buffer.alloc(0), rejected: false, auth: false }))).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('classification', () => {
    expect(ignoredKind('a/.writeflex/')).toBe('history')
    expect(ignoredKind('a/.writeflex/sync-copies/x/y.md')).toBe('recovery')
    expect(ignoredKind('a/.folio-bin/_bin-index.json')).toBe('recovery')
    expect(ignoredKind('a/.writeflex/widget-step-1.json')).toBeNull()
    expect(ignoredKind('.obsidian/workspace.md')).toBeNull()
    expect(ignoredKind('out/x.md')).toBeNull()
  })
})

test('templates: the Folio agent instructions and the agent skill forbid ignoring notes, recovery copies and history', async () => {
  const body = maintainedInstructionsBody()
  expect(body).toContain('Never add an ignore rule')
  for (const name of ['.writeflex/', '.bridle/', '.writeflex-backup', '.writeflex-backup.json', '.folio-bin/']) expect(body).toContain(name)
  const skill = await readFile(join(import.meta.dir, '../../resources/agent-skill/writeflex/SKILL.md'), 'utf8')
  expect(skill).toMatch(/Never add or widen an ignore rule/)
})
