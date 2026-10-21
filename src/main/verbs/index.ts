import { realpathSync } from 'node:fs'
import { posix, sep } from 'node:path'
import { Type } from 'typebox'
import type { Capability, CapabilityContext } from '@bridle/core'
import { ChangedSinceRead, DocumentChangedError, normaliseMarkdownPath, SavedButNotReadBack, Workspace, type FileReadResult, type SaveFileOptions } from '../workspace'
import { fingerprintOfRead } from '../guarded-document-read'
import { FOLIO_BACKUP_NAME, FOLIO_OWNERSHIP_NAME, MANIFEST_NAME, assertManifestAbsent, draftManifest } from '../folio'
import { TURN_BACK_DESCRIPTION, recordFolioInstructionOwnership, turnBackIntoCollection } from '../folio-conversion'
import { writeFolioAgentInstructions } from '../folio-agent-instructions'
import { AGENTS_FILE, CLAUDE_FILE } from '../../shared/folio-agent-files'
import { scrapsPathFor } from '../scraps'
import { prepareOffcutPromotion, writeMaterial } from '../board-material'
import { prepareSourceAttach } from '../source-attach'
import { describeListing, readPieceSources } from '../piece-sources'
import { compareParts, readPlanForAgent } from '../plan-agent-reads'
import { prepareProposal, runPlanOperations } from '../plan-proposal'
import { createAgentNote, createFileNoteRefusal, planAgentNotePath, NOTES_CREATE, type AgentNoteInput } from '../agent-note-create'
import { objectBlock, validateObjectMarkup } from '../../shared/object-markup'
import { formatRenameRepairMessage } from '../../shared/rename-repair-message'
import { applyRenameRepair, failedRenameRepairResult, type RenameRepairResult } from '../rename-repair'
import { AGENT_NOTE_DIR as NOTE_FOLDER } from '../agent-note-create'
import { listWidgetsInFile } from '../widgets'
import { resolveWidgetFileForInsert } from '../widget-insert'
import { planWidgetCreate, undoWidgetFile, writeWidgetFile, WIDGET_WRITE_SWITCHED_OFF, type CreatedWidgetFile } from '../widget-create'
import { insertWidgetInText, relativeEmbedPath, removeWidgetInText } from '../../shared/widget-insert'
import { captureInWorkspace, type WorkspaceCaptureInput } from '../research-capture'
import { CAPTURE_KINDS } from '../../shared/research-capture'
import { listTasksInFile, taskOnLine, toggleTaskInFile } from '../tasks'
import {
  renameStructuralPaths, prepareRename, assertSamePathSet, assertPathSubset, frontmatterSplit,
  normaliseExistingFrontmatter, ok, fail, resolveProseMove, resolveProseInsert, setFrontmatterKeys,
  type CapabilityServices, type ProseEditInput, type ProseMoveInput, type ProseInsertInput,
  type ObjectInsertInput, type CreateFileInput, type RenameFileInput, type FolioManifestInput,
  type FrontmatterNormaliseInput, type FrontmatterSetInput, type ScrapAddInput,
  type PlanReadInput, type PlanCompareInput, type PlanProposeInput,
  type TasksListInput, type TasksToggleInput, type WidgetsListInput, type WidgetsInsertInput, type WidgetsRemoveInput, type WidgetsCreateInput, type ScrapPromoteInput, type SourceAttachInput, type SourceListInput,
} from './verb-support'

export type Verb = Omit<Capability, 'name' | 'description' | 'execute'> & {
  id: string
  class: 'content' | 'view' | 'settings'
  posture: 'direct' | 'proposal' | 'approval'
  describe: string
  agentOnly?: true
  run: (ctx: CapabilityContext, input: Parameters<Capability['execute']>[0]) => ReturnType<Capability['execute']>
}

/** What a save is told so that it refuses, writing nothing, when the document no longer holds the bytes `source` read. */
const unchangedSince = (source: FileReadResult): SaveFileOptions => ({ expect: { fingerprint: fingerprintOfRead(source) } })


// Read/beyond-parity verbs have no exact UI command. Existing proposal floors also preserve
// frontmatter staging; correcting metadata posture is outside this behaviour-preserving ticket.
export function buildVerbTable(
  workspace: Workspace,
  services?: CapabilityServices,
  /** The live permission switches (the policy's own filter). A verb that writes a file reads it again at the write. */
  permitted?: (name: string) => boolean,
): Verb[] {
  /** The document text with the proposed embed line in it; throws the refusal's sentence (outside the Workspace, not HTML, no such widget). */
  const widgetInsertText = async (input: WidgetsInsertInput): Promise<{ read: string; next: string }> => {
    const resolved = await resolveWidgetFileForInsert(workspace.root, input.file)
    if (!resolved.ok) throw new Error(resolved.message)
    const source = await workspace.readFile(input.path)
    return { read: source.content, next: insertWidgetInText(source.content, relativeEmbedPath(source.file.path, resolved.relativePath), input.position ?? 'end') }
  }
  /** A refusal's sentence without the machine's folder names in it: fs errors quote absolute paths, and this text goes to the agent. */
  const plainMessage = (error: unknown): string => {
    const text = error instanceof Error ? error.message : String(error)
    let realRoot = workspace.root
    try { realRoot = realpathSync(workspace.root) } catch { /* the lexical root is still stripped */ }
    return [realRoot, workspace.root].reduce((message, root) => message.split(`${root}${sep}`).join('').split(root).join('the Workspace'), text)
  }
  const verbs: Verb[] = [
    {
      id: 'files.list', class: 'content', posture: 'direct', agentOnly: true, label: 'list files', risk: 'read',
      describe: 'List every Markdown file in the Workspace (relative paths).',
      parameters: Type.Object({}),
      run: async () => {
        const files = await workspace.listFiles()
        return { text: JSON.stringify(files.map((f) => f.path), null, 2), details: { files } }
      }
    },
    {
      id: 'files.read', class: 'content', posture: 'direct', agentOnly: true, label: 'read file', risk: 'read',
      describe: 'Read a Markdown file from the Workspace, including reference material the writer keeps under research/ (the Sources pane) — read it there for context before drafting.',
      parameters: Type.Object({ path: Type.String({ description: 'Relative Markdown file path' }) }),
      run: async (_ctx, input: { path: string }) => {
        const file = await workspace.readFile(input.path)
        services?.onFileRead?.(workspace.absolute(input.path))
        return { text: file.content, details: { file } }
      }
    },
    {
      id: 'plan.read', class: 'content', posture: 'direct', agentOnly: true, label: 'read report plan', risk: 'read',
      describe: 'Read a report folder\'s plan: its running order (each part\'s title, gloss, role, workspace-relative file or null for an unwritten part, word count, and whether the file exists), the Markdown files under the Folio\'s content_root that are NOT in the running order (strays), and whether the folder has an Index Note. Reads only; start any work on a report as a whole here.',
      parameters: Type.Object({ dir: Type.String({ description: 'Workspace-relative report folder ("" for the Workspace root)' }) }),
      run: async (_ctx, input: PlanReadInput) => {
        try {
          const readout = await readPlanForAgent(workspace, input.dir)
          return { text: JSON.stringify(readout, null, 2), details: { plan: readout } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'plan.compare_parts', class: 'content', posture: 'direct', agentOnly: true, label: 'compare two parts', risk: 'read',
      describe: 'Compare two near-identical Markdown files in a report folder — typically a sync conflict copy such as `00_intro-Studio Mac.md` beside `00_intro.md`. Returns their similarity, both word counts and modification times, which side is larger, and the passages (blocks: every typed line is its own passage) that only ONE side has, in document order, each marked with the side (a or b) that has it. Reads only; say what only the copy has before proposing anything.',
      parameters: Type.Object({
        dir: Type.String({ description: 'Workspace-relative report folder ("" for the Workspace root)' }),
        a: Type.String({ description: 'Workspace-relative path of the first file, inside dir' }),
        b: Type.String({ description: 'Workspace-relative path of the second file, inside dir' }),
      }),
      run: async (_ctx, input: PlanCompareInput) => {
        try {
          const comparison = await compareParts(workspace, input.dir, input.a, input.b)
          return { text: JSON.stringify(comparison, null, 2), details: { comparison } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'plan.propose', class: 'content', posture: 'proposal', agentOnly: true, label: 'propose running order', risk: 'write',
      describe: 'Propose changes to a report folder\'s running order as ONE proposal the writer accepts, edits or discards. Nothing is written when you call this: the writer sees the proposed order with each change marked, and Accept applies every change as one undoable step. There is no other way to change a running order. Name parts by their running-order title (as plan.read gives it). Changes apply in the order listed; `at` and `to` are 0-based places in the order as it stands at that point. insert: add a part (an unwritten one, or a file in the folder by its title). move: put a part at place `to`. remove: take a part out of the order (its file stays; nothing is deleted). adopt: add a stray file (by path, from plan.read\'s strays). materialise: write an unwritten part out into a new file. setRole: set a part\'s role (section, vignette, appendix, summary or front-matter). Front matter (a title page, a preface) exports before the contents page, is never listed in it and always comes first: a part joins or leaves it by its role, never by a move. If the folder has no Index Note, accepting creates it first. Call plan.read first.',
      parameters: Type.Object({
        dir: Type.String({ description: 'Workspace-relative report folder ("" for the Workspace root)' }),
        changes: Type.Array(Type.Union([
          Type.Object({ op: Type.Literal('insert'), title: Type.String(), at: Type.Optional(Type.Integer({ minimum: 0 })), gloss: Type.Optional(Type.String()), role: Type.Optional(Type.String()) }),
          Type.Object({ op: Type.Literal('move'), title: Type.String(), to: Type.Integer({ minimum: 0 }) }),
          Type.Object({ op: Type.Literal('remove'), title: Type.String() }),
          Type.Object({ op: Type.Literal('adopt'), path: Type.String({ description: 'Workspace-relative path of a stray file in the folder' }), at: Type.Optional(Type.Integer({ minimum: 0 })), role: Type.Optional(Type.String()) }),
          Type.Object({ op: Type.Literal('materialise'), title: Type.String() }),
          Type.Object({ op: Type.Literal('setRole'), title: Type.String(), role: Type.String() }),
        ]), { minItems: 1, description: 'The changes, applied in order' }),
        summary: Type.Optional(Type.String({ description: 'One or two sentences the card shows under the order: why this order' })),
      }),
      preview: (input: PlanProposeInput) => `Running-order proposal for ${input.dir || 'the Workspace root'} — ${input.changes?.length ?? 0} ${input.changes?.length === 1 ? 'change' : 'changes'}`,
      validateStage: async (input: PlanProposeInput) => {
        try {
          await prepareProposal(workspace, input)
          return { decision: 'pass' as const }
        } catch (error) {
          return { decision: 'deny' as const, reason: { code: 'writeflex-plan-proposal', message: error instanceof Error ? error.message : String(error) } }
        }
      },
      // Total by contract (see objects.insert): the files Accept may write, Index Note first so a new
      // proposal for the same folder supersedes the pending one.
      touchedPaths: async (input: PlanProposeInput) => {
        try {
          return (await prepareProposal(workspace, input)).writes.map((path) => workspace.absolute(path))
        } catch {
          return []
        }
      },
      // The Agent pane accepts through PlanProposalDesk (one restore point, guarded undo). A plain
      // Bridle adoption still runs the same Plan operations under Bridle's own snapshot.
      run: async (_ctx, input: PlanProposeInput) => {
        try {
          const prepared = await prepareProposal(workspace, input)
          const result = await runPlanOperations(workspace, prepared.basis.dir, prepared.ops)
          services?.notifyFilesChangedOnDisk?.([...prepared.writes, ...result.created])
          return { text: `Running order set · ${prepared.proposed.count} ${prepared.proposed.count === 1 ? 'change' : 'changes'}.`, details: { plan: result.plan } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'prose.edit', class: 'content', posture: 'proposal', agentOnly: true, label: 'propose prose edit', risk: 'write',
      describe: 'Propose ONE contiguous prose edit to an existing file as an exact text replacement. Staged for the writer to accept or reject. Each prose.edit must change at most ONE sentence or a short phrase — its oldText should not span more than one sentence. Rewriting a paragraph is therefore SEVERAL prose.edit calls, one per sentence you actually change, leaving the sentences you do not touch out of the edits entirely. A copy-edit pass is dozens of these small edits — a typo here, a wording tweak there — NEVER one big replacement, and NEVER the whole document or a whole section as a single edit. The writer accepts or rejects each one on its own, so keep them small and independent.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path to edit' }),
        oldText: Type.String({ description: 'Exact current text to replace; must be unique in the file' }),
        newText: Type.String({ description: 'Replacement text' }),
        category: Type.Union([
          Type.Literal('typo'),
          Type.Literal('grammar'),
          Type.Literal('wording'),
          Type.Literal('structure'),
          Type.Literal('clarity'),
          Type.Literal('tone'),
          Type.Literal('other'),
        ], {
          description: 'Writer-facing edit category assigned by the agent; use `other` only when none of the specific categories fit.'
        }),
        summary: Type.String({ description: 'One short sentence describing the edit' })
      }),
      preview: (input: ProseEditInput) =>
        [`${input.category} edit — ${input.summary}`, '--- current', input.oldText, '+++ proposed', input.newText].join('\n'),
      touchedPaths: (input: ProseEditInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: ProseEditInput) => {
        if (!input.oldText) return fail('oldText must not be empty; provide the exact current text to replace.')
        const source = await workspace.readFile(input.path)
        const first = source.content.indexOf(input.oldText)
        if (first === -1) return fail(`oldText was not found in ${input.path}; re-read the file and retry with the exact current text.`)
        if (source.content.indexOf(input.oldText, first + input.oldText.length) !== -1) {
          return fail(`oldText is not unique in ${input.path}; include more surrounding context.`)
        }
        const next = source.content.slice(0, first) + input.newText + source.content.slice(first + input.oldText.length)
        // Only over the text read above (final review round 1, finding 1): another version there is not
        // replaced, by the basis check and the guarded write's content check alike.
        try {
          const saved = await workspace.saveFileOverRead(input.path, next, source.content, unchangedSince(source))
          return ok(`Applied ${input.category} edit to ${input.path}: ${input.summary}`, saved)
        } catch (error) {
          // The document changed between the read above and the save: nothing was written.
          if (error instanceof ChangedSinceRead || error instanceof DocumentChangedError) return fail(error.message)
          throw error
        }
      }
    },
    {
      id: 'prose.move', class: 'content', posture: 'proposal', agentOnly: true, label: 'propose prose move', risk: 'write',
      describe: 'Propose ONE contiguous prose move inside an existing Markdown file. Use this when text should be relocated rather than rewritten: it stages as a single move Change, never as delete plus insert. `text` is the exact unique block to relocate; `insertAfter` is the exact unique destination anchor that the block should land after, and it must not overlap the moved text.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path to edit' }),
        text: Type.String({ description: 'Exact current block to relocate; must be unique in the file' }),
        insertAfter: Type.String({ description: 'Exact unique destination anchor; the moved block lands after this text' }),
        summary: Type.String({ description: 'One short sentence describing the move' })
      }),
      preview: (input: ProseMoveInput) =>
        [`structure move — ${input.summary}`, '--- move', input.text, '+++ after', input.insertAfter].join('\n'),
      touchedPaths: (input: ProseMoveInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: ProseMoveInput) => {
        const source = await workspace.readFile(input.path)
        try {
          const resolved = resolveProseMove(source.content, input)
          const saved = await workspace.saveFileOverRead(input.path, resolved.nextContent, source.content, unchangedSince(source))
          return ok(`Applied structure move to ${input.path}: ${input.summary}`, saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'prose.insert', class: 'content', posture: 'proposal', agentOnly: true, label: 'propose prose insertion', risk: 'write',
      describe: 'Propose NEW prose to ADD to an existing file — content that does not replace anything. This is the ONLY way to add text: use it to write into an empty or near-empty document, to add a paragraph, or to place a passage at a specific point. prose.edit REPLACES existing unique text and cannot express an insertion, so never fabricate an oldText just to add content — use prose.insert. `text` is the new prose; `insertAfter` is the exact unique existing text the new content should follow, or an EMPTY string to append at the end of the document (an empty string is also how you fill a blank file). Staged for the writer to accept or reject, and shown inline in the document as pending inserted text.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path to insert into' }),
        insertAfter: Type.String({ description: 'Exact unique existing text the new content should follow; use an empty string to append at the end of the document (and to fill an empty file)' }),
        text: Type.String({ description: 'The new prose to insert' }),
        category: Type.Union([
          Type.Literal('typo'),
          Type.Literal('grammar'),
          Type.Literal('wording'),
          Type.Literal('structure'),
          Type.Literal('clarity'),
          Type.Literal('tone'),
          Type.Literal('other'),
        ], {
          description: 'Writer-facing edit category assigned by the agent; use `other` only when none of the specific categories fit.'
        }),
        summary: Type.String({ description: 'One short sentence describing the insertion' })
      }),
      preview: (input: ProseInsertInput) =>
        [`${input.category} insertion — ${input.summary}`, input.insertAfter ? '+++ after' : '+++ at end of document', input.insertAfter, '+++ text', input.text].filter(Boolean).join('\n'),
      touchedPaths: (input: ProseInsertInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: ProseInsertInput) => {
        if (!input.text) return fail('text must not be empty; provide the content to insert.')
        const source = await workspace.readFile(input.path)
        try {
          const resolved = resolveProseInsert(source.content, input)
          const saved = await workspace.saveFileOverRead(input.path, resolved.nextContent, source.content, unchangedSince(source))
          return ok(`Inserted ${input.category} content in ${input.path}: ${input.summary}`, saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'objects.insert', class: 'content', posture: 'proposal', label: 'propose object insertion', risk: 'write',
      describe: 'Propose a validated Markdown object, staged for review; prefer objects.insert over prose.insert for tables, diagrams, mind maps, and SVG illustrations. Supply INNER markup only; this capability owns fences. table: `| A | B |\\n| --- | --- |\\n| 1 | 2 |`. mermaid: `flowchart LR\\n  A --> B`. markmap: `- Root\\n  - Child`. SVG: `<svg viewBox="0 0 10 10"><rect/></svg>`. SVG is untrusted and is sanitised before every render.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path to insert into' }),
        kind: Type.Union([Type.Literal('table'), Type.Literal('mermaid'), Type.Literal('markmap'), Type.Literal('svg')]),
        content: Type.String({ description: 'Inner object markup only, without fences' }),
        insertAfter: Type.Optional(Type.String({ description: 'Exact unique existing text to follow; omit or use an empty string to append' })),
        summary: Type.Optional(Type.String({ description: 'One short sentence describing the object' })),
      }),
      preview: (input: ObjectInsertInput) => {
        validateObjectMarkup(input.kind, input.content)
        return [`${input.kind} object — ${input.summary ?? 'Insert object'}`, objectBlock(input.kind, input.content)].join('\n')
      },
      // Stage-time veto lives in writeflexApprovalPolicy. `touchedPaths` must remain total: both Bridle's
      // Proposal baseline and its scripted/live relay call it after a policy decision, and a throw here
      // escalates a correctable tool-input error into a failed whole turn.
      touchedPaths: (input: ObjectInsertInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: ObjectInsertInput) => {
        try {
          validateObjectMarkup(input.kind, input.content)
          const source = await workspace.readFile(input.path)
          const resolved = resolveProseInsert(source.content, {
            path: input.path, insertAfter: input.insertAfter ?? '', text: objectBlock(input.kind, input.content), category: 'other', summary: input.summary ?? 'Insert object',
          })
          const saved = await workspace.saveFileOverRead(input.path, resolved.nextContent, source.content, unchangedSince(source))
          return ok(`Inserted ${input.kind} object in ${input.path}: ${input.summary ?? 'Object added.'}`, saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      id: 'housekeeping.create_file', class: 'content', posture: 'direct', label: 'create file', risk: 'write',
      describe: 'Create a NEW Markdown file with complete content. Fails if the file already exists — never use this to overwrite.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path for the new file, usually ending in .md' }),
        content: Type.String({ description: 'Complete Markdown content' })
      }),
      preview: (input: CreateFileInput) => `Create ${normaliseMarkdownPath(input.path)} (${input.content.length} chars)`,
      touchedPaths: (input: CreateFileInput) => [workspace.absolute(normaliseMarkdownPath(input.path))],
      run: async (_ctx, input: CreateFileInput) => {
        try {
          // Agent notes about a document never land beside it under a model-chosen name (2026-09-12).
          const refusal = createFileNoteRefusal(input.path)
          if (refusal) return fail(refusal)
          const created = await workspace.createFile(input.path, input.content)
          return ok(`Created ${created.file.path}.`, created)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: NOTES_CREATE, class: 'content', posture: 'direct', agentOnly: true, label: 'create agent note', risk: 'write',
      describe: 'Write a note ABOUT a Workspace document — a review, comments, feedback — as a new file the app files under agent-notes/ beside that document, with frontmatter marking it agent-authored (author, kind, source document, skill). You never choose the path: give the document, a short kind and the note body. Never use housekeeping.create_file for notes about a document.',
      parameters: Type.Object({
        sourceDocument: Type.String({ description: 'Relative path of the Workspace document the note is about' }),
        kind: Type.Optional(Type.String({ description: 'Short kind of note, e.g. review, comments, feedback (default notes)' })),
        title: Type.Optional(Type.String({ description: 'Note title; defaults to “<Kind> of <document>”' })),
        body: Type.String({ description: 'The note as Markdown' }),
      }),
      preview: (input: AgentNoteInput) => `Agent note (${input.kind ?? 'notes'}) about ${input.sourceDocument} (${input.body?.length ?? 0} chars)`,
      touchedPaths: (input: AgentNoteInput) => [workspace.absolute(planAgentNotePath(workspace, input))],
      run: async (ctx, input: AgentNoteInput) => {
        try {
          const declared = ctx.resolvedTouchedPaths?.length === 1 ? workspace.relative(ctx.resolvedTouchedPaths[0]) : undefined
          const created = await createAgentNote(workspace, input, { skill: services?.activeSkillName, path: declared })
          services?.onAgentNotesChanged?.(created.file.path)
          return ok(`Left an agent note at ${created.file.path}.`, created)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    // Checkbox items (docs/design/2026-09-27-checkbox-lists, frame 10). Reading is direct; a tick is a
    // proposal at every trust level (content-verb law): the agent never ticks a box on its own.
    {
      id: 'tasks.list', class: 'content', posture: 'direct', agentOnly: true, label: 'list checkbox items', risk: 'read',
      describe: 'List the checkbox items of a piece or an agent note — list items written `- [ ]` or `1. [ ]`, ticked ones `[x]` — as the open items and the done items, each with its 1-based line and its words. Use it to answer "what\'s left?": for an agent review, read the review\'s own note under agent-notes/ (the writer ticks points there as they deal with them). Reads only.',
      parameters: Type.Object({ path: Type.String({ description: 'Relative Markdown file path (a piece, or a note under agent-notes/)' }) }),
      run: async (_ctx, input: TasksListInput) => {
        try {
          const listing = await listTasksInFile(workspace, input.path)
          services?.onFileRead?.(workspace.absolute(listing.path))
          return { text: JSON.stringify(listing, null, 2), details: { tasks: listing } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    // Embed lines (interactive-widgets-in-documents, ticket 01): a read. Opening or listing writes nothing.
    {
      id: 'widgets.list', class: 'content', posture: 'direct', agentOnly: true, label: 'list widgets', risk: 'read',
      describe: 'List the interactive widgets a document embeds — lines written alone as `[Simulation: file.html]` — each with its 1-based ordinal in the document, its source line, the path as typed, and whether it resolves: ok with the file\'s workspace-relative path, or refused as missing, outside-workspace, not-html or web-address (`[Embed: …]` lines are web addresses and are not supported). Reads only.',
      parameters: Type.Object({ path: Type.String({ description: 'Relative Markdown file path' }) }),
      run: async (_ctx, input: WidgetsListInput) => {
        try {
          const listing = await listWidgetsInFile(workspace, input.path)
          services?.onFileRead?.(workspace.absolute(listing.path))
          return { text: JSON.stringify(listing, null, 2), details: { widgets: listing } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    // Embed lines, ticket 05: proposals. Each changes ONE line of the document; the widget file is never touched.
    {
      id: 'widgets.insert', class: 'content', posture: 'proposal', label: 'propose inserting a widget', risk: 'write',
      describe: 'Propose adding an interactive widget to a document: one line, `[Simulation: <path from the document\'s folder>]`, on its own with blank lines around it. `file` is the workspace-relative path of an HTML file inside the open Workspace (a refusal otherwise; web addresses are refused). `position` is "start" (after any frontmatter), "end" (the default), or the 1-based ordinal of an existing widget (from widgets.list) to place it directly after. Nothing is written when you call this: the writer sees the proposal and accepts or discards it. The HTML file is never created or changed.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path to insert into' }),
        file: Type.String({ description: 'Workspace-relative path of the HTML file to embed' }),
        position: Type.Optional(Type.Union([Type.Literal('start'), Type.Literal('end'), Type.Integer({ minimum: 1 })], { description: '"start", "end" (default), or the ordinal of the widget to follow' })),
      }),
      preview: async (input: WidgetsInsertInput) => `Insert a widget — ${input.file} into ${input.path} (${input.position === undefined ? 'end' : typeof input.position === 'number' ? `after widget ${input.position}` : input.position})`,
      validateStage: async (input: WidgetsInsertInput) => {
        try {
          await widgetInsertText(input)
          return { decision: 'pass' as const }
        } catch (error) {
          return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: error instanceof Error ? error.message : String(error) } }
        }
      },
      touchedPaths: (input: WidgetsInsertInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: WidgetsInsertInput) => {
        try {
          const { read, next } = await widgetInsertText(input)
          const saved = await workspace.saveFileOverRead(input.path, next, read)
          return ok(`Inserted a widget (${input.file}) in ${input.path}.`, saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'widgets.create', class: 'content', posture: 'proposal', agentOnly: true, label: 'propose making a widget', risk: 'write',
      describe: 'Propose a NEW interactive widget: you write one self-contained HTML page, WriteFlex saves it as a file in the assets/ folder beside the document (a free name, never overwriting) and puts its embed line `[Simulation: assets/<file>]` into the document, as one proposal the writer accepts or discards; the writer is shown the new file\'s path and its full source before deciding, and discarding writes nothing. `html` is a complete page with inline CSS and JS and a <title>. A widget runs in a sealed frame with no network and no other files, so write it to need neither (no http(s):, //host, fetch, XMLHttpRequest, WebSocket, import, external scripts, fonts or images; data: and blob: only). A page that obviously reaches for the network is refused straight away with the reason; that check is a convenience and catches only the obvious cases, and a page that slips past it still gets no network and will simply not work. Keep it compact: the block sizes to its content. `path` is a Markdown document in the Workspace; `fileName` is a plain name ending .html (it is cleaned up); `title` is the caption and is added if the page has no <title>; `position` is "start", "end" (default) or the ordinal of an existing widget to follow. Use this when asked for a calculator, chart, simulation or any interactive thing in a document. To embed an HTML file that already exists use widgets.insert.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path of the document that gets the widget' }),
        fileName: Type.String({ description: 'File name for the widget, ending .html (saved in assets/ beside the document)' }),
        html: Type.String({ description: 'The complete self-contained HTML page' }),
        title: Type.String({ description: 'Short title; the caption shown under the widget' }),
        position: Type.Optional(Type.Union([Type.Literal('start'), Type.Literal('end'), Type.Integer({ minimum: 1 })], { description: '"start", "end" (default), or the ordinal of the widget to follow' })),
      }),
      preview: async (input: WidgetsCreateInput) => `Make a widget — ${input.title} (${input.fileName}) in ${input.path}`,
      validateStage: async (input: WidgetsCreateInput) => {
        try {
          await planWidgetCreate(workspace, input)
          return { decision: 'pass' as const }
        } catch (error) {
          return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: plainMessage(error) } }
        }
      },
      touchedPaths: async (input: WidgetsCreateInput) => {
        const plan = await planWidgetCreate(workspace, input)
        return [workspace.absolute(plan.documentPath), workspace.absolute(plan.path)]
      },
      // Runs only when the writer accepts the staged proposal (the policy stages this verb on every route).
      run: async (ctx, input: WidgetsCreateInput) => {
        const allowed = (): boolean => permitted === undefined || permitted('widgets.create')
        let created: CreatedWidgetFile | null = null
        try {
          if (!allowed()) return fail(WIDGET_WRITE_SWITCHED_OFF)
          // The executor's frozen declaration names the file; write exactly that or nothing.
          const document = workspace.absolute(input.path)
          const declared = ctx.resolvedTouchedPaths?.filter((path) => path !== document).map((path) => workspace.relative(path))
          if (declared && declared.length > 1) return fail('The proposal names more than one new file; nothing was written.')
          const planned = await planWidgetCreate(workspace, input, declared?.[0])
          // What is written must be what the writer was shown IN THE CHANGE BEING ACCEPTED: this file, this path,
          // these bytes. The service answers for that one Change only; outside an accept it answers no.
          const shown = await services?.widgetFileShown?.({ documentPath: planned.documentPath, path: planned.path, sha256: planned.sha256 })
          if (shown !== true) {
            return fail(`The widget file ${planned.path} was not shown for review in this form (its path or content differs from the proposal being accepted, or the proposal is gone), so nothing was written. Ask for the widget again.`)
          }
          // The permission is read inside writeWidgetFile, in the same tick as the file is created.
          const written = await writeWidgetFile(workspace.root, planned.documentPath, planned.path, planned.html, planned.sha256, allowed)
          if (!written.ok) return fail(written.message)
          created = written.created
          let saved: FileReadResult
          try {
            // Read again, synchronously, immediately before the document save is started; no await in between.
            // A switch turned off after the save has started does not undo it.
            const refuseIfOff = (): void => { if (!allowed()) throw new Error(WIDGET_WRITE_SWITCHED_OFF.replace(', so nothing was written.', '')) }
            refuseIfOff()
            // And once more at the document's commit point: in the tick of the rename that makes the save real.
            // Off there, the temp file is dropped, the document is untouched, and the widget file is taken back
            // out below. A switch turned off before a file's commit syscall stops that commit; nothing after the
            // commit is undone.
            // Only over the document as the plan read it (final review round 1, finding 1).
            saved = await workspace.saveFileOverRead(planned.documentPath, planned.nextDocument, planned.currentDocument, { beforeCommit: refuseIfOff })
          } catch (error) {
            if (!(error instanceof SavedButNotReadBack)) throw error
            // The document was written and now refers to the widget: both stay. Only the read-back failed.
            created = null
            const notice = `Made the widget ${planned.path} and added its line to ${planned.documentPath}. Both were written and kept; the document could not be read back afterwards (${error.reason}), so reopen it to see the change.`
            services?.acceptNotice?.(notice)
            return { text: notice }
          }
          return ok(`Made the widget ${planned.path} and added it to ${planned.documentPath}.`, saved)
        } catch (error) {
          const reason = plainMessage(error).replace(/[.\s]+$/, '')
          if (!created) return fail(`${reason}.`)
          // The document was not written: take the widget file back out, and say so if that fails.
          const undone = await undoWidgetFile(workspace.root, created).catch((undoError: unknown) => ({ removed: false as const, reason: plainMessage(undoError) }))
          return fail(undone.removed
            ? `${reason}. The document was not changed, and the new widget file ${created.path} was removed again.`
            : `${reason}. The document was not changed, but the new widget file ${created.path} could not be removed (${undone.reason}). It is still in the Workspace with no line pointing to it; delete it by hand.`)
        }
      }
    },
    {
      id: 'widgets.remove', class: 'content', posture: 'proposal', agentOnly: true, label: 'propose removing a widget', risk: 'write',
      describe: 'Propose removing one widget line from a document, by its 1-based ordinal from widgets.list. Only the embed line goes; the HTML file stays. Nothing is written when you call this: the writer accepts or discards the proposal.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path' }),
        ordinal: Type.Integer({ minimum: 1, description: 'The widget\'s ordinal, as widgets.list gives it' }),
      }),
      preview: async (input: WidgetsRemoveInput) => `Remove widget ${input.ordinal} from ${input.path}`,
      validateStage: async (input: WidgetsRemoveInput) => {
        try {
          removeWidgetInText((await workspace.readFile(input.path)).content, input.ordinal)
          return { decision: 'pass' as const }
        } catch (error) {
          return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: error instanceof Error ? error.message : String(error) } }
        }
      },
      touchedPaths: (input: WidgetsRemoveInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: WidgetsRemoveInput) => {
        try {
          const read = (await workspace.readFile(input.path)).content
          const next = removeWidgetInText(read, input.ordinal)
          const saved = await workspace.saveFileOverRead(input.path, next, read)
          return ok(`Removed widget ${input.ordinal} from ${input.path}.`, saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'tasks.toggle', class: 'content', posture: 'proposal', label: 'propose ticking a checkbox', risk: 'write',
      describe: 'Propose ticking — or unticking — ONE checkbox item in a piece or an agent note, by its 1-based line from tasks.list. Nothing is written when you call this: the writer sees the proposal and accepts or discards it; you never tick a box yourself. One call per box; say in your reply which boxes you proposed and why.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path holding the box' }),
        line: Type.Integer({ minimum: 1, description: 'The 1-based line of the box, as tasks.list gives it' }),
      }),
      preview: async (input: TasksToggleInput) => {
        try {
          const item = await taskOnLine(workspace, input.path, input.line)
          return `${item.checked ? 'Untick' : 'Tick'} “${item.text}” — ${input.path}, line ${input.line}`
        } catch {
          return `Toggle the checkbox on line ${input.line} of ${input.path}`
        }
      },
      validateStage: async (input: TasksToggleInput) => {
        try {
          await taskOnLine(workspace, input.path, input.line)
          return { decision: 'pass' as const }
        } catch (error) {
          return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: error instanceof Error ? error.message : String(error) } }
        }
      },
      touchedPaths: (input: TasksToggleInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: TasksToggleInput) => {
        try {
          const toggled = await toggleTaskInFile(workspace, input.path, input.line)
          const path = toggled.saved.file.path
          services?.notifyFilesChangedOnDisk?.([path])
          if (posix.basename(posix.dirname(path)) === NOTE_FOLDER) services?.onAgentNotesChanged?.(path)
          return ok(`${toggled.checked ? 'Ticked' : 'Unticked'} “${toggled.text}” in ${path}.`, toggled.saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'housekeeping.rename_file', class: 'content', posture: 'direct', label: 'rename file', risk: 'write',
      describe: 'Rename or move a Markdown file inside the Workspace.',
      parameters: Type.Object({
        path: Type.String({ description: 'Current relative path' }),
        newPath: Type.String({ description: 'New relative path or bare name (stays in the same folder)' })
      }),
      preview: (input: RenameFileInput) => `Rename ${input.path} → ${input.newPath}`,
      touchedPaths: async (input: RenameFileInput) => {
        const { source, destination } = renameStructuralPaths(workspace, input)
        const structuralPaths = [source, destination].filter((path): path is string => Boolean(path))
        try {
          await workspace.readFile(input.path)
          return (await prepareRename(workspace, input)).touchedPaths
        } catch {
          return structuralPaths
        }
      },
      run: async (ctx, input: RenameFileInput) => {
        try {
          if (!ctx.resolvedTouchedPaths) throw new Error('Bridle did not provide resolved touched paths for housekeeping.rename_file.')
          const prepared = await prepareRename(workspace, input)
          if (prepared.plan.bystanderReferences.length) {
            return fail(
              `The rename was not made because it would change the meaning of other references: `
              + `${prepared.plan.bystanderReferences.join('; ')} The agent must propose this change for you to decide.`,
            )
          }
          assertSamePathSet(ctx.resolvedTouchedPaths, prepared.touchedPaths, 'The prepared rename')
          const renamed = await workspace.renameFile(input.path, input.newPath)
          if (renamed.file.path !== prepared.plan.toPath) {
            throw new Error(`The rename landed at ${renamed.file.path}, but the prepared destination was ${prepared.plan.toPath}.`)
          }
          // Never fails the rename: a Change left on the old path closes with its reason at accept.
          await services?.onFileRenamed?.(prepared.plan.fromPath, renamed.file.path).catch(() => {})
          let repair: RenameRepairResult
          try {
            const checkpoint = async (path: string) => services?.checkpointFile?.(path)
            repair = await applyRenameRepair(prepared.plan, workspace, {
              beforeMarkdownWrite: checkpoint,
              beforeManifestWrite: checkpoint,
            })
          } catch (error) {
            repair = await failedRenameRepairResult(prepared.plan, workspace, error)
          }
          const appliedPaths = [
            workspace.absolute(input.path),
            workspace.absolute(renamed.file.path),
            ...repair.writtenPaths.map((path) => workspace.absolute(path)),
          ]
          assertPathSubset(ctx.resolvedTouchedPaths, appliedPaths, 'The applied rename')
          if (repair.writtenPaths.length) services?.notifyFilesChangedOnDisk?.(repair.writtenPaths)
          const repaired = repair.writtenPaths.length
            ? ` and repaired ${repair.writtenPaths.length} referenced ${repair.writtenPaths.length === 1 ? 'file' : 'files'}`
            : ''
          return {
            text: formatRenameRepairMessage(`Renamed to ${renamed.file.path}${repaired}`, repair),
            details: { file: renamed, repair },
          }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'folio.create_manifest', class: 'content', posture: 'direct', agentOnly: true, label: 'create Folio manifest', risk: 'write',
      describe: `Declare a folder a Folio: create its ${MANIFEST_NAME} from the folder's numbered parts — ONLY when none exists. When .folio-backup.json exists, restore it: drop entries whose files no longer exist, append new files at the end as sections, and keep everything else byte-for-byte. Housekeeping; applies under snapshot. If a manifest already exists, this errors — edit it as a file instead.`,
      parameters: Type.Object({ dir: Type.String({ description: 'Workspace-relative folder to make a Folio ("" for the root)' }) }),
      preview: async (input: FolioManifestInput) => {
        let warning: string | undefined
        const draft = await draftManifest(workspace, input.dir, message => { warning = message })
        return `${warning ? warning + '\n\n' : ''}Create a Folio manifest in ${input.dir || 'the workspace root'}\n\n${draft}`
      },
      // The manifest and the Folio's agent instructions (ticket 0.23-08), so the turn's restore point covers the instructions and their ownership record.
      touchedPaths: (input: FolioManifestInput) => [MANIFEST_NAME, AGENTS_FILE, CLAUDE_FILE, FOLIO_OWNERSHIP_NAME].map((name) => workspace.absolute(input.dir ? posix.join(input.dir, name) : name)),
      run: async (_ctx, input: FolioManifestInput) => {
        try {
          await services?.prepareFolioInstructions?.(input.dir)
          await assertManifestAbsent(workspace, input.dir)
          const path = input.dir ? posix.join(input.dir, MANIFEST_NAME) : MANIFEST_NAME
          // saveFile writes the path VERBATIM (createFile would markdown-normalise the .json to .md).
          const saved = await workspace.saveFile(path, await draftManifest(workspace, input.dir))
          let instructions = ''
          try {
            const written = await writeFolioAgentInstructions(workspace, input.dir, services?.checkpointFile)
            await recordFolioInstructionOwnership(workspace, input.dir, written)
            if (written.length) instructions = ` Wrote the Folio's agent instructions: ${written.join(', ')}.`
          } catch (error) {
            instructions = ` The Folio's agent instructions were not written: ${error instanceof Error ? error.message : String(error)}`
          }
          return ok(`Drafted a Folio manifest at ${saved.file.path}.${instructions}`, saved)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      }
    },
    {
      id: 'folio.turn_back', class: 'content', posture: 'approval', label: 'Turn back into a collection', risk: 'write',
      describe: TURN_BACK_DESCRIPTION,
      parameters: Type.Object({ dir: Type.String() }),
      preview: async (input: FolioManifestInput) => `Turn ${input.dir || 'this Folio'} back into a collection. ${TURN_BACK_DESCRIPTION}`,
      touchedPaths: (input: FolioManifestInput) => [MANIFEST_NAME, AGENTS_FILE, CLAUDE_FILE, FOLIO_BACKUP_NAME, FOLIO_OWNERSHIP_NAME].map(name => workspace.absolute(input.dir ? posix.join(input.dir, name) : name)),
      run: async (_ctx, input: FolioManifestInput) => {
        try {
          await services?.prepareFolioInstructions?.(input.dir)
          return { text: 'Turned back into a collection.', details: { paths: await turnBackIntoCollection(workspace, input.dir, services?.trashFile) } }
        }
        catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
      },
    },
    {
      id: 'frontmatter.normalise', class: 'content', posture: 'proposal', agentOnly: true, label: 'normalise frontmatter', risk: 'write',
      describe: 'Canonicalise and reorder an EXISTING frontmatter block only; never use this to add or set metadata keys. Use frontmatter.set for metadata changes.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path with existing frontmatter' }),
      }),
      preview: (input: FrontmatterNormaliseInput) =>
        `normalise frontmatter — ${input.path}`,
      touchedPaths: (input: FrontmatterNormaliseInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: FrontmatterNormaliseInput) => {
        const source = await workspace.readFile(input.path)
        const bom = source.content.startsWith('﻿') ? '﻿' : ''
        const text = bom ? source.content.slice(1) : source.content
        const split = frontmatterSplit(text)
        if (!split) return fail(`${input.path} has no existing frontmatter block; use frontmatter.set to add metadata.`)
        try {
          const saved = await workspace.saveFileOverRead(input.path, normaliseExistingFrontmatter(source.content), source.content)
          return ok(`Normalised frontmatter on ${input.path}.`, saved)
        } catch (error) {
          if (error instanceof ChangedSinceRead) return fail(error.message)
          throw error
        }
      }
    },
    {
      id: 'frontmatter.set', class: 'content', posture: 'proposal', label: 'set frontmatter', risk: 'write',
      describe: 'Set or add document metadata (frontmatter) keys; lists as arrays. Example: { path: "draft.md", set: { status: "draft", tags: ["essay", "review"] } }. STAGED for review.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative Markdown file path' }),
        set: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())]), { description: 'Frontmatter key → scalar or list value' }),
        summary: Type.Optional(Type.String({ description: 'Short reason for the metadata change' })),
      }),
      preview: (input: FrontmatterSetInput) =>
        [`frontmatter — ${input.path}`, ...Object.entries(input.set).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`)].join('\n'),
      touchedPaths: (input: FrontmatterSetInput) => [workspace.absolute(input.path)],
      run: async (_ctx, input: FrontmatterSetInput) => {
        if (!input.set || Object.keys(input.set).length === 0) return fail('set must name at least one frontmatter key.')
        const source = await workspace.readFile(input.path)
        try {
          const saved = await workspace.saveFileOverRead(input.path, setFrontmatterKeys(source.content, input.set, input.path), source.content)
          return ok(`Set frontmatter on ${input.path}.`, saved)
        } catch (error) {
          return fail((error as Error).message)
        }
      },
    },
    // List a piece's sources (scraps ticket 04): a read. The `sources:` list merged with what the text
    // cites; "cited, not listed" ones are attached with sources.attach.
    {
      id: 'sources.list', class: 'content', posture: 'direct', label: 'list a piece\'s sources', risk: 'read',
      describe: 'List ONE piece\'s sources: its frontmatter `sources:` list merged with the sources its text cites. Each entry is marked listed, cited (with a count) or both. Wikilinks to research notes always count as citations; author–year citations ("Hall 1976", "(Bartlett, 1932)") count only when the research note carries author and year in its frontmatter, and one that fits more than one note is reported as ambiguous and not counted. The result says when author–year matching was unavailable. Reads only: to add a cited-but-unlisted source, call sources.attach.',
      parameters: Type.Object({ path: Type.String({ description: 'The piece\'s workspace-relative path' }) }),
      run: async (_ctx, input: SourceListInput) => {
        try {
          // No onFileRead: the listing is not the piece's text, so the piece does not count as read.
          const listing = await readPieceSources(workspace, { path: input.path })
          return { text: describeListing(listing), details: { sources: listing } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    },
    // Capture to research: the same main-process verb as the palette sheet and `writeflex capture`. Scout writes the
    // file (never the app); it is a NEW file in a research folder, so it is direct, and deleting it undoes it.
    {
      id: 'research.capture', class: 'content', posture: 'direct', label: 'capture to research', risk: 'write',
      describe: 'File ONE reusable unit — a table, a visualisation, a piece of evidence, a snippet, a search result or a widget description — as its own Markdown file in the research/ folder beside a Piece (or in its Folio\'s research/ folder), with its sources, and index it for search. Nothing existing is changed: it only ever makes a new file, and the writer can delete it. Give the Piece\'s path (or a folder) as `project`. Put the unit itself in `body`; list where it came from in `sources` (a scout passage id as `scout:<id>`, a URL, or `file:<path>`); never retype a search hit without its passage id.',
      parameters: Type.Object({
        project: Type.String({ description: 'Workspace-relative path of the Piece being worked on (or a folder: the Folio folder or a Folder Piece). A file is filed in its Folio\'s research/ folder, else beside it.' }),
        title: Type.String({ description: 'A short title for the unit' }),
        kind: Type.Union(CAPTURE_KINDS.map((kind) => Type.Literal(kind)), { description: 'What the unit is' }),
        prompt: Type.Optional(Type.String({ description: 'The question that produced it' })),
        sources: Type.Optional(Type.Array(Type.String(), { description: 'Provenance: `scout:<passage id>`, a URL, or `file:<path>`' })),
        artefact: Type.Optional(Type.String({ description: 'Workspace-relative path of a non-Markdown file (an HTML widget, a PNG, a CSV) to copy into research/ beside the description' })),
        body: Type.String({ description: 'The unit itself, as Markdown' }),
      }),
      // Scout names the new file, so none is known beforehand; no EXISTING file is touched, hence nothing to snapshot.
      touchedPaths: () => [],
      preview: (input: WorkspaceCaptureInput) => `Capture “${input.title}” (${input.kind}) to the research folder of ${input.project || 'the Workspace'}`,
      run: async (_ctx, input: WorkspaceCaptureInput) => {
        const result = await captureInWorkspace(workspace, input)
        if (!result.ok) return fail(result.message)
        return { text: `Captured to ${result.file}${result.indexed ? ' and indexed it for search' : ''}.`, details: { capture: result } }
      },
    },
    // Attach a source (scraps ticket 03, content-verb law): the writer's Board drag, proposed. The floor
    // is a proposal at every trust level — the agent never edits a piece's sources: list itself.
    {
      id: 'sources.attach', class: 'content', posture: 'proposal', label: 'propose attaching a source', risk: 'write',
      describe: 'Propose attaching ONE source — a Markdown note in a research/ folder of the collection — to ONE piece of that collection. Nothing is written when you call this: the writer sees the proposal and accepts or discards it. Accepting adds one line naming the note (its path from the piece\'s folder) to the piece\'s frontmatter `sources:` list, creating the key if absent; nothing else in the file changes and no file moves. A source the list already names is refused.',
      parameters: Type.Object({
        dir: Type.String({ description: 'Workspace-relative collection folder ("" for the Workspace root)' }),
        piece: Type.String({ description: 'The piece\'s workspace-relative path' }),
        source: Type.String({ description: 'The research note\'s workspace-relative path, e.g. "essays/research/hall-1976.md"' }),
      }),
      preview: (input: SourceAttachInput) => `Attach ${input.source} to the sources of ${input.piece}`,
      validateStage: async (input: SourceAttachInput) => {
        try {
          await prepareSourceAttach(workspace, input)
          return { decision: 'pass' as const }
        } catch (error) {
          return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: error instanceof Error ? error.message : String(error) } }
        }
      },
      touchedPaths: (input: SourceAttachInput) => [workspace.absolute(input.piece)],
      run: async (_ctx, input: SourceAttachInput) => {
        try {
          const plan = await prepareSourceAttach(workspace, input)
          await writeMaterial(workspace, [plan.piece])
          services?.notifyFilesChangedOnDisk?.([plan.piece.path])
          return { text: `Attached ${input.source} to the sources of ${plan.piece.path}.`, details: { piece: plan.piece.path, entry: plan.entry } }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    }
  ]
  // The scrap capabilities need the window's shared ScrapStore (agent + user writes MUST serialise
  // through one mutex); they are omitted when no store is provided (unit/e2e-double manifests).
  if (services?.scraps) {
    const scraps = services.scraps
    verbs.push(
      {
        id: 'scraps.list', class: 'content', posture: 'direct', agentOnly: true, label: 'list scraps', risk: 'read',
        describe: 'List the writer’s scraps (cuttings set aside), optionally filtered to one origin file’s scraps.',
        parameters: Type.Object({ origin: Type.Optional(Type.String({ description: 'Filter to one file’s scraps (its workspace-relative path)' })) }),
        run: async (_ctx, input: { origin?: string }) => {
          const items = await scraps.list(input.origin ? { origin: input.origin } : undefined)
          return { text: JSON.stringify(items, null, 2), details: { scraps: items } }
        }
      },
      {
        id: 'scraps.add', class: 'content', posture: 'direct', agentOnly: true, label: 'add scrap', risk: 'write',
        describe: 'File a cutting into the writer’s Scraps under an origin file. Housekeeping — applies immediately under snapshot.',
        parameters: Type.Object({
          origin: Type.String({ description: 'The origin file’s workspace-relative path' }),
          text: Type.String({ description: 'The scrap text' })
        }),
        preview: (input: ScrapAddInput) => `Add a scrap under ${input.origin}`,
        touchedPaths: (input: ScrapAddInput) => [workspace.absolute(scrapsPathFor(input.origin))],
        run: async (_ctx, input: ScrapAddInput) => {
          const scrap = await scraps.add(input.origin, input.text)
          services.onScrapsChanged?.()
          return { text: `Filed a scrap under ${input.origin}.`, details: { scrap } }
        }
      },
      // Offcut to idea (scraps ticket 02, content-verb law): the writer's Board step, proposed. The
      // floor is a proposal at every trust level — the agent never turns a scrap into an idea itself.
      {
        id: 'scraps.promote', class: 'content', posture: 'proposal', label: 'propose an idea from an offcut', risk: 'write',
        describe: 'Propose turning ONE scrap (an offcut, from scraps.list) into an idea for a collection. Nothing is written when you call this: the writer sees the proposal and accepts or discards it. Accepting adds one wikilink line, `- [[<name as a file name>]]`, under `## Ideas` in the collection\'s tracker note (its Index Note, `_<folder>_INDEX.md`, created if absent) with the scrap\'s text quoted beneath it, and removes the scrap from its scraps file. Name the idea as the piece it could become.',
        parameters: Type.Object({
          dir: Type.String({ description: 'Workspace-relative collection folder ("" for the Workspace root)' }),
          origin: Type.String({ description: 'The scrap\'s origin file, as scraps.list gives it' }),
          id: Type.String({ description: 'The scrap\'s id, as scraps.list gives it' }),
          name: Type.String({ description: 'The idea\'s name, e.g. "High and low context, everywhere"' }),
        }),
        preview: (input: ScrapPromoteInput) => `Make the idea “${input.name}” from an offcut of ${input.origin}`,
        validateStage: async (input: ScrapPromoteInput) => {
          try {
            await prepareOffcutPromotion(workspace, { dir: input.dir, scrapsPath: scrapsPathFor(input.origin), scrapId: input.id, name: input.name })
            return { decision: 'pass' as const }
          } catch (error) {
            return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: error instanceof Error ? error.message : String(error) } }
          }
        },
        touchedPaths: async (input: ScrapPromoteInput) => {
          try {
            const plan = await prepareOffcutPromotion(workspace, { dir: input.dir, scrapsPath: scrapsPathFor(input.origin), scrapId: input.id, name: input.name })
            return [plan.tracker.path, plan.scraps.path].map((path) => workspace.absolute(path))
          } catch {
            return []
          }
        },
        run: async (_ctx, input: ScrapPromoteInput) => {
          try {
            const plan = await scraps.exclusive(async () => {
              const prepared = await prepareOffcutPromotion(workspace, { dir: input.dir, scrapsPath: scrapsPathFor(input.origin), scrapId: input.id, name: input.name })
              await writeMaterial(workspace, [prepared.tracker, prepared.scraps])
              return prepared
            })
            services.onScrapsChanged?.()
            services.notifyFilesChangedOnDisk?.([plan.tracker.path, plan.scraps.path])
            return { text: `Made the idea [[${plan.target}]] in ${plan.tracker.path} and removed the scrap from ${plan.scraps.path}.`, details: { target: plan.target, tracker: plan.tracker.path } }
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error))
          }
        }
      }
    )
  }
  return verbs
}
