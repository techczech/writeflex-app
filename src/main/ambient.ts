import type { ContextItem } from '@bridle/core'

export type AmbientSnapshot = {
  workspaceRoot: string
  activeFile: { path: string; title: string; collection?: string; folio?: { path: string; index: number; of: number } } | null
  mode: { writer: 'drafting' | 'reviewing'; view: 'clean' | 'markup' | 'raw' } | null
  selection: { from: number; to: number; text: string } | null
  process: { session: 'none' | 'running' | 'paused'; wordsThisSession: number; goal?: { target: number; due?: string } } | null
  recency: { lastWriterEditAt?: string; lastAgentActionAt?: string }
}

function validateSnapshot(s: AmbientSnapshot): void {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const path = (v: unknown, empty = false): boolean => typeof v === 'string' && (empty || v.length > 0)
    && !v.startsWith('/') && !v.includes('\\') && !v.split('/').includes('..') && !v.includes('\0')
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string'
  const integer = (v: unknown): v is number => Number.isSafeInteger(v)
  if (!record(s) || typeof s.workspaceRoot !== 'string' || !record(s.recency)
    || !optionalString(s.recency.lastWriterEditAt) || !optionalString(s.recency.lastAgentActionAt)
    || (s.activeFile !== null && (!record(s.activeFile) || !path(s.activeFile.path) || typeof s.activeFile.title !== 'string'
      || (s.activeFile.collection !== undefined && !path(s.activeFile.collection, true))
      || (s.activeFile.folio !== undefined && (!record(s.activeFile.folio) || !path(s.activeFile.folio.path, true)
        || !integer(s.activeFile.folio.index) || !integer(s.activeFile.folio.of) || s.activeFile.folio.index < 1 || s.activeFile.folio.index > s.activeFile.folio.of))))
    || (s.mode !== null && (!record(s.mode) || !['drafting', 'reviewing'].includes(s.mode.writer) || !['clean', 'markup', 'raw'].includes(s.mode.view)))
    || (s.selection !== null && (!record(s.selection) || !integer(s.selection.from) || !integer(s.selection.to)
      || s.selection.from < 0 || s.selection.to < s.selection.from || typeof s.selection.text !== 'string'))
    || (s.process !== null && (!record(s.process) || !['none', 'running', 'paused'].includes(s.process.session)
      || !integer(s.process.wordsThisSession) || (s.process.goal !== undefined && (!record(s.process.goal)
        || !integer(s.process.goal.target) || s.process.goal.target <= 0 || !optionalString(s.process.goal.due)))))) {
    throw new Error('Invalid ambient snapshot.')
  }
}

/** One window's replace-only context. Agent recency is owned by main, never the renderer. */
export class AmbientState {
  private snapshot: AmbientSnapshot
  constructor(private readonly root: string) {
    this.snapshot = { workspaceRoot: root, activeFile: null, mode: null, selection: null, process: null, recency: {} }
  }
  set(snapshot: AmbientSnapshot): void {
    validateSnapshot(snapshot)
    if (snapshot.workspaceRoot !== this.root) throw new Error('Ambient snapshot belongs to another workspace.')
    const next = structuredClone(snapshot)
    if (next.selection) next.selection.text = boundSelection(next.selection.text)
    next.recency = { ...(next.recency.lastWriterEditAt ? { lastWriterEditAt: next.recency.lastWriterEditAt } : {}),
      ...(this.snapshot.recency.lastAgentActionAt ? { lastAgentActionAt: this.snapshot.recency.lastAgentActionAt } : {}) }
    this.snapshot = next
  }
  get(): AmbientSnapshot { return structuredClone(this.snapshot) }
  noteAgentAction(at = new Date().toISOString()): void {
    this.snapshot = { ...this.snapshot, recency: { ...this.snapshot.recency, lastAgentActionAt: at } }
  }
}

export function boundSelection(text: string): string {
  return text.length > 2000 ? text.slice(0, 1996) + ' […]' : text
}
const line = (text: string): string => text.replace(/\s+/g, ' ').trim()
export function ambientToPrompt(snapshot: AmbientSnapshot): string {
  const { activeFile: file, mode, selection, process, recency } = snapshot
  return [
    `Workspace: ${line(snapshot.workspaceRoot)}`,
    file ? `Open piece: ${line(file.title)} (${line(file.path)})` : 'Open piece: none',
    ...(file?.collection !== undefined ? [`Collection: ${line(file.collection) || '.'}`] : []),
    ...(file?.folio ? [`Folio: ${line(file.folio.path) || '.'}; part ${file.folio.index} of ${file.folio.of}`] : []),
    mode ? `Mode: ${mode.writer}; ${mode.view}` : 'Mode: unavailable',
    selection ? `Selection (${selection.from}–${selection.to}): “${line(boundSelection(selection.text))}”` : 'Selection: none',
    process ? `Process: ${process.session}; ${process.wordsThisSession} words this session${process.goal ? `; goal ${process.goal.target} words${process.goal.due ? ` due ${line(process.goal.due)}` : ''}` : ''}` : 'Process: unavailable',
    `Recency: ${[recency.lastWriterEditAt && `writer edit ${line(recency.lastWriterEditAt)}`, recency.lastAgentActionAt && `agent action ${line(recency.lastAgentActionAt)}`].filter(Boolean).join('; ') || 'none'}`,
  ].join('\n')
}
export function ambientContextItem(snapshot: AmbientSnapshot): ContextItem {
  return { kind: 'text', label: 'Writer situation', content: ambientToPrompt(snapshot), transcript: 'hidden' }
}
