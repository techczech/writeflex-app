/**
 * The room's Outline, Text and Split (ticket 10): the view switch and selection, Split, previous and next, the text pane's
 * two states, and T-READONLY: switching views and showing text write nothing to the Folio. Pure helpers from
 * src/shared/folio-room.ts plus the room-state IPC on a synthetic Folio (tests/fixtures/folio-room).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { readFolioRoom, roomStateKey } from '../../src/main/folio-room'
import { registerFolioRoomIpc } from '../../src/main/folio-room-ipc'
import { SettingsStore } from '../../src/main/settings'
import { Workspace } from '../../src/main/workspace'
import {
  DEFAULT_ROOM_STATE, ROOM_AVAILABLE_VIEWS, mergeRoomState, neighbourPart, outlineTotals, readRoomState, shownSelection, splitApplies, textBeside, textPaneKind,
} from '../../src/shared/folio-room'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-room-views-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function snapshot(base: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { out.push(`dir ${full.slice(base.length)}`); await walk(full) }
      else out.push(`${full.slice(base.length)} ${(await stat(full)).mtimeMs} ${(await readFile(full)).toString('base64')}`)
    }
  }
  await walk(base)
  return out.sort()
}

const part = (index: number, written = true) => ({ index, written, key: { title: `P${index}`, path: written ? `p${index}.md` : null } })

test('All seven workspace tabs are available, in tab order', () => {
  expect([...ROOM_AVAILABLE_VIEWS]).toEqual(['outline', 'text', 'cards', 'map', 'flags', 'evidence', 'files'])
})

test('switching views keeps the selection and the split toggle, in every view (interaction 3)', () => {
  const selected = { title: 'Method', path: 'mixed/method.md' }
  let state = mergeRoomState(DEFAULT_ROOM_STATE, { selected })
  state = mergeRoomState(state, { split: true })
  for (const view of ROOM_AVAILABLE_VIEWS) {
    state = mergeRoomState(state, { view })
    expect(state.view).toBe(view)
    expect(state.selected).toEqual(selected)
    expect(state.split).toBe(true)
  }
  // A view that is not built keeps the one on screen; the selection is untouched.
  expect(mergeRoomState(state, { view: 'unknown' })).toEqual(state)
})

test('the stored view and split come back as stored; a malformed split is off', () => {
  expect(readRoomState({ view: 'text', split: true, selected: { title: 'A', path: null } })).toEqual({ view: 'text', selected: { title: 'A', path: null }, surface: 'room', split: true })
  expect(readRoomState({ view: 'outline' }).view).toBe('outline')
  expect(readRoomState({ split: 'yes' }).split).toBe(false)
  expect(mergeRoomState({ ...DEFAULT_ROOM_STATE, split: true }, { split: 'no' }).split).toBe(true)
  expect(mergeRoomState({ ...DEFAULT_ROOM_STATE, split: true }, { split: false }).split).toBe(false)
})

test('Split puts the text beside the cards only in Cards; Text is already the text alone', () => {
  expect(splitApplies('cards')).toBe(true)
  expect(splitApplies('outline')).toBe(false)
  expect(splitApplies('text')).toBe(false)
  expect(textBeside('cards', true)).toBe(true)
  expect(textBeside('cards', false)).toBe(false)
  expect(textBeside('outline', true)).toBe(false)
  expect(textBeside('text', true)).toBe(false)
})

test('previous and next follow the running order and skip nothing: an unwritten part is a stop', () => {
  const cards = [part(1), part(2), part(3, false), part(4)]
  expect(neighbourPart(cards, 2, 1)?.index).toBe(3)
  expect(neighbourPart(cards, 3, 1)?.index).toBe(4)
  expect(neighbourPart(cards, 4, -1)?.index).toBe(3)
  expect(neighbourPart(cards, 3, -1)?.index).toBe(2)
  // Walking forward from the first part visits every part once, in order.
  const walked: number[] = [cards[0].index]
  for (let at = neighbourPart(cards, walked[0], 1); at; at = neighbourPart(cards, at.index, 1)) walked.push(at.index)
  expect(walked).toEqual([1, 2, 3, 4])
  // The ends have no neighbour; a selection that is not drawn has none either.
  expect(neighbourPart(cards, 1, -1)).toBeNull()
  expect(neighbourPart(cards, 4, 1)).toBeNull()
  expect(neighbourPart(cards, 9, 1)).toBeNull()
  expect(neighbourPart(cards, null, 1)).toBeNull()
  expect(neighbourPart([], 0, 1)).toBeNull()
})

test('the text pane holds the editor for a written part and "not written yet" with no editor for an unwritten one', () => {
  expect(textPaneKind(part(1))).toBe('editor')
  expect(textPaneKind(part(1, false))).toBe('not-written')
  // A part marked written but with no file path cannot be given an editor.
  expect(textPaneKind({ written: true, key: { title: 'x', path: null } })).toBe('not-written')
  expect(textPaneKind(null)).toBe('none')
})

test('the Outline totals count the parts, the unwritten ones and the words', () => {
  expect(outlineTotals([{ written: true, words: 65 }, { written: false, words: 0 }, { written: true, words: 2051 }])).toEqual({ line: '3 parts · 1 unwritten', words: 2116 })
  expect(outlineTotals([{ written: true, words: 1 }])).toEqual({ line: '1 part', words: 1 })
})

test('on a Folio with an unwritten part, Next from Method reaches Results (unwritten) before Costs, and no read or state write touches the Folio (T-READONLY)', async () => {
  const built = await mixedFolio(root)
  const before = await snapshot(join(root, built.dir))
  const room = (await readFolioRoom(ws, built.dir))!
  const cards = room.parts.filter((entry) => !entry.frontMatter)
  const method = cards.find((entry) => entry.title === 'Method')!
  expect(neighbourPart(cards, method.index, 1)?.title).toBe('Results')
  expect(textPaneKind(neighbourPart(cards, method.index, 1))).toBe('not-written')
  expect(neighbourPart(cards, neighbourPart(cards, method.index, 1)!.index, 1)?.title).toBe('Costs')
  expect(shownSelection(room.parts, method.key)).toBe(method.index)

  // Choosing views, the split and parts goes through the room-state IPC: app state, never the Folio.
  const settingsPath = join(await mkdtemp(join(tmpdir(), 'wf-room-views-settings-')), 'settings.json')
  const store = new SettingsStore(settingsPath)
  const handlers = new Map<string, (event: { sender: { id: number } }, input: any) => unknown>()
  registerFolioRoomIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { stateForSender: () => ({}), requireWorkspace: () => ws, store })
  const call = (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
  for (const patch of [{ selected: method.key }, { view: 'outline' }, { view: 'text' }, { view: 'cards' }, { split: true }, { split: false }]) {
    expect(await call('folio-room:set-state', { dir: built.dir, state: patch })).toBe(true)
  }
  expect(await call('folio-room:set-state', { dir: built.dir, state: { view: 'text', split: true } })).toBe(true)
  expect(await call('folio-room:get-state', { dir: built.dir })).toEqual({ view: 'text', selected: method.key, surface: 'room', split: true })
  expect(store.folioRoomState(roomStateKey(ws, built.dir))).toBeDefined()
  await readFolioRoom(ws, built.dir)
  expect(await snapshot(join(root, built.dir))).toEqual(before)
})
