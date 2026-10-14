/**
 * A document that main wrote while it is open in the window: accepting a suggestion, and redoing an
 * undone accept (quit-and-window-close-spec.md, review round 3, finding 1).
 *
 * `mainWroteDocument` is the one rule for every such write whose text the editor took as an undoable
 * edit (which reports no document change): the file main returned is the saved baseline from then on,
 * and the buffer as it is now is reported against it to the unsaved registry. Without it the baseline
 * stays at the text from before the write, and an undo back to that text reads as "equals the disk"
 * while the disk holds what main wrote.
 *
 * `replayAcceptRedo` is the redo of an undone accept. It runs at once, as every other resolution of a
 * change does, so the order in which main receives them is the order they were asked for. It writes
 * the document's file directly (the pre-accept text is put back, main applies the change to it); a
 * hold in the registry stands for the length of those calls, so a close waits for them. It ends in
 * one of three ways: main returned the file (`mainWroteDocument`); nothing was written (a refusal of
 * the first write, or main declining with nothing put back); or the disk is not known (a call threw,
 * or main declined after the pre-accept text was put back, or the file was not read back), and then
 * the document's text is kept in the registry as after a save of unknown outcome.
 *
 * Pure: no React, no IPC of its own.
 */
import type { FileReadResult, WriteFlexApi } from '../../../preload'
import type { SuggestionResolutionEffect } from '../editor/suggestion-resolution-history'
import { isTextChange } from '../../../shared/line-endings'

export type MainWrotePorts = {
  /** The content the app takes as being on disk for the document. */
  setBaseline(path: string, content: string): void
  /** The document's buffer as it is now, or null when the window has none to read (its tab is not
   *  resident, or the app is unmounted). */
  bufferOf(path: string): string | null
  /** The buffer's standing against the disk, with its text: to the registry and the dirty dot. */
  setDirty(path: string, dirty: boolean, text: string): void
  /** The text the registry holds for the document, if any. */
  heldText(path: string): string | undefined
  /** Text that is not on disk and that the registry does not hold yet. */
  keep(path: string, text: string): void
}

/**
 * Main wrote `file` and returned it. `lastKnown` is the buffer's text as last read, for when there is
 * no buffer to read now because the app was unmounted meanwhile: if it is not what is on disk and the
 * registry holds nothing for the document, it is kept. A returned file never clears text.
 */
export function mainWroteDocument(ports: MainWrotePorts, file: FileReadResult, lastKnown?: string): void {
  const path = file.file.path
  ports.setBaseline(path, file.content)
  const now = ports.bufferOf(path)
  if (now != null) ports.setDirty(path, isTextChange(file.content, now), now)
  else if (lastKnown !== undefined && isTextChange(file.content, lastKnown) && ports.heldText(path) === undefined) ports.keep(path, lastKnown)
}

export type AcceptRedoPorts = MainWrotePorts & {
  /** The unsaved registry's hold: a close waits until the release is called. */
  hold(path: string): () => void
  /** The disk is not known for the document, whose latest text is `text` (the registry's `unknown`). */
  unknown(path: string, text: string): void
  /** False once the app has been unmounted by an error. */
  editorPresent(): boolean
  api: Pick<WriteFlexApi, 'saveFile' | 'resolveChange'>
  flash(message: string): void
  /** e2e only: holds the calls to main until released, inside the hold. */
  gate?(): Promise<void>
}

const NOT_REPLAYED = 'Could not replay that suggestion resolution.'

/** True when main holds the accept. */
export async function replayAcceptRedo(ports: AcceptRedoPorts, effect: Pick<SuggestionResolutionEffect, 'id' | 'path' | 'beforeContent'>): Promise<boolean> {
  const { id, path, beforeContent } = effect
  // Read in the turn of the redo, while the editor is certainly there: the redone text.
  const atStart = ports.bufferOf(path)
  // The latest text of the document there is to keep. With the app unmounted that is what the registry
  // holds, or else the text read at the start. With the app mounted and no buffer, the tab was closed
  // meanwhile and there is no text of it in the window.
  const latestText = (): string | null => ports.bufferOf(path) ?? (ports.editorPresent() ? null : ports.heldText(path) ?? atStart)
  const diskUnknown = (): void => {
    const text = latestText()
    if (text != null) ports.unknown(path, text)
  }
  const release = ports.hold(path)
  try {
    if (ports.gate) await ports.gate() // without one the first call to main is made in this turn
    if (beforeContent !== undefined) {
      const restored = await ports.api.saveFile(path, beforeContent)
      if ('refused' in restored) {
        ports.flash(restored.message) // refused before anything was written: the disk is as it was
        return false
      }
    }
    const result = await ports.api.resolveChange(id, 'accept')
    if (!result.applied) {
      if (beforeContent !== undefined) diskUnknown() // the pre-accept text was put back: not what the baseline says
      ports.flash(result.message ?? NOT_REPLAYED)
      return false
    }
    if (!result.file) diskUnknown() // applied, and not read back
    else mainWroteDocument(ports, result.file, ports.editorPresent() ? undefined : atStart ?? undefined)
    return true
  } catch {
    // A call that threw may have written all the same.
    diskUnknown()
    ports.flash(`Could not save ${path.split('/').at(-1) ?? path}.`)
    return false
  } finally {
    release()
  }
}
