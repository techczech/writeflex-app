/**
 * Synthetic Folios for the room: a multi-part report shape with fully synthetic prose. Each builder
 * writes one Folio into a scratch workspace root and returns its folder (workspace-relative). Bytes are written
 * exactly (CRLF, BOM) so a test can assert that opening the room leaves them alone. Never reads or writes a
 * real document folder.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const put = async (root: string, rel: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), content)
}

const part = (title: string, body: string, front = ''): string => `${front}# ${title}\n\n${body}\n`

/** The support folders every synthetic report Folio has: research (md, json), source (html, json), feedback (subfolder). */
async function researchFolders(root: string, dir: string): Promise<void> {
  await put(root, `${dir}/research/audience-contract.md`, '# Audience contract\n\nWho reads this.\n')
  await put(root, `${dir}/research/scores.json`, '{"a": 1}\n')
  await put(root, `${dir}/source/report.html`, '<html><body>Report</body></html>\n')
  await put(root, `${dir}/source/scores.json`, '{"b": 2}\n')
  await put(root, `${dir}/feedback/reviews/review-scope.md`, '# Review scope\n\nCheck it.\n')
}

const manifest = (files: Array<{ path: string; role?: string }>, extra: Record<string, unknown> = {}): string => JSON.stringify({
  schema_version: 1, report_id: 'synthetic', content_root: 'contents', output: 'html/synthetic.html',
  title_matter: 'contents/00-frontmatter.md', files, ...extra,
}, null, 2)

export type BuiltFolio = {
  dir: string
  indexPath: string | null
  /** Running-order titles, in order. */
  titles: string[]
  /** Titles with no file. */
  unwritten: string[]
  /** Workspace-relative paths of the written parts, in running order. */
  writtenPaths: string[]
  /** An independent word count of each written part's body (frontmatter excluded), by path. */
  words: Record<string, number>
}

const wordsOf = (body: string): number => body.trim().split(/\s+/).filter(Boolean).length

/** F-PANGRAM: two-line running order, one gloss and `#summary`, content_root, title_matter, research, source, feedback. */
export async function pangramFolio(root: string, dir = 'pangram'): Promise<BuiltFolio> {
  const name = dir.split('/').at(-1)
  const summaryBody = 'Findings in one place. Seven short words here.'
  const detailsBody = 'Details body text with a few more words than the summary has, for the count.'
  await put(root, `${dir}/_${name}_INDEX.md`, `---\ntitle: Synthetic report\n---\n\n# Synthetic report\n\n## Running order\n\n- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n- [[Details]]\n`)
  await put(root, `${dir}/contents/00-frontmatter.md`, '---\ntitle: Synthetic report\nrole: title-matter\n---\n\nBy the author.\n')
  await put(root, `${dir}/contents/01-summary.md`, part('Summary', summaryBody, '---\ntitle: Summary\ndescription: Extra frontmatter\n---\n\n'))
  await put(root, `${dir}/contents/02-report.md`, part('Details', detailsBody, '---\ntitle: Details\nowner: someone\n---\n\n'))
  await put(root, `${dir}/_report-structure.json`, manifest([{ path: 'contents/01-summary.md', role: 'summary' }, { path: 'contents/02-report.md', role: 'report-body' }]))
  await researchFolders(root, dir)
  const written = [`${dir}/contents/01-summary.md`, `${dir}/contents/02-report.md`]
  return {
    dir, indexPath: `${dir}/_${name}_INDEX.md`, titles: ['Summary', 'Details'], unwritten: [], writtenPaths: written,
    words: { [written[0]]: wordsOf(`# Summary\n\n${summaryBody}`), [written[1]]: wordsOf(`# Details\n\n${detailsBody}`) },
  }
}

/** F-MANIFEST-ONLY: a manifest and no Index Note. */
export async function manifestOnlyFolio(root: string, dir = 'manifest-only'): Promise<BuiltFolio> {
  await put(root, `${dir}/contents/01-alpha.md`, part('Alpha', 'Alpha text.'))
  await put(root, `${dir}/contents/02-beta.md`, part('Beta', 'Beta text here.'))
  await put(root, `${dir}/_report-structure.json`, manifest([{ path: 'contents/01-alpha.md' }, { path: 'contents/02-beta.md' }], { title_matter: undefined }))
  const written = [`${dir}/contents/01-alpha.md`, `${dir}/contents/02-beta.md`]
  return { dir, indexPath: null, titles: ['Alpha', 'Beta'], unwritten: [], writtenPaths: written, words: { [written[0]]: wordsOf('# Alpha\n\nAlpha text.'), [written[1]]: wordsOf('# Beta\n\nBeta text here.') } }
}

/** F-INDEX-ONLY: an Index Note with a running order and no manifest. */
export async function indexOnlyFolio(root: string, dir = 'index-only'): Promise<BuiltFolio> {
  await put(root, `${dir}/_index-only_INDEX.md`, '# Index only\n\n## Running order\n\n- [[One]] — First part.\n- [[Two]]\n- [[Three]] — Not written.\n')
  await put(root, `${dir}/one.md`, part('One', 'One two three.'))
  await put(root, `${dir}/two.md`, part('Two', 'Two words.'))
  const written = [`${dir}/one.md`, `${dir}/two.md`]
  return { dir, indexPath: `${dir}/_index-only_INDEX.md`, titles: ['One', 'Two', 'Three'], unwritten: ['Three'], writtenPaths: written, words: { [written[0]]: wordsOf('# One\n\nOne two three.'), [written[1]]: wordsOf('# Two\n\nTwo words.') } }
}

/** An Index Note whose Running order heading has no parts (and one with no heading at all): "Start a plan". */
export async function noRunningOrderFolio(root: string, dir = 'no-order'): Promise<BuiltFolio> {
  await put(root, `${dir}/_no-order_INDEX.md`, '# No order\n\nJust prose, no plan yet.\n')
  await put(root, `${dir}/loose.md`, part('Loose', 'A file that is not in any outline.'))
  return { dir, indexPath: `${dir}/_no-order_INDEX.md`, titles: [], unwritten: [], writtenPaths: [], words: {} }
}

/** F-FORMS: repeated `1.`, non-consecutive numbers, `*`, aliases, ` - `, CRLF, BOM, a code block holding `- [[x]]`. */
export async function formsFolio(root: string, dir = 'forms'): Promise<BuiltFolio> {
  const lines = [
    '﻿# Forms', '', 'Foreign section above.', '', '## Running order', '',
    '1. [[Alpha]] — First - with a dash.', '1. [[Beta|the second]] — Second.', '1. [[Gamma]]',
    '3. [[Delta]] #section', '7. [[Epsilon]]', '* [[Zeta]] — Starred.', '',
    '## Notes', '', '```', '- [[Not a part]]', '```', '',
  ]
  await put(root, `${dir}/_forms_INDEX.md`, lines.join('\r\n'))
  const written: string[] = []
  const words: Record<string, number> = {}
  for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
    const path = `${dir}/${title.toLowerCase()}.md`
    await put(root, path, part(title, `${title} text.`))
    written.push(path)
    words[path] = wordsOf(`# ${title}\n\n${title} text.`)
  }
  return { dir, indexPath: `${dir}/_forms_INDEX.md`, titles: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'], unwritten: ['Zeta'], writtenPaths: written, words }
}

/**
 * F-MIXED: unwritten parts, a front-matter part, files not in the outline, a subfolder file, a status in
 * frontmatter, labels and priorities.
 */
export async function mixedFolio(root: string, dir = 'mixed'): Promise<BuiltFolio> {
  await put(root, `${dir}/_mixed_INDEX.md`, [
    '---', 'labels:', '  - Frame', '  - Findings', '---', '', '# Mixed', '', '## Running order', '',
    '- [[Title page]] #front-matter', '- [[Intro]] — Why it matters. #label-frame #priority-high', '- [[Method]] — How. #label-findings',
    '- [[Results]] — Not yet written.', '- [[Costs]] — Money. #priority-low #label-unlisted', '',
  ].join('\n'))
  const files: Record<string, { body: string; status?: string }> = {
    'title-page': { body: 'Title page text.' }, intro: { body: 'Intro text has five words.', status: 'in progress' },
    method: { body: 'Method text.', status: 'editing' }, costs: { body: 'Costs text for the section.' },
  }
  const titles: Record<string, string> = { 'title-page': 'Title page', intro: 'Intro', method: 'Method', costs: 'Costs' }
  const written: string[] = []
  const words: Record<string, number> = {}
  for (const [slug, { body, status }] of Object.entries(files)) {
    const path = `${dir}/${slug}.md`
    const front = status ? `---\nstatus: ${status}\n---\n\n` : ''
    await put(root, path, part(titles[slug], body, front))
    written.push(path)
    words[path] = wordsOf(`# ${titles[slug]}\n\n${body}`)
  }
  await put(root, `${dir}/not-in-outline.md`, part('Not in outline', 'Loose file.'))
  await put(root, `${dir}/sub/deeper.md`, part('Deeper', 'Subfolder file.'))
  await put(root, `${dir}/scraps/mixed-SCRAPS.md`, '## s_aaa1\nA first scrap\n\n## s_bbb2\nA second scrap\n')
  await researchFolders(root, dir)
  await put(root, `${dir}/notes/meeting.md`, '# Meeting\n\nNotes.\n')
  return {
    dir, indexPath: `${dir}/_mixed_INDEX.md`, titles: ['Title page', 'Intro', 'Method', 'Results', 'Costs'], unwritten: ['Results'],
    writtenPaths: written, words,
  }
}

/** F-CLASH: two unwritten "Results" lines with different glosses, and two written parts sharing a title. */
export async function clashFolio(root: string, dir = 'clash'): Promise<BuiltFolio> {
  await put(root, `${dir}/_clash_INDEX.md`, [
    '# Clash', '', '## Running order', '',
    '- [[Results]] — First gloss.', '- [[Results]] — Second gloss.', '- [[Same]] — One.', '- [[Same]] — Two.', '',
  ].join('\n'))
  await put(root, `${dir}/same-a.md`, part('Same', 'A text.', '---\ntitle: Same\n---\n\n'))
  await put(root, `${dir}/same-b.md`, part('Same', 'B text.', '---\ntitle: Same\n---\n\n'))
  return { dir, indexPath: `${dir}/_clash_INDEX.md`, titles: ['Results', 'Results', 'Same', 'Same'], unwritten: ['Results', 'Results'], writtenPaths: [], words: {} }
}

/** F-LABELS: `labels:` with "Check fact" and "Check-fact"; a stray `#label-x`; two `#priority-` tags on one line. */
export async function labelsFolio(root: string, dir = 'labels'): Promise<BuiltFolio> {
  await put(root, `${dir}/_labels_INDEX.md`, [
    '---', 'labels:', '  - Check fact', '  - Check-fact', '  - Frame', '---', '', '# Labels', '', '## Running order', '',
    '- [[One]] — A. #label-check-fact', '- [[Two]] — B. #label-x', '- [[Three]] — C. #priority-high #priority-low #label-frame', '',
  ].join('\n'))
  return { dir, indexPath: `${dir}/_labels_INDEX.md`, titles: ['One', 'Two', 'Three'], unwritten: ['One', 'Two', 'Three'], writtenPaths: [], words: {} }
}

/** F-LARGE: 200 parts of about 10 KB each. */
export async function largeFolio(root: string, dir = 'large', count = 200): Promise<BuiltFolio> {
  const lines = ['# Large', '', '## Running order', '']
  const written: string[] = []
  const words: Record<string, number> = {}
  const prose = 'lorem ipsum dolor sit amet '.repeat(380)
  for (let at = 0; at < count; at += 1) {
    const title = `Part ${at + 1}`
    lines.push(`- [[${title}]] — Gloss ${at + 1}.`)
    const path = `${dir}/part-${String(at + 1).padStart(3, '0')}.md`
    await put(root, path, part(title, prose))
    written.push(path)
    words[path] = wordsOf(`# ${title}\n\n${prose}`)
  }
  await put(root, `${dir}/_large_INDEX.md`, `${lines.join('\n')}\n`)
  return { dir, indexPath: `${dir}/_large_INDEX.md`, titles: written.map((_, at) => `Part ${at + 1}`), unwritten: [], writtenPaths: written, words }
}

export const READ_ONLY_FIXTURES: Array<[string, (root: string) => Promise<BuiltFolio>]> = [
  ['F-PANGRAM', pangramFolio], ['F-MANIFEST-ONLY', manifestOnlyFolio], ['F-INDEX-ONLY', indexOnlyFolio],
  ['no running order', noRunningOrderFolio], ['F-FORMS', formsFolio], ['F-MIXED', mixedFolio], ['F-CLASH', clashFolio], ['F-LABELS', labelsFolio],
]
