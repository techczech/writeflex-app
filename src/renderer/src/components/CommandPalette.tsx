import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Folder, Search, Settings, Sparkles, type LucideIcon } from 'lucide-react'
import type { MarkdownFile, SkillMeta } from '../../../preload'
import { isPathInSearchScope } from '../../../shared/search-scope'
import { fuzzyFilter, fuzzyScore } from '../fuzzy'
import { AgentLaunchIcon, orderSkills, skillDisplayName } from './AgentSkillSurfaces'
import { launchesAgent } from './agent-icon'
import type { TaskGroup } from '../commands/command-task-groups'
import { NO_CHECKLIST_PROGRESS, type ChecklistProgressMap } from '../hooks/useChecklistProgress'
import { ChecklistProgressChip } from './ChecklistProgressChip'

/**
 * A palette-facing command. App builds the list (mapping the editor's `paletteCommands` plus its own
 * app-level actions to icons + display shortcuts), so the palette stays a pure renderer: it never
 * reaches into the editor or workspace itself.
 */
export type AppCommand = {
  id: string
  label: string
  /** The command's task group: the label under its name on the palette row. */
  group: TaskGroup
  /** The sub-group inside the task group. Searchable, never rendered: typing "read aloud" still finds the Listen commands. */
  subgroup?: string
  icon: LucideIcon
  /** Extra searchable terms that are not rendered as chrome. */
  keywords?: string[]
  /** One line under the name in place of the group, for a command whose name alone does not say what it does. */
  hint?: string
  /** Queries (whole, lower case) for which this command is listed before every other match. */
  leadsFor?: string[]
  /** Display shortcut hint shown on the row, already in mac glyph form (e.g. '⌘E'); omitted when none. */
  keys?: string
  disabled?: boolean
  disabledReason?: string
  /** A toggle's state, shown on the row as On / Off (Writing only, Show titles in sidebar). Absent: not a toggle. */
  checked?: boolean
  run: () => void
}

type CommandPaletteProps = {
  /** Text already typed when the sheet opens (Actions here hands over what the writer typed). */
  initialQuery?: string
  /** 'files' = quick-open (⇧⌘K): fuzzy over workspace files. 'commands' = palette (⇧⌘P): the command list. */
  mode: 'files' | 'commands'
  /** Workspace files (relative POSIX paths), for files mode. */
  files: MarkdownFile[]
  /** Checklist notes' "done / total" (checkbox-lists frame 8), shown beside their file rows. */
  checklistProgress?: ChecklistProgressMap
  /** Workspace folders (relative POSIX paths), for files mode. */
  folders: string[]
  /** The command list, for commands mode. */
  commands: AppCommand[]
  /** The shared registry objects used by the Threads switcher, in App-owned state. */
  skills: SkillMeta[]
  /** Active Workspace-relative document path, or null when the workspace has no open document. */
  activeFile: string | null
  /** Command ids most-recently-used first — floats them to a Recent section on an empty query. */
  recentIds: string[]
  /** Run a command: App records it as recent, runs it, and closes the sheet. */
  onRun: (command: AppCommand) => void
  /** Open a file into a tab (files mode): App opens it and closes the sheet. */
  onOpenFile: (path: string) => void
  /** Reveal a file in the Files tree without opening it. */
  onRevealFile: (path: string) => void
  /** Reveal, expand, and focus a folder in the Files tree. */
  onRevealFolder: (path: string) => void
  /** Focus a folder (ticket 03): the tree narrows to it and search scopes to it. ⌘↵ on a folder
   *  row, or the row's Focus control. */
  onFocusFolder?: (path: string) => void
  /** The ask-row (commands mode, Task 15): hand the typed text to the agent composer — App closes
   *  the sheet, opens the agent panel and prefills the console (it does NOT send). */
  onAskAgent: (text: string) => void
  /** Run a skill as-is. App closes the palette before crossing the preload bridge. */
  onRunSkill: (name: string) => void
  /** Open a skill-bound thread. App closes the palette and reveals the Agent pane. */
  onOpenSkill: (name: string) => void
  /** Open the one skills manager surface (B5 owns the current no-op seam). */
  onManageSkills: () => void
  /** Dismiss the sheet (Esc, backdrop click). */
  onClose: () => void
}

/** A selectable palette row (arrow navigation flattens these across sections). */
export type PaletteItem =
  | { kind: 'file'; key: string; file: MarkdownFile }
  | { kind: 'folder'; key: string; path: string; name: string }
  | { kind: 'command'; key: string; command: AppCommand }
  | { kind: 'skill'; key: string; skill: SkillMeta; disabled: boolean }
  | { kind: 'manage-skills'; key: string }
  | { kind: 'ask'; key: string; query: string }

export type PaletteSection = { label: string; items: PaletteItem[] }

export type RankableEntry<T> = {
  item: T
  /** The name alone. A query that matches it whole ranks above any match that needs the group or keywords. */
  label: string
  /** Name, group, keywords: the text a query may also match through. */
  searchable: string
  /** Matched only when nothing else does. */
  fallback: string | undefined
  /** Queries for which this entry leads the list. */
  leadsFor?: string[]
  /** Registration order, the last tie-break. */
  order: number
}

/**
 * Ranks palette entries for a typed query. Tier 0: the label alone matches the whole query (by label
 * score). Tier 1: only the label with group and keywords matches (by full-text score). Tier 2: only
 * the sub-group matches. Ties fall to registration order.
 */
export function rankPaletteEntries<T>(query: string, entries: RankableEntry<T>[]): T[] {
  const typed = query.trim().toLowerCase()
  return entries
    .map((entry) => {
      // Tier -1: a command that names this very query as its lead ("review" lists Settled today and My edits first).
      if (entry.leadsFor?.includes(typed)) return { entry, score: 0, tier: -1 }
      const byLabel = fuzzyScore(query, entry.label)
      if (byLabel !== null) return { entry, score: byLabel, tier: 0 }
      const direct = fuzzyScore(query, entry.searchable)
      if (direct !== null) return { entry, score: direct, tier: 1 }
      const viaFallback = entry.fallback ? fuzzyScore(query, entry.fallback) : null
      return { entry, score: viaFallback, tier: 2 }
    })
    .filter((ranked): ranked is typeof ranked & { score: number } => ranked.score !== null)
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.entry.order - b.entry.order)
    .map((ranked) => ranked.entry.item)
}

export function buildCommandPaletteSections({
  mode,
  query,
  files,
  folders,
  commands,
  skills,
  activeFile,
  recentIds,
}: {
  mode: 'files' | 'commands'
  query: string
  files: MarkdownFile[]
  folders: string[]
  commands: AppCommand[]
  skills: SkillMeta[]
  activeFile: string | null
  recentIds: string[]
}): PaletteSection[] {
  const q = query.trim()
  if (mode === 'files') {
    const searchableFiles = files.filter((file) => isPathInSearchScope(file.path))
    const searchableFolders = folders.filter(isPathInSearchScope)
    const byPath = new Map(searchableFiles.map((file) => [file.path, file]))
    const fileItems: PaletteItem[] = fuzzyFilter(q, searchableFiles.map((file) => file.path))
      .map((path) => byPath.get(path))
      .filter((file): file is MarkdownFile => file != null)
      .map((file) => ({ kind: 'file', key: file.path, file }))
    const folderItems: PaletteItem[] = fuzzyFilter(q, searchableFolders)
      .map((path) => ({ kind: 'folder', key: path, path, name: path.split('/').at(-1) ?? path }))
    const sections: PaletteSection[] = []
    if (fileItems.length) sections.push({ label: 'Files', items: fileItems })
    if (folderItems.length) sections.push({ label: 'Folders', items: folderItems })
    return sections
  }

  const orderedSkills = orderSkills(skills)
  const skillItem = (skill: SkillMeta): PaletteItem => ({
    kind: 'skill',
    key: `skill:${skill.name}`,
    skill,
    disabled: skill.input === 'document' && activeFile === null,
  })
  if (q) {
    const ranked = rankPaletteEntries(q, [
      ...commands.map((command, order) => ({
        item: { kind: 'command', key: command.id, command } as PaletteItem,
        label: command.label,
        searchable: [command.label, command.group, ...(command.keywords ?? [])].join(' '),
        // Matches through the sub-group alone ("read aloud" for the Listen commands) rank below every other match.
        fallback: command.subgroup as string | undefined,
        leadsFor: command.leadsFor,
        order,
      })),
      ...orderedSkills.map((skill, order) => ({
        item: skillItem(skill),
        label: skillDisplayName(skill),
        searchable: `${skillDisplayName(skill)} ${skill.description}`,
        fallback: undefined,
        order: commands.length + order,
      })),
    ])
    const out: PaletteSection[] = ranked.length ? [{ label: 'Results', items: ranked }] : []
    out.push({ label: 'Agent', items: [{ kind: 'ask', key: '__ask', query: q }] })
    return out
  }

  const activeName = activeFile?.split('/').at(-1)
  const skillRows: PaletteItem[] = [
    ...orderedSkills.map(skillItem),
    { kind: 'manage-skills', key: '__manage-skills' },
  ]
  const recentRank = new Map(recentIds.map((id, index) => [id, index]))
  const recent = commands
    .filter((command) => recentRank.has(command.id))
    .sort((a, b) => (recentRank.get(a.id) ?? 0) - (recentRank.get(b.id) ?? 0))
  const rest = commands.filter((command) => !recentRank.has(command.id))
  const out: PaletteSection[] = []
  if (recent.length) {
    out.push({ label: 'Recent', items: recent.map((command) => ({ kind: 'command', key: command.id, command })) })
  }
  out.push({ label: 'Commands', items: rest.map((command) => ({ kind: 'command', key: command.id, command })) })
  out.push({
    label: activeName ? `Skills — on ${activeName}` : 'Skills',
    items: skillRows,
  })
  return out
}

/**
 * ONE sheet, two modes (Task 13, mockup `#palette`). ⇧⌘K raises files mode (quick-open — fuzzy file
 * search, Enter opens a tab, directory dimmed); ⇧⌘P raises commands mode (the command list, recents
 * floated on top). Arrows move, Enter runs, Esc / backdrop closes. Focus lives in the input, so CM6
 * never sees these keystrokes and the window's global shortcuts stand down (useOverlayGuard).
 */
export function CommandPalette({
  mode,
  initialQuery = '',
  files,
  checklistProgress = NO_CHECKLIST_PROGRESS,
  folders,
  commands,
  skills,
  activeFile,
  recentIds,
  onRun,
  onOpenFile,
  onRevealFile,
  onRevealFolder,
  onFocusFolder,
  onAskAgent,
  onRunSkill,
  onOpenSkill,
  onManageSkills,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Keyboard-first: the sheet owns the keyboard the instant it opens.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const sections = useMemo(() => buildCommandPaletteSections({
    mode, query, files, folders, commands, skills, activeFile, recentIds,
  }), [mode, query, files, folders, commands, skills, activeFile, recentIds])

  const flatItems = useMemo(() => sections.flatMap((section) => section.items), [sections])

  // A new query (or mode) re-ranks the list — start the highlight at the top again.
  useEffect(() => {
    setSelected(0)
  }, [query, mode])

  // Keep the highlighted row scrolled into view as arrows move it past the sheet's fold.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, sections])

  function activate(item: PaletteItem, options: { reveal?: boolean; alternate?: boolean } = {}): void {
    if (item.kind === 'file') options.reveal ? onRevealFile(item.file.path) : onOpenFile(item.file.path)
    else if (item.kind === 'folder') options.reveal && onFocusFolder ? onFocusFolder(item.path) : onRevealFolder(item.path)
    else if (item.kind === 'ask') onAskAgent(item.query)
    else if (item.kind === 'command') {
      if (!item.command.disabled) onRun(item.command)
    }
    else if (item.kind === 'manage-skills') onManageSkills()
    else if (!item.disabled) options.alternate ? onOpenSkill(item.skill.name) : onRunSkill(item.skill.name)
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[selected]
      if (item) activate(item, {
        reveal: e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey,
        alternate: e.altKey,
      })
    }
    // Esc is handled at the dialog root (onDialogKeyDown) so it closes from any focused element,
    // not only the input — the keystroke bubbles up to it from here regardless.
  }

  // The dialog root owns Esc (closes from anywhere inside the sheet) and traps Tab / Shift-Tab so
  // focus loops between the input and the rows rather than walking out to the toolbar behind the
  // backdrop — the standard modal focus loop.
  function onDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusables = dialog.querySelectorAll<HTMLElement>('input, button')
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const activeEl = document.activeElement
    if (e.shiftKey) {
      if (activeEl === first || !dialog.contains(activeEl)) {
        e.preventDefault()
        last.focus()
      }
    } else if (activeEl === last || !dialog.contains(activeEl)) {
      e.preventDefault()
      first.focus()
    }
  }

  let flatIndex = -1
  return (
    <div
      ref={dialogRef}
      className="overlay open"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'files' ? 'Quick open' : 'Command palette'}
      onKeyDown={onDialogKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet palette-sheet">
        <div className="pal-input">
          <Search className="icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={mode === 'files' ? 'Find files and folders…' : 'Type a command, or ask the agent…'}
            aria-label={mode === 'files' ? 'File or folder name' : 'Command'}
          />
          <kbd>esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {flatItems.length === 0 && (
            <div className="pal-empty">{mode === 'files' ? 'No names match' : 'No commands match'}</div>
          )}
          {sections.map((section) => (
            <div key={section.label}>
              <div className="pal-sec">{section.label}</div>
              {section.items.map((item) => {
                flatIndex += 1
                const index = flatIndex
                const isSelected = index === selected
                return (
                  <button
                    key={item.key}
                    className={`pal-row${item.kind === 'ask' ? ' pal-ask' : ''}${item.kind === 'skill' ? ' pal-skill-row' : ''}${item.kind === 'manage-skills' ? ' pal-manage-skills' : ''}`}
                    aria-selected={isSelected}
                    aria-pressed={item.kind === 'command' && item.command.checked !== undefined ? item.command.checked : undefined}
                    disabled={(item.kind === 'skill' && item.disabled) || (item.kind === 'command' && item.command.disabled)}
                    title={
                      item.kind === 'skill' && item.disabled
                        ? 'Needs an open document'
                        : item.kind === 'command' && item.command.disabled
                          ? item.command.disabledReason
                          : undefined
                    }
                    onMouseMove={() => setSelected(index)}
                    onClick={() => activate(item)}
                  >
                    {item.kind === 'file' ? (
                      <>
                        <FileText className="icon sm" />
                        <span className="grow">
                          <span className="pal-name">{item.file.name}</span>
                          {item.file.directory && <span className="pal-dir">{item.file.directory}</span>}
                        </span>
                        <ChecklistProgressChip path={item.file.path} progress={checklistProgress} />
                      </>
                    ) : item.kind === 'folder' ? (
                      <>
                        <Folder className="icon sm" />
                        <span className="grow">
                          <span className="pal-name">{item.name}</span>
                          {item.path.includes('/') && <span className="pal-dir">{item.path.slice(0, item.path.lastIndexOf('/'))}</span>}
                        </span>
                        {onFocusFolder && isSelected && (
                          // A role=button span: the row is itself a <button>, which cannot nest one.
                          <span
                            role="button"
                            tabIndex={-1}
                            className="pal-focus"
                            title="Focus on this folder (⌘↵)"
                            onClick={(event) => {
                              event.stopPropagation()
                              onFocusFolder(item.path)
                            }}
                          >
                            Focus <kbd>⌘↵</kbd>
                          </span>
                        )}
                      </>
                    ) : item.kind === 'ask' ? (
                      <>
                        <Sparkles className="icon sm" />
                        <span className="grow">Ask the agent: “{item.query}”</span>
                        <kbd>⏎</kbd>
                      </>
                    ) : item.kind === 'command' ? (
                      <>
                        {/* A command that starts an agent run wears the agent's icon (ticket 12). */}
                        {launchesAgent(item.command.id) ? <AgentLaunchIcon /> : <item.command.icon className="icon sm" />}
                        <span className="grow pal-command-copy">
                          <span className="pal-name">{item.command.label}</span>
                          <span className="pal-command-group">{item.command.hint ?? item.command.group}</span>
                        </span>
                        {item.command.checked !== undefined && (
                          <span className={`pal-state${item.command.checked ? ' on' : ''}`} aria-label={item.command.checked ? 'on' : 'off'}>{item.command.checked ? 'On' : 'Off'}</span>
                        )}
                        {item.command.keys && <kbd>{item.command.keys}</kbd>}
                      </>
                    ) : item.kind === 'manage-skills' ? (
                      <>
                        <Settings className="icon sm" />
                        <span className="grow">Manage skills…</span>
                      </>
                    ) : (
                      // ↵ runs the skill: an agent launch, so the agent's icon (ticket 12).
                      <>
                        <AgentLaunchIcon />
                        <span className="grow pal-skill-copy">
                          <span className="pal-name">{skillDisplayName(item.skill)}</span>
                          <span className="pal-description">{item.skill.description}</span>
                        </span>
                        {isSelected && <span className="pal-skill-verbs"><kbd>↵ run as-is</kbd><span>·</span><kbd>⌥↵ open thread</kbd></span>}
                      </>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {mode === 'files' && flatItems.length > 0 && (
          <div className="palette-footer">
            {flatItems[selected]?.kind === 'folder'
              ? (onFocusFolder ? '↵ reveal in Files · ⌘↵ focus' : '↵ reveal in Files')
              : '↵ open · ⌘↵ reveal in Files'}
          </div>
        )}
      </div>
    </div>
  )
}
