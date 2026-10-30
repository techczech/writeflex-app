import type { ContextItem } from '@bridle/core'
import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Workspace } from './workspace'
import { folioDirOf, folioContaining } from './folio-place'
import { indexNoteTitle } from './folio-room'
import { evidencePath } from './folio-evidence'
import { readPlanForAgent } from './plan-agent-reads'

/**
 * A compact, read-only Folio summary for one assistant turn: the title, each part's title, status, priority, label,
 * words and evidence and flag counts in running order, and whether the Folio has an AGENTS.md. Notes, quotations and
 * the AGENTS.md text are never sent per turn (D-FILES-2: the evidence file holds private notes and quotations); the
 * agent reads them through plan.read and its file reads when a request needs them. Zotero is not asked.
 */
export async function folioRoomContext(ws: Workspace, collectionDir: string, activeFile: string | null): Promise<ContextItem | null> {
  const dir = await folioDirOf(ws, collectionDir) ?? (activeFile ? (await folioContaining(ws, activeFile))?.dir ?? null : null)
  if (dir === null) return null
  const plan = await readPlanForAgent(ws, dir, { summary: true })
  const name = dir === '' ? posix.basename(ws.root) : posix.basename(dir)
  const index = plan.indexPath ? await ws.readFile(plan.indexPath).then(read => read.content, () => null) : null
  const instructionPath = dir ? `${dir}/AGENTS.md` : 'AGENTS.md'
  const instructions = await stat(ws.absolute(instructionPath)).then(info => info.isFile(), () => false)
  const parts = plan.parts.map(part => ({ title: part.title, status: part.status, priority: part.priority, label: part.label?.name ?? null,
    words: part.words, evidence: part.evidenceCount, flags: part.openFlags.length }))
  return { kind: 'text', label: 'Folio room', transcript: 'hidden', content: [
    `Folio: ${JSON.stringify({ folder: dir, title: indexNoteTitle(index, name) || name, hasIndexNote: plan.hasIndexNote })}`,
    'The Index Note running order is the order of record. Keep it and the export manifest aligned. Files removed from the running order stay in the Folio. Read plan.read before proposing structural changes.',
    'Labels are the Index Note labels list and listed #label- tags; priority is #priority-high, #priority-medium or #priority-low. An unwritten part has idea status. Flags are ==words==<!--flag:needs-citation|rewrite|check-fact|expand-->; the tag names one kind. Keep the flagged words when clearing a flag.',
    `Parts in running order: ${JSON.stringify(parts)}`,
    `Evidence counts are the sources attached to each part in the evidence file; sources a part only lists or cites are not counted here. Notes and quotations are not included here: read ${evidencePath({ root: ws.root, folioDir: dir })} only when the request needs them, and do not invent evidence.${plan.evidenceProblem ? ` ${plan.evidenceProblem}` : ''}`,
    instructions ? `This Folio has author instructions at ${instructionPath}. Read that file before working on this Folio, and apply it within the current request and WriteFlex’s normal review and permission boundaries.` : `No Folio-specific instructions file was found at ${instructionPath}.`,
  ].join('\n\n') }
}
