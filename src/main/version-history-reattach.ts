import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { followVersionMap, historyPath, isHistoryMapPath, readHeldBackVersions, undoVersionMap, type HistoryFollowResult } from './version-moves'
import { VersionStore } from './versions'
import type { Workspace } from './workspace'
import { readBytes } from './cli/guarded-fs'
import { versionTextReader } from './cli/history-store'

export type HistoryAttachment = { from: string; to: string }
export type HistoryRequest = { map: string } | { undo: string }
export type HistoryMapApproval = { map: string; hash: string; plan: string }
export type HistoryResult = HistoryFollowResult | { restored: number }

/** Shared CLI, agent and IPC map-import/Undo route, including preview verification.
 * The caller holds the Collection write turn/owner lock; approvals are app-owned. */
export async function reattachVersionHistory(ws: Workspace, request: HistoryRequest, confirmOwner: () => Promise<void>, approval?: HistoryMapApproval): Promise<HistoryResult> {
  if ('undo' in request) {
    await confirmOwner()
    return { restored: undoVersionMap(ws.root, request.undo) }
  }
  // Read without mutation first; confirm ownership before checking approval and appending anything.
  const bytes = await readBytes(ws, historyPath(request.map))
  await confirmOwner()
  if (approval && (request.map !== approval.map || createHash('sha256').update(bytes).digest('hex') !== approval.hash)) {
    throw new Error('History map changed since approval; preview again. Nothing was written.')
  }
  return followVersionMap(ws.root, bytes.toString('utf8'), approval?.plan)
}

/** Read-only, active-document suggestion. Missing old names alone grant no write authority. */
export async function suggestHistoryAttachments(ws: Workspace, path: string): Promise<HistoryAttachment[]> {
  historyPath(path)
  if (/[\t\r\n]/.test(path)) return []
  const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
  const current = digest(await readBytes(ws, path))
  const first = new Map<string, Awaited<ReturnType<VersionStore['list']>>[number]>()
  const held = readHeldBackVersions(ws.root)
  const heldNames = new Set(held.map(version => version.path))
  for (const version of [...await new VersionStore(ws).list(), ...held].sort((a, b) => a.ts - b.ts)) if (!first.has(version.path)) first.set(version.path, version)
  const reader = versionTextReader(ws.root)
  const suggestions: HistoryAttachment[] = []
  for (const [from, version] of first) {
    if (/[\t\r\n]/.test(from) || (from === path && !heldNames.has(from)) || !version.snapshotId || !isHistoryMapPath(from, true)) continue
    if (!heldNames.has(from) && await lstat(ws.absolute(from)).catch(() => null)) continue
    const text = await reader.readSnapshotContent(version.snapshotId)
    if (text !== null && digest(text) === current) suggestions.push({ from, to: path })
  }
  return suggestions
}
