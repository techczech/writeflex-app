/**
 * Direct writes that make something new: a document, a folder, a copy, an agent note, a scrap, a
 * Folio manifest. Each runs with the owner lock held (write-access.ts) and writes only through the
 * WriteSession. A new file is never journalled (undo does not delete); adding a scrap to an existing
 * scraps file changes that file, so it is.
 */
import { activateFolioDeclaration } from '../folio-declaration'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, posix, relative } from 'node:path'
import { AGENT_NOTE_BASENAME, createAgentNote } from '../agent-note-create'
import { MANIFEST_NAME, assertManifestAbsent, draftManifest } from '../folio'
import { scrapAddition, scrapsPathFor } from '../scraps'
import { CREATED_BY_KEY, createdByLine, recordAgentCreatedDocument, withCreatedBy } from './agent-created-hook'
import { fingerprintOf } from '../guarded-document-read'
import { readBytes } from './guarded-fs'
import { CliError, type Operation } from './operation'
import { markdownPath, visiblePath } from './paths'
import { declaredSource } from './review-format'
import { CAPTURE_KINDS } from '../../shared/research-capture'
import { captureInWorkspace } from '../research-capture'
import { WritesPausedError } from '../collection-write-gate'
import { STDIN_ARG, applied, textArgument, writeAccess } from './write-support'

const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i

export const CREATE_OPERATIONS: Operation[] = [
  {
    name: 'create', group: 'Find and manage files', behaviour: 'direct', writes: true,
    summary: 'Create a document. Refuses a name that is taken. The document records who created it.',
    details: [
      `A document created from the command line says so in two places: one line in its own frontmatter (${CREATED_BY_KEY}: Claude Code, Codex or Outside agent, from the declared --source), and a first version in its history in WriteFlex named "Created by <the same>". Text given with a frontmatter block gains the line inside that block; text that already carries ${CREATED_BY_KEY} keeps its own value. The line is ordinary frontmatter: the writer can edit or delete it.`,
      'The record never stops the create. If the history record cannot be written, the document is created with exactly the text given (no line), and the result says the record was not written and why (result.createdBy under --json).',
    ].join('\n'),
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the new document; .md is added when missing.' },
      { name: 'content', type: 'string', description: 'The document text. Empty when omitted.' },
      { name: 'source', type: 'string', description: 'Who is creating it, recorded in the document and its history: claude-code or codex. Anything else, or nothing, is recorded as "Outside agent".' },
      STDIN_ARG,
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const path = visiblePath(ctx.workspace, markdownPath(String(args.path)), { markdown: true })
      if (AGENT_NOTE_BASENAME.test(posix.basename(path))) {
        throw new CliError(`${path} is named like an agent note about a document. Use "writeflex note <document>" instead: it files the note under agent-notes/ with its author and source recorded.`)
      }
      if (existsSync(ctx.workspace.absolute(path))) throw new CliError(`${path} already exists. Nothing was written.`)
      const given = await textArgument(ctx, args, 'content', false)
      const source = declaredSource(args.source)
      // The provenance line is in the document's first bytes; its history record follows (agent-created-hook.ts).
      const marked = withCreatedBy(given, source, path)
      await access.session.create(path, marked.content)
      const createdBy = await recordAgentCreatedDocument(access, path, given, marked, source)
      return applied(`Created ${path}\n${createdByLine(createdBy)}`, { path, createdBy })
    },
  },
  {
    name: 'create-folder', group: 'Find and manage files', behaviour: 'direct', writes: true,
    summary: 'Create a folder. A folder that is already there is left as it is.',
    args: [{ name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the folder.' }],
    run: async (ctx, args) => {
      const path = visiblePath(ctx.workspace, String(args.path))
      const absolute = ctx.workspace.absolute(path)
      const existed = existsSync(absolute)
      if (existed && !statSync(absolute).isDirectory()) throw new CliError(`${path} exists and is not a folder.`)
      await writeAccess(ctx).session.folders(path)
      return applied(existed ? `${path} is already there` : `Created folder ${path}`, { path, created: !existed })
    },
  },
  {
    name: 'duplicate', group: 'Find and manage files', behaviour: 'direct', writes: true,
    summary: 'Copy a document beside itself as "name (copy).md".',
    args: [{ name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the document to copy.' }],
    run: async (ctx, args) => {
      const path = visiblePath(ctx.workspace, String(args.path), { markdown: true })
      const bytes = await readBytes(ctx.workspace, path)
      const directory = posix.dirname(path) === '.' ? '' : `${posix.dirname(path)}/`
      const name = posix.basename(path)
      const extension = MARKDOWN_EXTENSION.exec(name)?.[0] ?? ''
      const stem = name.slice(0, name.length - extension.length)
      // The app's own naming (Workspace.duplicateFile): a copy never replaces anything.
      let copy = `${directory}${stem} (copy)${extension}`
      for (let counter = 2; existsSync(ctx.workspace.absolute(copy)); counter++) copy = `${directory}${stem} (copy)-${counter}${extension}`
      await writeAccess(ctx).session.create(copy, bytes)
      return applied(`Copied ${path} to ${copy}`, { path: copy, from: path })
    },
  },
  {
    name: 'note', group: 'Work with the agent', behaviour: 'direct', writes: true,
    summary: 'Add an agent note about a document, filed under agent-notes/ beside it.',
    args: [
      { name: 'document', type: 'string', required: true, positional: true, description: 'Collection-relative path of the document the note is about.' },
      { name: 'body', type: 'string', description: 'The note, as Markdown.' },
      STDIN_ARG,
      { name: 'kind', type: 'string', description: 'What kind of note: review, comments, feedback. Default notes.' },
      { name: 'title', type: 'string', description: 'A title for the note.' },
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const document = visiblePath(ctx.workspace, String(args.document), { markdown: true })
      const body = await textArgument(ctx, args, 'body', true)
      let created
      try {
        created = await createAgentNote(access.workspace, {
          sourceDocument: document, body,
          ...(args.kind === undefined ? {} : { kind: String(args.kind) }),
          ...(args.title === undefined ? {} : { title: String(args.title) }),
        }, { now: access.now(), exact: true })
      } catch (error) {
        throw error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error))
      }
      return applied(`Added a note about ${document}: ${created.file.path}`, { path: created.file.path, document })
    },
  },
  {
    name: 'scrap', group: 'Collect and plan', behaviour: 'direct', writes: true,
    summary: 'Add a scrap to a document\'s scraps file.',
    args: [
      { name: 'document', type: 'string', required: true, positional: true, description: 'Collection-relative path of the document the scrap belongs to.' },
      { name: 'text', type: 'string', description: 'The scrap.' },
      STDIN_ARG,
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const document = visiblePath(ctx.workspace, String(args.document), { markdown: true })
      if (!existsSync(ctx.workspace.absolute(document))) throw new CliError(`${document} does not exist.`)
      const text = await textArgument(ctx, args, 'text', true)
      if (text.trim() === '') throw new CliError('The scrap is empty. Nothing was written.')
      const path = visiblePath(ctx.workspace, scrapsPathFor(document), { markdown: true })
      const exists = existsSync(ctx.workspace.absolute(path))
      const existing = exists ? await readBytes(ctx.workspace, path) : Buffer.alloc(0)
      const { addition, id, text: body } = scrapAddition(existing.toString('utf8'), text)
      // Appended to the file's own bytes, so nothing already in it changes; and only while it still holds them.
      if (exists) await access.session.replace(path, Buffer.concat([existing, Buffer.from(addition, 'utf8')]), { fingerprint: fingerprintOf(existing) })
      else await access.session.create(path, addition)
      return applied(`Added scrap ${id} to ${path}`, { scrap: { id, origin: document, text: body, done: false }, path }, await access.commit(`Added a scrap to ${path}`))
    },
  },
  {
    name: 'capture', group: 'Collect and plan', behaviour: 'direct', writes: true,
    summary: 'File one reusable unit (evidence, a table, a visualisation, a snippet, a search result, a widget) in a research folder, indexed for search.',
    details: [
      `Runs scout (scout capture) and writes one new Markdown file under research/ in the project folder: the folder of the document named, or its Folio's folder. Nothing existing is changed; deleting the file undoes it.`,
      `--kind is one of ${CAPTURE_KINDS.join(', ')}. --sources takes the provenance, one per line: scout:<passage id>, a URL, or file:<path>. --artefact is a non-Markdown file in the Collection copied beside the description.`,
      'The result carries the Collection-relative file, the scout corpus it was indexed in (or null) and whether it was indexed.',
    ].join('\n'),
    args: [
      { name: 'project', type: 'string', required: true, positional: true, description: 'Collection-relative path of the document, or the folder (a Folio, a Folder Piece), the unit belongs to; "." for the Collection itself.' },
      { name: 'title', type: 'string', required: true, description: 'A short title for the unit.' },
      { name: 'kind', type: 'string', required: true, description: `What it is: ${CAPTURE_KINDS.join(', ')}.` },
      { name: 'body', type: 'string', description: 'The unit itself, as Markdown.' },
      STDIN_ARG,
      { name: 'prompt', type: 'string', description: 'The question that produced it.' },
      { name: 'sources', type: 'string', description: 'Where it came from, one per line: scout:<passage id>, a URL, or file:<path>.' },
      { name: 'artefact', type: 'string', description: 'Collection-relative path of a non-Markdown file to copy into research/ beside the description.' },
    ],
    run: async (ctx, args) => {
      writeAccess(ctx)
      const kind = CAPTURE_KINDS.find((candidate) => candidate === args.kind)
      if (!kind) throw new CliError(`--kind must be one of ${CAPTURE_KINDS.join(', ')}.`, 'usage')
      const body = await textArgument(ctx, args, 'body', true)
      const project = String(args.project)
      const path = project === '.' || project === '' ? '' : isAbsolute(project) ? relative(ctx.workspace.root, project) : project
      const sources = typeof args.sources === 'string' ? args.sources.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
      // Through the WriteSession's workspace and write turn, so the owner lock and the write gate apply, and what scout
      // wrote is registered as touched (the app's executor then tells the window; see request-executor.ts).
      const result = await captureInWorkspace(ctx.workspace, {
        project: path, title: String(args.title), kind, body, sources,
        ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
        ...(typeof args.artefact === 'string' ? { artefact: args.artefact } : {}),
      }, undefined, undefined, {
        wrote: (paths) => paths.forEach((written) => writeAccess(ctx).session.noteWritten(written)),
        beforeSpawn: () => writeAccess(ctx).session.assertOwned(path),
      })
      if (!result.ok) {
        if (result.code === 'writes-paused') throw new WritesPausedError(result.message)
        throw new CliError(result.message)
      }
      return applied(`Captured to ${result.file}${result.indexed ? ' (indexed)' : ' (not indexed)'}`, { path: result.file, project: result.project, corpus: result.corpus, indexed: result.indexed })
    },
  },
  {
    name: 'create-manifest', group: 'Collect and plan', behaviour: 'direct', writes: true,
    summary: `Make a folder a Folio: write ${MANIFEST_NAME} listing its parts in order.`,
    args: [{ name: 'folder', type: 'string', required: true, positional: true, description: 'Collection-relative folder; "." for the Collection itself.' }],
    run: async (ctx, args) => {
      const folder = visiblePath(ctx.workspace, String(args.folder), { allowRoot: true })
      const path = folder === '' ? MANIFEST_NAME : `${folder}/${MANIFEST_NAME}`
      let draft: string
      try {
        await assertManifestAbsent(ctx.workspace, folder)
        draft = await draftManifest(ctx.workspace, folder)
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error))
      }
      await ctx.workspace.exclusiveAll(async () => {
        await writeAccess(ctx).session.create(path, draft)
        await activateFolioDeclaration(ctx.workspace, folder)
      })
      return applied(`Created ${path}`, { path, manifest: JSON.parse(draft) as unknown })
    },
  },
]
