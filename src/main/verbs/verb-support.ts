import { posix } from 'node:path'
import { readFileSync } from 'node:fs'
import type { ApprovalDecision, ApprovalPolicy, CapabilityResult } from '@bridle/core'
import { isHiddenWorkspacePath, Workspace, type FileReadResult } from '../workspace'
import type { ScrapStore } from '../scraps'
import { frontmatterSafeInsertPosition, objectBlock, parseFrontmatterEntries, serialiseFrontmatterEntries, validateObjectMarkup, type FmEntry, type ObjectKind } from '../../shared/object-markup'
import { FRONTMATTER_FENCE, FRONTMATTER_KEY_VALUE, frontmatterBlock } from '../../shared/markdown/frontmatter'
import { planRenameRepair, type RenameRepairPlan } from '../rename-repair'

export type ProseEditCategory = 'typo' | 'grammar' | 'wording' | 'structure' | 'clarity' | 'tone' | 'other'
export type ProseEditInput = { path: string; oldText: string; newText: string; category: ProseEditCategory; summary: string }
export type ProseMoveInput = { path: string; text: string; insertAfter: string; summary: string }
export type ProseInsertInput = { path: string; insertAfter: string; text: string; category: ProseEditCategory; summary: string }
export type ObjectInsertInput = { path: string; kind: ObjectKind; content: string; insertAfter?: string; summary?: string }
export type CreateFileInput = { path: string; content: string }
export type RenameFileInput = { path: string; newPath: string }
export type FolioManifestInput = { dir: string }
export type FrontmatterNormaliseInput = { path: string }
export type FrontmatterSetInput = { path: string; set: Record<string, string | string[]>; summary?: string }
export type ScrapAddInput = { origin: string; text: string }
export type PlanReadInput = { dir: string }
export type PlanCompareInput = { dir: string; a: string; b: string }
export type PlanProposeInput = import('../../shared/plan-proposal').PlanProposalInput
export type TasksListInput = { path: string }
export type WidgetsListInput = { path: string }
export type WidgetsInsertInput = { path: string; file: string; position?: 'start' | 'end' | number }
export type WidgetsCreateInput = { path: string; fileName: string; html: string; title: string; position?: 'start' | 'end' | number }
export type WidgetsRemoveInput = { path: string; ordinal: number }
export type TasksToggleInput = { path: string; line: number }
export type ScrapPromoteInput = { dir: string; origin: string; id: string; name: string }
export type SourceAttachInput = { dir: string; piece: string; source: string }
export type SourceListInput = { path: string }

export type PreparedRename = {
  plan: RenameRepairPlan
  touchedPaths: string[]
}

type RenameStructuralPaths = { source?: string; destination?: string }

export function renameStructuralPaths(workspace: Workspace, input: RenameFileInput): RenameStructuralPaths {
  let source: string | undefined
  let destination: string | undefined
  try {
    source = workspace.absolute(input.path)
  } catch {
    // touchedPaths is a total declaration seam; execute owns the reason-bearing refusal.
  }
  try {
    destination = workspace.renameTarget(input.path, input.newPath)
  } catch {
    // A valid source can still be declared when only the destination is rejected.
  }
  return { source, destination }
}

export async function prepareRename(workspace: Workspace, input: RenameFileInput): Promise<PreparedRename> {
  const { source: sourcePath, destination: destinationPath } = renameStructuralPaths(workspace, input)
  if (!sourcePath || !destinationPath) {
    throw new Error(`Cannot rename ${JSON.stringify(input.path)} because its source or destination is outside the open Workspace.`)
  }
  const plan = await planRenameRepair(workspace, input.path, workspace.relative(destinationPath))
  const touchedPaths = [...new Set([
    sourcePath,
    destinationPath,
    ...plan.writes.map((write) => workspace.absolute(write.path)),
  ])]
  return { plan, touchedPaths }
}

export function assertSamePathSet(expected: readonly string[], actual: readonly string[], context: string): void {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = [...expectedSet].filter((path) => !actualSet.has(path))
  const unexpected = [...actualSet].filter((path) => !expectedSet.has(path))
  if (missing.length === 0 && unexpected.length === 0 && expectedSet.size === actualSet.size) return
  const details = [
    missing.length ? `missing ${missing.join(', ')}` : '',
    unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
  ].filter(Boolean).join('; ')
  throw new Error(`${context} does not match Bridle's resolved touched paths: ${details}.`)
}

export function assertPathSubset(declared: readonly string[], applied: readonly string[], context: string): void {
  const declaredSet = new Set(declared)
  const unexpected = [...new Set(applied)].filter((path) => !declaredSet.has(path))
  if (unexpected.length === 0) return
  throw new Error(`${context} falls outside Bridle's resolved touched paths: unexpected ${unexpected.join(', ')}.`)
}

/** Services a bound agent shares with the app: the window's ONE ScrapStore (so agent + user scrap
 *  writes serialise through the same mutex — never two instances racing on a SCRAPS.md) and its
 *  change notifier. Absent in unit/e2e-double builds, where the scrap capabilities are simply omitted. */
export type CapabilityServices = {
  scraps?: ScrapStore
  onScrapsChanged?: () => void
  onFileRead?: (path: string) => void
  prepareFolioInstructions?: (dir: string) => Promise<void>
  trashFile?: (absolute: string) => Promise<void>
  checkpointFile?: (path: string) => Promise<void>
  notifyFilesChangedOnDisk?: (paths: string[]) => void
  /** A file was renamed by a capability: whatever tracks documents by path follows it (the review
   *  ledger's undecided Changes from outside, as for a rename the writer makes in the app). */
  onFileRenamed?: (from: string, to: string) => Promise<void>
  /** The skill whose run this agent is (a skill thread): recorded as `skill:` on agent notes it leaves. */
  activeSkillName?: string
  /** A prose note landed under agent-notes/ (notes.create): the Agent notes pane re-lists. */
  onAgentNotesChanged?: (path: string) => void
  /**
   * Whether THE Change being accepted right now shows the writer exactly this new widget file: this path, beside
   * this document, with content of this SHA-256. It answers for that one Change, never for another Change that
   * happens to match, and answers no outside an accept. widgets.create asks at accept time and writes nothing
   * unless the answer is true; with no review surface to ask (this service absent) it writes nothing.
   */
  widgetFileShown?: (file: { documentPath: string; path: string; sha256: string }) => Promise<boolean>
  /** Something the writer must be told about an accept that succeeded (the document saved but could not be read
   *  back): carried into that accept's response and shown on the margin card. */
  acceptNotice?: (text: string) => void
}

/** Split a document into its frontmatter lines and the byte offset where the body begins, or null when
 *  there is no leading `---` block. A BOM is handled by the caller (offsets are into the BOM-less text). */
export function frontmatterSplit(s: string): { fm: string[]; bodyOffset: number } | null {
  const block = frontmatterBlock(s)
  return block ? { fm: block.lines, bodyOffset: block.end } : null
}

type ExactLine = { content: string; ending: string }

function exactLines(source: string): ExactLine[] {
  const lines: ExactLine[] = []
  for (const match of source.matchAll(/([^\n]*)(\n|$)/g)) {
    if (match[0] === '') continue
    const raw = match[1]
    lines.push({ content: raw.replace(/\r$/, ''), ending: raw.endsWith('\r') ? `\r${match[2]}` : match[2] })
  }
  return lines
}

function renderedLines(source: string, finalEnding: string, nl: string): ExactLine[] {
  const lines = source.split('\n')
  return lines.map((content, index) => ({ content, ending: index === lines.length - 1 ? finalEnding : nl }))
}

function unsafeKey(path: string, key: string): Error {
  return new Error(`Could not change frontmatter in ${path}: key “${key}” is not in a safely writable scalar or list form.`)
}

type WritableFrontmatterEntry = { key: string; index: number; count: number }

const WRITABLE_KEY_LINE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/
const WRITABLE_TARGET_KEY = /^[A-Za-z0-9_-]+$/
const BYSTANDER_UNQUOTED_KEY = /^(?=[\p{L}\p{N} _.\-]*[\p{L}\p{N}])[\p{L}\p{N}_.\-](?:[\p{L}\p{N} _.\-]*[\p{L}\p{N}_.\-])?$/u
const WRITABLE_LIST_ITEM = /^[ \t]*- (.*)$/
const UNSAFE_SCALAR_START = /^[&*!%@`|>?]/
const UNSAFE_BYSTANDER_KEY_START = /^[#&*!|>%@`?\-]/

function unsafeLine(path: string, lineNumber: number, content: string): Error {
  const snippet = content.slice(0, 80) || '(blank line)'
  return new Error(`Could not change frontmatter in ${path}: cannot safely rewrite this block: line ${lineNumber} reads “${snippet}”.`)
}

function strandedLines(path: string, lines: Array<{ lineNumber?: number; content: string }>): Error {
  const context = lines
    .map(({ lineNumber, content }) => lineNumber === undefined
      ? `“${content.slice(0, 80) || '(blank line)'}”`
      : `line ${lineNumber} reads “${content.slice(0, 80) || '(blank line)'}”`)
    .join('; ')
  return new Error(`Could not change frontmatter in ${path}: removal would leave a block the reader cannot recognise: ${context}.`)
}

/** Find a closed document-leading fence pair even when the shared reader correctly classifies it as
 * body prose. Only a spelling of a key targeted by this write is a collision risk; every other
 * key-shaped line remains prose and the real frontmatter block is prepended above it. */
function malformedLeadingTargetCollision(
  source: string,
  targetKeys: ReadonlySet<string>,
): { line: ExactLine; lineNumber: number } | null {
  const lines = exactLines(source)
  if (!lines[0] || !FRONTMATTER_FENCE.test(lines[0].content)) return null
  const closing = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line.content))
  if (closing < 0) return null
  for (let index = 1; index < closing; index += 1) {
    const quotedSeparatorNormalised = lines[index].content.replace(
      /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]+:/,
      '$1:',
    )
    const parsed = bystanderKeyLine(quotedSeparatorNormalised)
    const colon = lines[index].content.indexOf(':')
    const whitespaceNormalised = colon < 0 ? '' : lines[index].content.slice(0, colon).trim()
    const unquotedKey = BYSTANDER_UNQUOTED_KEY.test(whitespaceNormalised)
      && !UNSAFE_BYSTANDER_KEY_START.test(whitespaceNormalised)
      ? whitespaceNormalised
      : null
    const key = parsed?.key || unquotedKey
    if (key && targetKeys.has(key)) return { line: lines[index], lineNumber: index + 1 }
  }
  return null
}

function validateQuotedScalar(tail: string, path: string, key: string): void {
  if (tail.startsWith('"')) {
    try {
      if (typeof JSON.parse(tail) !== 'string') throw new Error('not a string')
    } catch {
      throw unsafeKey(path, key)
    }
    return
  }
  if (!tail.startsWith("'")) return
  if (tail.length < 2 || !tail.endsWith("'")) throw unsafeKey(path, key)
  for (let index = 1; index < tail.length - 1; index += 1) {
    if (tail[index] !== "'") continue
    if (index + 1 >= tail.length - 1 || tail[index + 1] !== "'") throw unsafeKey(path, key)
    index += 1
  }
}

function validateWritableScalar(tail: string, path: string, key: string, listItem = false): void {
  const scalar = tail.trimStart()
  if (listItem && scalar === '') throw unsafeKey(path, key)
  if (UNSAFE_SCALAR_START.test(scalar)) throw unsafeKey(path, key)
  if (scalar.startsWith('"') || scalar.startsWith("'")) {
    validateQuotedScalar(scalar, path, key)
    return
  }
  if (/:(?:[ \t]|$)/.test(scalar)) throw unsafeKey(path, `${key}:${scalar}`.trimEnd())
  if (
    /(^|[ \t])#/.test(scalar) || /[\u0085\u2028\u2029]/.test(scalar)
    || /(?:^|[,\[{][ \t]*)[&*!](?=\S)/.test(scalar)
  ) {
    throw unsafeKey(path, key)
  }
}

function bystanderKeyLine(content: string): { key: string; tail: string } | null {
  if (content.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*"):[ \t]*(.*)$/.exec(content)
    if (!match) return null
    try {
      const key = JSON.parse(match[1])
      return typeof key === 'string' && !/[\r\n]/.test(key) ? { key, tail: match[2] } : null
    } catch {
      return null
    }
  }

  if (content.startsWith("'")) {
    const match = /^('(?:[^']|'')*'):[ \t]*(.*)$/.exec(content)
    if (!match) return null
    return { key: match[1].slice(1, -1).replaceAll("''", "'"), tail: match[2] }
  }

  const colon = content.indexOf(':')
  if (colon < 0) return null
  const key = content.slice(0, colon)
  if (!BYSTANDER_UNQUOTED_KEY.test(key) || UNSAFE_BYSTANDER_KEY_START.test(key)) return null
  return { key, tail: content.slice(colon + 1).replace(/^[ \t]*/, '') }
}

/** Validate the complete existing block before a byte of its in-memory copy is changed. The returned
 *  spans are the only entries the surgical writer may replace or remove. Blank lines and comments
 *  deliberately end list ownership, so they can never hide a later dash item or continuation. */
function writableFrontmatterEntries(
  lines: ExactLine[],
  path: string,
  targetKeys: ReadonlySet<string>,
): Map<string, WritableFrontmatterEntry> {
  const entries = new Map<string, WritableFrontmatterEntry>()
  let listOwner: WritableFrontmatterEntry | null = null
  let precedingKey: string | null = null

  lines.forEach((line, index) => {
    const lineNumber = index + 2 // The opening fence is document line 1.
    if (/^[ \t]*$/.test(line.content) || /^[ \t]*#/.test(line.content)) {
      listOwner = null
      precedingKey = null
      return
    }

    const keyLine = WRITABLE_KEY_LINE.exec(line.content)
    if (keyLine) {
      const key = keyLine[1]
      try {
        validateWritableScalar(keyLine[2], path, key)
      } catch {
        throw unsafeLine(path, lineNumber, line.content)
      }
      const entry = { key, index, count: 1 }
      if (targetKeys.has(key)) {
        if (entries.has(key)) throw unsafeLine(path, lineNumber, line.content)
        entries.set(key, entry)
      }
      listOwner = keyLine[2] === '' ? entry : null
      precedingKey = key
      return
    }

    const listItem = WRITABLE_LIST_ITEM.exec(line.content)
    if (listItem) {
      if (!listOwner) throw unsafeLine(path, lineNumber, line.content)
      try {
        validateWritableScalar(listItem[1], path, listOwner.key, true)
      } catch {
        throw unsafeLine(path, lineNumber, line.content)
      }
      listOwner.count += 1
      precedingKey = listOwner.key
      return
    }

    if (precedingKey && /^[ \t]+\S/.test(line.content)) throw unsafeLine(path, lineNumber, line.content)

    const bystander = bystanderKeyLine(line.content)
    if (bystander) {
      if (targetKeys.has(bystander.key)) throw unsafeLine(path, lineNumber, line.content)
      try {
        validateWritableScalar(bystander.tail, path, bystander.key)
      } catch {
        throw unsafeLine(path, lineNumber, line.content)
      }
      listOwner = null
      precedingKey = bystander.key
      return
    }

    throw unsafeLine(path, lineNumber, line.content)
  })

  return entries
}

function updateFrontmatter(
  content: string,
  set: Record<string, string | string[]>,
  remove: string[],
  path: string,
): string {
  const targetKeys = new Set([...Object.keys(set), ...remove])
  for (const key of targetKeys) {
    if (!WRITABLE_TARGET_KEY.test(key)) throw unsafeKey(path, key)
  }

  const bom = content.startsWith('﻿') ? '﻿' : ''
  const source = bom ? content.slice(1) : content
  let nl = source.match(/\r?\n/)?.[0] ?? '\n'
  const block = frontmatterBlock(source)
  if (!block) {
    if (Object.keys(set).length === 0) return content
    const collision = malformedLeadingTargetCollision(source, targetKeys)
    if (collision) throw unsafeLine(path, collision.lineNumber, collision.line.content)
    const entries = Object.entries(set).map(([key, value]): FmEntry => Array.isArray(value)
      ? { kind: 'list', key, values: value }
      : { kind: 'scalar', key, value })
    const inner = serialiseFrontmatterEntries(entries).replace(/\n/g, nl)
    return `${bom}---${nl}${inner}${nl}---${nl}${nl}${source}`
  }

  const frontmatter = exactLines(source.slice(0, block.end))
  const opening = frontmatter.shift()!
  const closing = frontmatter.pop()!
  nl = opening.ending || nl
  const body = source.slice(block.end)

  const originalLineNumbers = new Map(frontmatter.map((line, index) => [line, index + 2]))
  const entries = writableFrontmatterEntries(frontmatter, path, targetKeys)
  const mutations: Array<{ index: number; count: number; replacement: ExactLine[] }> = []
  const replacedKeys = new Set<string>()

  for (const [key, value] of Object.entries(set)) {
    const entry = entries.get(key)
    if (!entry) continue
    const replacement: FmEntry = Array.isArray(value)
      ? { kind: 'list', key, values: value }
      : { kind: 'scalar', key, value }
    const finalEnding = frontmatter[entry.index + entry.count - 1].ending
    mutations.push({
      index: entry.index,
      count: entry.count,
      replacement: renderedLines(serialiseFrontmatterEntries([replacement]), finalEnding, nl),
    })
    replacedKeys.add(key)
  }

  const removals = remove
    .filter((key) => !Object.hasOwn(set, key))
    .flatMap((key) => entries.get(key) ?? [])
  if (Object.keys(set).length === 0 && removals.length === 0) return content
  mutations.push(...removals.map((entry) => ({ index: entry.index, count: entry.count, replacement: [] })))
  mutations.sort((left, right) => right.index - left.index)
  for (const mutation of mutations) {
    frontmatter.splice(mutation.index, mutation.count, ...mutation.replacement)
  }

  for (const [key, value] of Object.entries(set)) {
    if (replacedKeys.has(key)) continue
    const replacement: FmEntry = Array.isArray(value)
      ? { kind: 'list', key, values: value }
      : { kind: 'scalar', key, value }
    frontmatter.push(...renderedLines(serialiseFrontmatterEntries([replacement]), nl, nl))
  }

  if (
    removals.length > 0
    && frontmatter.some((line) => line.content.trim() !== '')
    && !frontmatter.some((line) => FRONTMATTER_KEY_VALUE.test(line.content))
  ) {
    throw strandedLines(path, frontmatter
      .filter((line) => line.content.trim() !== '')
      .map((line) => ({ lineNumber: originalLineNumbers.get(line), content: line.content })))
  }

  if (removals.length > 0 && frontmatter.every((line) => /^[ \t]*$/.test(line.content))) {
    return `${bom}${body.replace(/^\r?\n/, '')}`
  }
  return `${bom}${[opening, ...frontmatter, closing].map((line) => line.content + line.ending).join('')}${body}`
}

/** Canonicalise only safe block lists. Scalar and opaque lines are copied byte-for-byte, so YAML's
 * typed spellings (`true`, `false`, `null`, `~`) cannot be silently retyped as strings. */
export function normaliseExistingFrontmatter(content: string): string {
  const bom = content.startsWith('﻿') ? '﻿' : ''
  const source = bom ? content.slice(1) : content
  const block = frontmatterBlock(source)
  if (!block) return content

  const lines = exactLines(source.slice(0, block.end))
  const opening = lines.shift()!
  const closing = lines.pop()!
  const nl = opening.ending || source.match(/\r?\n/)?.[0] || '\n'

  for (let index = 0; index < lines.length; index += 1) {
    const keyLine = WRITABLE_KEY_LINE.exec(lines[index].content)
    if (!keyLine || keyLine[2] !== '') continue
    let cursor = index + 1
    while (cursor < lines.length && WRITABLE_LIST_ITEM.test(lines[cursor].content)) cursor += 1
    if (cursor === index + 1) continue

    const parsed = parseFrontmatterEntries(lines.slice(index, cursor).map((line) => line.content).join('\n'))
    if (parsed.length !== 1 || parsed[0].kind !== 'list') continue
    const finalEnding = lines[cursor - 1].ending
    lines.splice(index, cursor - index, ...renderedLines(serialiseFrontmatterEntries(parsed), finalEnding, nl))
  }

  return `${bom}${[opening, ...lines, closing].map((line) => line.content + line.ending).join('')}${source.slice(block.end)}`
}

/**
 * Merge `set` into a document's leading frontmatter, preserving the BODY bytes exactly and every
 * existing frontmatter key NOT in `set`. Existing keys in `set` are rewritten in place; new keys are
 * appended; a bare file gains a fresh block. This is the only sanctioned frontmatter WRITE (ADR-0008
 * forbids AUTOMATIC insertion, not a writer-approved, agent-staged one). Exported for its tests.
 */
export function mergeFrontmatterKeys(content: string, set: Record<string, string>): string {
  return Object.keys(set).length ? updateFrontmatter(content, set, [], 'document') : content
}

export function setFrontmatterKeys(content: string, set: Record<string, string | string[]>, path = 'document'): string {
  return Object.keys(set).length ? updateFrontmatter(content, set, [], path) : content
}

/**
 * Remove top-level frontmatter keys after the complete block passes the strict write grammar,
 * preserving the BODY bytes exactly and every other entry. Removing the last remaining entry drops the whole block — bare files stay bare
 * (ADR-0008), so clearing a goal leaves no empty `---` husk. Bare files and missing keys are no-ops.
 * The goal:set direct IPC path (Round A T5) is the consumer; exported for its tests.
 */
export function removeFrontmatterKeys(content: string, keys: string[], path = 'document'): string {
  return keys.length ? updateFrontmatter(content, {}, keys, path) : content
}

export const PREAMBLE = [
  "You are WriteFlex's in-app writing agent. The human writes; you keep house.",
  "Be conservative: make the SMALLEST change that fixes a real error, and do not rewrite for style, tone, or flow unless the writer explicitly asks. When the writer limits the scope of a request — 'spelling only', 'just proofread', 'only the second paragraph' — stay strictly inside it and change nothing else, even if you notice other issues; mention them in your reply instead of editing them.",
  'Prose changes — anything a reader would notice in the rendered document, including heading text — must go through prose.edit. Stage MANY small edits, one prose.edit per SENTENCE or short phrase you change (its oldText must not span more than one sentence), each categorised as typo, grammar, wording, structure, clarity, tone, or other as a last-resort fallback when none of those fit. Rewriting a paragraph is several prose.edit calls, one per changed sentence — a copy-edit pass is dozens of small edits, a typo here, a wording tweak there, NEVER one big replacement and NEVER a whole section as a single edit. Judge the boundaries of each distinct change and stage them separately so the writer can accept/reject each on its own. prose.edit calls are staged for the writer to review; never expect them to apply immediately.',
  'Adding NEW text is prose.insert, never prose.edit. prose.edit REPLACES existing unique text; to write into an empty or near-empty file, add a paragraph, or place a new passage, use prose.insert with the exact unique text to follow as insertAfter, or an empty insertAfter to append at the end (also how you fill a blank file). Never invent an oldText that is not actually in the file just to satisfy prose.edit — that edit cannot be shown in the document and is a bug.',
  'Prefer objects.insert over prose.insert for tables, diagrams, mind maps, and SVG illustrations; it validates inner markup before staging and owns any required fences.',
  'Prefer frontmatter.set over prose edits for document metadata. Use it to set or add keys; pass lists as arrays.',
  'Relocations are prose.move, not delete plus insert: provide the exact unique block as text and the exact unique destination anchor as insertAfter. A move is categorised as structure and remains one reviewable operation.',
  'You can correct your OWN staged work: every staged call\'s result names its suggestion id, and suggestions.retract(id) withdraws it. If an edit you staged this turn was wrong or over-reached, or the writer asks you to undo a change you proposed, retract it — do NOT stack another edit on top to paper over it. To amend a staged edit, retract it and then stage the corrected version.',
  'Widgets. A widget is an interactive HTML page (a calculator, chart, simulation, quiz, any interactive thing) that runs live inside the document as a block. It is one self-contained HTML file inside the Workspace, referred to from the text by one line of its own, with blank lines around it, outside code, lists and quotes: `[Simulation: assets/compound-interest.html]` (path relative to the document\'s folder). Typed or pasted HTML in the text is only ever shown as text, so an embed line is the only way to make something run. When the writer asks for a calculator, chart, simulation or any interactive X in a document, make a widget: use widgets.create (you write the whole page; WriteFlex saves it in assets/ beside the document and adds the line). Other widget verbs: widgets.list reads the document\'s widgets (ordinal, line, path, whether it resolves); widgets.insert embeds an HTML file that already exists in the Workspace; widgets.remove takes one embed line out (the file stays). widgets.create, widgets.insert and widgets.remove are proposals: the writer accepts or discards them, and nothing is written until they accept; for widgets.create the writer is shown the new file\'s path and full source first. Widget rules: one file with inline CSS and JavaScript and a <title>; no network of any kind (no http(s): or //host addresses, no fetch, XMLHttpRequest, WebSocket or import, no external scripts, fonts, stylesheets or images; data: and blob: URLs only). The widget runs sealed: its frame has no network and it cannot read or change the document, other files, storage or the app. A page that obviously reaches for the network is refused straight away with the reason, but that check only catches the obvious cases; it is the sealed frame that keeps a widget offline, so a page that gets past the check still has no network and just does not work. Size: the block sizes to its content, so keep it compact (a widget taller than about seven tenths of the editor scrolls inside its block); give controls visible labels. Keyboard: typing belongs to the document until the writer clicks into the widget, which then takes the keyboard; Esc, or a click in the text, hands it back, so a widget must also make sense with no keyboard focus. Do not change the sealing or try to work around it.',
  'Housekeeping — new files, renames/moves — applies immediately under snapshot and audit.',
  'Never overwrite an existing file wholesale: propose prose.edit changes instead.',
  'The hidden Writer situation context describes the open piece, selection, mode and session. When the writer does not name a file, act on that piece. Briefly name the file you acted on.',
  'All paths are relative to the Workspace root. Keep final replies brief and say what changed or what was staged.'
].join('\n')

export function ok(text: string, file: FileReadResult): CapabilityResult<{ file: FileReadResult }> {
  return { text, details: { file } }
}
export function fail(text: string): CapabilityResult {
  return { text, isError: true }
}

const range = (from: number, length: number): { from: number; to: number } => ({ from, to: from + length })

function uniqueRange(content: string, needle: string, field: string, path: string): { from: number; to: number } | string {
  if (!needle) return `${field} must not be empty; provide exact current text from ${path}.`
  const first = content.indexOf(needle)
  if (first === -1) return `${field} was not found in ${path}; re-read the file and retry with the exact current text.`
  if (content.indexOf(needle, first + needle.length) !== -1) return `${field} is not unique in ${path}; include more surrounding context.`
  return range(first, needle.length)
}

/**
 * Text could not be placed in a document. The message is the reason as before; `code` says which of
 * the two usual reasons it was (the text is not there, or is there more than once), for a caller
 * that records it from a closed list (shared/closed-code.ts).
 */
export class PlacementError extends Error {
  override readonly name = 'PlacementError'
  constructor(message: string, readonly code: 'target-gone' | 'target-repeated' | 'other') {
    super(message)
  }
}

/** `uniqueRange`'s refusal for `needle` in `content`, with its code. */
const notPlaced = (content: string, needle: string, message: string): PlacementError =>
  new PlacementError(message, !needle ? 'other' : content.indexOf(needle) === -1 ? 'target-gone' : 'target-repeated')

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }): boolean =>
  a.from < b.to && b.from < a.to

function joinAfterRemoval(before: string, after: string): string {
  const trailing = before.match(/\n+$/)?.[0] ?? ''
  const leading = after.match(/^\n+/)?.[0] ?? ''
  if (!trailing && !leading) return `${before}${after}`
  if (!trailing || !leading) return `${before}${after}`
  const separator = trailing.length + leading.length >= 2 ? '\n\n' : '\n'
  return `${before.slice(0, before.length - trailing.length)}${separator}${after.slice(leading.length)}`
}

function insertBlockAfter(content: string, insertAt: number, text: string): string {
  const beforeRaw = content.slice(0, insertAt)
  const afterRaw = content.slice(insertAt)
  const trailing = beforeRaw.match(/\n+$/)?.[0] ?? ''
  const leading = afterRaw.match(/^\n+/)?.[0] ?? ''
  const before = trailing ? beforeRaw.slice(0, beforeRaw.length - trailing.length) : beforeRaw
  const after = leading ? afterRaw.slice(leading.length) : afterRaw
  const prefix = before ? '\n\n' : ''
  const suffix = after ? '\n\n' : ''
  return `${before}${prefix}${text}${suffix}${after}`
}

/** Place a block at an exact, current document cursor after frontmatter safety has been applied. */
export function resolveProseInsertAt(content: string, position: number, text: string): { nextContent: string } {
  if (!Number.isInteger(position) || position < 0 || position > content.length) {
    throw new Error('The restage cursor is outside the current document; place the cursor again and retry.')
  }
  return { nextContent: insertBlockAfter(content, frontmatterSafeInsertPosition(content, position), text) }
}

export type ResolvedProseMove = {
  moveFrom: { from: number; to: number }
  moveTo: { from: number; to: number }
  nextContent: string
}

export function resolveProseMove(content: string, input: ProseMoveInput): ResolvedProseMove {
  const moveFrom = uniqueRange(content, input.text, 'text', input.path)
  if (typeof moveFrom === 'string') throw notPlaced(content, input.text, moveFrom)
  const anchor = uniqueRange(content, input.insertAfter, 'insertAfter', input.path)
  if (typeof anchor === 'string') throw notPlaced(content, input.insertAfter, anchor)
  if (overlaps(moveFrom, anchor)) throw new PlacementError('insertAfter must not overlap the text being moved; choose a separate unique destination anchor.', 'other')

  const withoutSource = joinAfterRemoval(content.slice(0, moveFrom.from), content.slice(moveFrom.to))
  const anchorInWithoutSource = uniqueRange(withoutSource, input.insertAfter, 'insertAfter', input.path)
  if (typeof anchorInWithoutSource === 'string') throw notPlaced(withoutSource, input.insertAfter, anchorInWithoutSource)
  const inserted = insertBlockAfter(withoutSource, anchorInWithoutSource.to, input.text)
  const nextContent = content.endsWith('\n') && !inserted.endsWith('\n') ? `${inserted}\n` : inserted
  // Pending Change ranges are rendered against the current, pre-apply buffer:
  // moveFrom is the source range, moveTo is the zero-width insertion point after
  // the original anchor, and nextContent is the post-apply document.
  const moveTo = { from: anchor.to, to: anchor.to }
  return {
    moveFrom,
    moveTo,
    nextContent,
  }
}

/**
 * Apply an insertion: new content added AFTER a unique existing anchor, or appended at the end of the
 * document when `insertAfter` is empty (the path a write into an empty/near-empty file takes — there is
 * nothing to replace, so prose.edit cannot express it). Throws with the agent-facing reason when a
 * non-empty anchor is missing or ambiguous, so a malformed insertion is never staged.
 */
export function resolveProseInsert(content: string, input: ProseInsertInput): { nextContent: string } {
  if (input.insertAfter === '') {
    const afterMetadata = frontmatterSafeInsertPosition(content, 0)
    return { nextContent: insertBlockAfter(content, afterMetadata > 0 ? afterMetadata : content.length, input.text) }
  }
  const anchor = uniqueRange(content, input.insertAfter, 'insertAfter', input.path)
  if (typeof anchor === 'string') throw notPlaced(content, input.insertAfter, anchor)
  return { nextContent: insertBlockAfter(content, anchor.to, input.text) }
}

/**
 * Where an insert asked for from OUTSIDE WriteFlex goes (the command line's `insert` and
 * `insert-object`), in one place for the three that must agree: the validator that says a request can
 * be placed, the check after another Change is accepted, and accept itself. With an anchor it is
 * `resolveProseInsert`. With none it is the END OF THE DOCUMENT, after any frontmatter and after all
 * the prose, as the Change's own summary says ("Add text at the end").
 *
 * The in-app agent's `prose.insert` with no anchor is NOT this: it keeps `resolveProseInsert`, whose
 * anchorless place in a document that has frontmatter is just after the frontmatter.
 */
export function resolveOutsideInsert(content: string, input: Pick<ProseInsertInput, 'path' | 'insertAfter' | 'text'>): { nextContent: string } {
  if (input.insertAfter === '') return { nextContent: insertBlockAfter(content, content.length, input.text) }
  return resolveProseInsert(content, { ...input, category: 'other', summary: '' })
}

/**
 * Settings keys backing the Agent Permissions switches (Task 17). Absent key → the switch has never
 * been touched → enabled (every switch defaults on, per the mockup). One switch covers both read
 * lanes. Capabilities not listed here have no switch and stay enabled.
 */
/** The settings switch (or switches: every one must be on) behind each capability. The SAME entry gates the
 *  manifest at bind, the policy at proposal and at accept, and the verb at the moment it runs. */
export const CAPABILITY_PERMISSION_KEYS: Record<string, string | readonly string[]> = {
  'prose.edit': 'permissions.proseEdits',
  'prose.move': 'permissions.proseEdits',
  'prose.insert': 'permissions.proseEdits',
  'objects.insert': 'permissions.proseEdits',
  'housekeeping.create_file': 'permissions.createFiles',
  'notes.create': 'permissions.createFiles',
  'housekeeping.rename_file': 'permissions.renameFiles',
  'files.list': 'permissions.readWorkspace',
  'files.read': 'permissions.readWorkspace',
  'plan.read': 'permissions.readWorkspace',
  'plan.compare_parts': 'permissions.readWorkspace',
  'tasks.list': 'permissions.readWorkspace',
  'sources.list': 'permissions.readWorkspace',
  'tasks.toggle': 'permissions.proseEdits',
  'widgets.insert': 'permissions.proseEdits',
  'widgets.remove': 'permissions.proseEdits',
  // Makes a file AND edits the document's text, so it needs both switches: with prose edits off, the embed line is refused too.
  'widgets.create': ['permissions.createFiles', 'permissions.proseEdits']
}

/** Whether `name` is permitted under the live settings values: only an explicit false disables. */
export function capabilityEnabled(name: string, get: (key: string) => unknown): boolean {
  const key = CAPABILITY_PERMISSION_KEYS[name]
  if (key === undefined) return true
  return (typeof key === 'string' ? [key] : key).every((one) => get(one) !== false)
}

/**
 * The approval policy, optionally wrapped around the live permissions filter: a switched-off
 * capability is DENIED outright before any trust reasoning — the second fence behind the
 * bind-time manifest exclusion, and the one that catches a mid-session toggle.
 */
function stageValidationFailure(workspace: Workspace, capabilityName: string, rawInput: unknown): string | null {
  try {
    if (!rawInput || typeof rawInput !== 'object') throw new Error('The staged input must be an object.')
    const input = rawInput as Record<string, unknown>
    if (typeof input.path !== 'string') throw new Error('path must name a Workspace file.')
    const content = readFileSync(workspace.absolute(input.path), 'utf8')
    if (capabilityName === 'prose.edit') {
      if (typeof input.oldText !== 'string') throw new Error('oldText must be exact current text.')
      const match = uniqueRange(content, input.oldText, 'oldText', input.path)
      if (typeof match === 'string') throw new Error(match)
    } else if (capabilityName === 'prose.move') {
      resolveProseMove(content, input as ProseMoveInput)
    } else if (capabilityName === 'prose.insert') {
      if (typeof input.text !== 'string' || !input.text) throw new Error('text must not be empty; provide the content to insert.')
      resolveProseInsert(content, input as ProseInsertInput)
    } else if (capabilityName === 'objects.insert') {
      if (typeof input.kind !== 'string' || typeof input.content !== 'string') throw new Error('kind and content are required for an object insertion.')
      validateObjectMarkup(input.kind as ObjectKind, input.content)
      resolveProseInsert(content, {
        path: input.path,
        insertAfter: typeof input.insertAfter === 'string' ? input.insertAfter : '',
        text: objectBlock(input.kind as ObjectKind, input.content),
        category: 'other',
        summary: typeof input.summary === 'string' ? input.summary : 'Insert object',
      })
    } else if (capabilityName === 'frontmatter.normalise') {
      const source = content.startsWith('﻿') ? content.slice(1) : content
      if (!frontmatterSplit(source)) throw new Error(`${input.path} has no existing frontmatter block; use frontmatter.set to add metadata.`)
    } else if (capabilityName === 'frontmatter.set') {
      if (!input.set || typeof input.set !== 'object' || Object.keys(input.set).length === 0) {
        throw new Error('set must name at least one frontmatter key.')
      }
      setFrontmatterKeys(content, input.set as FrontmatterSetInput['set'], input.path)
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function denyWithValidationReason(reason: string): ApprovalDecision {
  return {
    decision: 'deny',
    reason: {
      code: 'writeflex-stage-validation',
      message: reason,
    },
  }
}

export function writeflexApprovalPolicy(isEnabled?: (name: string) => boolean, workspace?: Workspace): ApprovalPolicy {
  return ({ capability, input, trigger }) => {
    if (isEnabled && !isEnabled(capability.name)) return 'deny'
    // No verb that writes may aim at a hidden folder (.writeflex, .bridle, .git, ...): those are the app's and
    // other tools' records, not the writer's documents. The policy runs at proposal and again at accept.
    if (capability.risk !== 'read' && input && typeof input === 'object') {
      for (const key of ['path', 'newPath'] as const) {
        const value = (input as Record<string, unknown>)[key]
        if (typeof value === 'string' && isHiddenWorkspacePath(value)) {
          return denyWithValidationReason(`${value} is not a document in a visible folder of the Workspace, so ${capability.name} will not change it.`)
        }
      }
    }
    if (workspace && (
      capability.name.startsWith('prose.') || capability.name === 'objects.insert'
      || capability.name === 'frontmatter.normalise' || capability.name === 'frontmatter.set'
    )) {
      const failure = stageValidationFailure(workspace, capability.name, input)
      if (failure) return denyWithValidationReason(failure)
    }
    // prose.* always stages; frontmatter.normalise stages too — though it touches only metadata it
    // rewrites whole files, one Suggestion per file, so the writer reviews each before it lands.
    if (capability.name.startsWith('prose.') || capability.name === 'objects.insert' || capability.name === 'frontmatter.normalise' || capability.name === 'frontmatter.set') return 'stage'
    // plan.propose's floor is a proposal, always (ticket 09): no trust level or wording lowers it.
    if (capability.name === 'plan.propose') return 'stage'
    // So is a tick (checkbox-lists ticket 04, content-verb law): the agent never ticks a box directly.
    if (capability.name === 'tasks.toggle') return 'stage'
    // And a widget line put in or taken out (interactive-widgets ticket 05): one embed line, proposed, never written directly.
    if (capability.name === 'widgets.insert' || capability.name === 'widgets.remove' || capability.name === 'widgets.create') return 'stage'
    // And an offcut becoming an idea (scraps ticket 02): the agent proposes, the writer accepts.
    if (capability.name === 'scraps.promote') return 'stage'
    // And a source attached to a piece (scraps ticket 03): one frontmatter line, proposed, never written directly.
    if (capability.name === 'sources.attach') return 'stage'
    if (capability.name === 'folio.turn_back') return trigger.trust === 'background' ? 'deny' : 'ask'
    const trusted = trigger.trust === 'interactive' || trigger.trust === 'trusted_app'
    if (capability.risk === 'read') return 'allow'
    if (capability.risk === 'destructive') return trusted ? 'ask' : 'deny'
    return trusted ? 'allow' : 'stage'
  }
}

