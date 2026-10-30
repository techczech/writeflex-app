import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { readFolioPlan, setPartRole } from '../../src/main/plan'
import { undoSectionRole } from '../../src/main/folio-section-role'

test('role menu changes only folio key, removal keeps other bytes, and Undo restores exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-role-'))
  try {
    const ws = new Workspace(root)
    const before = '---\r\ntitle: One\r\n# keep this comment\r\nFOLIO: "Other"\r\ntags: [a, b]\r\n---\r\n\r\n# One\r\n\r\nBody\r\n'
    const index = '# Book\n\n## Running order\n\n- [[One]]\n'
    const manifest = '{"files":[{"path":"one.md"}]}\n'
    await writeFile(join(root, '_report-structure.json'), manifest)
    await writeFile(join(root, `_${root.split('/').pop()}_INDEX.md`), index)
    await writeFile(join(root, 'one.md'), before)
    const read = () => readFile(join(root, 'one.md'), 'utf8')
    let plan = (await readFolioPlan(ws, ''))!
    plan = await setPartRole(ws, '', 0, 'section-page', plan.parts[0])
    expect(await read()).toBe(before.replace('FOLIO: "Other"', 'FOLIO: section'))
    expect(plan.parts[0].sectionPage).toBe(true)
    expect(await readFile(join(root, '_report-structure.json'), 'utf8')).toBe(manifest)
    expect(await readFile(join(root, plan.indexPath), 'utf8')).toBe(index)
    expect((await undoSectionRole(ws, '', plan.sectionRoleUndoToken!)).ok).toBe(true)
    expect(await read()).toBe(before)
    plan = await setPartRole(ws, '', 0, 'section-page', (await readFolioPlan(ws, ''))!.parts[0])
    plan = await setPartRole(ws, '', 0, 'section', plan.parts[0])
    expect(await read()).toBe(before.replace('FOLIO: "Other"\r\n', ''))
    expect((await undoSectionRole(ws, '', plan.sectionRoleUndoToken!)).ok).toBe(true)
    expect(await read()).toBe(before.replace('FOLIO: "Other"', 'FOLIO: section'))
    await writeFile(join(root, 'one.md'), (await read()) + 'Edited')
    expect((await undoSectionRole(ws, '', plan.sectionRoleUndoToken!)).ok).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

import { withSectionPage } from '../../src/main/folio-section-role'
import { readPlanForAgent } from '../../src/main/plan-agent-reads'

test('removing the last folio key preserves every byte of the body, including its first blank line', () => {
  const source = '\uFEFF---\r\nfolio: section\r\n---\r\n\r\n# One\r\n\r\nBody\r\n'
  expect(withSectionPage(source, false, 'one.md')).toBe('\uFEFF\r\n# One\r\n\r\nBody\r\n')
})

test('leaving a section for front matter and Undo restore all three files, with no new manifest role', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-role-front-'))
  try {
    const ws = new Workspace(root)
    const index = `_${root.split('/').pop()}_INDEX.md`
    const files = new Map([
      [index, '# Book\n\n## Running order\n\n- [[Alpha]]\n- [[Opening]]\n- [[Beta]]\n'],
      ['_report-structure.json', '{"files":[{"path":"a.md"},{"path":"s.md"},{"path":"b.md"}]}\n'],
      ['a.md', '# Alpha\n'], ['s.md', '---\ntitle: Opening\nfolio: section\n---\n\n# Opening\n'], ['b.md', '# Beta\n'],
    ])
    for (const [path, text] of files) await writeFile(join(root, path), text)
    const before = (await readFolioPlan(ws, ''))!
    const agent = await readPlanForAgent(ws, '', { manifestOrder: true })
    expect(agent.parts[0]).not.toHaveProperty('section')
    expect(agent.parts[1].sectionPage).toBe(true)
    expect(agent.parts[2].section).toBe('Opening')
    const after = await setPartRole(ws, '', 1, 'front-matter', before.parts[1])
    expect(after.parts[0].title).toBe('Opening')
    expect(after.parts[0].role).toBe('front-matter')
    expect(after.parts[0].sectionPage).toBeUndefined()
    expect(await readFile(join(root, '_report-structure.json'), 'utf8')).not.toContain('section-page')
    const answer = await undoSectionRole(ws, '', after.sectionRoleUndoToken!)
    expect(answer.ok).toBe(true)
    for (const [path, text] of files) expect(await readFile(join(root, path), 'utf8')).toBe(text)
    expect((await undoSectionRole(ws, '', after.sectionRoleUndoToken!)).ok).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Undo checkpoint failure leaves all three documents unchanged and the token remains usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-undo-failure-'))
  try {
    const ws = new Workspace(root), index = `_${root.split('/').pop()}_INDEX.md`
    await writeFile(join(root, index), '# Book\n\n## Running order\n\n- [[Opening]]\n')
    await writeFile(join(root, '_report-structure.json'), '{"files":[{"path":"s.md"}]}')
    await writeFile(join(root, 's.md'), '---\ntitle: Opening\nfolio: section\n---\n# Opening\n')
    const plan = (await readFolioPlan(ws, ''))!
    const next = await setPartRole(ws, '', 0, 'front-matter', plan.parts[0])
    const paths = [index, '_report-structure.json', 's.md']
    const before = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))
    const answer = await undoSectionRole(ws, '', next.sectionRoleUndoToken!, async path => { if (path === index) throw new Error('history checkpoint failed') })
    expect(answer.ok).toBe(false)
    expect(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
    expect((await undoSectionRole(ws, '', next.sectionRoleUndoToken!)).ok).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a read failure after a committed role change restores the complete prior state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-post-commit-'))
  try {
    const ws = new Workspace(root), index = `_${root.split('/').pop()}_INDEX.md`
    const files = new Map([[index, '# Book\n\n## Running order\n\n- [[Opening]]\n'], ['_report-structure.json', '{"files":[{"path":"s.md"}]}'], ['s.md', '---\ntitle: Opening\nfolio: section\n---\n# Opening\n']])
    for (const [path, text] of files) await writeFile(join(root, path), text)
    const plan = (await readFolioPlan(ws, ''))!
    const list = ws.listFiles.bind(ws)
    let committed = false
    ws.listFiles = async (...args) => { if (committed) throw new Error('post-commit read failed'); return list(...args) }
    await expect(setPartRole(ws, '', 0, 'front-matter', plan.parts[0], { onCommit: () => { committed = true } })).rejects.toThrow()
    for (const [path, text] of files) expect(await readFile(join(root, path), 'utf8')).toBe(text)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Reviewer accum/write probes: ordinary role cycles must leave bare documents byte-identical.
for (const source of ['# One\n\nBody\n', '# One\r\n\r\nBody\r\n', '\uFEFF# One\nBody\n', '\uFEFF# One\r\nBody\r\n', '', '\uFEFF', '\n# One', '# One']) {
  test(`bare section-page cycles preserve bytes: ${JSON.stringify(source)}`, () => {
    let text = source
    for (let cycle = 0; cycle < 5; cycle++) {
      text = withSectionPage(withSectionPage(text, true, 'one.md'), false, 'one.md')
      expect(text).toBe(source)
    }
  })
}

for (const nl of ['\n', '\r\n']) test(`an initially empty header is removed with its only key: ${JSON.stringify(nl)}`, () => {
  const source = `\uFEFF---${nl}---${nl}# One${nl}`
  expect(withSectionPage(withSectionPage(source, true, 'one.md'), false, 'one.md')).toBe(`\uFEFF# One${nl}`)
})

test('front matter ignores a section mark and choosing its current role writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-front-role-'))
  try {
    const ws = new Workspace(root), index = `_${root.split('/').pop()}_INDEX.md`
    const files = new Map([[index, '# Book\n\n## Running order\n\n- [[./pre.md|Pre]] #front-matter\n'], ['_report-structure.json', '{"files":[{"path":"pre.md","role":"front-matter","toc":false}]}'], ['pre.md', '---\nfolio: section\n---\n# Pre\n']])
    for (const [path, text] of files) await writeFile(join(root, path), text)
    const plan = (await readFolioPlan(ws, ''))!
    expect(plan.parts[0].role).toBe('front-matter')
    expect(plan.parts[0].sectionPage).toBeUndefined()
    const checkpoints: string[] = []
    const after = await setPartRole(ws, '', 0, 'front-matter', plan.parts[0], { beforeIndexWrite: async path => { checkpoints.push(path) }, beforeManifestWrite: async path => { checkpoints.push(path) } })
    expect(checkpoints).toEqual([])
    expect(after.sectionRoleUndoToken).toBeUndefined()
    for (const [path, text] of files) expect(await readFile(join(root, path), 'utf8')).toBe(text)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a null plan refresh refuses the section change rather than returning a token-only plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-null-plan-'))
  try {
    const ws = new Workspace(root), index = `_${root.split('/').pop()}_INDEX.md`
    await writeFile(join(root, index), '# Book\n\n## Running order\n\n- [[One]]\n')
    const source = '# One\n'
    await writeFile(join(root, 'one.md'), source)
    const plan = (await readFolioPlan(ws, ''))!
    await expect(setPartRole(ws, '', 0, 'section-page', plan.parts[0], { beforeIndexWrite: async () => { await rm(join(root, index)) } })).rejects.toThrow(/could not be read again/)
    expect(await readFile(join(root, 'one.md'), 'utf8')).toBe(source)
  } finally { await rm(root, { recursive: true, force: true }) }
})
