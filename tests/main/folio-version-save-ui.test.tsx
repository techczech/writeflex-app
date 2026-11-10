/**
 * Ticket 04 of Folio versions: the words and small decisions of the ⇧⌘S choice and the Save Folio version sheet
 * (app/folio-version-save.ts), the two modals as drawn (render seam: facts already read), and the remembered answer
 * as app state through a relaunch (SettingsStore). The keys and the real window are the Electron end-to-end test's.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioVersionSheet, SaveChooser } from '../../src/renderer/src/components/FolioVersionSave'
import {
  capLabel, chooserOrder, createSaveGate, describeSheetChange, factsFor, insertedVersionLabel, leftOutLine, notKeptLine, placeName, refusalSentence, saveChanged, savedToast, textLine, waitingBlocks,
} from '../../src/renderer/src/app/folio-version-save'
import type { FolioSheetFacts } from '../../src/main/folio-version-sheet'
import type { SavedFolioVersion } from '../../src/main/folio-version-save'
import { SettingsStore } from '../../src/main/settings'

const FACTS: FolioSheetFacts = {
  dir: 'papers/unitybc', indexPath: 'papers/unitybc/_unitybc_INDEX.md', parts: 11, partList: [], planned: 2, words: 5249, indexWords: 349,
  insertedCapBytes: 25 * 1024 * 1024, fingerprint: 'fp-ticked', withoutUnlisted: null,
  unlisted: [{ path: 'papers/unitybc/limitations-draft.md' }, { path: 'papers/unitybc/notes-on-judges.md' }, { path: 'papers/unitybc/sam-comments.md' }],
  inserted: [
    { path: 'papers/unitybc/data/scores.csv', name: 'scores.csv', kind: 'table', version: { number: 2, name: 'Outliers removed' }, handling: 'kept', bytes: 40, hash: 'aa' },
    { path: 'papers/unitybc/assets/agreement.html', name: 'agreement.html', kind: 'widget', version: null, handling: 'kept', bytes: 90, hash: 'bb' },
    { path: 'papers/unitybc/assets/pipeline.svg', name: 'pipeline.svg', kind: 'image', version: { number: 1, name: 'First' }, handling: 'kept', bytes: 70, hash: 'cc' },
  ],
  linked: [],
  waiting: [{ path: 'papers/unitybc/p08.md', role: 'part', title: 'How could we improve reliability?', order: 8, own: 2, agent: 0 }],
  leftOut: { research: 38, data: 6, offcuts: 3, archive: 43, bin: 0 },
  backup: { state: 'ok', leftOut: [] }, versionCount: 4, author: 'Dominik Lukes',
}

describe('the ⇧⌘S choice', () => {
  test('the last answer comes first; anything else reads as the Folio, the common act', () => {
    expect(chooserOrder('folio')).toEqual(['folio', 'part'])
    expect(chooserOrder('part')).toEqual(['part', 'folio'])
    expect(chooserOrder(undefined)).toEqual(['folio', 'part'])
    expect(chooserOrder('nonsense')).toEqual(['folio', 'part'])
  })

  test('drawn with the last answer first and highlighted, the other not, and the keys named', () => {
    const html = renderToStaticMarkup(<SaveChooser last="part" partName="8 How could we improve reliability?" parts={11} onChoose={() => {}} onCancel={() => {}} />)
    expect(html).toContain('Whole Folio or this part only?')
    expect(html.indexOf('This part only')).toBeLessThan(html.indexOf('Whole Folio</span>'))
    expect(html.match(/your last choice/g)).toHaveLength(1)
    expect(html).toMatch(/data-choice="part"[^>]*>|aria-checked="true"[^>]*data-choice="part"/)
    expect(html).toContain('“8 How could we improve reliability?”, as the per-part Save Version does today.')
    expect(html).toContain('The text of all 11 parts in running order')
    expect(html).toContain('uses the highlighted choice')
    expect(html).toContain('⌘1')
    expect(html).toContain('⌘2')
    expect(html).toContain('Cancel')
    expect(html).toContain('Continue')
  })
})

describe('the sheet\'s words', () => {
  test('the text line, in the mockup\'s order, with a planned part only when there is one', () => {
    // The Folio room's header counts the parts only; the line says how the total divides, so the two numbers can be reconciled.
    expect(textLine(FACTS)).toBe('Index Note · 11 parts in running order · 2 planned parts · 5,249 words (4,900 in the parts, 349 in the Index Note)')
    expect(textLine({ ...FACTS, parts: 1, planned: 0, words: 1, indexWords: 0 })).toBe('Index Note · 1 part in running order · 1 word')
  })

  test('an inserted file over the cap is said plainly to be noted and not kept; the cap reads as megabytes', () => {
    const big = { path: 'p/assets/fig.png', name: 'fig.png', kind: 'image' as const, version: null, handling: 'too-large' as const, bytes: 30 * 1024 * 1024, hash: null }
    expect(notKeptLine(big, 25 * 1024 * 1024)).toBe('fig.png is too large to keep a copy of (over 25 MB); the version notes it but does not keep it.')
    expect(capLabel(25 * 1024 * 1024)).toBe('25 MB')
    expect(capLabel(1536 * 1024)).toBe('1.5 MB')
    expect(capLabel(2048)).toBe('2 KB')
  })

  test('the tick box shows the unticked set whole: inserted, linked, waiting, left out and the fingerprint', () => {
    const unticked = { inserted: [FACTS.inserted[0]], linked: [], waiting: [], leftOut: { research: 38, data: 7, offcuts: 3, archive: 43, bin: 0 }, fingerprint: 'fp-unticked' }
    const facts = { ...FACTS, withoutUnlisted: unticked }
    expect(factsFor(facts, true)).toBe(facts)
    expect(factsFor(facts, false)).toMatchObject({ inserted: [FACTS.inserted[0]], waiting: [], fingerprint: 'fp-unticked', leftOut: { data: 7 }, words: 5249 })
    // No file outside the outline: nothing to untick, the same facts either way.
    expect(factsFor(FACTS, false)).toBe(FACTS)
  })

  test('what moved is said in words: a file added, an inserted file changed, changes newly waiting, the text', () => {
    const before = { ...FACTS, partList: [{ path: 'p/p01.md', title: 'One', order: 1 }], words: 100, waiting: [] }
    const after = {
      ...before,
      unlisted: [...before.unlisted, { path: 'p/later.md' }],
      inserted: [{ ...before.inserted[0], hash: 'changed', version: null }, ...before.inserted.slice(1)],
      waiting: [{ path: 'p/p01.md', role: 'part' as const, own: 2, agent: 1 }],
      words: 130,
    }
    const lines = describeSheetChange(before, after, true)
    expect(lines).toEqual([
      'later.md was added to the Folio outside the outline.',
      'scores.csv changed, so the version would hold its new contents.',
      'Your waiting changes in the margin: 2 now, 0 when the sheet opened.',
      'Suggestions from an agent waiting: 1 now, 0 when the sheet opened.',
      'The text now has 130 words (100 when the sheet opened).',
    ])
    expect(describeSheetChange(before, before, true)).toEqual(['Something in the Folio moved that the sheet does not list.'])
    // The box as the writer had it decides which lists are compared.
    const looseOnly = describeSheetChange({ ...before, withoutUnlisted: { ...FACTS, inserted: [], linked: [], waiting: [], leftOut: FACTS.leftOut, fingerprint: 'u' } }, { ...after, withoutUnlisted: { inserted: [], linked: [], waiting: [], leftOut: FACTS.leftOut, fingerprint: 'u2' } }, false)
    expect(looseOnly.join(' ')).not.toContain('scores.csv')
    expect(saveChanged({ changed: true, facts: after })).toBe(true)
    expect(saveChanged({ record: {}, settled: [] } as unknown as SavedFolioVersion)).toBe(false)
  })

  test('one save at a time: a second begin is refused while the first holds the gate, and a late end by another token lets go of nothing', () => {
    const gate = createSaveGate()
    expect(gate.held()).toBeNull()
    const opening = gate.begin('opening')!
    expect(gate.begin('opening')).toBeNull()
    expect(gate.begin('saving')).toBeNull()
    expect(gate.held()).toBe('opening')
    gate.end(opening)
    const saving = gate.begin('saving')!
    expect(saving).not.toBeNull()
    expect(gate.begin('opening')).toBeNull()
    expect(gate.held()).toBe('saving')
    gate.end(opening) // the earlier invocation finishing late
    expect(gate.held()).toBe('saving')
    gate.end(saving)
    expect(gate.held()).toBeNull()
    expect(gate.begin('saving')).not.toBeNull()
  })

  test('each inserted file names its version, or says a new one is made with this', () => {
    expect(insertedVersionLabel(FACTS.inserted[0])).toBe('version 2, “Outliers removed”')
    expect(insertedVersionLabel(FACTS.inserted[1])).toBe('a new version, saved with this one')
  })

  test('places are named as the writer knows them', () => {
    expect(placeName({ role: 'part', path: 'a/p08.md', title: 'How could we improve reliability?', order: 8 })).toBe('part 8 “How could we improve reliability?”')
    expect(placeName({ role: 'index', path: 'a/_a_INDEX.md' })).toBe('the Index Note')
    expect(placeName({ role: 'unlisted', path: 'a/notes.md' })).toBe('notes.md (not in the outline)')
  })

  test('the waiting block names the part, says what is settled; an agent\'s says what is left out', () => {
    const own = waitingBlocks(FACTS, true).own!
    expect(own.headline).toBe('2 changes in part 8 “How could we improve reliability?” are still waiting')
    expect(own.body).toBe('in the margin. They are yours, so saving gathers them into the text first and the version holds them.')
    const both = waitingBlocks({
      ...FACTS,
      waiting: [
        { path: 'a/p02.md', role: 'part', title: 'Two', order: 2, own: 1, agent: 0 },
        { path: 'a/p03.md', role: 'part', title: 'Three', order: 3, own: 0, agent: 2 },
        { path: 'a/p04.md', role: 'part', title: 'Four', order: 4, own: 1, agent: 1 },
      ],
    }, true)
    expect(both.own!.headline).toBe('2 changes in 2 parts are still waiting')
    expect(both.own!.lines).toEqual(['1 change in part 2 “Two”', '1 change in part 4 “Four”'])
    expect(both.agent!.headline).toBe('3 suggestions from an agent in 2 parts are waiting too.')
    expect(both.agent!.body).toBe('They stay in the margin and are left out of this version.')
    expect(both.agent!.lines).toEqual(['2 suggestions in part 3 “Three”', '1 suggestion in part 4 “Four”'])
    expect(waitingBlocks({ ...FACTS, waiting: [] }, true)).toEqual({ own: null, agent: null })
  })

  test('with the files not in the outline unticked, their waiting changes are not mentioned', () => {
    const facts = { ...FACTS, waiting: [{ path: 'a/x.md', role: 'unlisted' as const, own: 3, agent: 1 }] }
    expect(waitingBlocks(facts, true).own!.headline).toContain('x.md (not in the outline)')
    expect(waitingBlocks(facts, false)).toEqual({ own: null, agent: null })
  })

  test('what is left out names each folder with its count and leaves empty ones out', () => {
    expect(leftOutLine(FACTS)).toBe('research/ 38 files · data/ 6 files the text does not insert · offcuts/ 3 · archive/ 43')
    expect(leftOutLine({ ...FACTS, leftOut: { research: 0, data: 0, offcuts: 0, archive: 0, bin: 1 } })).toBe('the Folio bin 1 file')
    expect(leftOutLine({ ...FACTS, leftOut: { research: 0, data: 0, offcuts: 0, archive: 0, bin: 0 } })).toContain('nothing is in them now')
  })

  test('the toast counts what was kept, and says what was left out', () => {
    const member = (role: string, n: number) => Array.from({ length: n }, (_, i) => ({ role, path: `${role}${i}.md`, versionId: 'v' }))
    const saved = { record: { name: 'After Sam’s comments', members: [...member('index', 1), ...member('part', 11), ...member('unlisted', 3), ...member('inserted', 3)] }, waiting: [] } as unknown as SavedFolioVersion
    expect(savedToast(saved)).toBe('Saved Folio version “After Sam’s comments”: 11 parts, 3 files not in the outline, 3 inserted files.')
    const withLeft = { ...saved, waiting: [{ path: 'p.md', pending: 1, held: 0 }] } as unknown as SavedFolioVersion
    expect(savedToast(withLeft)).toContain('Waiting suggestions in 1 file were left out.')
  })

  test('a refusal from main loses the wrapper Electron puts round it and keeps the sentence', () => {
    expect(refusalSentence(new Error('Error invoking remote method \'folio-version-save:save\': VersionSaveRefused: Version name is required.'))).toBe('Version name is required.')
    expect(refusalSentence(new Error('Error invoking remote method \'x\': Error: Plain.'))).toBe('Plain.')
  })
})

describe('the sheet as drawn', () => {
  const draw = (facts: FolioSheetFacts, extra: Partial<Parameters<typeof FolioVersionSheet>[0]> = {}) => renderToStaticMarkup(
    <FolioVersionSheet facts={facts} folioName="unitybc" today={new Date(2026, 10, 2)} busy={false} error="" onCancel={() => {}} onSave={() => {}} {...extra} />,
  )

  test('shows the text, the inserted files with their versions, the tick box, what is left out and who saves', () => {
    const html = draw(FACTS)
    expect(html).toContain('Save Folio version')
    expect(html).toContain('Index Note · 11 parts in running order · 2 planned parts · 5,249 words (4,900 in the parts, 349 in the Index Note)')
    expect(html).toContain('scores.csv')
    expect(html).toContain('version 2, “Outliers removed”')
    expect(html).toContain('a new version, saved with this one')
    expect(html).toContain('Include the 3 Markdown files that are not in the outline')
    expect(html).toContain('research/ 38 files')
    expect(html).toContain('Saved as you · Dominik Lukes · 2 Nov 2026')
    expect(html).toContain('2 changes in part 8')
    // No internal id, no machine path.
    expect(html).not.toMatch(/fv_|\.writeflex|\/Users\//)
  })

  test('an inserted file over the cap is listed plainly as not kept, not under the frozen files; the notice says what moved and that nothing was saved', () => {
    const big = { path: 'p/assets/fig.png', name: 'fig.png', kind: 'image' as const, version: null, handling: 'too-large' as const, bytes: 30 * 1024 * 1024, hash: null }
    const html = draw({ ...FACTS, inserted: [FACTS.inserted[0], big] })
    expect(html).toContain('fig.png is too large to keep a copy of (over 25 MB); the version notes it but does not keep it.')
    const kept = html.slice(html.indexOf('data-testid="folio-save-inserted"'), html.indexOf('data-testid="folio-save-not-kept"'))
    expect(kept).toContain('scores.csv')
    expect(kept).not.toContain('fig.png')
    // Only over-cap files: no "each kept" line and no kept list.
    const onlyBig = draw({ ...FACTS, inserted: [big] })
    expect(onlyBig).not.toContain('Each kept as it is now')
    expect(onlyBig).not.toContain('folio-save-inserted')
    const notice = draw(FACTS, { changed: ['later.md was added to the Folio outside the outline.'] })
    expect(notice).toContain('The Folio changed while this sheet was open, so nothing was saved.')
    expect(notice).toContain('later.md was added to the Folio outside the outline.')
    expect(draw(FACTS)).not.toContain('folio-save-changed')
  })

  test('an inserted file is not warned about as out of backup, and a Folio with none says so quietly', () => {
    expect(draw(FACTS)).not.toMatch(/out of (the )?backup|not in the backup/)
    expect(draw({ ...FACTS, inserted: [], unlisted: [] })).toContain('No tables, widgets or images are inserted.')
  })

  test('earlier versions the backup holds back are listed with their plain reason; an unreadable backup is said, not hidden', () => {
    const reason = '‘After pilot numbers’ is not in the backup because part one.md is in the bin. Restore the part to back it up.'
    const html = draw({ ...FACTS, backup: { state: 'ok', leftOut: [{ id: 'fv_x', name: 'After pilot numbers', reason } as never] } })
    expect(html).toContain('Earlier versions the backup holds back')
    expect(html).toContain('Restore the part to back it up.')
    expect(draw({ ...FACTS, backup: { state: 'unavailable', reason: 'a history file is damaged' } })).toContain('could not be checked just now: a history file is damaged')
  })

  test('a Folio that cannot be saved says why in words, switches the button off and says nothing was saved', () => {
    const html = draw({ ...FACTS, refused: 'This Folio has no Index Note file yet.' })
    expect(html).toContain('This Folio has no Index Note file yet.')
    expect(html).toContain('Nothing was saved.')
    expect(html).toMatch(/data-testid="folio-save-submit"[^>]*disabled|disabled[^>]*data-testid="folio-save-submit"/)
  })

  test('busy and error states: the button says Saving…, a refusal shows as a sentence', () => {
    expect(draw(FACTS, { busy: true })).toContain('Saving…')
    expect(draw(FACTS, { error: 'part one.md changed while its version was being saved.' })).toContain('part one.md changed while its version was being saved.')
  })
})

describe('the remembered answer is app state, kept through a relaunch', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wf04-choice-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test('the Folio until an answer is given; the last answer after a relaunch; junk reads as the Folio; it is not a setting', async () => {
    const file = join(dir, 'settings.json')
    const first = new SettingsStore(file)
    expect(first.folioSaveChoice()).toBe('folio')
    expect(first.setFolioSaveChoice('part')).toBe(true)
    expect(new SettingsStore(file).folioSaveChoice()).toBe('part')
    expect(new SettingsStore(file).setFolioSaveChoice('folio')).toBe(true)
    expect(new SettingsStore(file).folioSaveChoice()).toBe('folio')
    // Not under `values`, so no row in Settings and no changelog entry.
    expect(new SettingsStore(file).get('folioSaveChoice')).toBeNull()
    await writeFile(file, JSON.stringify({ folioSaveChoice: 'bogus' }))
    expect(new SettingsStore(file).folioSaveChoice()).toBe('folio')
  })
})
