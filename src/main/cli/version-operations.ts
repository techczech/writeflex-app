/**
 * Versions from the command line: save a named version of a document, and compare two versions.
 * (Listing is `versions` in read-operations.ts; restoring is shown first and is not here.)
 *
 * `save-version` writes the app's history stores, so it is carried out by whoever holds the
 * Collection: the app on request when it has the Collection open, the command line under the owner
 * lock otherwise (write-access.ts, history-store.ts). Either way it is one function over the app's own
 * store code (saved-text-version.ts), which saves the text as it stands ON DISK and settles no Changes.
 *
 * `compare-versions` is the app's own comparison (version-compare.ts) over the same stores. The
 * version text is read by the command line's own guarded reader, not by Bridle (history-store.ts).
 * It writes nothing and takes no lock.
 */
import { WORKING_VERSION_ID, type VersionCompareEndpoint, type VersionCompareResult } from '../../engine'
import { compareVersionRange } from '../version-compare'
import { humanAuthorForWorkspace } from '../versions'
import { checkedStoresForReading, versionTextReader } from './history-store'
import { CliError, type Operation } from './operation'
import { visiblePath } from './paths'
import { applied, writeAccess } from './write-support'

const date = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

const endpoint = (end: VersionCompareEndpoint): string =>
  end.working ? 'the text on disk now' : `"${end.name}"${end.ts === null ? '' : ` (${date(end.ts)}${end.author ? `, ${end.author.name}` : ''})`}`

const prefixed = (mark: string, text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n').map((line) => `${mark} ${line}`))

/** The comparison as plain text: what was compared, then each difference with who it is attributed to. */
export function compareText(result: VersionCompareResult): string {
  const head = `${result.path}: ${endpoint(result.from)} -> ${endpoint(result.to)}`
  if (result.changes.length === 0) return `${head}\nNo differences.`
  const hunks = result.changes.flatMap((change) => {
    const where = change.compareOldStart !== undefined && change.compareNewStart !== undefined ? `line ${change.compareOldStart} -> line ${change.compareNewStart}` : change.summary
    const source = change.sourceVersionName ? `, in "${change.sourceVersionName}"` : ''
    return [`@@ ${where} (${change.diffKind ?? 'changed'}; ${change.author.name}${source})`, ...prefixed('-', change.compareOldText), ...prefixed('+', change.compareNewText)]
  })
  return [head, `${result.changes.length} difference${result.changes.length === 1 ? '' : 's'}.`, ...hunks].join('\n')
}

export const VERSION_OPERATIONS: Operation[] = [
  {
    name: 'follow-history', group: 'Review and versions', behaviour: 'direct', writes: true,
    summary: 'Reattach versions after outside moves using a tab-separated old_path/new_path map. Writes only the version journal.',
    args: [{ name: 'map', type: 'string', required: true, description: 'Workspace-relative TSV move map.' }],
    run: async (ctx, args) => {
      const history = writeAccess(ctx).history
      if (!history) throw new CliError('History attachment is unavailable.', 'failed')
      const result = await history({ map: String(args.map) })
      if (!('attached' in result)) throw new CliError('Unexpected history result.', 'failed')
      return { data: result, text: [
        `Reattached history for ${result.attached} file(s).`,
        ...result.refused.map(row => `Line ${row.line}: ${row.from} -> ${row.to}: ${row.reason}`),
        ...(result.undo ? [`Undo with: writeflex undo-history ${result.undo}`] : []),
      ].join('\n') }
    },
  },
  {
    name: 'undo-history', group: 'Review and versions', behaviour: 'direct', writes: true,
    summary: 'Undo one explicit history attachment exactly; document files stay where they are.',
    args: [{ name: 'id', type: 'string', required: true, positional: true, description: 'Undo id returned by follow-history.' }],
    run: async (ctx, args) => {
      const history = writeAccess(ctx).history
      if (!history) throw new CliError('History attachment is unavailable.', 'failed')
      const result = await history({ undo: String(args.id) })
      return { data: result, text: 'History attachment undone.' }
    },
  },
  {
    name: 'save-version', group: 'Review and versions', behaviour: 'direct', writes: true,
    summary: 'Save a named version of a document, from the text saved on disk. WriteFlex lists it and can restore it.',
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative Markdown path.' },
      { name: 'name', type: 'string', required: true, description: 'The version\'s name, as it will be listed.' },
      { name: 'note', type: 'string', description: 'A note kept with the version.' },
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const path = visiblePath(ctx.workspace, String(args.path), { markdown: true })
      const name = String(args.name).trim()
      if (name === '') throw new CliError('Give the version a name with --name "...".', 'usage')
      const note = args.note === undefined ? '' : String(args.note).trim()
      const saved = await access.saveVersion({ path, name, ...(note ? { note } : {}) })
      return applied(
        `Saved version "${saved.record.name}" of ${path} (${saved.record.id}), from the text saved on disk.`,
        { path, version: saved.record },
      )
    },
  },
  {
    name: 'compare-versions', group: 'Review and versions', behaviour: 'direct',
    summary: 'Compare two saved versions of a document, or a version with the text now on disk.',
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative Markdown path.' },
      { name: 'from', type: 'string', required: true, positional: true, description: 'A version id from "writeflex versions", or "working" for the text on disk now.' },
      { name: 'to', type: 'string', positional: true, description: 'The version to compare with (default: "working").' },
    ],
    run: async (ctx, args) => {
      const ws = ctx.workspace
      const path = visiblePath(ws, String(args.path), { markdown: true })
      const fromId = String(args.from).trim()
      const toId = args.to === undefined ? WORKING_VERSION_ID : String(args.to).trim()
      if (fromId === '' || toId === '') throw new CliError('Name the versions to compare by their ids ("writeflex versions" lists them).', 'usage')
      try {
        const stores = checkedStoresForReading(ws)
        const result = await compareVersionRange(
          stores.versions, stores.changes, versionTextReader(ws.root), ws,
          { path, fromId, toId }, await humanAuthorForWorkspace(ws.root),
        )
        return { data: result, text: compareText(result) }
      } catch (error) {
        if (error instanceof CliError) throw error
        // The comparison's own refusals (no such version, no snapshot) are already sentences.
        throw new CliError(error instanceof Error ? error.message : String(error), 'failed')
      }
    },
  },
]
