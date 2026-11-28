import type { CollectionPageCommand } from './collection-page-commands'

const controls = ['search', 'search-in', 'status', 'purpose', 'tags', 'modified', 'group', 'sort'] as const
export type CollectionControl = typeof controls[number]

export function isCollectionControl(command: CollectionPageCommand): command is CollectionControl {
  return controls.some(control => control === command)
}

export function findCollectionControl(root: ParentNode | null, name: CollectionControl): HTMLElement | null {
  const control = root?.querySelector<HTMLElement>(`[data-collection-control="${name}"]`)
  if (!control || control.matches(':disabled') || control.closest('[inert]')
    || control.getClientRects().length === 0 || getComputedStyle(control).visibility !== 'visible') return null
  return control
}

export function focusCollectionControl(control: HTMLElement): void {
  if (!(control instanceof HTMLDetailsElement)) {
    control.focus()
    return
  }
  control.open = true
  // The summary stays mounted as the listing (and its facet choices) arrives.
  const destination = control.querySelector<HTMLElement>('input[type="checkbox"]:enabled') ?? control.querySelector('summary')
  destination?.focus()
}
