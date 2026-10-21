import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { folioOutline } from '../../src/main/folio-outline'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { proposePartTitles, setPartHeadingMode } from '../../src/main/folio-part-proposals'
import { Workspace } from '../../src/main/workspace'
import { shownHeadings } from '../../src/shared/folio-outline'
import { isAddHeadingProposal } from '../../src/shared/part-title-proposal'

// The logic of tests/e2e/folio-part-titles.spec.ts without Electron: the same four-part report, read through
// the same Folio outline, proposals and Accept. The Outline's drawing, the margin card and the menu are the
// renderer's; the titles it shows, the change it stages and the bytes it writes are decided here.
const MANIFEST = JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: '01-summary.md' }, { path: '02-survey-data.md' }, { path: '03-what-would-it-cost.md' }, { path: '04-method.md' }] })
const FILES: Record<string, string> = {
  'report/_report-structure.json': MANIFEST,
  'report/01-summary.md': '---\ntitle: Executive summary\n---\n\n# Executive summary\n\nSummary text.\n\n## Findings\n\n### Cost\n',
  'report/02-survey-data.md': '---\ntitle: Survey data\nheading: none\n---\n\n### Question one\n\nRows.\n\n### Question two\n',
  'report/03-what-would-it-cost.md': 'Costs text.\n\n## Items\n',
  'report/04-method.md': '---\ntitle: Method\n---\n\n# Approach\n\nMethod text.\n',
}
const COST = 'report/03-what-would-it-cost.md'
const DATA = 'report/02-survey-data.md'

let root: string
let appData: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-part-titles-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-part-titles-data-'))
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  invalidateFolioPlaces(root)
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})
const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

test('each part is named once in the Outline; the differing title is flagged; the open part and the data part nest as drawn', async () => {
  const outline = await folioOutline(ws, 'report/01-summary.md')
  expect(outline).not.toBeNull()
  // Every part has one title: the # heading, else the metadata title, else the file name.
  expect(outline!.pieces.map((piece) => piece.title)).toEqual(['Executive summary', 'Survey data', 'What would it cost', 'Approach'])
  // "Executive summary" is the part's name; its # heading is not listed under it again.
  const summary = outline!.pieces[0]
  expect(shownHeadings(summary.headings, summary.heading ?? 'own', summary.title).map((h) => h.text)).toEqual(['Findings', 'Cost'])
  // The part with a differing title is flagged (and only it).
  expect(outline!.pieces.map((piece) => piece.titleMismatch === true)).toEqual([false, false, false, true])
  // heading: none - the data part's headings nest directly under it.
  const data = outline!.pieces[1]
  expect(data.heading).toBe('none')
  expect(shownHeadings(data.headings, data.heading ?? 'own', data.title).map((h) => h.text)).toEqual(['Question one', 'Question two'])
})

test('opening the Folio stages one pending change (the missing heading), writes nothing, and Accept adds the heading and its title only', async () => {
  const changes = new ChangeStore(ws)
  expect(await proposePartTitles(ws, changes, 'report')).toEqual({ proposed: 1, flagged: 1, withdrawn: 0 })
  expect((await changes.list({ status: 'pending' })).map((c) => c.path).sort()).toEqual([COST]) // the differing title is the title-conflict buttons' job
  expect(await read(COST)).toBe(FILES[COST])
  expect(await read(DATA)).toBe(FILES[DATA])

  const pending = (await changes.list({ status: 'pending' }))[0]
  expect(isAddHeadingProposal(pending)).toBe(true)
  expect(pending.author?.name).toBe('WriteFlex')
  const agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  try {
    const result = await agent.resolveChange(pending.id, 'accept')
    expect(result.applied).toBe(true)
  } finally {
    agent.dispose()
  }
  expect(await read(COST)).toBe('---\ntitle: What would it cost\n---\n\n# What would it cost\n\nCosts text.\n\n## Items\n')
  expect(await read(DATA)).toBe(FILES[DATA]) // the data part still has no heading in its text
})

test('"No heading in the text" writes heading: none with no # line, the proposal is declined, and it is not proposed again', async () => {
  const changes = new ChangeStore(ws)
  await proposePartTitles(ws, changes, 'report')
  const [proposal] = await changes.list({ path: COST, status: 'pending' })
  expect(proposal).toBeDefined()

  expect(await setPartHeadingMode(ws, COST, 'none')).toEqual([COST])
  await changes.setReviewStatus(proposal.id, 'rejected') // the margin's second step
  expect(await read(COST)).toBe('---\nheading: none\n---\n\nCosts text.\n\n## Items\n')
  expect((await changes.get(proposal.id))?.status).toBe('rejected')
  expect(await changes.list({ path: COST, status: 'pending' })).toEqual([])
  expect(await proposePartTitles(ws, changes, 'report')).toEqual({ proposed: 0, flagged: 0, withdrawn: 0 })
})
