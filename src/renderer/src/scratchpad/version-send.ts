// Sending a copy of text from a saved Folio version to the Scratchpad (ADR-0052 § Sending text to the Scratchpad; Folio versions ticket 10).
// The read-only view and Compare draw the text; this module is the one place the window asks main to send it. It sends NUMBERS (a version, a
// part and a range of paragraphs); main reads the saved text itself and writes the Scratchpad item. Nothing here writes a file.
//
// App registers where the status line is and which folder the window is bound to (`registerVersionSendHost`); the read-only view and Compare
// register what is selected in them (`registerVersionSelection`) so the existing "Send a copy to Scratchpad" command can send it.
import { VERSION_SEND_UNAVAILABLE, VERSION_SEND_UNDONE, versionSentText, type VersionTextSide } from '../../../shared/folio-version-scratchpad'

export type VersionSendHost = {
  /** The folder this window is bound to now. */
  root: () => string | null
  /** The status line, with an optional Undo. */
  say: (message: string, action?: { label: string; run: () => void }) => void
}

let host: VersionSendHost | null = null
export function registerVersionSendHost(next: VersionSendHost): () => void {
  host = next
  return () => { if (host === next) host = null }
}

/** One selection in the version being read or compared: which text, and which paragraphs of it. */
export type VersionSelection = { dir: string; id: string; path: string; side: VersionTextSide; from: number; to: number }

export type SendOutcome = 'sent' | 'failed'

/** Ask main to send the paragraphs; say what happened. The Undo withdraws the unused card (`discardCopy`) and nothing else. */
export async function sendVersionSelection(selection: VersionSelection): Promise<SendOutcome> {
  const root = host?.root() ?? null
  if (!host || root === null) { host?.say(VERSION_SEND_UNAVAILABLE); return 'failed' }
  const reply = await window.writeflex.folioVersions.sendText({ root, ...selection }).catch(() => null)
  if (!reply) { host.say(VERSION_SEND_UNAVAILABLE); return 'failed' }
  if (!reply.ok) { host.say(reply.error); return 'failed' }
  const id = reply.item.id
  host.say(versionSentText(reply.from, reply.to), {
    label: 'Undo',
    run: () => { void withdrawCopy(id) },
  })
  return 'sent'
}

/** Take back a copy that nothing has used (the Undo of a send, and of "keep mine"). */
export async function withdrawCopy(id: string): Promise<boolean> {
  const root = host?.root() ?? null
  if (!host || root === null) return false
  const undone = await window.writeflex.scratchpad.discardCopy({ root, id }).catch(() => null)
  host.say(undone?.ok ? VERSION_SEND_UNDONE : `The copy was kept: ${undone && !undone.ok ? undone.error : 'the Scratchpad did not answer.'}`)
  return undone?.ok === true
}

/** What the read-only view or Compare has selected, for the command. */
let selectionOf: (() => VersionSelection | null) | null = null
export function registerVersionSelection(read: () => VersionSelection | null): () => void {
  selectionOf = read
  return () => { if (selectionOf === read) selectionOf = null }
}

/**
 * The "Send a copy to Scratchpad" command (palette, menu, chord) while a saved version is on screen: sends the selection there.
 * `not-reading` when no version is on screen (the editor's own sender handles the command); `none` when one is, with nothing selected.
 */
export async function sendVersionSelectionFromCommand(): Promise<'sent' | 'failed' | 'none' | 'not-reading'> {
  if (!selectionOf) return 'not-reading'
  const selection = selectionOf()
  if (!selection) { host?.say('Select text in the saved version first, or use the icon beside a paragraph, then send a copy to the Scratchpad.'); return 'none' }
  return sendVersionSelection(selection)
}
