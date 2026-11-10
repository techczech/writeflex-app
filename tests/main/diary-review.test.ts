import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendDiarySession, persistDiarySession } from '../../src/main/diary'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { Workspace } from '../../src/main/workspace'
import { readDiaryGlance } from '../../src/main/diary-views'
import { tmpdir } from 'node:os'

let d: string
beforeEach(async () => { d = await mkdtemp(join(tmpdir(), 'wf-diary-review-')) })
afterEach(async () => { await rm(d, { recursive: true, force: true }) })
const at = (h: number, m: number) => new Date(2026, 10, 2, h, m).getTime()
const rec = (id: string, h: number, m: number, w: number, piece = 'a.md', extra = {}) => ({ id, startedAt: at(h, m), minutes: 5, netWords: w, pieces: [piece], edited: true, ...extra })
const file = () => join(d, '2026-11-02.md')
const totals = async () => {
  const c = await readFile(file(), 'utf8')
  const f = parseFrontmatter(c)!.extra
  return { w: f.words_written, m: f.mins_spent, c }
}

test('annotated earlier rows remain in day totals', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 300))
  await appendDiarySession(d, rec('B', 10, 0, 200, 'b.md'))
  let c = await readFile(file(), 'utf8')
  c = c.replace('[[a]]', '[[a]] — tough going')
  await writeFile(file(), c)
  await appendDiarySession(d, rec('C', 11, 0, 100, 'c.md'))
  const t = await totals()
  expect(t.w).toBe('600')
  expect(t.c).toContain('— tough going')
})

test('an empty template block accepts sittings and checkpoints without losing prose', async () => {
  await writeFile(file(), '# Day\n\nMy prose.\n\n<!-- writeflex:recorded:start -->\n<!-- writeflex:recorded:end -->\n')
  expect(await persistDiarySession(d, rec('A', 9, 0, 50))).toEqual({ name: '2026-11-02.md' })
  expect(await persistDiarySession(d, rec('A', 9, 0, 70))).toEqual({ name: '2026-11-02.md' })
  expect(await persistDiarySession(d, rec('B', 10, 0, 60))).toEqual({ name: '2026-11-02.md' })
  const t = await totals()
  expect(t.w).toBe('130')
  expect(t.m).toBe('10')
  expect(t.c).toContain('My prose.')
  expect(t.c.match(/^09:00/gm)).toHaveLength(1)
})

test('deleting all recorded rows allows the same and later sittings with stale metadata', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 300))
  const c = (await readFile(file(), 'utf8')).split('\n').filter(l => !l.startsWith('09:00')).join('\n')
  await writeFile(file(), c)
  expect(await persistDiarySession(d, rec('A', 9, 0, 320))).toEqual({ name: '2026-11-02.md' })
  expect(await persistDiarySession(d, rec('B', 10, 0, 20))).toEqual({ name: '2026-11-02.md' })
  expect((await totals()).w).toBe('340')
})

test('metadata recovery counts both identical row occurrences', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 40))
  await appendDiarySession(d, rec('A2', 9, 0, 40))
  expect((await totals()).w).toBe('80')
  let c = await readFile(file(), 'utf8')
  c = c.replace(/<!-- writeflex:recorded:meta .* -->\n/, '')
  await writeFile(file(), c)
  await appendDiarySession(d, rec('B', 10, 0, 1, 'b.md'))
  expect((await totals()).w).toBe('81')
})

test('edited sitting links survive repeated checkpoints without duplicate rows', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  let c = await readFile(file(), 'utf8')
  c = c.replace('[[a]]', '[[a draft]]')
  await writeFile(file(), c)
  await appendDiarySession(d, rec('A', 9, 0, 150))
  await appendDiarySession(d, rec('A', 9, 0, 175))
  const t = await totals()
  expect(t.w).toBe('175')
  expect(t.c).toContain('[[a draft]]')
  expect(t.c.match(/^09:00/gm)).toHaveLength(1)
})

test('metadata recovery preserves surrounding prose, inside notes and CRLF', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  let c = await readFile(file(), 'utf8')
  c = c.replace(/<!-- writeflex:recorded:meta .* -->\n/, '<!-- writeflex:recorded:meta [{"id":"A","che\n')
  c = 'Before prose\n' + c + 'After prose\n'
  c = c.replace('recorded\n', 'recorded\nMy note inside block\n').replace(/\n/g, '\r\n')
  await writeFile(file(), c)
  await appendDiarySession(d, rec('B', 10, 0, 7, 'b.md'))
  const t = await totals()
  expect(t.w).toBe('107')
  expect(t.c).toContain('My note inside block\r\n')
  expect(t.c).toContain('Before prose\r\n')
  expect(t.c).toContain('After prose\r\n')
  expect(t.c.replaceAll('\r\n', '')).not.toContain('\n')
})

test('same-day concurrent sessions are serialised without lost totals', async () => {
  await Promise.all([1,2,3,4,5,6].map(i => appendDiarySession(d, rec('X'+i, 8+i, 0, i*10, `p${i}.md`))))
  expect((await totals()).w).toBe('210')
})

test('ambiguous checkpoint refusal does not block a later sitting', async () => {
  await persistDiarySession(d, rec('A', 9, 0, 100))
  let c = await readFile(file(), 'utf8')
  await writeFile(file(), c.replace(/<!-- writeflex:recorded:meta .* -->\n/, ''))
  expect((await persistDiarySession(d, rec('A', 9, 0, 120))).error).toBeDefined()
  expect(await persistDiarySession(d, rec('B', 14, 0, 500, 'b.md'))).toEqual({ name: '2026-11-02.md' })
  expect((await totals()).w).toBe('600')
})


test('every refused checkpoint reports an error', async () => {
  await writeFile(file(), '<!-- writeflex:recorded:start -->\n')
  expect((await persistDiarySession(d, rec('A', 9, 0, 100))).error).toBeDefined()
  expect((await persistDiarySession(d, rec('A', 9, 0, 150))).error).toBeDefined()
})

test('an autosave during title reads is never overwritten', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  const source = new Workspace(d)
  const edited = (await readFile(file(), 'utf8')) + '\nWriter autosave.\n'
  await writeFile(join(d, 'a.md'), '# A\n')
  const sourceRead = source.readFile.bind(source)
  source.readFile = async () => { await writeFile(file(), edited); return sourceRead('a.md') }
  expect(await persistDiarySession(d, rec('B', 10, 0, 50), { sourceWorkspace: source })).toEqual({ name: '2026-11-02.md' })
  expect((await totals()).c).toContain('Writer autosave.')
  expect((await totals()).w).toBe('150')
  expect(await persistDiarySession(d, rec('C', 11, 0, 20))).toEqual({ name: '2026-11-02.md' })
})

test('a file appearing during title reads is preserved by the same write', async () => {
  const source = new Workspace(d)
  await writeFile(join(d, 'a.md'), '# A\n')
  const sourceRead = source.readFile.bind(source)
  source.readFile = async () => { await writeFile(file(), '# Writer created this.\n'); return sourceRead('a.md') }
  expect(await persistDiarySession(d, rec('A', 9, 0, 100), { sourceWorkspace: source })).toEqual({ name: '2026-11-02.md' })
  expect((await totals()).c).toContain('# Writer created this.')
  expect((await totals()).w).toBe('100')
  expect(await persistDiarySession(d, rec('B', 10, 0, 50))).toEqual({ name: '2026-11-02.md' })
})

test('a hand-typed invalid aggregate does not break Diary glance', async () => {
  await writeFile(file(), '---\nwords_written: 1,187\nmins_spent: 5\n---\n')
  expect(await readDiaryGlance(d, new Date(2026, 10, 2))).toMatchObject({ todayWords: 0 })
})


test('an unedited sitting updates links when it visits another piece', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  await appendDiarySession(d, rec('A', 9, 0, 150, 'a.md', { pieces: ['a.md', 'b.md'] }))
  expect((await totals()).c).toContain('[[a]], [[b]]')
})


test('ambiguous edited rows refuse without duplicating, including after another sitting recovers metadata', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  const original = await readFile(file(), 'utf8')
  const edited = original.replace(/,"prefix":"[^"]*"/g, '').replace('[[a]]', '[[a draft]]')
  await writeFile(file(), edited)
  expect((await persistDiarySession(d, rec('A', 9, 0, 150))).error).toBeDefined()
  expect(await readFile(file(), 'utf8')).toBe(edited)
  await appendDiarySession(d, rec('B', 10, 0, 20, 'b.md'))
  expect((await persistDiarySession(d, rec('A', 9, 0, 150))).error).toBeDefined()
  expect((await totals()).w).toBe('120')
})

test('a final checkpoint retries one compare-before-save conflict in place', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  const diary = new Workspace(d)
  const save = diary.saveFileOverRead.bind(diary)
  let attempts = 0
  diary.saveFileOverRead = async (...args) => {
    if (++attempts === 1) await writeFile(file(), (await readFile(file(), 'utf8')) + '\nWriter autosave.\n')
    return save(...args)
  }
  expect(await persistDiarySession(d, rec('A', 9, 0, 160, 'a.md', { minutes: 6 }), { diaryWorkspace: diary })).toEqual({ name: '2026-11-02.md' })
  expect(attempts).toBe(2)
  const t = await totals()
  expect(t.w).toBe('160')
  expect(t.m).toBe('6')
  expect(t.c).toContain('Writer autosave.')
  expect(t.c.match(/^09:00/gm)).toHaveLength(1)
})

test('a repeated conflict refuses after exactly one retry and preserves both autosaves', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  const diary = new Workspace(d)
  const save = diary.saveFileOverRead.bind(diary)
  let attempts = 0
  diary.saveFileOverRead = async (...args) => {
    await writeFile(file(), (await readFile(file(), 'utf8')) + '\nAutosave ' + ++attempts + '\n')
    return save(...args)
  }
  expect((await persistDiarySession(d, rec('A', 9, 0, 160), { diaryWorkspace: diary })).error).toContain('changed')
  expect(attempts).toBe(2)
  const t = await totals()
  expect(t.w).toBe('100')
  expect(t.c).toContain('Autosave 1')
  expect(t.c).toContain('Autosave 2')
})

test('an exclusive-create conflict retries over the newly created day', async () => {
  const diary = new Workspace(d)
  const create = diary.createFile.bind(diary)
  let creates = 0
  diary.createFile = async (...args) => {
    creates++
    await writeFile(file(), '# Writer created this.\n')
    return create(...args)
  }
  expect(await persistDiarySession(d, rec('A', 9, 0, 100), { diaryWorkspace: diary })).toEqual({ name: '2026-11-02.md' })
  expect(creates).toBe(1)
  expect((await totals()).c).toContain('# Writer created this.')
  expect((await totals()).w).toBe('100')
})

test('a non-conflict save error is reported without retrying', async () => {
  await appendDiarySession(d, rec('A', 9, 0, 100))
  const diary = new Workspace(d)
  let attempts = 0
  diary.saveFileOverRead = async () => { attempts++; throw new Error('Synthetic permission refusal') }
  expect((await persistDiarySession(d, rec('A', 9, 0, 160), { diaryWorkspace: diary })).error).toBe('Synthetic permission refusal')
  expect(attempts).toBe(1)
  expect((await totals()).w).toBe('100')
})
