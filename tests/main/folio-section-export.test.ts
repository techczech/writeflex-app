import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Workspace } from '../../src/main/workspace'
import { exportBundle } from '../../src/main/export'
import { readFolioDetails, setFolioDetail, undoFolioDetail } from '../../src/main/folio-details'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
test('export nests sections; both options default off; opting in adds section contents and page breaks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-export-'))
  try {
    const ws = new Workspace(root)
    const index = `_${root.split('/').pop()}_INDEX.md`
    const put = async (path: string, text: string) => { await writeFile(join(root, path), text); await utimes(join(root, path), 1_700_000_000, 1_700_000_000) }
    await put('_report-structure.json', '{"name":"Book","files":[{"path":"s.md"},{"path":"a.md"},{"path":"t.md"},{"path":"b.md"}]}')
    await put(index, '---\ntitle: Book\n---\n# Book\n')
    await put('s.md', '---\nfolio: section\n---\n# First\n\nOpening body.\n')
    await put('a.md', '# Alpha\n\nAlpha body.\n')
    await put('t.md', '---\nfolio: section\n---\n# Second\n\nSecond opening.\n')
    await put('b.md', '# Beta\n\nBeta body.\n')
    const output = join(root, 'book.html')
    const html = async () => { await exportBundle(ws, { dir: '', format: 'html', target: output }); return readFile(output, 'utf8') }
    const off = await html()
    // Baseline captured on 745aed81 before section export implementation; navigation is the only intended difference.
    expect(digest(off.replace(/<a class="nav-link[^\n]+/g, ''))).toBe('dcc7f12ad5f633acf5846487ba1cf6ea1c3c891336f39b9f325c740a7f8fe19d')
    expect(off).toContain('class="nav-link level-2" href="#p2-section">Alpha')
    expect(off).not.toContain('wf-section-contents')
    expect(off).not.toContain('break-before:page')
    expect(off).toContain('Opening body.')
    const details = (await readFolioDetails(ws, ''))!
    if (!details.ok) throw new Error(details.message)
    const set = await setFolioDetail(ws, '', { field: 'section-title-pages', value: 'true', basis: details.text })
    expect(set.ok).toBe(true)
    if (!set.ok) throw new Error(set.message)
    expect(set.text).toBe(details.text.replace('title: Book\n', 'title: Book\nsection-title-pages: "true"\n'))
    const pages = await html()
    expect(pages).toContain('break-before:page;break-after:page')
    expect(pages).not.toContain('wf-section-contents')
    const toc = await setFolioDetail(ws, '', { field: 'section-contents', value: 'true', basis: set.text })
    expect(toc.ok).toBe(true)
    const both = await html()
    expect(both).toContain('<nav class="wf-section-contents" aria-label="Contents of First"><ol><li><a href="#p2-section">Alpha</a></li></ol></nav>')
    expect(both).toContain('<nav class="wf-section-contents" aria-label="Contents of Second"><ol><li><a href="#p4-section">Beta</a></li></ol></nav>')
    if (toc.ok) { expect((await undoFolioDetail(ws, '', toc.undoToken!)).ok).toBe(true) }
    expect((await html())).not.toContain('wf-section-contents')
    expect((await undoFolioDetail(ws, '', set.undoToken!)).ok).toBe(true)
    expect(await html()).toBe(off)
    await put('s.md', '# First\n\nOpening body.\n')
    await put('t.md', '# Second\n\nSecond opening.\n')
    const plain = await html()
    expect(digest(plain)).toBe('5f594d920f7c1e69e3a5ed7db857aa79cff9a3d0df7793fff7ecbfe951221f2f')
    expect(plain).toContain('class="nav-link piece-link" href="#p2-section">Alpha')
    await put(index, '---\ntitle: Book\nsection-title-pages: false\nsection-contents: false\n---\n# Book\n')
    expect(await html()).toBe(plain)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a quoted section title stays within its contents label and cannot inject an HTML attribute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-export-quotes-'))
  try {
    const ws = new Workspace(root)
    const title = 'Opening" onmouseover="alert(1)'
    await writeFile(join(root, '_report-structure.json'), '{"files":[{"path":"s.md"},{"path":"a.md"}]}')
    await writeFile(join(root, `_${root.split('/').pop()}_INDEX.md`), '---\ntitle: Book\nsection-contents: true\n---\n# Book\n')
    await writeFile(join(root, 's.md'), `---\ntitle: ${JSON.stringify(title)}\nfolio: section\n---\nOpening body.\n`)
    await writeFile(join(root, 'a.md'), '# Alpha\n')
    const target = join(root, 'book.html')
    await exportBundle(ws, { dir: '', format: 'html', target })
    const html = await readFile(target, 'utf8')
    expect(html).toContain('aria-label="Contents of Opening&quot; onmouseover=&quot;alert(1)"')
    expect(html).not.toContain('aria-label="Contents of Opening" onmouseover="alert(1)"')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('section contents omit navigation for consecutive and trailing empty sections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'section-export-empty-'))
  try {
    const ws = new Workspace(root)
    await writeFile(join(root, '_report-structure.json'), '{"files":[{"path":"s.md"},{"path":"t.md"},{"path":"a.md"},{"path":"u.md"}]}')
    await writeFile(join(root, `_${root.split('/').pop()}_INDEX.md`), '---\nsection-contents: true\n---\n# Book\n')
    for (const name of ['s', 't', 'u']) await writeFile(join(root, `${name}.md`), `---\nfolio: section\n---\n# ${name}\n`)
    await writeFile(join(root, 'a.md'), '# Alpha\n')
    const target = join(root, 'book.html')
    await exportBundle(ws, { dir: '', format: 'html', target })
    const html = await readFile(target, 'utf8')
    expect(html).not.toContain('aria-label="Contents of s"')
    expect(html).not.toContain('aria-label="Contents of u"')
    expect(html).toContain('aria-label="Contents of t"')
  } finally { await rm(root, { recursive: true, force: true }) }
})
