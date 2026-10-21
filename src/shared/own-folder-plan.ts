/**
 * The "own folder on widget insert" sheet's plan (contracts §14 C5; locked drawing
 * docs/design/2026-10-20-folio-on-widget-insert/). Pure: no fs, no DOM.
 *
 * When Create and insert would make a Folio, WriteFlex asks first which documents belong with the widget:
 *   - just this document (the default): it moves into a new subfolder (name editable, default the document's
 *     title), which becomes the Folio;
 *   - other documents here belong with it: the ticked documents move together into the new subfolder, read in
 *     the chosen order; when every document is ticked the folder itself becomes the Folio and nothing moves.
 * When documents move and the widget reads a data file, the data file is copied into the widget's folder (the
 * original stays; the default) or moved with the documents.
 *
 * The renderer draws the sheet from this plan and the engine carries out the very same plan, so what the sheet
 * shows and what is written cannot disagree. Both take the folder's facts (read by main, nothing written) and the
 * writer's choice.
 */
import { MANIFEST_NAME } from './folio-constants'

/** What is in the document's folder, as main read it. Names are file or folder names in that folder. */
export type OwnFolderFacts = {
  /** Workspace-relative folder that holds the document ('' is the Workspace folder). */
  folder: string
  /** That folder's name as shown. */
  folderLabel: string
  /** The document's file name. */
  document: string
  /** The other Markdown documents directly in the folder, sorted. */
  documents: string[]
  /** The other visible files directly in the folder (not Markdown), sorted. */
  files: string[]
  /** The visible folders directly in the folder, sorted. */
  folders: string[]
  /** Every name in the folder, hidden ones included: a new folder may take none of them. */
  taken: Array<{ name: string; folder: boolean }>
  /** The new folder's name before the writer changes it: the document's title. */
  defaultName: string
  /** The widget's title, for the sheet's text. */
  widgetTitle: string
  /** The widget's folder name inside `visualisations`, when the folder itself becomes the Folio, and when a new folder does. */
  widgetFolder: { inPlace: string; ownFolder: string }
  /** The widget's data file, from the folder (`courses.csv`, `data/courses.csv`); null when it reads none. */
  source: string | null
  /** Agent instruction files already in the folder (the in-place Folio keeps them). */
  agentFiles: { agents: boolean; claude: boolean }
  /** Whether `visualisations` already is a folder here. */
  hasVisualisations: boolean
}

export type DataFileChoice = 'copy' | 'move'

/** The writer's answer in the sheet. `order` is the reading order of every document in the folder (the document
 *  first by default); `checked` names the other documents ticked to go with it. `fingerprint`: `planFingerprint` of
 *  the plan the sheet showed for this answer; the engine plans again over the folder as it is now and refuses on
 *  any difference, so a sheet drawn over an older folder never carries out a plan the writer did not see. */
export type OwnFolderChoice = { mode: 'one' | 'several'; checked: string[]; order: string[]; name: string; dataFile: DataFileChoice; fingerprint?: string }

export type TreeRowKind = 'folder' | 'doc' | 'data' | 'json' | 'html' | 'recipe'
export type TreeRow = {
  name: string
  kind: TreeRowKind
  depth: number
  /** Folder drawn open. */
  open?: boolean
  tag?: 'moves' | 'new' | 'copy'
  note?: string
  /** Reading order, 1-based. */
  order?: number
  dim?: boolean
  /** The new folder's name is not settled (a problem with the typed one): drawn dashed. */
  pending?: boolean
}

export type NameProblem = { text: string; suggest?: string }

export type OwnFolderPlan = {
  /** Every document is ticked: the folder itself becomes the Folio, nothing moves. */
  inPlace: boolean
  /** The documents of the Folio, in reading order (the document always among them). */
  documents: string[]
  /** The documents that move into the new folder, in reading order (none in place). */
  moving: string[]
  /** The new folder's name (trimmed), or null in place or while the typed name has a problem. */
  newFolder: string | null
  nameProblem: NameProblem | null
  /** The data file: asked only when documents move and the widget reads a data file (always outside the new folder). */
  dataFile: { asked: boolean; effect: 'copy' | 'move' | 'where-it-is' | 'none' }
  /** The main button may be pressed. */
  ready: boolean
  before: TreeRow[]
  after: TreeRow[]
  title: string
  primary: string
  /** The line under the trees: reading order and where the outline lives, and what happens to the data file. */
  orderNote: string
  /** `orderNote` after the numbered list (the sheet sets the numbers in bold). */
  orderTail: string
  /** Every document of the folder in the order the checklist shows (the chosen order, unticked ones in place). */
  listOrder: string[]
  /** The footer's link line. */
  linkNote: string
}

export const AGENTS_FILE_NAME = 'AGENTS.md'
/** Every name a widget build writes in a widget folder (build.ts: recipe, page, page beside a hand edit, receipt).
 *  A data file may never take one of them (compared without case: the Mac's disks ignore it). */
export const WIDGET_GENERATED_NAMES: readonly string[] = ['widget.md', 'widget.html', 'widget.rebuilt.html', 'widget.build.json']
/** The name the widget's data file takes in the widget's folder: its own, or `data-<name>` when that is a name the
 *  build writes (a dataset called `widget.build.json` would be replaced by the build receipt). */
export function widgetDataFileName(name: string): string {
  return WIDGET_GENERATED_NAMES.includes(name.toLowerCase()) ? `data-${name}` : name
}

/** A short, stable fingerprint of a plan as the sheet shows it (every field: the trees, the documents that move, the
 *  new folder, the data file). Not a secret: it only tells a plan from another. Same in the renderer and in main. */
export function planFingerprint(plan: OwnFolderPlan): string {
  const text = JSON.stringify(plan)
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
    b ^= b >>> 15
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}
export const CLAUDE_FILE_NAME = 'CLAUDE.md'
const VISUALISATIONS = 'visualisations'

const stemOf = (name: string): string => name.replace(/\.(md|markdown)$/i, '')
const baseName = (path: string): string => path.split('/').at(-1) ?? path
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)
const byName = (a: string, b: string): number => a.localeCompare(b)

/** The sheet's first state: just this document, the default name, the document first in the order. */
export function initialOwnFolderChoice(facts: OwnFolderFacts): OwnFolderChoice {
  return { mode: 'one', checked: [], order: [facts.document, ...facts.documents], name: facts.defaultName, dataFile: 'copy' }
}

/** A folder name made from a document title: no `/`, `:` or `\`, no leading dot, at most 80 characters. */
export function folderNameFromTitle(title: string, fileName: string): string {
  const fromTitle = title.replace(/[/:\\\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 80).trim()
  if (fromTitle !== '' && fromTitle !== stemOf(fileName)) return fromTitle
  // No heading: the file's own name, made readable ("course-notes.md" → "Course notes").
  const stem = stemOf(fileName).replace(/[-_]+/g, ' ').replace(/[/:\\\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(0, 80).trim()
  return stem === '' ? 'New folder' : stem.charAt(0).toUpperCase() + stem.slice(1)
}

/** The lowest free "<name> N" (N from 2) among `taken`, compared without case. */
export function freeFolderName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()))
  for (let i = 2; ; i += 1) if (!lower.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
}

/** What is wrong with `typed` as the new folder's name in `facts.folder`, or null. */
export function folderNameProblem(facts: OwnFolderFacts, typed: string): NameProblem | null {
  const name = typed.trim()
  if (name === '') return { text: 'Type a name for the new folder.' }
  if (/[/:\\\u0000-\u001f]/.test(name)) return { text: 'A folder name cannot contain / or :.' }
  if (name.startsWith('.')) return { text: 'A folder name cannot start with a dot.' }
  if (name.length > 120) return { text: 'That name is too long for a folder.' }
  const clash = facts.taken.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  if (!clash) return null
  return {
    text: `${facts.folderLabel} already has ${clash.folder ? 'a folder' : 'a file'} called “${clash.name}”. Nothing in it would be changed, but the new folder needs a different name.`,
    suggest: freeFolderName(name, facts.taken.map((entry) => entry.name)),
  }
}

/** The choice with unknown names dropped and every document present in the order exactly once. */
export function settledOrder(facts: OwnFolderFacts, choice: OwnFolderChoice): { order: string[]; checked: string[] } {
  const known = new Set([facts.document, ...facts.documents])
  const seen = new Set<string>()
  const order: string[] = []
  for (const name of choice.order) if (known.has(name) && !seen.has(name)) { seen.add(name); order.push(name) }
  for (const name of [facts.document, ...facts.documents]) if (!seen.has(name)) { seen.add(name); order.push(name) }
  const checked = choice.checked.filter((name) => facts.documents.includes(name))
  return { order, checked }
}

/** Whether `choice` names exactly the documents `facts` has (none missing, none unknown): a sheet drawn from older
 *  facts is refused by the engine rather than carried out over a folder that changed. */
export function choiceMatchesFacts(facts: OwnFolderFacts, choice: OwnFolderChoice): boolean {
  const all = [facts.document, ...facts.documents].sort(byName)
  const order = [...new Set(choice.order)].sort(byName)
  return order.length === choice.order.length && order.length === all.length && order.every((name, i) => name === all[i])
    && choice.checked.every((name) => facts.documents.includes(name))
}

const widgetRows = (widgetFolder: string, depth: number, data: TreeRow | null, visualisationsNew: boolean): TreeRow[] => [
  { name: VISUALISATIONS, kind: 'folder', open: true, depth, ...(visualisationsNew ? { tag: 'new' as const, note: 'widgets live here' } : { dim: true }) },
  { name: widgetFolder, kind: 'folder', open: true, depth: depth + 1, tag: 'new', note: 'this widget' },
  ...(data ? [data] : []),
  { name: 'widget.md', kind: 'recipe', depth: depth + 2, tag: 'new', note: 'widget settings' },
  { name: 'widget.html', kind: 'html', depth: depth + 2, tag: 'new', note: 'what readers see' },
  { name: 'widget.build.json', kind: 'json', depth: depth + 2, tag: 'new', note: 'build record' },
]

const kindOf = (name: string): TreeRowKind => (/\.(md|markdown)$/i.test(name) ? 'doc' : /\.json$/i.test(name) ? 'json' : /\.csv$/i.test(name) ? 'data' : 'doc')

/** The sheet's plan for `choice` over `facts`. */
export function planOwnFolder(facts: OwnFolderFacts, choice: OwnFolderChoice): OwnFolderPlan {
  const { order, checked } = settledOrder(facts, choice)
  const several = choice.mode === 'several'
  const documents = order.filter((name) => name === facts.document || (several && checked.includes(name)))
  const inPlace = several && facts.documents.every((name) => checked.includes(name))
  const moving = inPlace ? [] : documents
  const nameProblem = inPlace ? null : folderNameProblem(facts, choice.name)
  const newFolder = inPlace || nameProblem ? null : choice.name.trim()
  const source = facts.source
  const sourceName = source === null ? '' : widgetDataFileName(baseName(source))
  const dataFile: OwnFolderPlan['dataFile'] = source === null ? { asked: false, effect: 'none' } : inPlace ? { asked: false, effect: 'where-it-is' } : { asked: true, effect: choice.dataFile }
  const sourceNested = source !== null && source.includes('/')
  const docStem = stemOf(facts.document)

  // ---- Now ----
  const before: TreeRow[] = [{ name: facts.folderLabel, kind: 'folder', open: true, depth: 0 }]
  for (const name of facts.folders) before.push({ name, kind: 'folder', depth: 1, note: 'already here' })
  const looseFiles = [facts.document, ...facts.documents, ...facts.files].sort(byName)
  for (const name of looseFiles) {
    const moves = moving.includes(name) || (dataFile.effect === 'move' && name === source)
    const note = name === facts.document && !moves ? 'this document' : name === source ? 'widget data' : undefined
    before.push({ name, kind: kindOf(name), depth: 1, ...(moves ? { tag: 'moves' as const } : {}), ...(note ? { note } : {}) })
  }
  if (sourceNested) before.push({ name: source!, kind: kindOf(source!), depth: 1, note: 'widget data', ...(dataFile.effect === 'move' ? { tag: 'moves' as const } : {}) })

  // ---- After ----
  const after: TreeRow[] = [{ name: facts.folderLabel, kind: 'folder', open: true, depth: 0 }]
  const outlineRows = (depth: number, existing: OwnFolderFacts['agentFiles']): TreeRow[] => [
    { name: MANIFEST_NAME, kind: 'json', depth, tag: 'new', note: 'reading order' },
    existing.agents ? { name: AGENTS_FILE_NAME, kind: 'doc', depth, dim: true, note: 'Folio notes added' } : { name: AGENTS_FILE_NAME, kind: 'doc', depth, tag: 'new', note: 'notes for AI assistants' },
    ...(existing.claude ? [] : [{ name: CLAUDE_FILE_NAME, kind: 'doc' as const, depth, tag: 'new' as const, note: 'points to AGENTS.md' }]),
  ]
  if (inPlace) {
    after.push(...outlineRows(1, facts.agentFiles))
    for (const name of facts.folders.filter((name) => name !== VISUALISATIONS)) after.push({ name, kind: 'folder', depth: 1, dim: true })
    for (const name of [...documents].sort(byName)) after.push({ name, kind: 'doc', depth: 1, order: documents.indexOf(name) + 1, dim: true, ...(name === facts.document ? { note: 'now with the widget' } : {}) })
    for (const name of facts.files) after.push({ name, kind: kindOf(name), depth: 1, dim: true, ...(name === source ? { note: 'used by the widget where it is' } : {}) })
    if (sourceNested) after.push({ name: source!, kind: kindOf(source!), depth: 1, dim: true, note: 'used by the widget where it is' })
    after.push(...widgetRows(facts.widgetFolder.inPlace, 1, null, !facts.hasVisualisations))
  } else {
    for (const name of facts.folders) after.push({ name, kind: 'folder', depth: 1, dim: true, note: 'unchanged' })
    const shownName = nameProblem ? (nameProblem.suggest ?? 'New folder') : choice.name.trim()
    after.push({ name: shownName, kind: 'folder', open: true, depth: 1, tag: 'new', ...(nameProblem ? { pending: true, note: nameProblem.suggest ? 'suggested name' : 'name needed' } : { note: 'new folder' }) })
    moving.forEach((name, i) => after.push({ name, kind: 'doc', depth: 2, order: i + 1, tag: 'moves', ...(name === facts.document ? { note: 'now with the widget' } : {}) }))
    after.push(...outlineRows(2, { agents: false, claude: false }))
    const data: TreeRow | null = dataFile.effect === 'copy' ? { name: sourceName, kind: kindOf(sourceName), depth: 4, tag: 'copy', note: 'copy of the data' }
      : dataFile.effect === 'move' ? { name: sourceName, kind: kindOf(sourceName), depth: 4, tag: 'moves', note: 'moved with the documents' } : null
    after.push(...widgetRows(facts.widgetFolder.ownFolder, 2, data, true))
    const staying = [...facts.documents.filter((name) => !moving.includes(name)), ...facts.files.filter((name) => !(dataFile.effect === 'move' && name === source))].sort(byName)
    for (const name of staying) after.push({ name, kind: kindOf(name), depth: 1, dim: true, ...(name === source ? { note: 'original stays here' } : {}) })
    if (sourceNested && dataFile.effect === 'copy') after.push({ name: source!, kind: kindOf(source!), depth: 1, dim: true, note: 'original stays here' })
  }

  const n = documents.length
  const title = inPlace ? `${facts.folderLabel} will hold the widget for ${docStem}`
    : n === 1 ? `${docStem} will get a folder of its own`
      : `${docStem} and ${n - 1} other ${plural(n - 1, 'document', 'documents')} will get a folder of their own`
  const primary = inPlace ? 'Insert widget' : n === 1 ? 'Move and insert widget' : `Move ${n} documents and insert widget`
  const originalName = source === null ? '' : baseName(source)
  const renamed = sourceName !== originalName
  const dataSentence = dataFile.effect === 'copy' ? ` The widget uses its own copy of ${originalName}${renamed ? `, named ${sourceName}` : ''}; the original stays in ${facts.folderLabel}.`
    : dataFile.effect === 'move' ? ` ${originalName} moves into the widget's folder${renamed ? ` as ${sourceName}` : ''}.` : ''
  const orderTail = `: reading order, kept in ${MANIFEST_NAME}.${dataSentence}`
  const orderNote = `${documents.map((name, i) => `${i + 1} ${name}`).join(' · ')}${orderTail}`
  const linkNote = inPlace ? 'No document moves, so every link stays as it is.' : 'Links to and from the moved documents are updated, so they keep working.'
  return { inPlace, documents, moving, newFolder, nameProblem, dataFile, ready: inPlace || nameProblem === null, before, after, title, primary, orderNote, orderTail, listOrder: order, linkNote }
}
