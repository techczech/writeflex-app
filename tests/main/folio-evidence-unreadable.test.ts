import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { readFolioRoom } from '../../src/main/folio-room'
import { readPlanForAgent } from '../../src/main/plan-agent-reads'
import { prepareProposal, proposalBasis } from '../../src/main/plan-proposal'
import { runCli } from '../../src/main/cli/run'
import { attachEvidence, evidencePath, readEvidence, writeEvidence } from '../../src/main/folio-evidence'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'

// MAJOR 1 (r1 review): an evidence file that exists but cannot be read never stops a read. The room, the agent and CLI
// plan reads and plan proposals all open and say so; writes refuse with a plain sentence.
let root: string
let outside: string
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-evidence-unreadable-')))
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-evidence-outside-')))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })

const cases: Array<[string, (path: string) => Promise<void>]> = [
  ['a folder', async path => { await mkdir(path) }],
  ['a link out of the workspace', async path => { await writeFile(join(outside, 'secret.md'), '## [[Intro]]\n\n### Notes\nOutside words.\n'); await symlink(join(outside, 'secret.md'), path) }],
]

for (const [name, make] of cases) {
  test(`evidence file that is ${name}: the room, plan.read, the CLI read and proposals open and say it cannot be read`, async () => {
    const built = await mixedFolio(root)
    const ws = new Workspace(root)
    const path = evidencePath({ root, folioDir: built.dir })
    await make(join(root, path))

    const evidence = await readEvidence(ws, built.dir)
    expect(evidence.state).toBe('unreadable')
    expect(evidence.message).toContain('The evidence file cannot be read.')
    expect(Object.keys(evidence.parts)).toEqual([])

    const room = (await readFolioRoom(ws, built.dir))!
    expect(room.parts.map(part => part.title)).toEqual(built.titles)
    expect(room.evidence?.state).toBe('unreadable')
    expect(room.map?.state).toBe('missing')

    const plan = await readPlanForAgent(ws, built.dir)
    expect(plan.parts.map(part => part.title)).toEqual(built.titles)
    expect(plan.parts.every(part => part.evidenceCount === null)).toBe(true)
    expect(plan.evidenceProblem).toContain('The evidence file cannot be read.')
    expect(JSON.stringify(plan)).not.toContain('Outside words.')

    let out = ''
    const code = await runCli(['--root', root, 'running-order', built.dir], { cwd: tmpdir(), stdout: text => { out += text }, stderr: () => {}, openUrl: async () => {} })
    expect(code).toBe(0)
    expect(out).toContain('Intro')
    expect(out).not.toContain('Outside words.')
    // The command line reads a link out of the workspace exactly as a file that is not there (cli-content-paths).
    if (name === 'a folder') expect(out).toContain('The evidence file cannot be read.')

    const basis = await proposalBasis(ws, built.dir)
    expect(basis.parts.map(part => part.title)).toEqual(built.titles)
    // Proposals change the running order only; they stage as usual and the agent learns of the file from plan.read.
    const prepared = await prepareProposal(ws, { dir: built.dir, changes: [{ op: 'move', title: built.titles[0], to: 1 }] })
    expect(prepared.proposed.rows.map(row => row.title)).toEqual([built.titles[1], built.titles[0], ...built.titles.slice(2)])

    const folio = new FolioWorkspace(ws, built.dir)
    const notes = await writeEvidence(folio, [{ kind: 'notes', part: 'Intro', expect: null, value: 'New.\n\n' }], { session: 'unreadable' })
    expect(notes).toMatchObject({ ok: false, message: 'The evidence file cannot be read, so nothing was changed.' })
    const attached = await attachEvidence(folio, 'Intro', { kind: 'file', path: `${built.dir}/notes/meeting.md` }, { session: 'unreadable' })
    expect(attached).toMatchObject({ ok: false, message: 'The evidence file cannot be read, so nothing was changed.' })
    if (name !== 'a folder') expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('## [[Intro]]\n\n### Notes\nOutside words.\n')
  })
}
