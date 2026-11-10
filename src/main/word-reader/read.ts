import { blockMarkdown, makeContext, readBlocks, type BodyContext, type RawBlock } from './body'
import { MAIN_DOCUMENT_TYPE, contentTypeOf, dirOf, isW, readContentTypes, readNumbering, readRelationships, readStyles, relsNameFor, resolveTarget, wChild } from './package-model'
import { WordRefusalError, refusal } from './refusal'
import { WORD_READER_VERSION, DEFAULT_WORD_READER_LIMITS, type WordBlock, type WordChange, type WordReadResult, type WordReaderLimits, type WordSection } from './types'
import { parseXml, type XmlElement } from './xml'
import { openZip, readPart } from './zip'

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
// "EncryptedPackage" in UTF-16LE, the stream name that marks a password-protected Office file.
const ENCRYPTED_MARK = Uint8Array.from([...'EncryptedPackage'].flatMap((c) => [c.charCodeAt(0), 0]))

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/**
 * Read a Word (.docx) file from its bytes. Pure: no file system, no network, nothing in the file is
 * ever run. Either a reading or a refusal, never a part of one. The same bytes give the same result.
 */
export function readWordFile(bytes: Uint8Array, overrides: Partial<WordReaderLimits> = {}): WordReadResult {
  const limits: WordReaderLimits = { ...DEFAULT_WORD_READER_LIMITS, ...overrides }
  try {
    return read(bytes, limits)
  } catch (e) {
    if (e instanceof WordRefusalError) return refusal(e.code)
    // Anything unforeseen is a damaged file, not a crash, and carries no partial reading.
    return refusal('damaged')
  }
}

function read(bytes: Uint8Array, limits: WordReaderLimits): WordReadResult {
  if (!(bytes instanceof Uint8Array)) throw new WordRefusalError('not-a-word-file')
  if (bytes.length > limits.maxFileBytes) throw new WordRefusalError('too-large')
  if (OLE_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new WordRefusalError(indexOfBytes(bytes, ENCRYPTED_MARK) >= 0 ? 'password-protected' : 'old-word-format')
  }
  const zip = openZip(bytes, limits)
  const budget = { used: 0 }
  const load = (name: string): Uint8Array | null => {
    const entry = zip.byName.get(name.toLowerCase())
    if (!entry) return null
    budget.used += entry.size
    if (budget.used > limits.maxReadBytes) throw new WordRefusalError('zip-bomb')
    return readPart(zip, entry, limits)
  }
  const loadXml = (name: string): XmlElement | null => {
    const data = load(name)
    return data ? parseXml(data, limits) : null
  }

  // A macro project anywhere in the package is a refusal, whatever the main part says.
  for (const e of zip.entries) if (/(^|\/)(vbaProject\.bin|vbaData\.xml)$/i.test(e.name)) throw new WordRefusalError('macro-enabled')

  const typesRoot = loadXml('[Content_Types].xml')
  if (!typesRoot) throw new WordRefusalError('not-a-word-file')
  const types = readContentTypes(typesRoot)
  for (const t of [...types.defaults.values(), ...types.overrides.values()]) {
    if (/macroenabled|vba/i.test(t)) throw new WordRefusalError('macro-enabled')
  }

  const packageRels = loadXml('_rels/.rels')
  if (!packageRels) throw new WordRefusalError('not-a-word-file')
  const mainRel = readRelationships(packageRels).find((r) => !r.external && /\/officeDocument$/.test(r.type))
  if (!mainRel) throw new WordRefusalError('not-a-word-file')
  const mainName = resolveTarget('', mainRel.target)
  if (contentTypeOf(types, mainName) !== MAIN_DOCUMENT_TYPE) throw new WordRefusalError('not-a-word-file')

  const documentRoot = loadXml(mainName)
  if (!documentRoot || !isW(documentRoot, 'document')) throw new WordRefusalError('not-a-word-file')
  const body = wChild(documentRoot, 'body')
  if (!body) throw new WordRefusalError('damaged')

  const relsRoot = loadXml(relsNameFor(mainName))
  const rels = relsRoot ? readRelationships(relsRoot) : []
  const partFor = (suffix: string): XmlElement | null => {
    const rel = rels.find((r) => !r.external && r.type.endsWith(suffix))
    return rel ? loadXml(resolveTarget(dirOf(mainName), rel.target)) : null
  }
  const ctx = makeContext(readStyles(partFor('/styles')), readNumbering(partFor('/numbering')), rels, limits)

  const raw: RawBlock[] = []
  readBlocks(body, ctx, raw)
  return assemble(raw, ctx.changes, ctx)
}

function assemble(raw: RawBlock[], changes: WordChange[], ctx: BodyContext): WordReadResult {
  const levelCounts = new Map<number, number>()
  for (const b of raw) if (b.kind === 'paragraph' && b.raw.headingLevel !== undefined) levelCounts.set(b.raw.headingLevel, (levelCounts.get(b.raw.headingLevel) ?? 0) + 1)
  const noHeadingStyles = levelCounts.size === 0
  const levels = [...levelCounts.keys()].sort((a, b) => a - b)
  const sectionLevel = noHeadingStyles ? null : (levels.find((l) => (levelCounts.get(l) ?? 0) >= 2) ?? levels[0])

  const sections: WordSection[] = []
  const preamble: WordBlock[] = []
  const blockOf = (b: RawBlock): WordBlock => {
    if (b.kind !== 'paragraph') return b.block
    // A heading below the section level keeps its level so a reader of the blocks can tell it from body text.
    if (b.raw.headingLevel !== undefined) b.raw.block.headingLevel = b.raw.headingLevel
    return b.raw.block
  }

  if (noHeadingStyles) {
    for (const b of raw) sections.push(sectionFrom(null, null, null, [blockOf(b)], []))
  } else {
    let current: { heading: string; original: string; level: number; blocks: WordBlock[]; headingChanges: WordChange[] } | null = null
    const close = (): void => {
      if (current) sections.push(sectionFrom(current.heading, current.original, current.level, current.blocks, current.headingChanges))
      current = null
    }
    for (const b of raw) {
      if (b.kind === 'paragraph' && b.raw.headingLevel === sectionLevel) {
        close()
        current = { heading: b.raw.headingRevised, original: b.raw.headingOriginal, level: sectionLevel!, blocks: [], headingChanges: b.raw.block.changes }
      } else if (current) current.blocks.push(blockOf(b))
      else preamble.push(blockOf(b))
    }
    close()
  }

  // Which section each change sits in.
  sections.forEach((s, i) => {
    for (const c of s.changes) c.sectionIndex = i
  })

  const seen = new Set<string>()
  const reviewers: string[] = []
  for (const c of changes) {
    if (seen.has(c.author)) continue
    seen.add(c.author)
    reviewers.push(c.author)
  }

  const limitations: string[] = []
  if (ctx.commentRefs > 0) limitations.push('Reviewers’ comments are not read.')
  if (ctx.footnoteRefs > 0) limitations.push('Footnotes and endnotes are not read.')
  if (ctx.textBoxes > 0) limitations.push('Text inside text boxes is not read.')
  if (ctx.equations > 0) limitations.push('Equations are not read.')
  if (ctx.cellChanges > 0) limitations.push('Tracked changes to table cells (added, removed, merged) are not read.')
  if (ctx.formattingChanges > 0) limitations.push('Tracked formatting changes are not carried over.')

  return {
    ok: true,
    converterVersion: WORD_READER_VERSION,
    sections,
    preamble,
    sectionLevel,
    noHeadingStyles,
    changes,
    reviewers,
    tableCount: ctx.tableCount,
    figureCount: ctx.figureCount,
    limitations
  }
}

function joinMarkdown(blocks: WordBlock[], view: 'revised' | 'original'): string {
  let out = ''
  let previousList = false
  for (const b of blocks) {
    const md = blockMarkdown(b, view)
    if (md === '') continue
    const isList = b.type === 'paragraph' && b.list !== undefined
    out += out === '' ? md : (previousList && isList ? '\n' : '\n\n') + md
    previousList = isList
  }
  return out
}

function sectionFrom(heading: string | null, original: string | null, level: number | null, blocks: WordBlock[], headingChanges: WordChange[]): WordSection {
  const changes = [...headingChanges]
  for (const b of blocks) if (b.type !== 'figure') for (const c of b.changes) changes.push(c)
  return {
    heading,
    headingOriginal: original,
    level,
    blocks,
    markdown: joinMarkdown(blocks, 'revised'),
    originalMarkdown: joinMarkdown(blocks, 'original'),
    changes
  }
}

