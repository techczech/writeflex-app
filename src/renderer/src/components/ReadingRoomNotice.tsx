export type ReadingRoomNoticeProps = {
  refusal: string
  onSync: () => void
}

export function ReadingRoomNotice({
  refusal,
  onSync,
}: ReadingRoomNoticeProps): JSX.Element {
  return (
    <p className="reading-room-notice" role="status" aria-live="polite">
      <span>
        <strong>Saved here, waiting for Zotero.</strong>
        {' '}
        {refusal}
      </span>
      <button type="button" onClick={onSync}>Sync now</button>
    </p>
  )
}
