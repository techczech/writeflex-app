import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, FileText, Maximize2, Play, Plus, RefreshCw, Undo2 } from 'lucide-react'
import { relativeEmbedPath } from '../../../shared/widget-insert'
import { mountWidgetFrame, type WidgetFrame } from '../widgets/widget-frame'
import type { OwnFolderChoice, OwnFolderFacts } from '../../../shared/own-folder-plan'
import { OwnFolderSheet } from './OwnFolderSheet'
import {
  browserPatch, browserRecipe, declaredResource, dirOf, guessMapping, insertLine, readRecipe, readSource, refusalText, resolveFrom, sourceKindOf, sourceLabel, titleFromFile,
  type FieldMapping, type RecipeInput, type RecipeReading, type SourceKind, type SourceReading,
} from '../widgets/standard-widget-model'

/**
 * Source and preview (record browser, ticket 04b; locked drawing direction-b/mockup-source-and-preview.html, with
 * the file step of direction-c/mockup-guided-sheet.html). One tab, two jobs:
 *
 *   new widget   choose a CSV or JSON file in the document's folder (the list) or by the system picker (Choose
 *                file…, in main: any file on the Mac). A file outside the document's folders comes back as a token
 *                (never a path) and the tab asks how to bring it in: Copy (the default) or Keep in sync with the
 *                original (ticket 04c); Create and insert brings it into the document's resources in the same step.
 *                Map its fields, edit the source text if wanted, Build preview (⌘B) to see the real page,
 *                then Create and insert: the engine writes the edited source, the widget and its embed line (at the
 *                caret's line) as one undoable step, and the open buffer takes the change from disk. For a document
 *                in no Folio whose folder holds other files, the own-folder sheet (OwnFolderSheet) asks first which
 *                documents belong with the widget; nothing is written until its main button;
 *   edit widget  reopened from a made widget: change the title, mapping or source text, Build and save (⌘B), see
 *                the page rebuilt.
 *
 * The preview is always the engine's page, built without writing anything, shown in the same sealed frame the
 * document uses. Nothing new is granted to the frame.
 */
export const WORKBENCH_TEXT = {
  tab: 'Widget workbench',
  newState: 'New widget',
  saved: 'Saved',
  changed: 'Mapping changed',
  sourceChanged: 'Source changed',
  failed: 'Build failed',
  noFile: 'Choose a CSV or JSON file in this folder to begin.',
  chooseFile: 'Choose file…',
  create: 'Create and insert',
  build: 'Build preview',
  buildSave: 'Build and save',
  back: 'Document',
  backToDocument: 'Back to document',
  undo: 'Undo last widget step',
  footNew: 'No widget file created yet.',
  footSaved: 'Widget saved in visualisations/',
  sourceFoot: 'Edit the source, then build to update the preview.',
  outsideFoot: 'This file is brought into the document\'s resources when the widget is created.',
  copyFoot: 'A copy in the document\'s resources. Edit it in its own program, then build to update the widget.',
  syncFoot: 'Kept in sync with its original. Edit the original, then build to update the widget.',
  outsideLead: 'is outside this document\'s folders. Bring it in as:',
  copy: 'Copy',
  copyHint: 'A copy in the document\'s resources. The widget and every export use it.',
  sync: 'Keep in sync with the original',
  syncHint: 'The same copy, refreshed from the original at each build. If the original is missing, the last copy is used.',
  sourceTooLarge: 'This file is too large to edit here. Edit it in its own program, then build to update the preview.',
  interactive: 'Interactive',
  stale: 'Showing last successful build',
  kept: 'Your last working preview is kept.',
} as const

export type WorkbenchStep = { undoId: string; kind: 'create' | 'update'; documentPath: string; recipePath: string; /** Create: the document's text as the step left it. */ documentText?: string; /** Create: the document editor's undo depth just after it (set by the app). */ historyDepth?: number; /** Create: files the step moved into the widget's new folder (the document among them when it moved). */ moved?: Array<{ from: string; to: string }> }

/** The create call, run by the app while the documents it may move or rewrite are saved and held (the app's
 *  rename path): the buffers follow the moves before the hold is let go. Answers null when the app refused (it
 *  said why). Without it the call is made as it is. */
export type RunCreate = (paths: string[], create: () => Promise<CreateWidgetResult>) => Promise<CreateWidgetResult | null>
type CreateWidgetResult = Awaited<ReturnType<Window['writeflex']['createStandardWidget']>>

export type StandardWidgetWorkbenchProps = {
  /** The document the widget belongs to (workspace-relative). */
  documentPath: string
  /** Set to edit a made widget; unset to make a new one. */
  recipePath: string | null
  /** The 1-based line the caret was on in the document when the tab opened; a new widget goes in there. */
  caretLine?: number | null
  /** Save whatever the open document holds, so the engine's write starts from the disk's text. */
  flushDocument: () => Promise<{ ok: true } | { ok: false; message: string }>
  /** A step was made: remember its undo id (the palette's Undo last widget step uses it). */
  onStep: (step: WorkbenchStep) => void
  /** A new widget was created and inserted; the tab goes back to the document. */
  onCreated: (step: WorkbenchStep) => void
  onBack: () => void
  onStatus: (message: string) => void
  /** Run the create call while the documents it may move are held (see RunCreate). */
  runCreate?: RunCreate
  /** The last step's undo, offered in the footer while this tab holds it. */
  onUndo?: () => void
  canUndo?: boolean
}

/** Larger sources are shown read-only: a text box this size is no place to edit them. */
const SOURCE_EDIT_MAX = 1_000_000
const CHOOSE = '\u0000choose'
const NONE = ''
/** The Source file value of a file picked outside the document's folders: its name only; main holds the file. */
const OUTSIDE = '\u0000outside/'
type Inclusion = 'copy' | 'sync'
type OutsideFile = { token: string; name: string; inclusion: Inclusion }

/** The mapping after the source was read again: the writer's own, kept even when a field it names is gone (the
 *  field shows as missing and the build names it); a guess only when there is none yet. */
function keptMapping(fields: readonly string[], wanted: FieldMapping | null): FieldMapping {
  return wanted ?? guessMapping(fields)
}

export function StandardWidgetWorkbench(props: StandardWidgetWorkbenchProps): JSX.Element {
  const { documentPath, recipePath } = props
  const editing = recipePath !== null
  const [loaded, setLoaded] = useState<'loading' | 'ready' | { problem: string }>(editing ? 'loading' : 'ready')
  const [sources, setSources] = useState<{ folder: string; files: string[] } | null>(null)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  /** The source as it is on disk, and as the source pane holds it. */
  const [sourceBasis, setSourceBasis] = useState('')
  const [sourceText, setSourceText] = useState('')
  /** The text the shown page was built from. */
  const [builtText, setBuiltText] = useState<string | null>(null)
  const [reading, setReading] = useState<SourceReading | null>(null)
  const [pointer, setPointer] = useState('')
  const [title, setTitle] = useState('')
  const [mapping, setMapping] = useState<FieldMapping | null>(null)
  const [saved, setSaved] = useState(editing)
  const [settingsChanged, setSettingsChanged] = useState(false)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState<{ html: string; title: string; key: number } | null>(null)
  const [full, setFull] = useState(false)
  const [lastStep, setLastStep] = useState<string | null>(null)
  const [pickNote, setPickNote] = useState('')
  /** A file picked outside the document's folders, not yet brought in: main's token for it and the writer's choice. */
  const [outside, setOutside] = useState<OutsideFile | null>(null)
  /** A made widget's source that is a declared resource (a file brought in): shown read-only. */
  const [resource, setResource] = useState<{ id: string; inclusion: string } | null>(null)
  /** The last build's warnings (a file kept in sync whose original is missing …), named on their own line. */
  const [warning, setWarning] = useState('')
  /** The own-folder sheet, open over the tab: the folder's facts and the draft it was opened for. */
  const [folderSheet, setFolderSheet] = useState<{ facts: OwnFolderFacts; draft: RecipeInput; text: string; basis: string; notice?: string } | null>(null)
  const recipeRef = useRef<{ text: string; reading: Extract<RecipeReading, { ok: true }> } | null>(null)
  const pageKey = useRef(0)
  const lastPreviewed = useRef('')
  const kind: SourceKind | null = sourcePath === null ? null : sourceKindOf(sourcePath)
  const sourceChanged = builtText !== null && sourceText !== builtText

  const showHtml = (html: string, pageTitle: string): void => { pageKey.current += 1; setPage({ html, title: pageTitle, key: pageKey.current }) }

  const showPage = useCallback(async (pagePath: string): Promise<boolean> => {
    const raw = relativeEmbedPath(documentPath, pagePath)
    try {
      const result = await window.writeflex.readWidget(documentPath, raw)
      if (!result.ok) return false
      pageKey.current += 1
      setPage({ html: result.html, title: result.title, key: pageKey.current })
      return true
    } catch { return false }
  }, [documentPath])

  /** Read `text` as the source's records: fields, the record list, the mapping kept or guessed. */
  const readInto = useCallback((path: string, text: string, wanted?: { pointer?: string; mapping?: FieldMapping | null }): { read: SourceReading; mapping: FieldMapping | null; pointer: string } => {
    const sourceKind = sourceKindOf(path)
    if (sourceKind === null) {
      const refused: SourceReading = { ok: false, message: `${path.split('/').at(-1)} is not a CSV or JSON file.` }
      setReading(refused)
      return { read: refused, mapping: null, pointer: '' }
    }
    const read = readSource(sourceKind, text, wanted?.pointer)
    setReading(read)
    if (!read.ok) return { read, mapping: null, pointer: wanted?.pointer ?? '' }
    const next = keptMapping(read.fields, wanted?.mapping ?? null)
    setPointer(read.pointer)
    setMapping(next)
    return { read, mapping: next, pointer: read.pointer }
  }, [])

  /** A new source file in the pane: its text is the disk's, nothing edited. */
  const loadSource = useCallback((path: string, text: string, wanted?: { pointer?: string; mapping?: FieldMapping | null }) => {
    setSourcePath(path)
    setSourceBasis(text)
    setSourceText(text)
    return readInto(path, text, wanted)
  }, [readInto])

  // The CSV and JSON files a widget here may read.
  useEffect(() => {
    let live = true
    void window.writeflex.listStandardWidgetSources(documentPath).then((listing) => { if (live && listing.ok) setSources({ folder: listing.folder, files: listing.files }) }).catch(() => {})
    return () => { live = false }
  }, [documentPath])

  // Edit mode: the recipe, its source and the page it last built.
  useEffect(() => {
    if (recipePath === null) return
    let live = true
    void (async () => {
      try {
        const recipeText = (await window.writeflex.readFile(recipePath)).content
        const parsed = readRecipe(recipeText)
        if (!parsed.ok) { if (live) setLoaded({ problem: parsed.message }); return }
        recipeRef.current = { text: recipeText, reading: parsed }
        let resolved = resolveFrom(dirOf(recipePath), parsed.sourcePath)
        if (parsed.sourceResource !== null) {
          // A file brought into the document's resources: the manifest says where its copy is.
          const bundle = dirOf(dirOf(dirOf(recipePath)))
          let item: { path: string; inclusion: string } | null = null
          try { item = declaredResource((await window.writeflex.readFile(bundle === '' ? '_report-structure.json' : `${bundle}/_report-structure.json`)).content, parsed.sourceResource) } catch { /* named below */ }
          if (!live) return
          if (item === null) { setLoaded({ problem: `This widget reads ${parsed.sourceResource}, which is not declared in the document's resources.` }); return }
          resolved = resolveFrom(bundle, item.path)
          setResource({ id: parsed.sourceResource, inclusion: item.inclusion })
        }
        if (!live) return
        setTitle(parsed.title)
        if (resolved === null) { setLoaded({ problem: 'This widget reads a file outside its folder, so it cannot be edited here.' }); return }
        let text: string | null = null
        try { text = (await window.writeflex.readFile(resolved)).content } catch { /* named below */ }
        if (!live) return
        if (text === null) {
          setSourcePath(resolved)
          setReading({ ok: false, message: `${resolved} is missing. Choose the file again.` })
          setMapping(parsed.mapping)
        } else {
          loadSource(resolved, text, { pointer: parsed.pointer, mapping: parsed.mapping })
          setBuiltText(text)
        }
        await showPage(`${dirOf(recipePath)}/widget.html`)
        if (live) setLoaded('ready')
      } catch (cause) {
        if (live) setLoaded({ problem: cause instanceof Error ? cause.message : 'This widget cannot be opened.' })
      }
    })()
    return () => { live = false }
  }, [recipePath, loadSource, showPage])

  const inputOf = (draftTitle: string, draftKind: SourceKind | null, draftPointer: string, draftMapping: FieldMapping | null): RecipeInput | null =>
    draftKind && draftMapping ? { title: draftTitle, kind: draftKind, pointer: draftPointer, mapping: draftMapping } : null
  const input = useMemo(() => (reading?.ok ? inputOf(title, kind, pointer, mapping) : null), [reading, mapping, kind, title, pointer])
  const fields = reading?.ok ? reading.fields : []

  /** The page this draft would build, from the engine, with nothing written. An outside file (`token`) is read by
   *  main from what it holds for the token. */
  const preview = useCallback(async (path: string, text: string, draft: RecipeInput, token?: string): Promise<boolean> => {
    try {
      const source = token !== undefined ? { pick: { token } } : { sourceFile: path, sourceText: text }
      const result = await window.writeflex.previewStandardWidget({ documentPath, recipe: browserRecipe(draft), ...source, name: draft.title || 'records', ...(recipePath !== null ? { recipePath } : {}) })
      if (!result.ok) { setError(refusalText(result)); setFailed(true); return false }
      showHtml(result.html, result.title)
      setBuiltText(text)
      setError('')
      setFailed(false)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The preview could not be built.')
      setFailed(true)
      return false
    }
  }, [documentPath, recipePath])

  const choose = async (path: string, text: string, picked: OutsideFile | null = null): Promise<void> => {
    setPickNote('')
    setWarning('')
    setOutside(picked)
    setResource(null)
    // The page for this file comes from the preview below, not from the settings-follow effect.
    lastPreviewed.current = ''
    setBuiltText(null)
    const loaded = loadSource(path, text)
    const nextTitle = title === '' && loaded.read.ok ? titleFromFile(path) : title
    if (nextTitle !== title) setTitle(nextTitle)
    setError('')
    setFailed(false)
    if (editing) { setSettingsChanged(true); return }
    const draft = loaded.read.ok ? inputOf(nextTitle, sourceKindOf(path), loaded.pointer, loaded.mapping) : null
    if (draft) await preview(path, text, draft, picked?.token)
  }

  /** Choose file…: the native picker, in main (any file on the Mac). A file in the document's folders is used in
   *  place; any other comes back as a token, and the tab asks Copy or Keep in sync (Copy chosen to start with). */
  const chooseFile = async (): Promise<void> => {
    setPickNote('')
    let answer: Awaited<ReturnType<Window['writeflex']['pickStandardWidgetSource']>>
    try { answer = await window.writeflex.pickStandardWidgetSource(documentPath) } catch (cause) { setPickNote(cause instanceof Error ? cause.message : 'The file could not be chosen.'); return }
    if (!answer.ok) { if (answer.cancelled !== true) setPickNote(answer.message); return }
    if (answer.inside) { await choose(answer.path, answer.text); return }
    await choose(`${OUTSIDE}${answer.name}`, answer.text, { token: answer.token, name: answer.name, inclusion: 'copy' })
  }

  const listed = async (path: string): Promise<void> => {
    if (path === CHOOSE) { void chooseFile(); return }
    if (path === NONE || path === sourcePath) return
    try { await choose(path, (await window.writeflex.readFile(path)).content) } catch { setPickNote(`${path} could not be read.`) }
  }

  // A new widget's preview follows its settings: the page is rebuilt (nothing written) when the mapping or title changes.
  const settingsKey = input ? JSON.stringify(browserRecipe(input)) : ''
  useEffect(() => {
    if (editing || !input || sourcePath === null || builtText === null) return
    if (lastPreviewed.current === settingsKey) return
    const first = lastPreviewed.current === ''
    lastPreviewed.current = settingsKey
    if (first) return
    const timer = window.setTimeout(() => { void preview(sourcePath, builtText, input, outside?.token) }, 200)
    return () => window.clearTimeout(timer)
  }, [editing, input, settingsKey, sourcePath, builtText, preview, outside])

  const changeSettings = (patch: Partial<FieldMapping>): void => { if (mapping) { setMapping({ ...mapping, ...patch }); if (editing) setSettingsChanged(true) } }

  /** Build preview (⌘B) for a new widget: the fields read again from the pane's text, then the engine's page. */
  const buildPreview = async (): Promise<void> => {
    if (sourcePath === null || busy) return
    const again = readInto(sourcePath, sourceText, { pointer, mapping })
    if (!again.read.ok) { setError(again.read.message); setFailed(true); return }
    const draft = inputOf(title, kind, again.pointer, again.mapping)
    if (!draft) return
    setBusy(true)
    try { await preview(sourcePath, sourceText, draft, outside?.token) } finally { setBusy(false) }
  }

  /** Create and insert: for a document in no Folio whose folder holds other files, the own-folder sheet asks first
   *  (nothing written); otherwise the step runs at once. */
  const create = async (): Promise<void> => {
    if (!input || sourcePath === null || busy) return
    setBusy(true)
    setError('')
    try {
      const again = readInto(sourcePath, sourceText, { pointer, mapping })
      if (!again.read.ok) { setError(again.read.message); setFailed(true); return }
      const draft = inputOf(title, kind, again.pointer, again.mapping)!
      const facts = await window.writeflex.standardWidgetOwnFolderFacts({ documentPath, ...(outside ? {} : { sourceFile: sourcePath }), name: title || 'records', ...(title ? { title } : {}) })
      if (!facts.ok) { setError(facts.message); setFailed(true); return }
      if (facts.needed) { setFolderSheet({ facts: facts.facts, draft, text: sourceText, basis: sourceBasis }); return }
      await insert(draft, sourceText, sourceBasis, undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The widget could not be created.')
      setFailed(true)
    } finally { setBusy(false) }
  }

  /** The sheet, opened over the folder as it is now (`notice`: why it is shown again). Answers false when no sheet is
   *  needed any more (the folder's situation changed so far that the step would go ahead without one). */
  const reopenSheet = async (draft: RecipeInput, text: string, basisText: string, notice: string): Promise<boolean> => {
    const facts = await window.writeflex.standardWidgetOwnFolderFacts({ documentPath, ...(outside || sourcePath === null ? {} : { sourceFile: sourcePath }), name: title || 'records', ...(title ? { title } : {}) })
    if (!facts.ok) { setError(facts.message); setFailed(true); return true }
    if (!facts.needed) return false
    setFolderSheet({ facts: facts.facts, draft, text, basis: basisText, notice })
    return true
  }

  /** The one create step: the document saved first, then the engine call (held by the app when files may move). A
   *  folder that changed since the sheet was drawn (or that now needs it) brings the sheet back over the folder as
   *  it is now, nothing written; answers 'sheet' then. */
  const insert = async (draft: RecipeInput, text: string, basisText: string, placement: OwnFolderChoice | undefined): Promise<boolean | 'sheet'> => {
    if (sourcePath === null) return false
    const flushed = await props.flushDocument()
    if (!flushed.ok) { setError(flushed.message); setFailed(true); return false }
    const basis = (await window.writeflex.readFile(documentPath)).content
    const line = insertLine(props.caretLine, basis)
    // An outside file goes by main's token and the writer's choice; it is brought in by the same step.
    const source = outside
      ? { pick: { token: outside.token, inclusion: outside.inclusion } }
      : { sourceFile: sourcePath, ...(text !== basisText ? { sourceEdit: { text, basis: basisText } } : {}) }
    const call = () => window.writeflex.createStandardWidget({
      documentPath, name: title || 'records', recipe: browserRecipe(draft), ...source,
      position: line === null ? 'end' : { line }, documentBasis: basis,
      ...(placement ? { placement } : {}),
    })
    const folder = dirOf(documentPath)
    const holds = placement ? [documentPath, ...placement.order.map((name) => (folder === '' ? name : `${folder}/${name}`))] : [documentPath]
    const result = placement && props.runCreate ? await props.runCreate([...new Set(holds)], call) : await call()
    if (result === null) return false
    if (!result.ok && (result.code === 'own-folder-changed' || result.code === 'placement-required')) {
      const notice = result.code === 'own-folder-changed' ? 'The folder changed since this was drawn. This is how it looks now; check it and press the button again.' : 'Choose which documents go with the widget first.'
      if (await reopenSheet(draft, text, basisText, notice)) return 'sheet'
      // No sheet any more: nothing was written; the next Create and insert goes ahead over the folder as it is.
      setError(`${result.message} Press ${WORKBENCH_TEXT.create} again to go ahead.`)
      setFailed(true)
      return false
    }
    if (!result.ok) { setError(refusalText(result)); setFailed(true); return false }
    const step: WorkbenchStep = { undoId: result.undoId, kind: 'create', documentPath: result.documentPath, recipePath: result.recipePath, documentText: result.documentText, ...(result.moved.length > 0 ? { moved: result.moved } : {}) }
    setLastStep(result.undoId)
    props.onStep(step)
    props.onCreated(step)
    if (result.notices.length > 0) props.onStatus(`Some links could not be carried along: ${result.notices.join(' ')}`)
    const warned = result.build.errors.filter((item) => item.severity === 'warning').map((item) => item.message)
    if (warned.length > 0) props.onStatus(warned.join(' '))
    else if (result.intake) props.onStatus(result.intake.inclusion === 'sync' ? `${result.intake.path} is kept in sync with its original.` : `${result.intake.path} was copied into the document's resources.`)
    return true
  }

  /** The sheet's main button: the step runs with the writer's answer; the sheet closes when it is done. */
  const confirmFolder = async (choice: OwnFolderChoice): Promise<void> => {
    const held = folderSheet
    if (!held || busy) return
    setBusy(true)
    setError('')
    let again = false
    try {
      // Done or refused, the sheet closes: a refusal is named on the tab's error line, and nothing was changed. A
      // folder that changed since the sheet was drawn brings it back, drawn again.
      again = (await insert(held.draft, held.text, held.basis, choice)) === 'sheet'
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The widget could not be created.')
      setFailed(true)
    } finally {
      if (!again) setFolderSheet(null)
      setBusy(false)
    }
  }

  const finish = async (outcome: { build: { result: string; errors: Array<{ message: string; severity: string }>; writtenOutput: string | null; outputPath: string } }, built: string): Promise<boolean> => {
    let text = built
    const hard = outcome.build.errors.filter((item) => item.severity === 'error')
    if (outcome.build.result === 'failed' || hard.length > 0) {
      setError(hard.map((item) => item.message).join(' ') || 'The widget could not be built.')
      setFailed(true)
      return false
    }
    setError('')
    setFailed(false)
    setSaved(true)
    setSettingsChanged(false)
    setWarning(outcome.build.errors.filter((item) => item.severity === 'warning').map((item) => item.message).join(' '))
    // A source kept in sync may have been refreshed from its original by the build: show the copy as it is now.
    if (resource !== null && sourcePath !== null) {
      try { const now = (await window.writeflex.readFile(sourcePath)).content; setSourceBasis(now); setSourceText(now); text = now } catch { /* the build named it */ }
    }
    setBuiltText(text)
    await showPage(outcome.build.writtenOutput ?? outcome.build.outputPath)
    return true
  }

  /** Build and save (⌘B) for a made widget: the edited source and changed settings are saved, and the page rebuilt. */
  const buildAndSave = async (): Promise<void> => {
    const held = recipeRef.current
    if (!held || recipePath === null || busy) return
    setBusy(true)
    try {
      let text = sourceText
      let basis = sourceBasis
      let unread = false
      // An unedited source is read again, so a file edited in another program is what the page shows.
      if (sourcePath !== null && outside === null && sourceText === sourceBasis) {
        try { text = (await window.writeflex.readFile(sourcePath)).content; basis = text; setSourceBasis(text); setSourceText(text) } catch { unread = true /* the build names it */ }
      }
      const again = sourcePath !== null ? readInto(sourcePath, text, { pointer, mapping }) : null
      // A source that cannot be read as records stops here: Build failed, the last good page kept, nothing saved
      // (never the old settings rebuilt and called Saved). A file that could not be read at all is named by the build.
      if (again !== null && !again.read.ok && !unread) { setError(again.read.message); setFailed(true); return }
      const draft = again?.read.ok ? inputOf(title, kind, again.pointer, again.mapping) : null
      const original = { title: held.reading.title, kind: held.reading.kind, pointer: held.reading.pointer, mapping: held.reading.mapping }
      // A resource source stays as it is unless another file was chosen; an outside file is named by its token.
      const moved = outside !== null ? outside.name
        : resource !== null ? undefined
        : sourcePath !== null && resolveFrom(dirOf(recipePath), held.reading.sourcePath) !== sourcePath ? sourcePath : undefined
      const sameSettings = draft === null || (JSON.stringify(browserPatch(held.reading.recipe, draft)) === JSON.stringify(browserPatch(held.reading.recipe, original)) && moved === undefined)
      const edited = text !== basis
      if (sameSettings && !edited) {
        const outcome = await window.writeflex.buildStandardWidget(recipePath)
        await finish({ build: outcome }, text)
        return
      }
      const patch = draft === null || sameSettings ? {} : browserPatch(held.reading.recipe, draft, moved)
      const brought = outside
      const result = await window.writeflex.updateStandardWidgetRecipe({
        recipePath, patch, basis: held.text,
        ...(brought ? { pick: { token: brought.token, inclusion: brought.inclusion }, documentPath } : edited ? { sourceEdit: { text, basis } } : {}),
      })
      if (!result.ok) { setError(refusalText(result)); setFailed(true); return }
      const reread = readRecipe(result.recipeText)
      if (reread.ok) recipeRef.current = { text: result.recipeText, reading: reread }
      if (brought && result.intake) {
        // Brought in: from now on the widget reads the copy in the document's resources.
        setOutside(null)
        setResource({ id: result.intake.id, inclusion: result.intake.inclusion })
        setSourcePath(result.intake.path)
        props.onStatus(result.intake.inclusion === 'sync' ? `${result.intake.path} is kept in sync with its original.` : `${result.intake.path} was copied into the document's resources.`)
      }
      if (edited) setSourceBasis(text)
      setLastStep(result.undoId)
      props.onStep({ undoId: result.undoId, kind: 'update', documentPath, recipePath })
      await finish(result, text)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The widget could not be built.')
      setFailed(true)
    } finally { setBusy(false) }
  }

  const build = (): void => { if (editing) void buildAndSave(); else void buildPreview() }
  const primary = (): void => { if (editing) props.onBack(); else void create() }

  const statePill = failed ? WORKBENCH_TEXT.failed : sourceChanged ? WORKBENCH_TEXT.sourceChanged : settingsChanged ? WORKBENCH_TEXT.changed : saved ? WORKBENCH_TEXT.saved : WORKBENCH_TEXT.newState
  const stateClass = failed ? 'error' : sourceChanged || settingsChanged ? 'dirty' : ''

  useEffect(() => {
    if (!full) return
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setFull(false) } }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [full])

  if (typeof loaded === 'object') {
    return (
      <section className="swb" data-testid="widget-workbench" aria-label="Widget workbench">
        <header className="swb-head"><button type="button" className="btn" data-testid="workbench-back" onClick={props.onBack}><ArrowLeft className="icon sm" />{WORKBENCH_TEXT.back}</button><h1>Widget workbench</h1></header>
        <p className="swb-problem" role="alert" data-testid="workbench-problem">{loaded.problem}</p>
      </section>
    )
  }

  const sourceName = sourcePath?.split('/').at(-1) ?? ''
  const folder = sources?.folder ?? dirOf(documentPath)
  const listedFiles = sources?.files ?? []
  const options = sourcePath !== null && !listedFiles.includes(sourcePath) ? [sourcePath, ...listedFiles] : listedFiles
  const labelOf = (path: string): string => (path.startsWith(OUTSIDE) ? `${path.slice(OUTSIDE.length)} (from outside this folder)` : sourceLabel(folder, path))
  const folderHint = sourcePath !== null ? labelOf(sourcePath) : recipePath !== null ? dirOf(recipePath) : `${folder === '' ? '' : `${folder}/`}visualisations/`
  const tooLarge = sourceText.length > SOURCE_EDIT_MAX
  // An outside file is shown as it was chosen; a file brought into the resources is edited in its own program (a
  // copy kept in sync would be replaced by its original at the next build).
  const readOnly = tooLarge || outside !== null || resource !== null
  const foot = tooLarge ? WORKBENCH_TEXT.sourceTooLarge : outside ? WORKBENCH_TEXT.outsideFoot : resource ? (resource.inclusion === 'sync' ? WORKBENCH_TEXT.syncFoot : WORKBENCH_TEXT.copyFoot) : WORKBENCH_TEXT.sourceFoot
  const stale = page !== null && (failed || sourceChanged || settingsChanged)
  return (
    <section className="swb" data-testid="widget-workbench" aria-label="Widget workbench" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); event.stopPropagation(); build() }
    }}>
      <header className="swb-head">
        <button type="button" className="btn" data-testid="workbench-back" onClick={props.onBack}><ArrowLeft className="icon sm" />{WORKBENCH_TEXT.back}</button>
        <h1>{title || 'Record browser'}</h1>
        <span className="swb-grow" />
        <span className={`swb-state ${stateClass}`} data-testid="workbench-state">{statePill}</span>
      </header>
      <div className="swb-recipe">
        <label>Source file
          <select data-testid="workbench-source" value={sourcePath ?? NONE} onChange={(event) => { void listed(event.target.value) }}>
            {sourcePath === null && <option value={NONE}>{options.length > 0 ? 'Choose a source file' : 'No CSV or JSON file here'}</option>}
            {options.map((path) => <option key={path} value={path}>{labelOf(path)}</option>)}
            <option value={CHOOSE}>{WORKBENCH_TEXT.chooseFile}</option>
          </select>
        </label>
        <label>Template
          <select data-testid="workbench-template" value="browser" disabled onChange={() => {}}><option value="browser">Browser</option></select>
        </label>
        <label>Widget title
          <input className="swb-title-input" data-testid="workbench-title" value={title} onChange={(event) => { setTitle(event.target.value); if (editing) setSettingsChanged(true) }} />
        </label>
        <span className="swb-grow" />
        <span className="swb-hint">{folderHint}{pickNote && <em data-testid="workbench-pick-note"> · {pickNote}</em>}</span>
      </div>
      {outside && (
        <fieldset className="swb-inclusion" data-testid="workbench-outside">
          <legend><b>{outside.name}</b> {WORKBENCH_TEXT.outsideLead}</legend>
          <div className="radio-row">
            {(['copy', 'sync'] as const).map((choice) => (
              <label key={choice} className={`radio-card${outside.inclusion === choice ? ' on' : ''}`} data-testid={`inclusion-${choice}`}>
                <input type="radio" name="swb-inclusion" value={choice} checked={outside.inclusion === choice} onChange={() => { setOutside({ ...outside, inclusion: choice }); if (editing) setSettingsChanged(true) }} />
                <span>{choice === 'copy' ? WORKBENCH_TEXT.copy : WORKBENCH_TEXT.sync}<small>{choice === 'copy' ? WORKBENCH_TEXT.copyHint : WORKBENCH_TEXT.syncHint}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="swb-mapping">
        <b>Fields</b>
        {reading?.ok && mapping ? (
          <>
            <FieldSelect label="Title" testId="map-title" value={mapping.title} fields={fields} onChange={(value) => changeSettings({ title: value })} />
            <FieldSelect label="Group" testId="map-group" value={mapping.group} fields={fields} none onChange={(value) => changeSettings({ group: value === '' ? null : value })} />
            <FieldSelect label="Description" testId="map-detail" value={mapping.detail} fields={fields} onChange={(value) => changeSettings({ detail: value })} />
            {reading.kind === 'json' && reading.pointers.length > 1 && (
              <label>Records
                <select data-testid="map-records" value={pointer} onChange={(event) => { if (sourcePath) { readInto(sourcePath, sourceText, { pointer: event.target.value, mapping: null }); if (editing) setSettingsChanged(true) } }}>
                  {reading.pointers.map((item) => <option key={item} value={item}>{item === '' ? 'whole file' : item}</option>)}
                </select>
              </label>
            )}
          </>
        ) : <span className="swb-muted">{reading && !reading.ok ? '' : 'Fields appear when a file is chosen.'}</span>}
      </div>
      <div className={`swb-split${full ? ' full' : ''}`}>
        <section className="swb-source">
          <div className="swb-panehead"><FileText className="icon sm" />{sourcePath ? <b>{sourceName}</b> : <b>No file chosen</b>}<span className="swb-grow" /><span className="swb-muted">{kind === 'csv' ? 'CSV' : kind === 'json' ? 'JSON' : ''}{kind ? ' · ' : ''}{readOnly ? 'Read-only source' : 'Editable source'}</span></div>
          {sourcePath === null ? (
            <div className="swb-empty" data-testid="workbench-no-file"><p>{WORKBENCH_TEXT.noFile}</p><button type="button" className="btn primary" data-testid="workbench-choose" onClick={() => { void chooseFile() }}><Plus className="icon sm" />{WORKBENCH_TEXT.chooseFile}</button></div>
          ) : (
            <textarea className="swb-source-text" data-testid="workbench-source-text" aria-label="Widget source" spellCheck={false} readOnly={readOnly} value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
          )}
          <div className="swb-sourcefoot" data-testid="workbench-source-foot">{foot}<span className="swb-keyhint">⌘B</span></div>
        </section>
        <section className="swb-preview-pane">
          <div className="swb-panehead"><Play className="icon sm" /><b>Preview</b><span className="swb-grow" /><span className="swb-muted" data-testid="workbench-preview-label">{page ? (stale ? WORKBENCH_TEXT.stale : WORKBENCH_TEXT.interactive) : ''}</span>
            <button type="button" className="btn" data-testid="workbench-full" onClick={() => setFull((value) => !value)}><Maximize2 className="icon sm" />{full ? 'Close · Esc' : 'Full size'}</button>
          </div>
          <div className="swb-preview" data-testid="workbench-preview">
            {page ? <BuiltPage key={page.key} html={page.html} title={page.title || title} />
              : <p className="swb-muted swb-pad">{reading && !reading.ok ? '' : 'The preview shows the widget once a file is chosen.'}</p>}
          </div>
        </section>
      </div>
      {warning && !error && <div className="swb-warnline" role="status" data-testid="workbench-warning">{warning}</div>}
      {(error || (reading && !reading.ok)) && (
        <div className="swb-errorline" role="alert" data-testid="workbench-error">{error || (reading && !reading.ok ? reading.message : '')}{page && failed ? ` ${WORKBENCH_TEXT.kept}` : ''}</div>
      )}
      <footer className="swb-foot">
        <span data-testid="workbench-foot">{saved ? WORKBENCH_TEXT.footSaved : WORKBENCH_TEXT.footNew}</span>
        <span className="swb-grow" />
        {props.canUndo && lastStep !== null && <button type="button" className="btn" data-testid="workbench-undo" onClick={props.onUndo}><Undo2 className="icon sm" />{WORKBENCH_TEXT.undo}</button>}
        <button type="button" className="btn" data-testid="workbench-build" title={`${editing ? WORKBENCH_TEXT.buildSave : WORKBENCH_TEXT.build} (⌘B)`} disabled={busy || sourcePath === null} onClick={build}><RefreshCw className="icon sm" />{editing ? WORKBENCH_TEXT.buildSave : WORKBENCH_TEXT.build}</button>
        <button type="button" className="btn primary" data-testid="workbench-primary" disabled={busy || (!editing && (input === null || sourcePath === null))} onClick={primary}>
          {editing ? <Check className="icon sm" /> : <Plus className="icon sm" />}{editing ? WORKBENCH_TEXT.backToDocument : WORKBENCH_TEXT.create}
        </button>
      </footer>
      {folderSheet && (
        <OwnFolderSheet key={JSON.stringify(folderSheet.facts)} facts={folderSheet.facts} busy={busy} notice={folderSheet.notice} onConfirm={(choice) => { void confirmFolder(choice) }}
          onCancel={() => { setFolderSheet(null); props.onStatus('Cancelled. Nothing was moved or created.') }} />
      )}
    </section>
  )
}

function FieldSelect(props: { label: string; testId: string; value: string | null; fields: string[]; none?: boolean; onChange: (value: string) => void }): JSX.Element {
  const listed = props.value !== null && !props.fields.includes(props.value) ? [props.value, ...props.fields] : props.fields
  return (
    <label>{props.label}
      <select data-testid={props.testId} value={props.value ?? ''} onChange={(event) => props.onChange(event.target.value)}>
        {props.none && <option value="">None</option>}
        {listed.map((name) => <option key={name} value={name}>{props.fields.includes(name) ? name : `${name} (missing)`}</option>)}
      </select>
    </label>
  )
}

/** The engine's page in the existing sealed frame (widget-frame.ts), unchanged. */
function BuiltPage(props: { html: string; title: string }): JSX.Element {
  const stage = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const container = stage.current
    if (!container) return
    let frame: WidgetFrame | null = null
    try { frame = mountWidgetFrame({ container, html: props.html, title: props.title, returnFocus: () => {} }) } catch { /* shown empty */ }
    return () => frame?.dispose()
  }, [props.html, props.title])
  return <div className="wf-widget-stage swb-stage" ref={stage} data-testid="workbench-frame" />
}
