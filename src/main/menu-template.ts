import type { MenuItem, MenuItemConstructorOptions } from 'electron'
import { NO_NATIVE_ACCELERATOR, toAccelerator, type MenuFocus, type CommandMenuItem } from '../shared/command-menu'
import { NATIVE_EDIT_ROLE_CHORDS, NO_RECENTS_LABEL, NATIVE_EDIT_LABELS } from '../shared/native-menu-commands'

const EDIT_ROLES = ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'] as const

/** Only the fixed native frame lives here; every app action comes from the model. Menus are found by id, never by title. */
export function buildMenuTemplate(model: readonly CommandMenuItem[], run: (id: string) => void, recents: MenuItemConstructorOptions[], focus: MenuFocus = 'editor'): MenuItemConstructorOptions[] {
  const identity = (accelerator?: string) => accelerator?.split('+').sort().join('+')
  const claimed = new Set<string | undefined>()
  const remember = (nodes: readonly CommandMenuItem[]): void => {
    for (const node of nodes) { if (node.accelerator) claimed.add(identity(node.accelerator)); if (node.submenu) remember(node.submenu) }
  }
  remember(model)
  const adapt = (node: CommandMenuItem): MenuItemConstructorOptions => {
    const { sourceLabel: _source, checked, role: modelRole, nativeAccelerator, submenu: _submenu, menu: _menu, ...rest } = node
    const history = node.id === 'edit.undo' || node.id === 'edit.redo'
    const role = focus === 'plain-text-field' && history ? node.id!.slice('edit.'.length) : modelRole
    return {
      ...rest,
      role: role as MenuItemConstructorOptions['role'],
      ...(checked === undefined ? {} : { type: 'checkbox', checked }),
      registerAccelerator: Boolean(role) || nativeAccelerator === true,
      // A role keeps Electron's own behaviour (About opens the native panel).
      ...(node.id && (!role || history) ? { click: (item: MenuItem) => {
        // Electron toggles before dispatch. The renderer's live check remains authoritative, even if it refuses the action.
        if (checked !== undefined) item.checked = checked
        run(node.id!)
      } } : {}),
      ...(node.submenu ? { submenu: node.submenu.map(adapt) } : {}),
      ...(node.id === 'app.openRecent' ? { submenu: recents.length ? recents : [{ label: NO_RECENTS_LABEL, enabled: false }] } : {}),
    }
  }
  return model.map(node => {
    const submenu = (node.submenu ?? []).map(adapt)
    if (node.menu === 'app') submenu.push({ type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' })
    if (node.menu === 'edit') {
      // The native text roles follow Redo (or lead the menu when the model has no history items).
      const redo = submenu.findIndex(item => item.id === 'edit.redo')
      const at = redo < 0 ? submenu.findIndex(item => item.id === 'edit.undo') + 1 : redo + 1
      const more = submenu.length > at
      const textItems: MenuItemConstructorOptions[] = EDIT_ROLES.map(role => {
        if (focus === 'plain-text-field') return { label: NATIVE_EDIT_LABELS[role], role }
        const chord = NATIVE_EDIT_ROLE_CHORDS[role]
        return {
          label: NATIVE_EDIT_LABELS[role],
          // Keep text operations on the current responder, without a role swallowing app history clicks.
          click: (_item, window) => {
            if (window && 'webContents' in window) (window as Electron.BrowserWindow).webContents[role]()
          },
          ...(chord ? {
            accelerator: focus === 'editor' && claimed.has(identity(toAccelerator(chord))) ? NO_NATIVE_ACCELERATOR : toAccelerator(chord),
            registerAccelerator: false,
          } : {}),
        }
      })
      submenu.splice(at, 0, ...(at > 0 ? [{ type: 'separator' as const }] : []), ...textItems, ...(more ? [{ type: 'separator' as const }] : []))
    }
    if (node.menu === 'window') submenu.push({ role: 'minimize' }, { role: 'zoom' }, { role: 'front' })
    return { ...adapt(node), ...(node.menu === 'help' ? { role: 'help' as const } : node.menu === 'window' ? { role: 'windowMenu' as const } : {}), submenu }
  })
}
