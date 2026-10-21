import { describe, expect, test } from 'bun:test'
import { documentTitle } from '../../src/main/frontmatter'
import {
  boundedHiddenList, DEFAULT_SUPPORT_FOLDERS, DEFAULT_VAULT_HIDDEN, DEFAULT_VAULT_WORK_SETTINGS, detectVaultWorks,
  HIDE_RULE_LIMITS, hideListCost, markdownFactsFrom, type VaultWorkSettings,
} from '../../src/main/vault-works'
import { hiddenCountText, type VaultIndex } from '../../src/shared/vault-index'
import { DEFAULT_VAULT_HIDDEN as SHARED_DEFAULT_HIDDEN, defaultVaultSettings, settingsFromRaw } from '../../src/shared/vault'
import { PREVIEW_HIDDEN } from '../../src/shared/vault-preview'

import { AGENT_IMPORT } from '../helpers/fake-auth'

/**
 * Work detection on fixture trees copied in miniature from the two real layouts (locked notes § Concepts,
 * survey-sample-data.json): a reports vault of Folios, and a writing vault of single files in topic folders.
 * A tree is a map of root-relative paths: a `.md` or manifest with its text, or a folder ending in `/`.
 */
type Fixture = Record<string, string | null>

function run(fixture: Fixture, settings: VaultWorkSettings = DEFAULT_VAULT_WORK_SETTINGS, rootName = 'vault') {
  const files = Object.keys(fixture).filter((path) => path.endsWith('.md'))
  const manifests = Object.keys(fixture).filter((path) => path.endsWith('/_report-structure.json')).map((path) => path.slice(0, -'/_report-structure.json'.length))
  const folders = new Set<string>()
  for (const path of Object.keys(fixture)) {
    const parts = path.replace(/\/$/, '').split('/')
    const upTo = path.endsWith('/') ? parts.length : parts.length - 1
    for (let i = 1; i <= upTo; i += 1) folders.add(parts.slice(0, i).join('/'))
  }
  const reads = new Map<string, number>()
  const index = detectVaultWorks({ rootName, files, folders: [...folders], manifests }, settings, {
    markdown: (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1)
      const content = fixture[path] ?? ''
      return markdownFactsFrom(content, path, documentTitle(content, path))
    },
    manifest: (folder) => {
      const key = `${folder}/_report-structure.json`
      reads.set(key, (reads.get(key) ?? 0) + 1)
      return fixture[key] ?? null
    },
  })
  return { index, reads }
}

const work = (index: VaultIndex, path: string) => index.works.find((candidate) => candidate.path === path)

const REPORTS: Fixture = {
  'AGENTS.md': '# Agents',
  'README.md': '# Reports',
  'example-training-offer-2026-10-16/_report-structure.json': JSON.stringify({ content_root: 'contents', files: [{ path: '01-intro.md' }, { path: '02-offer.md' }, { path: 'AGENTS.md' }] }),
  'example-training-offer-2026-10-16/README.md': '---\ntitle: Something else entirely\nstatus: review\n---\n\n# Example training follow-up\n',
  'example-training-offer-2026-10-16/AGENTS.md': '# Folio agents',
  'example-training-offer-2026-10-16/CLAUDE.md': AGENT_IMPORT,
  'example-training-offer-2026-10-16/contents/01-intro.md': '# Introduction',
  'example-training-offer-2026-10-16/contents/02-offer.md': '# The offer',
  'example-training-offer-2026-10-16/research/notes.md': '---\nstatus: draft\n---\n# Notes',
  'example-training-offer-2026-10-16/source/brief.md': '# Brief',
  'example-training-offer-2026-10-16/feedback/round-1.md': '# Feedback',
  'example-training-offer-2026-10-16/html/': null,
  'example-training-offer-2026-10-16/build/': null,
  'example-training-offer-2026-10-16/review-colleague-2026-10-14/comments.md': '# Comments',
  'example-training-offer-2026-10-16/review-colleague-2026-10-14/deeper/more.md': '# More',
  'notes-towards-ai-strategy/_report-structure.json': JSON.stringify({ files: [] }),
  'notes-towards-ai-strategy/agent-notes/n.md': '# n',
  'remote-proctoring-admissions-interviews/_report-structure.json': JSON.stringify({ files: [], status: 'idea' }),
  '_TEMPLATE/_report-structure.json': JSON.stringify({ files: [{ path: 'contents/01-a.md' }] }),
  '_TEMPLATE/contents/01-a.md': '# Template part',
  '_TEMPLATE/README.md': '# Template',
}

describe('reports vault (Folios)', () => {
  const { index, reads } = run(REPORTS)

  test('each manifest folder is one Folio work; _TEMPLATE is housekeeping', () => {
    expect(index.works.map((w) => [w.path, w.kind])).toEqual([
      ['example-training-offer-2026-10-16', 'folio'],
      ['notes-towards-ai-strategy', 'folio'],
      ['remote-proctoring-admissions-interviews', 'folio'],
    ])
    expect(index.workFolders).toEqual(index.works.map((w) => w.path))
  })

  test('title from the README heading, never its title:, status from README frontmatter', () => {
    const training = work(index, 'example-training-offer-2026-10-16')!
    expect(training.title).toBe('Example training follow-up')
    expect(training.status).toBe('review')
    expect(training.mainPath).toBe('example-training-offer-2026-10-16/README.md')
    expect(index.labels['example-training-offer-2026-10-16']).toBe('Example training follow-up')
  })

  test('parts in manifest order, agent instructions never a part; support and nested folders roll in', () => {
    const training = work(index, 'example-training-offer-2026-10-16')!
    expect(training.parts).toEqual([
      'example-training-offer-2026-10-16/contents/01-intro.md',
      'example-training-offer-2026-10-16/contents/02-offer.md',
    ])
    expect(training.support.sort()).toEqual([
      'example-training-offer-2026-10-16/feedback/round-1.md',
      'example-training-offer-2026-10-16/research/notes.md',
      'example-training-offer-2026-10-16/review-colleague-2026-10-14/comments.md',
      'example-training-offer-2026-10-16/review-colleague-2026-10-14/deeper/more.md',
      'example-training-offer-2026-10-16/source/brief.md',
    ])
  })

  test('a Folio with a manifest and 0 parts is still a work, named by its folder; manifest status is the fallback', () => {
    const empty = work(index, 'notes-towards-ai-strategy')!
    expect(empty).toMatchObject({ kind: 'folio', title: 'notes-towards-ai-strategy', status: null, mainPath: null, parts: [] })
    expect(work(index, 'remote-proctoring-admissions-interviews')!.status).toBe('idea')
    expect(index.hidden.paths).not.toContain('remote-proctoring-admissions-interviews')
  })

  test('hidden: top-most housekeeping only, empty folders inside a work are not hidden', () => {
    expect(index.hidden.paths).toEqual([
      'AGENTS.md',
      'README.md',
      '_TEMPLATE',
      'example-training-offer-2026-10-16/AGENTS.md',
      'example-training-offer-2026-10-16/CLAUDE.md',
    ])
    expect(index.hidden.countText).toBe('1 folder and 4 files hidden')
  })

  test('no file is read twice', () => {
    for (const [path, count] of reads) expect([path, count]).toEqual([path, 1])
  })
})

const WRITING: Fixture = {
  'AGENTS.md': '# a', 'CLAUDE.md': AGENT_IMPORT, 'README.md': '# Writing', 'CONTEXT.md': '# c',
  '_TASK-LOG/2026-10-01.md': '# log',
  'cache/blisty/a.md': '# cached',
  'tools/catalogue/x.md': '# tool',
  'inventory/': null,
  'empty-topic/sub/': null,
  'agent-only/AGENTS.md': '# only agents here',
  'blogs/_blogs_INDEX.md': '# Blogs',
  'blogs/techczech/2024-01-02-post-one.md': '---\nstatus: published\n---\n# Post one',
  'blogs/techczech/2024-01-02-post-one (1).md': '# Post one',
  'blogs/techczech/2024-01-02-post-one-conflict-20261001.md': '# Post one',
  'blogs/techczech/2024-01-03-post-two.md': '---\nstatus: draft\n---\n# Post two',
  'blogs/techczech/2024-01-03-post-two.review.md': '# review',
  'blogs/techczech/2024-01-03-post-two.notes.md': '# notes',
  'blogs/techczech/2024-01-03-post-two.editing/README.md': '# editing state',
  'blogs/techczech/2024-01-03-post-two.editing/turn-1.md': '# turn',
  'blogs/techczech/2024-01-03-post-two-Studio.md': '# Post two',
  'talks/what-should-educators-know.md': '# What should educators know',
  'talks/what-should-educators-know-about-ai.md': '# About AI',
  'tweets/2023-10-27-one-word-story.md': '---\nstatus: published\n---\nNo heading here.',
  'tweets/2023-11-19-maybe-the-move.md': '---\nstatus: published\n---\n# Maybe',
  'academic-writing-research/papers/unitybc-paper/_unitybc-paper_INDEX.md': '# UnityBC paper',
  'academic-writing-research/papers/unitybc-paper/01-overview.md': '---\nstatus: draft\n---\n# Pilot overview',
  'academic-writing-research/papers/unitybc-paper/02-pairwise-calculation.md': '---\nstatus: draft\n---\n# How are pairwise scores calculated?',
  'academic-writing-research/papers/unitybc-paper/10-costs.md': '---\nstatus: draft\n---\n# Costs and coverage',
  'academic-writing-research/papers/unitybc-paper/evidence/chunk-1.md': '---\nstatus: draft\n---\n# Urdu questionnaire',
  'academic-writing-research/papers/unitybc-paper/evidence/chunk-2.md': '---\nstatus: draft\n---\n# Another chunk',
  'academic-writing-research/papers/unitybc-paper/exports/': null,
  'academic-writing-research/papers/unitybc-paper/assets/': null,
  'essays/frontmatter-title.md': '---\ntitle: Frontmatter Title\nstatus: rough-draft\n---\n\n## The real heading\n',
  'essays/no-heading.md': 'Just prose.',
  'essays/research/background.md': '---\nstatus: draft\n---\n# Background',
  'books/guide/guide.md': '---\nstatus: partial-draft\n---\n# A guide to practice',
  'books/guide/chapter-one.md': '# Chapter one',
  'books/guide/drafts/old.md': '# old',
  'series/_series_INDEX.md': '---\npiece: many\n---\n# A series\n\nSome cover prose.',
  'series/README.md': '# Series readme',
  'series/part-a.md': '# Part A',
  'series/part-b.md': '# Part B',
  'drafts-old/x.md': '# hidden by pattern',
  'essays/junk.tmp.md': '# hidden by pattern',
}

describe('writing vault (single files in topic folders)', () => {
  const settings = { hidden: [...DEFAULT_VAULT_HIDDEN, 'drafts-old/', '*.tmp.md'], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] }
  const { index, reads } = run(WRITING, settings, 'writing')

  test('works, kinds, titles and raw statuses', () => {
    expect(index.works.map((w) => [w.path, w.kind, w.title, w.status])).toEqual([
      ['academic-writing-research/papers/unitybc-paper', 'folder-piece', 'unitybc-paper', null],
      ['blogs/techczech/2024-01-02-post-one.md', 'file', 'Post one', 'published'],
      ['blogs/techczech/2024-01-03-post-two.md', 'file', 'Post two', 'draft'],
      ['books/guide', 'folder-piece', 'A guide to practice', 'partial-draft'],
      ['essays/frontmatter-title.md', 'file', 'The real heading', 'rough-draft'],
      ['essays/no-heading.md', 'file', 'no-heading', null],
      ['series/part-a.md', 'file', 'Part A', null],
      ['series/part-b.md', 'file', 'Part B', null],
      ['talks/what-should-educators-know-about-ai.md', 'file', 'About AI', null],
      ['talks/what-should-educators-know.md', 'file', 'What should educators know', null],
      ['tweets/2023-10-27-one-word-story.md', 'file', '2023-10-27-one-word-story', 'published'],
      ['tweets/2023-11-19-maybe-the-move.md', 'file', 'Maybe', 'published'],
    ])
  })

  test('numbered parts make a folder piece; evidence/chunk-*.md with status draft is support, not a work', () => {
    const paper = work(index, 'academic-writing-research/papers/unitybc-paper')!
    expect(paper.parts).toEqual([
      'academic-writing-research/papers/unitybc-paper/01-overview.md',
      'academic-writing-research/papers/unitybc-paper/02-pairwise-calculation.md',
      'academic-writing-research/papers/unitybc-paper/10-costs.md',
    ])
    expect(paper.support).toEqual([
      'academic-writing-research/papers/unitybc-paper/_unitybc-paper_INDEX.md',
      'academic-writing-research/papers/unitybc-paper/evidence/chunk-1.md',
      'academic-writing-research/papers/unitybc-paper/evidence/chunk-2.md',
    ])
    expect(index.works.some((w) => w.path.includes('/evidence/'))).toBe(false)
  })

  test('a support folder outside any work never yields works', () => {
    expect(work(index, 'essays/research/background.md')).toBeUndefined()
    expect(index.hidden.paths).not.toContain('essays/research')
  })

  test('folder-named main document makes a folder piece; nested folders roll in', () => {
    const guide = work(index, 'books/guide')!
    expect(guide.mainPath).toBe('books/guide/guide.md')
    expect(guide.parts).toEqual(['books/guide/chapter-one.md'])
    expect(guide.support).toEqual(['books/guide/drafts/old.md'])
  })

  test('sidecars roll into their work and are never works', () => {
    expect(work(index, 'blogs/techczech/2024-01-03-post-two.md')!.sidecars.sort()).toEqual([
      'blogs/techczech/2024-01-03-post-two.editing/turn-1.md',
      'blogs/techczech/2024-01-03-post-two.notes.md',
      'blogs/techczech/2024-01-03-post-two.review.md',
    ])
  })

  test('conflict copies are not works and are hidden; a slug-named sibling is not a conflict copy', () => {
    for (const copy of [
      'blogs/techczech/2024-01-02-post-one (1).md',
      'blogs/techczech/2024-01-02-post-one-conflict-20261001.md',
      'blogs/techczech/2024-01-03-post-two-Studio.md',
    ]) {
      expect(work(index, copy)).toBeUndefined()
      expect(index.hidden.paths).toContain(copy)
    }
    expect(work(index, 'talks/what-should-educators-know-about-ai.md')).toBeDefined()
  })

  test('covers are neither works nor hidden; piece: many keeps a folder a Collection', () => {
    expect(work(index, 'blogs/_blogs_INDEX.md')).toBeUndefined()
    expect(index.hidden.paths).not.toContain('blogs/_blogs_INDEX.md')
    expect(work(index, 'series')).toBeUndefined()
    expect(index.hidden.paths).toContain('series/README.md')
  })

  test('hidden set: top-most entries only, with the count line', () => {
    expect(index.hidden.paths).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'CONTEXT.md',
      'README.md',
      '_TASK-LOG',
      'agent-only',
      'blogs/techczech/2024-01-02-post-one (1).md',
      'blogs/techczech/2024-01-02-post-one-conflict-20261001.md',
      'blogs/techczech/2024-01-03-post-two-Studio.md',
      'blogs/techczech/2024-01-03-post-two.editing/README.md',
      'cache',
      'drafts-old',
      'empty-topic',
      'essays/junk.tmp.md',
      'inventory',
      'series/README.md',
      'tools',
    ])
    expect(index.hidden.countText).toBe('7 folders and 10 files hidden')
  })

  test('labels map every work path to its title', () => {
    expect(Object.keys(index.labels)).toEqual(index.works.map((w) => w.path))
    expect(index.labels['books/guide']).toBe('A guide to practice')
    expect(index.workFolders).toEqual(['academic-writing-research/papers/unitybc-paper', 'books/guide'])
  })

  test('no file is read twice', () => {
    for (const [path, count] of reads) expect([path, count]).toEqual([path, 1])
  })
})

describe('ADR-0033 recognition details', () => {
  test('a cover alone does not make a folder one work; piece: one does', () => {
    const covered = run({ 'topic/_topic.md': '# Topic cover', 'topic/a.md': '# A', 'topic/b.md': '# B' }).index
    expect(covered.works.map((w) => w.path)).toEqual(['topic/a.md', 'topic/b.md'])
    const declared = run({ 'topic/_topic_INDEX.md': '---\npiece: one\n---\n# The one work\n\nCover prose.', 'topic/a.md': '# A' }).index
    expect(declared.works.map((w) => [w.path, w.kind, w.title])).toEqual([['topic', 'folder-piece', 'The one work']])
  })

  test('README makes a folder one work and is then not hidden', () => {
    const { index } = run({ 'post/README.md': '---\nstatus: draft\n---\n# Long post', 'post/research/x.md': '# x' })
    expect(index.works).toEqual([{ path: 'post', kind: 'folder-piece', title: 'Long post', status: 'draft', mainPath: 'post/README.md', parts: [], sidecars: [], support: ['post/research/x.md'] }])
    expect(index.hidden.paths).toEqual([])
  })

  test('a single numbered file or dated files are not numbered parts', () => {
    expect(run({ 'f/01-only.md': '# Only', 'f/notes.md': '# Notes' }).index.works.map((w) => w.kind)).toEqual(['file', 'file'])
    expect(run({ 'f/2024-01-01-a.md': '# A', 'f/2024-01-02-b.md': '# B' }).index.works.map((w) => w.kind)).toEqual(['file', 'file'])
  })

  test('a frontmatter title: different from the first heading does not change the title', () => {
    const { index } = run({ 'a.md': '---\ntitle: From frontmatter\n---\n### Deep heading first\n# Later H1' })
    expect(index.works[0].title).toBe('Deep heading first')
  })
})

describe('hidden count line', () => {
  test('folders only, files only, both, singulars, none', () => {
    expect(hiddenCountText(3, 0)).toBe('3 folders hidden')
    expect(hiddenCountText(0, 2)).toBe('2 files hidden')
    expect(hiddenCountText(4, 2)).toBe('4 folders and 2 files hidden')
    expect(hiddenCountText(1, 1)).toBe('1 folder and 1 file hidden')
    expect(hiddenCountText(0, 0)).toBe('Nothing hidden')
  })

  test('from a tree: folders only and files only', () => {
    expect(run({ '_TASK-LOG/a.md': '# a', 'w.md': '# w' }).index.hidden.countText).toBe('1 folder hidden')
    expect(run({ 'AGENTS.md': '# a', 'w.md': '# w' }).index.hidden.countText).toBe('1 file hidden')
  })
})

describe('performance', () => {
  test('a 2,600-file synthetic tree completes well inside a second, each file read at most once', () => {
    const fixture: Fixture = {}
    for (let t = 0; t < 26; t += 1) {
      for (let i = 0; i < 90; i += 1) fixture[`topic-${t}/sub-${i % 6}/2024-01-${String(i).padStart(2, '0')}-piece-${i}.md`] = `---\nstatus: draft\n---\n# Piece ${t}.${i}\n\nBody.`
      for (let p = 1; p <= 10; p += 1) fixture[`topic-${t}/report/${String(p).padStart(2, '0')}-part.md`] = `# Part ${p}`
    }
    expect(Object.keys(fixture).length).toBe(2600)
    run(fixture) // warm the JIT
    const start = performance.now()
    const { index, reads } = run(fixture)
    const ms = performance.now() - start
    console.log(`vault-works: 2,600 files in ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(1000)
    expect(index.works.length).toBe(26 * 90 + 26)
    expect(Math.max(...reads.values())).toBe(1)
  })
})

describe('review fixes (ticket 02 fix round)', () => {
  const withRules = (...extra: string[]): VaultWorkSettings => ({ hidden: [...DEFAULT_VAULT_HIDDEN, ...extra], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] })

  test('a hostile wildcard pattern matches in bounded time (no backtracking)', () => {
    const hostile = `${'*a'.repeat(18)}b`
    const name = `${'a'.repeat(40)}.md`
    const start = performance.now()
    const { index } = run({ [name]: '# A', [`dir/${name}`]: '# B' }, withRules(hostile, `**/${hostile}`))
    expect(performance.now() - start).toBeLessThan(250)
    expect(index.works.map((w) => w.path).sort()).toEqual([`dir/${name}`, name].sort())
    // The matcher is still a wildcard matcher: `*` stays in a segment, `**` crosses, `?` is one character.
    const globs = run({ 'a/x1.md': '# x', 'a/b/x2.md': '# y', 'keep.md': '# k' }, withRules('a/*.md', 'a/**/x?.md')).index
    expect(globs.works.map((w) => w.path)).toEqual(['keep.md'])
    expect(run({ 'a/b/x2.md': '# y', 'keep.md': '# k' }, withRules('a/*.md')).index.works.map((w) => w.path)).toEqual(['a/b/x2.md', 'keep.md'])
  })

  test('the hidden list is capped at 200 entries of 200 characters; the rest is ignored with a warning', () => {
    const warnings: string[] = []
    const settings = { hidden: [...DEFAULT_VAULT_HIDDEN, `${'x'.repeat(201)}`, ...Array.from({ length: 250 }, (_, i) => `n${i}.md`)], supportFolders: [] }
    const files = ['n0.md', 'n199.md', 'n240.md']
    const index = detectVaultWorks({ rootName: 'v', files, folders: [], manifests: [] }, settings, {
      markdown: (path) => markdownFactsFrom('# t', path, 't'),
      manifest: () => null,
    }, (message) => warnings.push(message))
    // Entries 0..199 of the list are read: 15 defaults, the long one (ignored), then n0..n183.
    expect(index.works.map((w) => w.path)).toEqual(['n199.md', 'n240.md'])
    expect(index.hidden.paths).toEqual(['n0.md'])
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('past the first 200')
    expect(warnings[0]).toContain('longer than 200')
  })

  test('a candidate main document hidden by a rule the writer added is not a main document', () => {
    const { index } = run({ 'post/post.md': '# Hidden main', 'post/other.md': '# Other' }, withRules('post/post.md'))
    expect(index.works.map((w) => [w.path, w.kind, w.title])).toEqual([['post/other.md', 'file', 'Other']])
    expect(index.hidden.paths).toEqual(['post/post.md'])
  })

  test('a dotted sidecar folder belongs to the longest stem with a sibling file', () => {
    const { index } = run({ 'essay.v2.md': '# Essay two', 'essay.v2.editing/notes.md': '# Notes', 'essay.md': '# Essay one' })
    expect(index.works.map((w) => [w.path, w.sidecars])).toEqual([
      ['essay.md', ['essay.v2.editing/notes.md', 'essay.v2.md']],
    ])
    const lone = run({ 'essay.v2.md': '# Essay two', 'essay.v2.editing/notes.md': '# Notes' }).index
    expect(lone.works.map((w) => [w.path, w.sidecars])).toEqual([['essay.v2.md', ['essay.v2.editing/notes.md']]])
  })

  test('numbered parts take any number of digits, but a date prefix is not a part number', () => {
    const book = run({ 'book/0001-intro.md': '# Intro', 'book/0002-body.md': '# Body' }).index
    expect(book.works.map((w) => [w.path, w.kind, w.parts])).toEqual([['book', 'folder-piece', ['book/0001-intro.md', 'book/0002-body.md']]])
    expect(run({ 'blog/2024-05-a.md': '# A', 'blog/2024-06-b.md': '# B' }).index.works.map((w) => w.kind)).toEqual(['file', 'file'])
  })

  test('a folder work whose main document has no heading is named by its folder', () => {
    const { index } = run({ 'post/README.md': '---\nstatus: draft\n---\nJust prose, no heading.', 'post/notes/x.md': '# x' })
    expect(index.works.map((w) => [w.path, w.title, w.status])).toEqual([['post', 'post', 'draft']])
    // A heading that happens to equal the file name is still a heading.
    expect(run({ 'post/README.md': '# README', 'post/notes/x.md': '# x' }).index.works[0].title).toBe('README')
    expect(markdownFactsFrom('Prose only.', 'post/README.md', 'README').heading).toBe(false)
  })

  test('hidden is the complete rule list: a rule left out is not applied', () => {
    const tree: Fixture = {
      'README.md': '# Vault readme',
      'essay.md': '# Essay',
      'essay (1).md': '# Essay',
      'empty/': null,
      'report/_report-structure.json': JSON.stringify({ files: [{ path: '01-a.md' }] }),
      'report/README.md': '# The report',
      'report/01-a.md': '# A',
    }
    const all = run(tree).index
    expect(all.works.map((w) => w.path)).toEqual(['essay.md', 'report'])
    expect(all.hidden.paths).toEqual(['README.md', 'empty', 'essay (1).md'])

    const none = run(tree, { hidden: [], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] }).index
    expect(none.works.map((w) => w.path).sort()).toEqual(['README.md', 'essay (1).md', 'essay.md', 'report'])
    expect(none.hidden.paths).toEqual([])
    // README inside the Folio stays its main document whatever the list says.
    expect(none.works.find((w) => w.path === 'report')?.mainPath).toBe('report/README.md')
    expect(all.works.find((w) => w.path === 'report')?.mainPath).toBe('report/README.md')

    const noReadme = run(tree, { hidden: DEFAULT_VAULT_HIDDEN.filter((rule) => rule !== 'README.md'), supportFolders: [] }).index
    expect(noReadme.works.map((w) => w.path).sort()).toEqual(['README.md', 'essay.md', 'report'])
  })

  test('the built-in list is one source: shared defaults, work-detection defaults, the two reserved rules', () => {
    expect(DEFAULT_VAULT_WORK_SETTINGS.hidden).toEqual([...SHARED_DEFAULT_HIDDEN])
    expect(defaultVaultSettings('x').hidden).toEqual([...SHARED_DEFAULT_HIDDEN])
    expect(settingsFromRaw({ name: 'x' }, 'x').hidden).toEqual([...SHARED_DEFAULT_HIDDEN])
    expect(SHARED_DEFAULT_HIDDEN).toContain(':conflict-copies')
    expect(SHARED_DEFAULT_HIDDEN).toContain(':empty-folders')
  })
})

describe('matcher cost bound (ticket 02 fix round 2)', () => {
  /** In-memory detection over flat names; returns the work paths, the warnings and the time taken. */
  const detect = (files: string[], hidden: string[]) => {
    const warnings: string[] = []
    const start = performance.now()
    const index = detectVaultWorks({ rootName: 'v', files, folders: [], manifests: [] }, { hidden, supportFolders: [] }, {
      markdown: (path) => markdownFactsFrom('# t', path, 't'),
      manifest: () => null,
    }, (message) => warnings.push(message))
    return { index, warnings, ms: performance.now() - start }
  }
  const longNames = Array.from({ length: 2600 }, (_, i) => `topic${Math.floor(i / 100)}/${'a'.repeat(100)}${i}.md`)

  test("the reviewer's reproduction (200 rules of 95 wildcards over 2,600 long names) finishes inside a second", () => {
    const hidden = Array.from({ length: 200 }, (_, i) => `${'*a'.repeat(95)}${i}b`)
    expect(Math.max(...hidden.map((rule) => rule.length))).toBeLessThanOrEqual(HIDE_RULE_LIMITS.length)
    const { index, warnings, ms } = detect(longNames, hidden)
    console.log(`vault-works: reviewer reproduction in ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(1000)
    expect(index.works.length).toBe(2600)
    expect(warnings).toEqual(['vault.json hidden: ignored 200 entries with more than 16 wildcards'])
  })

  test('rules inside the wildcard cap still stop at the total budget; matching stays inside a second', () => {
    // 16 wildcards each, long literal runs and a `.md` suffix so the prefilter passes: the costliest list allowed.
    const hidden = Array.from({ length: 200 }, (_, i) => `${'*aaaaaaaaa'.repeat(16)}${i}x.md`)
    const kept = boundedHiddenList(hidden)
    expect(hideListCost(kept)).toBeLessThanOrEqual(HIDE_RULE_LIMITS.budget)
    expect(kept.length).toBe(2)
    const { index, warnings, ms } = detect(longNames, hidden)
    console.log(`vault-works: budget-filled hostile list in ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(1000)
    expect(index.works.length).toBe(2600)
    expect(warnings).toEqual(['vault.json hidden: ignored 198 wildcard entries past the matching budget of 400'])
  })

  test('the built-in list costs nothing and the sheet list 11 of the 400; a normal list matches as before', () => {
    expect(hideListCost([...DEFAULT_VAULT_HIDDEN])).toBe(0)
    expect(hideListCost([...PREVIEW_HIDDEN])).toBe(11)
    expect(boundedHiddenList([...PREVIEW_HIDDEN, 3, null])).toEqual([...PREVIEW_HIDDEN])
    const { index, warnings } = detect(
      ['README.md', 'topic/_topic_INDEX.md', 'topic/a.md', 'drafts/old-1.md', 'drafts/keep.md', 'x/y/z.md', 'notes.md'],
      [...PREVIEW_HIDDEN, 'drafts/old-?.md', '**/y/*.md', '*.MD.bak'],
    )
    expect(warnings).toEqual([])
    expect(index.works.map((w) => w.path).sort()).toEqual(['drafts/keep.md', 'notes.md', 'topic/a.md'])
    expect(index.hidden.paths.sort()).toEqual(['README.md', 'drafts/old-1.md', 'topic/_topic_INDEX.md', 'x'].sort())
  })

  test('the literal prefix and suffix gate the match, case ignored', () => {
    const { index } = detect(['Draft-one.md', 'draft-two.txt.md', 'final-one.md', 'draft.md'], ['DRAFT-*.MD'])
    expect(index.works.map((w) => w.path)).toEqual(['draft.md', 'final-one.md'])
  })
})
