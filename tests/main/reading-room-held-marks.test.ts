import { expect, test } from 'bun:test'
import { createHeldMarks } from '../../src/renderer/src/reading-room-held-marks'

const mark = { color: '#ffd400', comment: 'first', key: 'ANN2', pageLabel: '3', position: '{"pageIndex":2,"rects":[[1,2,3,4]]}', sortIndex: '00002|000001|00001', text: 'words' }
const fields = ({ key: _key, ...rest }: typeof mark) => rest

test('an edit returns what this reader held before it, then holds the edit', () => {
  const held = createHeldMarks()
  held.load([mark])
  expect(held.edit({ ...mark, color: '#5fb236' })).toEqual(fields(mark))
  expect(held.edit({ ...mark, color: '#5fb236', comment: 'second' })).toEqual({ ...fields(mark), color: '#5fb236' })
  expect(held.remove(mark)).toEqual({ ...fields(mark), color: '#5fb236', comment: 'second' })
  expect(held.remove(mark)).toBeNull()
})

test('a reader holds nothing for a mark it was never given; loading replaces what it held', () => {
  const held = createHeldMarks()
  expect(held.edit(mark)).toBeNull()
  held.load([])
  expect(held.remove(mark)).toBeNull()
  held.hold({ ...mark, position: { pageIndex: 2, rects: [[1, 2, 3, 4]] } })
  expect(held.remove(mark)?.position).toBe('{"pageIndex":2,"rects":[[1,2,3,4]]}')
})

test('each reader instance has its own session id, sent with its changes', () => {
  const one = createHeldMarks()
  const two = createHeldMarks()
  expect(one.session).toMatch(/^[0-9a-f]{32}$/)
  expect(two.session).not.toBe(one.session)
})

test('a mark read from Zotero keeps its Zotero state; an edit keeps the tags and forgets the stamp; a new mark has no tags', () => {
  const held = createHeldMarks()
  const state = { modified: '2026-10-22 10:00:00', tags: ['models'] }
  held.load([{ ...mark, zoteroState: state }, { ...mark, key: 'OWED0002' }])
  // A mark painted from WriteFlex's own queue has no state.
  expect(held.remove({ ...mark, key: 'OWED0002' })?.zoteroState).toBeUndefined()
  expect(held.edit({ ...mark, color: '#5fb236' })?.zoteroState).toEqual(state)
  expect(held.remove(mark)?.zoteroState).toEqual({ modified: null, tags: ['models'] })
  held.created({ ...mark, key: 'NEWMARK2' })
  expect(held.remove({ ...mark, key: 'NEWMARK2' })?.zoteroState).toEqual({ modified: null, tags: [] })
  // Made under a key this reader already showed for a Zotero mark: still a new mark, with no tags.
  held.load([{ ...mark, zoteroState: state }])
  held.created(mark)
  expect(held.remove(mark)?.zoteroState).toEqual({ modified: null, tags: [] })
})

test('an edit the reader echoes back with the state it was painted with holds the tags, never the old stamp', () => {
  const held = createHeldMarks()
  const state = { modified: '2026-10-22 10:00:00', tags: ['models'] }
  held.load([{ ...mark, zoteroState: state }])
  held.edit({ ...mark, color: '#5fb236', zoteroState: state })
  expect(held.remove(mark)?.zoteroState).toEqual({ modified: null, tags: ['models'] })
})
