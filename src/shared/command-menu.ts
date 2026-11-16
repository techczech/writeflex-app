export type MenuFocus = 'editor' | 'plain-text-field' | 'other'

/** Explicitly suppress an Electron role's default key; undefined would restore its default. */
export const NO_NATIVE_ACCELERATOR = ''

/** Serializable menu seam: the renderer resolves registry metadata, chords and live state. */
export type MenuCommand = {
  id: string; label: string; task: string; subgroup: string; chord?: string
  enabled: boolean; nativeAccelerator?: boolean; checked?: boolean; noMenu?: string
}
export type CommandMenuItem = {
  /** Names a top-level menu, so the native frame finds it without matching its title. */
  menu?: string
  label?: string; id?: string; sourceLabel?: string; accelerator?: string
  enabled?: boolean; nativeAccelerator?: boolean; checked?: boolean; role?: string; type?: 'separator'
  submenu?: CommandMenuItem[]
}

/** Labels for the menu bar only; contextual surfaces retain the registry wording. */
export const MENU_BAR_LABELS: Readonly<Record<string, string>> = {
  'file.open': 'Show in Files List',
  'file.reveal': 'Reveal File in Finder',
  'folder.reveal': 'Reveal Folder in Finder',
  'folder.focus': 'Focus on This Folder',
  'folder.rename': 'Rename Folder',
  'file.rename': 'Rename File',
  'file.duplicate': 'Duplicate File',
  'file.pin': 'Pin File as Favourite',
  'file.copyPath': 'Copy File Path',
  'folder.newFile': 'New File in This Folder',
  'folder.newFolder': 'New Subfolder…',
  'block.edit': 'Edit Block',
  'folder.helpWithReport': 'Help with Report in This Folder',
}

/** Commands shown first, at the top level of their menu, in this order (not inside a sub-group submenu). */
export const MENU_TOP_LEVEL: Record<string, readonly string[]> = {
  File: ['file.new', 'folder.new', 'window.new', 'app.open', 'app.openRecent', 'app.quickOpen', 'file.checkpoint', 'file.nameVersion', 'tab.close'],
}

/** Items that keep an Electron role (its own behaviour) while their label and place still come from the registry. */
export const MENU_ROLE_ITEMS: Readonly<Record<string, string>> = { 'app.about': 'about' }

/** Placement is data; task names remain the ADR-0043 vocabulary. Edit holds only history and the native text roles; the other version operations stay in Review with their sub-group, so no sub-group is split across menus. */
export const MENU_PLACEMENT = [
  { menu: 'app', label: 'WriteFlex', ids: ['app.about', 'app.settings', 'app.checkForUpdates', 'app.whatsNew'], tasks: [] },
  { menu: 'file', label: 'File', ids: [...MENU_TOP_LEVEL.File], tasks: ['Find and manage files'] },
  { menu: 'edit', label: 'Edit', ids: ['edit.undo', 'edit.redo'], tasks: [] },
  { menu: 'write', label: 'Write', ids: [], tasks: ['Write'] },
  { menu: 'structure', label: 'Structure', ids: [], tasks: ['Shape the document'] },
  { menu: 'review', label: 'Review', ids: [], tasks: ['Review and versions'] },
  { menu: 'collect', label: 'Collect', ids: [], tasks: ['Collect and plan'] },
  { menu: 'agent', label: 'Agent', ids: [], tasks: ['Work with the agent'] },
  { menu: 'share', label: 'Share', ids: [], tasks: ['Share and export'] },
  { menu: 'view', label: 'View', ids: [], tasks: ['Stay focused', 'Listen', 'Set up WriteFlex'] },
  { menu: 'window', label: 'Window', ids: [], tasks: [] },
  { menu: 'help', label: 'Help', ids: ['guide.open', 'app.shortcuts', 'app.commandPalette', 'app.actionsHere', 'example.restore'], tasks: [] },
] as const

export function toAccelerator(chord?: string): string | undefined {
  if (!chord || !/[⌃⌥⌘]/.test(chord)) return undefined
  const mods: Record<string, string> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'CmdOrCtrl' }
  const keys: Record<string, string> = { '+': 'Plus', '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down', '⌫': 'Backspace', '⇥': 'Tab', '↵': 'Enter', 'Esc': 'Escape' }
  const parts: string[] = []
  while (chord.length > 1 && mods[chord[0]]) { parts.push(mods[chord[0]]); chord = chord.slice(1) }
  if (!(chord in keys) && !/^[A-Z0-9,.;'`/\\\[\]\-=]$/.test(chord) && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(chord)) return undefined
  return [...parts, keys[chord] ?? chord].join('+')
}

const FAMILY_PREFIXES = [
  'Outline: Show levels ', 'Insert heading, level ', 'List type: ', 'Ruler: ', 'Line focus: ',
  'Ruler opacity: ', 'Fixed line: ', 'Read-aloud highlight: ', 'Read aloud highlight: ', 'Folio workspace: ', 'Export preset: ',
]
function family(command: MenuCommand): { name: string; label: string } | undefined {
  if (command.id === 'outline.showAllLevels') return { name: 'Outline: Show levels', label: command.label.slice('Outline: Show '.length) }
  const prefix = FAMILY_PREFIXES.find(p => command.label.startsWith(p))
  if (prefix) return { name: prefix.replace(/[: ,]+$/, ''), label: command.label.slice(prefix.length) }
  if (command.id.startsWith('exportPresets.')) return { name: 'Export presets', label: command.label.replace(/\s*export presets?:?\s*/i, ' ').trim() }
  return undefined
}
function subgroup(c: MenuCommand, menu: string): string {
  if (menu !== 'Collect') return c.subgroup
  if (/^(folio\.|plan\.|title\.)/.test(c.id) || c.id === 'collection.startFolio') return 'Folio'
  if (c.subgroup === 'Sources' || c.subgroup === 'Reading Room') return 'Sources and Reading Room'
  if (c.subgroup === 'Capture ideas') return 'Ideas'
  return 'Collections'
}

export function buildCommandMenu(commands: readonly MenuCommand[]): CommandMenuItem[] {
  const listed = commands.filter(c => {
    if (c.noMenu !== undefined && !c.noMenu.trim()) throw new Error(`Empty noMenu reason: ${c.id}`)
    return c.noMenu === undefined
  })
  const explicit = new Map<string, string>(MENU_PLACEMENT.flatMap(m => m.ids.map(id => [id, m.label] as [string, string])))
  const placement = (c: MenuCommand): string => explicit.get(c.id)
    ?? MENU_PLACEMENT.find(m => (m.tasks as readonly string[]).includes(c.task))?.label
    ?? 'File'
  const item = (c: MenuCommand): CommandMenuItem => {
    const role = MENU_ROLE_ITEMS[c.id]
    return { id: c.id, label: MENU_BAR_LABELS[c.id] ?? c.label, sourceLabel: c.label, accelerator: toAccelerator(c.chord), enabled: role ? true : c.enabled, nativeAccelerator: c.nativeAccelerator, checked: c.checked, ...(role ? { role } : {}) }
  }
  return MENU_PLACEMENT.map(menu => {
    const groups = new Map<string, MenuCommand[]>()
    const placed = listed.filter(c => placement(c) === menu.label)
    const ordered = ['WriteFlex', 'Help', 'Edit'].includes(menu.label)
      ? [...placed].sort((a, b) => {
        const ids: readonly string[] = menu.ids
        const rank = (id: string) => { const index = ids.indexOf(id); return index < 0 ? ids.length : index }
        return rank(a.id) - rank(b.id)
      }) : placed
    for (const c of ordered) {
      const group = subgroup(c, menu.label)
      groups.set(group, [...(groups.get(group) ?? []), c])
    }
    const children: CommandMenuItem[] = []
    const top = MENU_TOP_LEVEL[menu.label] ?? []
    const topCommands = top.flatMap(id => placed.filter(c => c.id === id))
    children.push(...topCommands.map(item))
    if (topCommands.length) children.push({ type: 'separator' })
    for (const [label, all] of groups) {
      const grouped = all.filter(c => !topCommands.includes(c))
      const fixed = menu.label === 'Edit' ? grouped.filter(c => ['edit.undo', 'edit.redo'].includes(c.id)) : []
      children.push(...fixed.map(item))
      const entries = grouped.filter(c => !fixed.includes(c))
      if (!entries.length) continue
      const contents: CommandMenuItem[] = []
      const families = new Map<string, CommandMenuItem>()
      for (const c of entries) {
        const f = family(c)
        if (!f) { contents.push(item(c)); continue }
        let parent = families.get(f.name)
        if (!parent) { parent = { label: f.name, submenu: [] }; families.set(f.name, parent); contents.push(parent) }
        parent.submenu!.push({ ...item(c), label: f.label })
      }
      if (['WriteFlex', 'Help'].includes(menu.label) || (entries.length <= 3 && menu.label !== 'Collect' && label !== 'Scratchpad')) {
        if (children.length && children[children.length - 1].type !== 'separator') children.push({ type: 'separator' })
        children.push(...contents)
      } else children.push({ label, submenu: contents })
    }
    return { menu: menu.menu, label: menu.label, submenu: children }
  })
}
