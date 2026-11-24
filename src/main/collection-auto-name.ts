import { posix } from 'node:path'
import { isUntitledPiece, type CollectionNamingCandidate, type CollectionNamingTitle, type CollectionTitleField as TitleField } from '../shared/collection-naming-title'
import { parseMarkdownBlocks } from '../shared/markdown/dialect'
import { FRONTMATTER_DASH_ITEM, frontmatterBlock } from '../shared/markdown/frontmatter'
import { listingTitle } from '../shared/markdown/listing-title'
import { parseFrontmatter } from './frontmatter'
import { slugifyFileName, type Workspace } from './workspace'

type NamingPattern = { kind: 'plain' | 'date' } | { kind: 'number'; width: number; next: number }
type TitlePreference = 'metadata' | 'heading' | 'either'
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SLUG = '[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*'
const DATE_NAME = new RegExp('^\\d{4}-\\d{2}-\\d{2}-' + SLUG + '$', 'u')
const NUMBER_NAME = new RegExp('^(\\d+)-' + SLUG + '$', 'u')

export function collectionNamingPattern(names: readonly string[]): NamingPattern {
  const stems = names.filter(name => !isUntitledPiece(name)).map(name => name.replace(/\.(?:md|markdown|mdx)$/i, ''))
  if (stems.length < 3) return { kind: 'plain' }
  if (stems.every(stem => DATE_NAME.test(stem))) return { kind: 'date' }
  const numbers = stems.map(stem => DATE_NAME.test(stem) ? undefined : NUMBER_NAME.exec(stem)?.[1])
  if (numbers.every((number): number is string => number !== undefined && Number.isSafeInteger(Number(number)))) {
    const used = new Set(numbers.map(Number))
    let next = 1
    while (used.has(next)) next += 1
    const width = numbers.some(number => number.startsWith('0')) ? Math.min(...numbers.map(number => number.length)) : 1
    return { kind: 'number', width, next }
  }
  return { kind: 'plain' }
}

function titleIn(content: string, field: TitleField): string | null {
  const title = (field === 'metadata' ? parseFrontmatter(content)?.title : listingTitle(content, '', 1))?.trim()
  return title && title.toLowerCase() !== 'untitled' ? title : null
}

export function hasNewCollectionTitle(before: string, after: string): boolean {
  return newCollectionTitle(before, after, 'metadata') !== null || newCollectionTitle(before, after, 'heading') !== null
}

export function newCollectionTitle(before: string, after: string, field: TitleField): string | null {
  return titleIn(before, field) ? null : titleIn(after, field)
}

/** Source coordinates include the line ending position where a caret sits after the last letter. */
export function collectionNamingTitle(before: string, content: string, preference: TitlePreference): CollectionNamingTitle | null {
  let field: TitleField = preference === 'metadata' ? 'metadata' : 'heading'
  let title = newCollectionTitle(before, content, field)
  if (!title && preference === 'either') {
    field = 'metadata'
    title = newCollectionTitle(before, content, field)
  }
  if (!title) return null
  const metadata = frontmatterBlock(content)
  let range: CollectionNamingTitle['range'] = null
  if (field === 'metadata' && metadata) {
    let from = content.indexOf('\n') + 1
    for (const [index, line] of metadata.lines.entries()) {
      const to = content.indexOf('\n', from)
      if (line.startsWith('title:')) {
        let last = to
        if (line.slice('title:'.length).trim() === '') {
          for (let i = index + 1; i < metadata.lines.length && FRONTMATTER_DASH_ITEM.test(metadata.lines[i]); ++i) {
            last = content.indexOf('\n', last + 1)
          }
        }
        range = { from, to: last }
      }
      from = to + 1
    }
  } else if (field === 'heading') {
    const offset = metadata?.end ?? (content.startsWith('\uFEFF') ? 1 : 0)
    const root = parseMarkdownBlocks(content.slice(offset)).topNode
    for (let node = root.firstChild; node; node = node.nextSibling) {
      if (node.name !== 'ATXHeading1' && node.name !== 'SetextHeading1') continue
      const end = content.indexOf('\n', offset + node.to)
      range = { from: content.lastIndexOf('\n', offset + node.from - 1) + 1, to: end < 0 ? content.length : end }
      break
    }
  }
  return { field, title, range }
}

export function collectionName(title: string, content: string, created: string, pattern: NamingPattern, occupied: readonly string[]): string | null {
  const ascii = slugifyFileName(title.normalize('NFKD').replace(/\p{M}/gu, '')).slice(0, -3)
  const local = title.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '')
  // Keep the app's usual slug when it has letters or digits. Preserve titles in other scripts too.
  let slug = Array.from(ascii === 'untitled' ? local : ascii).slice(0, 160).join('')
  while (Buffer.byteLength(slug) > 160) slug = Array.from(slug).slice(0, -1).join('')
  slug = slug.replace(/-+$/, '')
  if (!slug) return null
  const date = parseFrontmatter(content)?.date
  const prefix = pattern.kind === 'date' ? (date && DATE.test(date) ? date : created) + '-'
    : pattern.kind === 'number' ? String(pattern.next).padStart(pattern.width, '0') + '-' : ''
  const stem = prefix + slug
  const taken = new Set(occupied.map(name => name.toLowerCase()))
  let name = stem + '.md'
  for (let suffix = 2; taken.has(name) || isUntitledPiece(name); suffix += 1) name = stem + '-' + suffix + '.md'
  return name
}

export type AutoNameSave = { content: string; created: string; candidate: CollectionNamingCandidate }

async function namingSiblings(ws: Workspace, path: string) {
  const parent = posix.dirname(path)
  const dir = parent === '.' ? '' : parent
  return (await ws.listFilesIn(dir, { recursive: false })).filter(file =>
    !isUntitledPiece(file.name) && !/^(?:_|\.|(?:readme|index|agents|claude)\.)/i.test(file.name))
}

export async function preferredCollectionTitle(ws: Workspace, path: string): Promise<TitlePreference> {
  let metadata = 0
  let headings = 0
  for (const file of await namingSiblings(ws, path)) {
    const content = await ws.readFile(file.path).then(file => file.content, () => '')
    if (titleIn(content, 'metadata')) metadata += 1
    else if (titleIn(content, 'heading')) headings += 1
  }
  return metadata === headings ? 'either' : metadata > headings ? 'metadata' : 'heading'
}

export async function planCollectionName(ws: Workspace, path: string, saved: AutoNameSave, collisions: readonly string[]): Promise<string | null> {
  const names = (await namingSiblings(ws, path)).map(file => file.name)
  return collectionName(saved.candidate.title, saved.content, saved.created, collectionNamingPattern(names), [...names, ...collisions])
}
