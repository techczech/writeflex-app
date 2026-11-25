import { askConfirm } from '../components/confirm-bus'
import type { ExternalDiskNotice } from '../editor/reconcile'
import type { DocumentOwner } from './document-owner'

type TabClosePorts = {
  owner: DocumentOwner
  notice(): ExternalDiskNotice | undefined
  isCurrentTab(): boolean
  checkpoint(path: string): Promise<void>
  closeForgotten(): void
  saveRefusalReported(): boolean
  flash(message: string): void
}

export async function closeDocumentTab(path: string, ports: TabClosePorts): Promise<void> {
  const { owner, closeForgotten, flash } = ports
  const fileName = path.split('/').at(-1) ?? path
  // Flush through the owner and send the close checkpoint (ADR-0013). The owner detaches the
  // buffer and forgets it only if it is saved and still matches the snapshot the close holds.
  const flushed = await owner.withFlushed([path], () => {
    if (!owner.forgetIfSaved(path)) return false
    closeForgotten()
    return true
  }, { detach: true, afterSave: ports.checkpoint })
  if (flushed.status === 'refused') {
    // Under a removal notice, Keep mine writes the file again and closing can discard the buffer
    // only through explicit confirmation.
    const notice = ports.notice()
    if (notice?.kind === 'removed') {
      const discard = owner.prepareRemovedDiscard(path, notice, ports.isCurrentTab)
      if (!discard) {
        flash(`Could not close ${fileName}. Its text is still available. Try closing the tab again.`)
        return
      }
      const confirmed = await askConfirm({
        title: `Close ${fileName} and discard its text?`,
        detail: `${fileName} was removed on disk, and this tab holds text that is not saved anywhere.`,
        recover: 'Cancel keeps the tab; Keep mine above the text writes the file again.',
        confirmLabel: 'Discard and close',
      })
      if (!confirmed) return
      if (!discard()) {
        flash(`${fileName} changed while the card was open. Nothing was discarded. Please try closing the tab again.`)
        return
      }
      closeForgotten()
      flash(`Closed ${fileName}; the text that was only in the tab was discarded`)
      return
    }
    if (!ports.saveRefusalReported()) flash(`Could not save ${fileName} — the tab stays open`)
    return
  }
  if (flushed.status === 'still-unsaved' || !flushed.result) {
    flash(`${fileName} was still being edited while it was saved — the tab stays open`)
  }
}
