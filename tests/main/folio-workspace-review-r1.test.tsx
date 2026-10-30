/**
 * Review round 1 of the Folio workspace's one surface (ADR-0049, slice 2): routing for a Folio without a manifest (S-1)
 * and for a part that fails to route (S-7), status lanes and the keyboard lane move (S-3), Open Folio / Open at… and the
 * chord each action owns (S-4), an inspector draft surviving the inspector closing (S-5), the binder's Not in the outline
 * using the page's eligibility (S-6), room keys on sidebar controls (S-8), and the sidebar store keyed by Folio (D-4).
 */
import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { PART_ROUTE_REFUSAL, folderIsFolio, routeOpenedPart, type FolderFolioApi } from '../../src/renderer/src/app/folio-routing'
import { FolioBinderText } from '../../src/renderer/src/components/FolioBinderText'
import { pressedInSidebar, removeKeyApplies, roomKeysIgnored } from '../../src/renderer/src/components/folio-room-keys'
import { activateSidebar, dispatchSidebar, registerSidebarSlot, releaseSidebar, sidebarState } from '../../src/renderer/src/plan/folio-sidebar'
import { BOARD_STATUS_ORDER } from '../../src/shared/collection-status'
import { groupByStatus, laneOrder, neighbourLaneStatus, OPEN_SELECTED_CHORD, unlistedRowFacts, workspaceOpenParts } from '../../src/shared/folio-surface'

// ---- S-1: a Folio without a manifest is still a Folio ----

test('folder routing uses the declaration answer from main, including manifest-less Folios', async () => {
  for (const isFolio of [true, false]) expect(await folderIsFolio('a', { readFolioDeclaration: async () => ({ isFolio }) })).toBe(isFolio)
  expect(await folderIsFolio('a', { readFolioDeclaration: async () => { throw new Error('unavailable') } })).toBe(false)
})

// ---- S-7: a part that fails to route stays put and says why ----

test('a part routes to its workspace after the state write; a non-part opens the editor', async () => {
  const written: unknown[] = []
  const ok = await routeOpenedPart('f/01.md', { readFolioPlace: async () => ({ dir: 'f', kind: 'piece' }), setState: async (dir, patch) => { written.push([dir, patch]); return true }, readPlan: async () => ({ parts: [] }) })
  expect(ok.kind).toBe('workspace')
  expect(written).toEqual([['f', { view: 'text', selected: { title: '', path: 'f/01.md' }, split: false }]])
  expect((await routeOpenedPart('f/i.md', { readFolioPlace: async () => ({ dir: 'f', kind: 'index' }), setState: async () => true, readPlan: async () => ({ parts: [] }) })).kind).toBe('editor')
  expect((await routeOpenedPart('x.md', { readFolioPlace: async () => null, setState: async () => true, readPlan: async () => ({ parts: [] }) })).kind).toBe('editor')
  // A path main will not place (outside the workspace) is in no Folio: the editor, not a refusal.
  expect((await routeOpenedPart('/x.md', { readFolioPlace: async () => { throw new Error('outside') }, setState: async () => true, readPlan: async () => ({ parts: [] }) })).kind).toBe('editor')
})

test('Open Folio keeps its parts in editing mode without writing workspace state; other Folios still route normally', async () => {
  const written: string[] = []
  const routing = {
    readFolioPlace: async (path: string) => ({ dir: path.split('/')[0], kind: 'piece' as const }),
    setState: async (dir: string) => { written.push(dir); return true },
    readPlan: async () => ({ parts: [] }),
  }
  for (const path of ['f/01.md', 'f/02.md']) expect(await routeOpenedPart(path, routing, 'f')).toEqual({ kind: 'editor' })
  expect(written).toEqual([])
  expect((await routeOpenedPart('other/01.md', routing, 'f')).kind).toBe('workspace')
  expect(written).toEqual(['other'])
})

test('a failed state write (rejected or false) is a refusal with the routing sentence, and no workspace opens', async () => {
  const place = async (): Promise<{ dir: string; kind: 'piece' }> => ({ dir: 'f', kind: 'piece' })
  for (const setState of [async () => { throw new Error('restarting') }, async () => false]) {
    expect(await routeOpenedPart('f/01.md', { readFolioPlace: place, setState, readPlan: async () => ({ parts: [] }) })).toEqual({ kind: 'refused', message: PART_ROUTE_REFUSAL })
  }
  expect(PART_ROUTE_REFUSAL).toMatch(/^Could not open that part/)
})

test('a Plan that throws or reads null sends the part to the editor and writes no state (F-1)', async () => {
  for (const readPlan of [async () => { throw new Error('unreadable') }, async () => null]) {
    let calls = 0
    const r = await routeOpenedPart('f/01.md', { readFolioPlace: async () => ({ dir: 'f', kind: 'piece' }), setState: async () => { calls++; return true }, readPlan })
    expect(r).toEqual({ kind: 'editor' })
    expect(calls).toBe(0)
  }
})

// ---- S-3: lanes ----

test('a status no part has still has a lane (a drop target), in the Board’s saved order when there is one', () => {
  const parts = [{ status: 'idea' }, { status: 'idea' }]
  const lanes = groupByStatus(parts, laneOrder([]))
  expect(lanes.map((lane) => lane.status)).toEqual([...BOARD_STATUS_ORDER])
  expect(lanes.find((lane) => lane.status === 'ready')!.parts).toEqual([])
  const saved = ['ready', 'idea', 'Odd']
  const reordered = groupByStatus(parts, laneOrder(saved)).map((lane) => lane.status)
  expect(reordered.slice(0, 3)).toEqual(['ready', 'idea', 'Odd'])
  expect(reordered).toHaveLength(3 + BOARD_STATUS_ORDER.filter((status) => !['ready', 'idea'].includes(status)).length)
  expect(laneOrder([])).toEqual([...BOARD_STATUS_ORDER])
})

test('the keyboard lane move goes to the lane on the left or right, and stops at the ends', () => {
  const lanes = groupByStatus([{ status: 'idea' }], BOARD_STATUS_ORDER)
  expect(neighbourLaneStatus(lanes, 'idea', 1)).toBe('note gathering')
  expect(neighbourLaneStatus(lanes, 'Idea', -1)).toBe('Unsorted')
  expect(neighbourLaneStatus(lanes, 'Unsorted', -1)).toBeNull()
  expect(neighbourLaneStatus(lanes, 'published', 1)).toBeNull()
  expect(neighbourLaneStatus(lanes, 'no such lane', 1)).toBeNull()
})

// ---- S-4: Open Folio and Open at… ----

test('⌘↵ keeps its meaning (Open Folio), ⇧⌘↵ keeps Open at…, and the selected-part action has its own chord', () => {
  const keys = (id: string): unknown => commandRegistry.find((command) => command.id === id)?.keys
  expect(keys('folio.open')).toBe('⌘↵')
  expect(keys('folio.openAt')).toBe('⇧⌘↵')
  expect(OPEN_SELECTED_CHORD).toBe('⇧↵')
  // The chord is documented by one sheet-only row that never claims it, so the app's chord table leaves ⇧↵ to the room.
  const taken = commandRegistry.filter((command) => command.keys === OPEN_SELECTED_CHORD)
  expect(taken.map((command) => [command.id, command.surfaces, command.claimsChord])).toEqual([['folio.room.openSelected', ['sheet'], false]])
})

test('Open Folio and its Open at… menu list the written parts that have a file, in running order', () => {
  const part = (title: string, path: string | null, written: boolean) => ({ title, written, key: { path } })
  expect(workspaceOpenParts([part('A', 'f/a.md', true), part('Idea', null, false), part('B', 'f/b.md', true), part('Gone', 'f/g.md', false)]))
    .toEqual([{ path: 'f/a.md', title: 'A' }, { path: 'f/b.md', title: 'B' }])
  expect(workspaceOpenParts([])).toEqual([])
})

// ---- S-5 and D-4: the sidebar store ----

const slot = (contains: (node: unknown) => boolean): HTMLElement => ({ contains }) as unknown as HTMLElement
const field = (log: string[]): Element => ({ blur: () => { log.push('blur') } }) as unknown as Element
afterEach(() => { releaseSidebar('f1'); releaseSidebar('f2') })

test('closing the inspector blurs a focused inspector field first, so its draft is committed by its own writer', () => {
  activateSidebar('f1')
  const mine = field([]), log: string[] = []
  const inside = field(log)
  registerSidebarSlot('f1', 'inspector', slot((node) => node === inside))
  dispatchSidebar('show-inspector', inside)
  expect(log).toEqual([])
  dispatchSidebar('toggle-inspector', inside)
  expect(log).toEqual(['blur'])
  expect(sidebarState('f1').mode).toBe('binder')
  // A focus outside the inspector is left alone; opening the inspector blurs nothing.
  dispatchSidebar('show-inspector', mine)
  dispatchSidebar('close-inspector', mine)
  expect(log).toEqual(['blur'])
  registerSidebarSlot('f1', 'inspector', null)
})

test('clicking the title row while the inspector shows a part also commits the part’s draft; the switch to Inspector does not blur', () => {
  activateSidebar('f1')
  const log: string[] = [], inside = field(log)
  registerSidebarSlot('f1', 'inspector', slot((node) => node === inside))
  dispatchSidebar('show-inspector', inside)
  dispatchSidebar('select-title-row', inside)
  expect(log).toEqual(['blur'])
  registerSidebarSlot('f1', 'inspector', null)
})

test('the sidebar state is kept per Folio: a second Folio starts fresh and cannot change the first', () => {
  activateSidebar('f1')
  dispatchSidebar('show-inspector')
  activateSidebar('f2')
  expect(sidebarState('f2').mode).toBe('binder')
  expect(sidebarState('f1').mode).toBe('inspector')
  dispatchSidebar('show-inspector')
  releaseSidebar('f2')
  expect(sidebarState('f2').mode).toBe('binder')
  expect(sidebarState('f1').mode).toBe('inspector')
})

// ---- S-6: Not in the outline uses the page's eligibility ----

const row = { title: 'Loose', gloss: null, role: '', tags: [] as string[], path: 'f/loose.md', line: 1 }

test('a file main would refuse shows its sentence and cannot be added; an eligible file can; front matter only when offered', () => {
  const refused = unlistedRowFacts({ ...row, putBackRefusal: 'A part with this title is already in the outline.' })
  expect(refused).toMatchObject({ canAdd: false, canAddFrontMatter: false, canOpen: true, refusal: 'A part with this title is already in the outline.' })
  expect(unlistedRowFacts({ ...row, putBackRefusal: null })).toMatchObject({ canAdd: true, canAddFrontMatter: false, refusal: null })
  expect(unlistedRowFacts({ ...row, frontMatterOffer: {} })).toMatchObject({ canAdd: true, canAddFrontMatter: true })
  expect(unlistedRowFacts({ ...row, path: null })).toMatchObject({ canAdd: false, canOpen: false })
  expect(unlistedRowFacts({ ...row, heading: { title: 'The heading' } })).toMatchObject({ title: 'The heading', headingChoice: true })
})

const model = (notInOutline: Array<{ title: string; path: string | null }>) => ({
  title: 'Folio', parts: [], meta: { parts: 0 }, newCardFolio: { notInOutline },
}) as never
const binder = (unlistedPlan: unknown) => renderToStaticMarkup(
  <FolioBinderText model={model([{ title: 'Loose', path: 'f/loose.md' }])} shown={null} titleRow={false} hidden={new Set()} canAdopt loose onLoose={() => {}} onLooseSelect={() => {}}
    onTitle={() => {}} onPart={() => {}} onOpenPart={() => {}} onAdopt={() => {}} onOpenFile={() => {}} unlistedPlan={unlistedPlan as never} onHeadingMode={() => {}} />)

test('the binder draws the refusal, a disabled Add, and the heading choice for an unlisted file', () => {
  const heading = { title: 'Loose', mode: 'own', mismatch: false, frontMatter: false, headingText: 'Loose', frontmatterTitle: 'Loose' }
  const html = binder([{ ...row, heading, putBackRefusal: 'Already in the outline under another name.' }])
  expect(html).toContain('Already in the outline under another name.')
  expect(html).toMatch(/data-action="add-to-outline"[^>]*disabled|disabled=""[^>]*data-action="add-to-outline"/)
  expect(html).toContain('Has its own heading')
  const eligible = binder([{ ...row, putBackRefusal: null }])
  expect(eligible).not.toMatch(/data-action="add-to-outline"[^>]*disabled/)
  expect(eligible).not.toContain('data-plan-putback-why')
  // Before the Plan has been read, a file is listed (openable) but offers no add.
  expect(binder(null)).not.toContain('add-to-outline')
})

// ---- S-8: room keys and sidebar controls ----

const el = (matches: string[]): { closest: (selector: string) => unknown } => ({ closest: (selector) => (selector.split(',').some((part) => matches.includes(part.trim())) ? {} : null) })

test('a key on a sidebar button is not a room key; Delete and Backspace act only on the cards or Outline list', () => {
  const sidebarButton = el(['.fr-sidebar'])
  const list = el(['[role="listbox"]'])
  const typing = el(['input', 'textarea'])
  expect(pressedInSidebar(sidebarButton)).toBe(true)
  expect(roomKeysIgnored(sidebarButton)).toBe(true)
  expect(roomKeysIgnored(typing)).toBe(true)
  expect(roomKeysIgnored(list)).toBe(false)
  expect(removeKeyApplies(list)).toBe(true)
  expect(removeKeyApplies(sidebarButton)).toBe(false)
  // The binder's own parts list is a listbox too, but inside the sidebar: it never removes.
  expect(removeKeyApplies(el(['.fr-sidebar', '[role="listbox"]']))).toBe(false)
  expect(removeKeyApplies(el([]))).toBe(false)
  expect(removeKeyApplies(null)).toBe(false)
})
