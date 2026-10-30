export type ReadingRoomNoticeProps = {
  /** Highlights, edits and deletions still owed to Zotero. The notice is not drawn at zero. */
  waiting: number
  /** The main process's own sentence from the last refused write, or null. */
  refusal: string | null
  /** Which refusal it was. Zotero closed or busy is the ordinary wait; the plugin codes ask him to
   *  install the plugin; anything else is shown as an error. */
  refusalCode: string | null
  onSync: () => void
  /** Reveal the WriteFlex plugin file shipped with the app, for him to install in Zotero. */
  onShowPlugin?: () => void
}

/** Refusals that only mean "not yet": the highlights go when Zotero is open and answering. */
const WAITING_CODES = new Set(['zotero-closed', 'zotero-busy'])
/** Refusals he fixes by installing the bundled plugin in Zotero. */
const INSTALL_CODES = new Set(['plugin-missing', 'plugin-outdated'])

export const PLUGIN_INSTALL_SENTENCE =
  'To send highlights to Zotero, install the WriteFlex plugin in Zotero: Tools, Plugins, then install from file.'

function highlights(count: number): string {
  return count === 1 ? '1 highlight' : `${count} highlights`
}

/**
 * The Room's one line about Zotero. Three states, all quiet, none a modal:
 *
 * - **Waiting** — the ordinary case, Zotero is not open: "N highlights waiting for Zotero. They are
 *   sent when Zotero is open." The main process looks for Zotero every few seconds and sends then.
 * - **Plugin needed** — Zotero is open without the WriteFlex plugin (or with an old one): says how to
 *   install it and shows the plugin file.
 * - **Failed** — anything else (the plugin did not accept WriteFlex's key, say): says so with the main
 *   process's sentence and offers to try again. The highlights are still saved here.
 */
export function ReadingRoomNotice({
  waiting,
  refusal,
  refusalCode,
  onSync,
  onShowPlugin,
}: ReadingRoomNoticeProps): JSX.Element | null {
  if (waiting <= 0) return null
  if (refusalCode && INSTALL_CODES.has(refusalCode)) {
    return (
      <p className="reading-room-notice reading-room-notice-error" role="alert">
        <span>
          <strong>{highlights(waiting)} waiting for Zotero.</strong>
          {' '}
          {PLUGIN_INSTALL_SENTENCE}
        </span>
        {onShowPlugin && <button type="button" onClick={onShowPlugin}>Show plugin file</button>}
      </p>
    )
  }
  const failed = !!refusal && !!refusalCode && !WAITING_CODES.has(refusalCode)
  if (failed) {
    return (
      <p className="reading-room-notice reading-room-notice-error" role="alert">
        <span>
          <strong>{highlights(waiting)} could not be written to Zotero.</strong>
          {' '}
          {refusal}
        </span>
        <button type="button" onClick={onSync}>Try again</button>
      </p>
    )
  }
  return (
    <p className="reading-room-notice" role="status" aria-live="polite">
      <span>
        <strong>{highlights(waiting)} waiting for Zotero.</strong>
        {' '}
        {waiting === 1 ? 'It is' : 'They are'} sent when Zotero is open.
      </span>
      <button type="button" onClick={onSync}>Sync now</button>
    </p>
  )
}
