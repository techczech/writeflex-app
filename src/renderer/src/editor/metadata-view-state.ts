type ReadStorage = Pick<Storage, 'getItem'>
type WriteStorage = Pick<Storage, 'setItem'>
const keyOf = (workspace: string) => `writeflex:metadata:collapsed:${workspace}`
export const METADATA_VIEW_EVENT = 'writeflex:metadata-view'
export function metadataCollapsed(workspace: string, storage: ReadStorage = localStorage): boolean {
  try { return storage.getItem(keyOf(workspace)) === 'true' } catch { return false }
}
export function rememberMetadataCollapsed(workspace: string, collapsed: boolean, storage: WriteStorage = localStorage): void {
  try { storage.setItem(keyOf(workspace), String(collapsed)) } catch { /* Session still works without storage. */ }
}
export function setMetadataCollapsed(workspace: string, collapsed: boolean): void {
  rememberMetadataCollapsed(workspace, collapsed)
  window.dispatchEvent(new CustomEvent(METADATA_VIEW_EVENT, { detail: { workspace, collapsed } }))
}
export function metadataWorkspace(element: HTMLElement): string {
  return element.closest<HTMLElement>('[data-metadata-workspace]')?.dataset.metadataWorkspace ?? ''
}
