/** Read-only projections of the same store and inventory the floating panel uses, the one
 *  agent-originated candidate write (send_text), and the declared metadata content verbs of spec
 *  §8 (group create/rename/move, reject/restore and the approval-bound delete). Every write goes
 *  through the same guarded ScratchpadStore methods the panel's IPC calls — no second dispatcher,
 *  no renderer-named paths; an item is named by its typed id alone. */
import { Type } from 'typebox'
import type { Verb } from './index'
import type { Workspace } from '../workspace'
import type { ScrapStore } from '../scraps'
import { ScratchpadStore } from '../scratchpad-store'
import { readScratchInventory } from '../scratchpad-inventory'
import { inScope, matchesQuery, parseQuery, type ScratchScope } from '../../shared/scratchpad-items'
import { visiblePath } from '../cli/paths'
import { fail } from './verb-support'

export function scratchpadReadVerbs(workspace: Workspace, scraps: ScrapStore | null): Verb[] {
  const store = new ScratchpadStore(workspace, scraps)
  // The delete verb's approval binding (the history.follow pattern): preview records the exact
  // item version it showed against the input object itself; run consumes it once, and the store
  // refuses if the body changed while approval waited. Never serialised, never reusable.
  const deleteApprovals = new WeakMap<object, { id: string; version: string }>()
  const validIds = (ids: unknown): string[] | null =>
    Array.isArray(ids) && ids.length > 0 && ids.length <= 500 && ids.every((id) => typeof id === 'string' && id !== '') ? (ids as string[]) : null
  /** Run one guarded store action per id and report the ACTUAL outcome of each, never a blanket claim. */
  const eachItem = async (ids: string[], act: (id: string) => Promise<void>): Promise<{ done: string[]; failed: Array<{ id: string; error: string }> }> => {
    const done: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const id of ids) {
      try { await act(id); done.push(id) } catch (error) { failed.push({ id, error: (error as Error).message }) }
    }
    return { done, failed }
  }
  const batchText = (verb: string, outcome: { done: string[]; failed: Array<{ id: string; error: string }> }): string =>
    `${verb}: ${outcome.done.length} done${outcome.failed.length ? `, ${outcome.failed.length} refused (${outcome.failed.map((f) => `${f.id}: ${f.error}`).join('; ')})` : ''}.`
  return [
    {
      id: 'scratchpad.list', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'list Scratchpad items',
      describe: 'Read typed Scratchpad item ids, kinds, titles, sources, groups and status. Bodies are available through scratchpad.get. No writes.',
      parameters: Type.Object({ path: Type.Optional(Type.String()), scope: Type.Optional(Type.Union([Type.Literal('document'), Type.Literal('folio'), Type.Literal('workspace')])), query: Type.Optional(Type.String()) }),
      run: async (_ctx, input: { path?: string; scope?: ScratchScope; query?: string }) => {
        try {
          const path = input.path ? visiblePath(workspace, input.path, { markdown: true }) : null
          const snapshot = await store.list({ activePath: path })
          const items = snapshot.items.filter(item => inScope(item, input.scope ?? 'workspace', { activePath: path, folioDir: snapshot.folioDir }) && matchesQuery(item, parseQuery(input.query ?? '')))
            .map(({ markdown: _markdown, ...item }) => item)
          return { text: JSON.stringify(items, null, 2), details: { items, groups: snapshot.groups, notices: snapshot.notices } }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    {
      id: 'scratchpad.get', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'read Scratchpad content',
      describe: 'Read one retained Scratchpad item with its exact Markdown payload and source path. Private withdrawn copies are unavailable. No writes.',
      parameters: Type.Object({ id: Type.String() }),
      run: async (_ctx, input: { id: string }) => {
        try { const item = await store.get(input.id); return { text: JSON.stringify(item, null, 2), details: { item } } }
        catch (error) { return fail((error as Error).message) }
      },
    },
    {
      // The one agent-originated Scratchpad write (ADR-0050 spec §8, ticket 04): exact Markdown filed
      // as a new candidate through the store's checked payload+metadata writer — never the legacy
      // SCRAPS.md heading grammar (which trims and splits), never an arbitrary path. Provenance is
      // recorded as the agent's; the item is a candidate the writer can reject, so the floor is direct.
      id: 'scratchpad.send_text', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'send text to the Scratchpad',
      describe: 'File exact Markdown in the floating Scratchpad as a new candidate that came from the named document. The text is kept byte for byte (headings, fences, blank lines and line endings survive), labelled as suggested by the agent, and nothing in any document changes. Optionally file it under a group name (created if new). Returns the new item id.',
      parameters: Type.Object({
        origin: Type.String({ description: 'Workspace-relative Markdown document this text belongs to (its origin; must exist in this workspace)' }),
        markdown: Type.String({ description: 'The exact Markdown to keep, byte for byte' }),
        heading: Type.Optional(Type.String({ description: 'The heading the text sits under in its origin, when known' })),
        group: Type.Optional(Type.String({ description: 'Group name to file it under; created if it does not exist' })),
      }),
      preview: (input: { origin: string }) => `Send text from ${input.origin} to the Scratchpad`,
      // The item's payload and record are new files with a fresh id: no existing file is touched.
      touchedPaths: () => [],
      run: async (_ctx, input: { origin: string; markdown: string; heading?: string; group?: string }) => {
        try {
          const origin = visiblePath(workspace, input.origin, { markdown: true })
          if (!(await workspace.listFiles()).some((file) => file.path === origin)) return fail(`Not a document in this workspace: ${input.origin}`)
          const group = input.group?.trim() ? await store.createGroup(input.group) : null
          const item = await store.addText({ origin, markdown: input.markdown, how: 'copy', by: 'agent', heading: input.heading ?? null, ...(group ? { group: group.id } : {}) })
          return { text: `Filed ${item.id} in the Scratchpad from ${origin}. It is a candidate there, labelled as suggested by the agent; no document changed.`, details: { item } }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    {
      // Spec §8 `scratchpad.group` (direct): create, rename, or move items between groups, through
      // the same checked index/record writers the panel calls. A group is named by its id or its
      // exact name; an unknown group refuses rather than creating one by a typo (create is its own op).
      id: 'scratchpad.group', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'manage Scratchpad groups',
      describe: 'Manage Scratchpad groups: op "create" makes a group from `name` (or returns the existing one of that name); op "rename" renames the group named by `group` (its id, from scratchpad.list) to `name`; op "move" files every item in `ids` under `group` (a group id, or null to ungroup). Metadata only: no document and no item payload is ever rewritten. Reports the actual outcome per item.',
      parameters: Type.Object({
        op: Type.Union([Type.Literal('create'), Type.Literal('rename'), Type.Literal('move')]),
        name: Type.Optional(Type.String({ description: 'The group name to create, or the new name for a rename' })),
        group: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'A group id (g_…), or null with op "move" to take items out of their group' })),
        ids: Type.Optional(Type.Array(Type.String(), { description: 'Item ids to move (op "move")' })),
      }),
      preview: (input: { op: string; name?: string }) => input.op === 'create' ? `Create the Scratchpad group “${input.name ?? ''}”` : input.op === 'rename' ? `Rename a Scratchpad group to “${input.name ?? ''}”` : 'Move Scratchpad items to a group',
      touchedPaths: () => [],
      run: async (_ctx, input: { op: 'create' | 'rename' | 'move'; name?: string; group?: string | null; ids?: string[] }) => {
        try {
          if (input.op === 'create') {
            const group = await store.createGroup(input.name ?? '')
            const groups = (await store.list({ activePath: null })).groups
            return { text: `Group “${group.name}” (${group.id}) is ready.`, details: { group, groups } }
          }
          if (input.op === 'rename') {
            if (typeof input.group !== 'string' || input.group === '') return fail('Name the group to rename by its id (scratchpad.list shows groups).')
            const group = await store.renameGroup(input.group, input.name ?? '')
            const groups = (await store.list({ activePath: null })).groups
            return { text: `Group renamed to “${group.name}” (${group.id}).`, details: { group, groups } }
          }
          const ids = validIds(input.ids)
          if (!ids) return fail('Name the items to move.')
          let groupId: string | null
          if (input.group === null) groupId = null
          else if (typeof input.group === 'string') {
            const groups = (await store.list({ activePath: null })).groups
            const found = groups.find((g) => g.id === input.group) ?? groups.find((g) => g.name.toLowerCase() === (input.group as string).trim().toLowerCase())
            if (!found) return fail(`No Scratchpad group “${input.group}”. Create it first with op "create".`)
            groupId = found.id
          } else return fail('Name the group to move items to (a group id, or null to ungroup).')
          const outcome = await eachItem(ids, async (id) => { await store.get(id); await store.setGroup([id], groupId) })
          return { text: batchText(groupId ? 'Filed under the group' : 'Taken out of their group', outcome), details: { group: groupId, ...outcome } }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    {
      // Spec §8 reject/restore (direct): triage only. Rejecting deletes nothing; restoring moves an
      // item back to Candidates. Both run the panel's own guarded status writer, per item.
      id: 'scratchpad.reject', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'reject Scratchpad items',
      describe: 'Move Scratchpad items to Rejected (triage: rejecting deletes nothing, and scratchpad.restore brings an item back). Only a rejected item can later be deleted, and only through the approval-bound scratchpad.delete. Reports the actual outcome per item.',
      parameters: Type.Object({ ids: Type.Array(Type.String()) }),
      preview: (input: { ids: string[] }) => `Reject ${input.ids?.length ?? 0} Scratchpad item(s)`,
      touchedPaths: () => [],
      run: async (_ctx, input: { ids: string[] }) => {
        const ids = validIds(input.ids)
        if (!ids) return fail('Name the items to reject.')
        const outcome = await eachItem(ids, async (id) => { await store.get(id); await store.setStatus([id], 'rejected') })
        return { text: batchText('Rejected', outcome), details: outcome }
      },
    },
    {
      id: 'scratchpad.restore', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'restore Scratchpad items to Candidates',
      describe: 'Move rejected Scratchpad items back to Candidates, through the same guarded status writer the panel calls. Reports the actual outcome per item.',
      parameters: Type.Object({ ids: Type.Array(Type.String()) }),
      preview: (input: { ids: string[] }) => `Move ${input.ids?.length ?? 0} Scratchpad item(s) back to Candidates`,
      touchedPaths: () => [],
      run: async (_ctx, input: { ids: string[] }) => {
        const ids = validIds(input.ids)
        if (!ids) return fail('Name the items to move back.')
        const outcome = await eachItem(ids, async (id) => { await store.get(id); await store.setStatus([id], 'active') })
        return { text: batchText('Back in Candidates', outcome), details: outcome }
      },
    },
    {
      // Spec §8 `scratchpad.delete` (APPROVAL, always asks): Delete forever for ONE rejected item.
      // The approval is bound to the exact version preview showed; a body changed while approval
      // waited refuses. Only the candidate's own record/payload (lossless) or its own legacy
      // section in its own origin's scraps file is removed — canonical/linked source assets and
      // source documents are never touched, and no path can be named. Bridle's execution journal
      // records the operation; a generic turn Undo does NOT promise to restore a deletion.
      id: 'scratchpad.delete', class: 'content', posture: 'approval', asks: true, risk: 'destructive', agentOnly: true, label: 'delete a rejected Scratchpad item forever',
      describe: 'Delete ONE rejected Scratchpad item forever, only with the writer\'s approval of the exact item shown. Refuses an item that is not rejected, unknown, or changed since it was shown. Removes only the candidate itself (its record and saved text, or its section in its own origin\'s scraps file); the documents and sources it came from are never touched. This cannot be undone.',
      parameters: Type.Object({
        id: Type.String({ description: 'The rejected item\'s id, as scratchpad.list gives it' }),
        version: Type.Optional(Type.String({ description: 'The item version scratchpad.list/get showed; when given, it must still match at approval and at execution' })),
      }),
      preview: async (input: { id: string; version?: string }) => {
        deleteApprovals.delete(input)
        const item = await store.get(input.id)
        if (item.status !== 'rejected') throw new Error('Only a rejected item can be deleted forever. Reject it first; rejecting deletes nothing.')
        if (!item.version) throw new Error('That item could not be checked, so it was kept.')
        if (input.version !== undefined && input.version !== item.version) throw new Error('That item changed since it was shown, so it was kept.')
        deleteApprovals.set(input, { id: item.id, version: item.version })
        return `Delete forever: “${item.title}” from ${item.origin.path} (${item.id}). The item is rejected; its source document is not touched. This cannot be undone.`
      },
      touchedPaths: () => [],
      run: async (_ctx, input: { id: string; version?: string }) => {
        try {
          const approval = deleteApprovals.get(input)
          deleteApprovals.delete(input)
          if (!approval || approval.id !== input.id) return fail('Preview the item for approval before deleting it. Nothing was deleted.')
          const item = await store.get(input.id)
          await store.deleteRejected(input.id, approval.version)
          return {
            text: `Deleted “${item.title}” (${item.id}) from the Scratchpad forever. Its source document ${item.origin.path} was not touched.`,
            details: { deleted: item.id, title: item.title, origin: item.origin.path, source: item.source },
          }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    {
      id: 'scratchpad.inventory', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'read document inventory',
      describe: 'Read pictures, SVG, tables, widgets and cited references at exact source positions. A cited reference carries its canonical citation id, how many times it is cited and every citation\'s range. Live owners take precedence over disk. Every span says live or disk; without the running app only disk is available. No writes or saves.',
      parameters: Type.Object({ path: Type.String(), scope: Type.Optional(Type.Union([Type.Literal('part'), Type.Literal('folio')])) }),
      run: async (_ctx, input: { path: string; scope?: 'part' | 'folio' }) => {
        try {
          const inventory = await readScratchInventory(workspace, { activePath: visiblePath(workspace, input.path, { markdown: true }), scope: input.scope ?? 'part' })
          return { text: JSON.stringify(inventory, null, 2), details: inventory }
        } catch (error) { return fail((error as Error).message) }
      },
    },
  ]
}
