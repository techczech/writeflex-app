/**
 * The Folios of a vault, as every list shows them (Dominik, 6 and 10 Nov 2026): by the Folio's own title,
 * with its folder path as secondary text, so two Folios whose READMEs share a heading can still be told
 * apart, and so a Folio can be found in a vault that mixes loose files and Folios. Pure; the titles come
 * from the vault index (main's vault-works.ts: Index Note title, then manifest title, then README heading).
 */
import type { VaultIndex } from '../../shared/vault-index'
import { prepareFuzzyScore } from './fuzzy'

export type FolioRow = { path: string; title: string }

/** Every Folio in the vault index, sorted by title (then path, so equal titles keep a stable order). */
export function vaultFolios(index: Pick<VaultIndex, 'works'> | null | undefined): FolioRow[] {
  if (!index) return []
  return index.works
    .filter((work) => work.kind === 'folio')
    .map((work) => ({ path: work.path, title: work.title }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || a.path.localeCompare(b.path))
}

/** The secondary line of a Folio row: its folder path, or "Vault root" for a vault that is itself a Folio. */
export function folioPathText(path: string): string {
  return path === '' ? 'Vault root' : path
}

/** Folios matching a query on their title or their folder path, best first; all of them for an empty query. */
export function matchFolios(query: string, folios: readonly FolioRow[]): FolioRow[] {
  if (query.trim() === '') return [...folios]
  const score = prepareFuzzyScore(query)
  const scored: Array<{ row: FolioRow; score: number }> = []
  for (const row of folios) {
    const byTitle = score(row.title)
    const byPath = score(row.path)
    const best = byTitle === null ? byPath : byPath === null ? byTitle : Math.max(byTitle, byPath)
    if (best !== null) scored.push({ row, score: best })
  }
  return scored.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title)).map((entry) => entry.row)
}

const collapsedKey = (root: string): string => `writeflex:vault-folios-collapsed:${root}`

/** Whether the sidebar's Folios section is folded for this vault on this Mac (a convenience; never vault data). */
export function readFoliosCollapsed(root: string): boolean {
  try { return localStorage.getItem(collapsedKey(root)) === '1' } catch { return false }
}

export function writeFoliosCollapsed(root: string, collapsed: boolean): void {
  try { localStorage.setItem(collapsedKey(root), collapsed ? '1' : '0') } catch { /* convenience only */ }
}
