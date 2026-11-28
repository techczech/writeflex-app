import { askConfirm } from '../components/confirm-bus'
import type { ExternalDiskNotice } from '../editor/reconcile'
import type { DocumentOwner } from './document-owner'

type TabClosePorts = {
  owner: DocumentOwner
  currentPath?(): string
  notice(path: string): ExternalDiskNotice | undefined
  isCurrentTab(path: string): boolean
  checkpoint(path: string): Promise<void>
  closeForgotten(path: string): void
  saveRefusalReported(path: string): boolean
  flash(message: string): void
}

export async function closeDocumentTab(initialPath: string, ports: TabClosePorts): Promise<void> {
  const { owner, closeForgotten, flash } = ports
  const currentPath = ports.currentPath ?? (() => initialPath)
  // A Collection relocation can finish while close is waiting for the owner's queue. Ask for
  // the current path at each flush round and checkpoint only the path still being closed.
  const flushClose = () => owner.withFlushed(() => [currentPath()], () => {
    const path = currentPath()
    if (!owner.forgetIfSaved(path)) return false
    closeForgotten(path)
    return true
  }, {
    detach: true,
    afterSave: async (path) => { if (path === currentPath()) await ports.checkpoint(path) },
  })
  let attempted = currentPath()
  let flushed = await flushClose()
  while (flushed.status !== 'acted' && attempted !== currentPath()) {
    attempted = currentPath()
    flushed = await flushClose()
  }
  const path = currentPath()
  const fileName = path.split('/').at(-1) ?? path
  if (flushed.status === 'refused') {
    // Under a removal notice, Keep mine writes the file again and closing can discard the buffer
    // only through explicit confirmation.
    const notice = ports.notice(path)
    if (notice?.kind === 'removed') {
      const discard = owner.prepareRemovedDiscard(path, notice, () => path === currentPath() && ports.isCurrentTab(path))
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
      closeForgotten(path)
      flash(`Closed ${fileName}; the text that was only in the tab was discarded`)
      return
    }
    if (!ports.saveRefusalReported(path)) flash(`Could not save ${fileName} — the tab stays open`)
    return
  }
  if (flushed.status === 'still-unsaved' || !flushed.result) {
    flash(`${fileName} was still being edited while it was saved — the tab stays open`)
  }
}
