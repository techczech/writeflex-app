import { isCheatSheetShortcut, requestCheatSheet } from '../../app/shortcuts'

export type ObjectEditorApi = {
  /** Write the edited source back into the document and close the editor. False = refused. */
  commit(source: string): boolean
  /**
   * Close the editor WITHOUT writing anything.
   *
   * An editor the writer never typed in has nothing to save, and saving it anyway is not free: the
   * serialisers normalise (a fresh empty table round-trips `| --- |` to `| :--- |` and drops its
   * blank rows), so a commit nobody asked for is a real document change that lands in the undo
   * history. The live pass of 2026-09-12 measured the cost: insert a table from the action bar,
   * press Undo, and the FIRST press only undid the commit the press itself had just triggered.
   */
  close(): void
}
export type MountedEditor = { element: HTMLElement; serialise(): string; focus(): void; onEscape?(): boolean; destroy?(): void }

export function objectEditorKeyAction(key: string, metaKey: boolean, escapeHandled: boolean): 'commit' | 'handled' | 'none' {
  if (key === 'Enter' && metaKey) return 'commit'
  if (key === 'Escape' && escapeHandled) return 'handled'
  return 'none'
}

export function textareaEditor(source: string, className = 'oe-markup'): MountedEditor {
  const area = document.createElement('textarea'); area.className = className; area.value = source; area.spellcheck = false
  return { element: area, serialise: () => area.value, focus: () => area.focus() }
}

export function mountShell(options: {
  kind: string; editor: MountedEditor; markup?: MountedEditor; editorLabel?: string; markupLabel?: string; editorDisabledTitle?: string
  parseEditor?(source: string): MountedEditor | null; normaliseSource?(source: string): string | null; notParsedNote?: string; primaryTab?: 'editor' | 'markup'; foot: string; api: ObjectEditorApi
}): HTMLElement {
  const shell = document.createElement('div'); shell.className = 'oe'; shell.tabIndex = -1
  const head = document.createElement('div'); head.className = 'oe-head'
  const kind = document.createElement('span'); kind.className = 'oe-kind'; kind.textContent = options.kind
  const tabs = document.createElement('div'); tabs.className = 'oe-tabs'
  const surfaces = document.createElement('div'); surfaces.className = 'oe-surface'
  let active = options.editor
  const note = document.createElement('div'); note.className = 'oe-parse-note'; note.hidden = true
  // What the active editor serialises to while the writer has typed NOTHING. Compared on the way
  // out to tell "closed an editor" from "saved an edit"; see `ObjectEditorApi.close`.
  let pristine = ''
  const setActive = (mounted: MountedEditor, button: HTMLButtonElement): void => {
    // Swapping Editor↔Markup is not typing: an untouched editor stays untouched across the swap,
    // so the baseline moves to what the NEW surface serialises rather than going stale.
    const untouched = active.serialise() === pristine
    active.destroy?.(); active.element.replaceWith(mounted.element); active = mounted; note.hidden = true
    if (untouched) pristine = active.serialise()
    tabs.querySelectorAll('button').forEach((item) => item.classList.toggle('on', item === button)); mounted.focus()
  }
  if (options.markup) {
    const editorTab = document.createElement('button'); editorTab.type = 'button'; editorTab.textContent = options.editorLabel ?? 'Editor'
    if (options.editorDisabledTitle) { editorTab.disabled = true; editorTab.title = options.editorDisabledTitle }
    const markupTab = document.createElement('button'); markupTab.type = 'button'; markupTab.textContent = options.markupLabel ?? 'Markup'
    const primaryTab = options.primaryTab ?? 'editor'
    ;(primaryTab === 'editor' ? editorTab : markupTab).className = 'on'
    editorTab.addEventListener('click', () => {
      if (!options.parseEditor || active === options.editor) return
      const parsed = options.parseEditor(active.serialise())
      if (!parsed) { note.textContent = `This markup cannot be parsed as a ${options.editorLabel?.toLowerCase() ?? 'visual editor'} yet. Fix it here; your text is unchanged.`; note.hidden = false; return }
      options.editor = parsed; setActive(parsed, editorTab)
    })
    markupTab.addEventListener('click', () => {
      if (primaryTab === 'markup' || active !== options.editor) return
      options.markup = textareaEditor(active.serialise()); setActive(options.markup, markupTab)
    })
    tabs.append(editorTab, markupTab)
  }
  head.append(kind, tabs); surfaces.append(active.element, note)
  const foot = document.createElement('div'); foot.className = 'oe-foot'
  const hint = document.createElement('span'); hint.className = 'grow'; hint.textContent = options.foot
  const done = document.createElement('button'); done.type = 'button'; done.className = 'oe-done'; done.innerHTML = '✓ Done <kbd>⌘↵</kbd>'
  const controller = new AbortController(); let committed = false
  const commit = (): void => {
    if (committed) return
    committed = true
    let source = active.serialise()
    // NOTHING TYPED, NOTHING WRITTEN. Every way out of this editor runs through here — Done, ⌘↵, a
    // pointer down anywhere outside the shell, the window losing focus, widget teardown — and all
    // but one of those is the writer going somewhere else rather than saving. Closing must then
    // cost the document nothing at all, or one button press costs two undos.
    if (source === pristine) {
      controller.abort(); active.destroy?.()
      options.api.close()
      return
    }
    if (options.normaliseSource) {
      // Hand-typed text (the Markup tab) is repaired into valid markup; text that is not the object
      // at all stays in the editor with a note instead of being written and then lost.
      const fixed = options.normaliseSource(source)
      if (fixed === null) {
        committed = false
        note.textContent = options.notParsedNote ?? 'This text cannot be saved as this kind of object. Your text is kept; fix it here.'
        note.hidden = false
        return
      }
      source = fixed
    }
    if (!options.api.commit(source)) {
      committed = false
      shell.classList.remove('oe-commit-refused'); void shell.offsetWidth; shell.classList.add('oe-commit-refused')
      note.textContent = 'This edit was not saved because it was empty or the document changed underneath it. Reopen the editor and try again.'
      note.hidden = false
      return
    }
    controller.abort(); active.destroy?.()
  }
  // Widget teardown (live-preview toggle, buffer swap) must serialise too — the fail-closed range
  // guard in the api.commit path makes a stale cross-file teardown a safe no-op (C7.2 review find).
  ;(shell as HTMLElement & { __wfCommit?: () => void }).__wfCommit = () => {
    if (!committed) commit()
  }
  done.addEventListener('click', commit); foot.append(hint, done); shell.append(head, surfaces, foot)
  shell.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (isCheatSheetShortcut(event)) {
      event.preventDefault()
      requestCheatSheet(shell)
      return
    }
    const action = objectEditorKeyAction(event.key, event.metaKey, event.key === 'Escape' ? active.onEscape?.() === true : false)
    if (action !== 'none') event.preventDefault()
    if (action === 'commit') commit()
  })
  for (const type of ['keyup', 'keypress', 'beforeinput', 'input', 'mousedown', 'click', 'dblclick'] as const) shell.addEventListener(type, (event) => event.stopPropagation())
  document.addEventListener('mousedown', (event) => { if (!shell.contains(event.target as Node)) commit() }, { capture: true, signal: controller.signal })
  window.addEventListener('blur', commit, { signal: controller.signal })
  queueMicrotask(() => active.focus())
  // AFTER mounting, so it is what the editor actually parsed the source into — not the source.
  pristine = active.serialise()
  return shell
}
