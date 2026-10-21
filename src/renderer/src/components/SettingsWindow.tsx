import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenterVertical,
  Anchor,
  AudioLines,
  BookOpen,
  Calendar,
  CircleUser,
  Command,
  Cpu,
  Terminal,
  FilePlus2,
  FileSearch,
  FolderSync,
  Folder,
  Eye,
  History,
  Info,
  Keyboard,
  KeyRound,
  Library,
  Link2,
  MoveHorizontal,
  Minus,
  PanelTop,
  PenLine,
  ScrollText,
  Search,
  SearchX,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SpellCheck,
  Sparkles,
  SquarePen,
  SunMedium,
  TextCursorInput,
  TriangleAlert,
  Type,
  Undo2,
  Volume2,
  type LucideIcon,
  Compass,
  Scan,
} from 'lucide-react'
import { useIpcAuthFlow } from '@bridle/electron/renderer'
import type {
  ModelChoice,
  SettingsChangeEntry,
  SettingsRecord,
  SettingValue,
} from '../../../preload'
import { allBindableCommands, commandsByTaskGroup, type Command as RegistryCommand } from '../commands/registry'
import { hereCount } from '../commands/actions-here'
import { placeLabel } from '../commands/place'
import { placeChipText } from './status-bar-model'
import { SHOW_PLACE_KEY, SHOW_PLACE_LABEL } from '../hooks/usePlace'
import {
  chordDisplayForLog,
  conflictingBindableIds,
  conflictsFor,
  defaultChords,
  parseOverrides,
  resolveChord,
  SHORTCUT_OVERRIDES_KEY,
  splitChord,
  type OverrideMap,
} from '../commands/chords'
import { normaliseTypingScheme, type TypingScheme } from '../../../shared/sound-pack'
import { ACTION_BAR_VISIBLE_KEY, ACTION_BAR_VISIBLE_LABEL, actionBarVisibleFrom } from '../../../shared/action-bar-settings'
import { READ_ALOUD_RATES, normaliseReadAloudRate } from '../editor/read-aloud-player'
import { createColourPick } from '../editor/read-aloud-colour-pick'
import {
  READ_ALOUD_COLOUR_SETTING,
  READ_ALOUD_PRESETS,
  READ_ALOUD_PRESET_IDS,
  READ_ALOUD_STRENGTHS,
  READ_ALOUD_STRENGTH_SETTING,
  isReadAloudPreset,
  normaliseReadAloudColour,
  normaliseReadAloudStrength,
  readAloudTokens,
} from '../editor/read-aloud-colours'
import {
  FIXED_LINE_PRESETS,
  FIXED_LINE_PRESET_LABELS,
  fixedLineCustomLabel,
  fixedLinePreset,
  normaliseFixedLine,
} from '../editor/fixed-line'
import { normaliseReadAloudScrollMode } from '../editor/read-aloud'
import { normaliseFocusMode } from '../editor/focus-modes'
import {
  LINE_FOCUS_DIM_NAMES,
  LINE_FOCUS_DIMS,
  LINE_FOCUS_SIZES,
  LINE_FOLLOW_NAMES,
  LINE_FOLLOWS,
  LINE_OVERLAY_SETTINGS,
  RULER_COVER_NAMES,
  RULER_COVERS,
  RULER_OPACITY_MAX,
  RULER_OPACITY_MIN,
  RULER_OPACITY_STEP,
  normaliseLineFocusDim,
  normaliseLineFocusSize,
  normaliseLineFollow,
  normaliseRulerCovers,
  normaliseRulerOpacity,
} from '../editor/line-overlay'
import type { SpeechVoiceInfo } from '../editor/speech-engine'
import { ShortcutCapture } from './ShortcutCapture'
import { VoiceSettings } from './VoiceSettings'
import { ModelRefreshControl } from './ModelRefreshControl'
import type { ModelsChecked } from '../../../shared/model-refresh'
import { AboutPanel } from './settings/AboutPanel'
import { SharingSettingsPanel } from './settings/SharingSettingsPanel'
import changelogSource from '../../../../CHANGELOG.md?raw'

export type SettingsWindowProps = {
  values: SettingsRecord
  changelog: SettingsChangeEntry[]
  /** Persist + log + apply a setting (useSettings.set). `log: false` for non-Settings tweaks. */
  onSet: (key: string, value: SettingValue, label: string, opts?: { log?: boolean }) => void
  /** Reset a changelog entry: revert the value AND re-fire its effect (useSettings.revert). */
  onRevert: (index: number) => void
  onRefresh: () => void
  /** The LIVE typewriter state (⌘T flips it outside Settings) — the switch mirrors the truth. */
  typewriterOn: boolean
  /** The opened folder's name, for the Library section row. */
  workspaceName: string
  /** Installed platform voices; the voice choice exists only in the Read aloud section. */
  voices: SpeechVoiceInfo[]
  /** null means the operating system chooses its current default voice. */
  selectedVoiceURI: string | null
  /** Open the action bar's configure sheet (ADR-0040). App owns it, so it can sit above Settings. */
  onConfigureActionBar: () => void
  /** Opens a command-linked section directly without creating another settings surface. */
  initialSection?: string
  /** True when Start session routed here because the Diary has no destination yet. */
  diarySessionRequired?: boolean
  /** The status-bar flash (the mockup's #statusFlash — visible beneath the sheet's light scrim). */
  onFlash: (message: string) => void
  onClose: () => void
  /** Get started (ticket 10): was the example removed, and may it be brought back. */
  getStarted?: { removed: boolean; canRestore: boolean }
  /** Bring the Example collection back; resolves with one sentence when it could not be. */
  onRestoreExample?: () => Promise<{ ok: true } | { ok: false; message: string }>
  /** Open the Guide (the same command as the palette's). */
  onOpenGuide?: () => void
  /** Open the set-up steps for sharing (the same command as the palette's "Set up sharing"). */
  onOpenSharingSetup?: () => void
}
/** The words the Settings filter finds the Sharing section by. */
const SHARING_SEARCH = 'sharing share by link cloudflare account token replace check sharing service update version remove sharing from this account set up sharing'

/** The words the Settings filter finds the Place chip's switch by. */
/** Settings → Get started (state 32), as drawn. */
export const GET_STARTED_TEXT = {
  section: 'Get started',
  rowA: { label: 'Get started', small: 'The example was removed', b1: 'Show the example on the start screen again', b2: 'Open the Guide' },
} as const
const GET_STARTED_SEARCH = 'get started example collection removed show the example on the start screen again bring back restore open the guide'
const SHOW_PLACE_SEARCH = 'show where i am in the status bar place chip actions here on a heading'
/** The row's second line, as drawn (state 32): what the chip reads on a heading, from the live command list. */
const PLACE_CHIP_EXAMPLE = `${placeChipText(placeLabel('heading'), hereCount('heading', null)).full} ⌘K`

const SECTIONS: Array<{ id: string; title: string; icon: LucideIcon }> = [
  { id: 'sec-account', title: 'Account & Model', icon: CircleUser },
  { id: 'sec-perms', title: 'Agent Permissions', icon: ShieldCheck },
  { id: 'sec-appearance', title: 'Appearance', icon: SunMedium },
  { id: 'sec-action-bar', title: 'Action bar', icon: PanelTop },
  { id: 'sec-editor', title: 'Editor', icon: Type },
  { id: 'sec-reading-room', title: 'Reading Room', icon: BookOpen },
  { id: 'sec-read-aloud', title: 'Read aloud', icon: AudioLines },
  { id: 'sec-sounds', title: 'Sounds', icon: Volume2 },
  { id: 'sec-library', title: 'Library', icon: Library },
  { id: 'sec-diary', title: 'Diary', icon: BookOpen },
  { id: 'sec-snapshots', title: 'Saving & history', icon: History },
  { id: 'sec-changelog', title: 'Changelog', icon: ScrollText },
  { id: 'sec-get-started', title: 'Get started', icon: Compass },
  { id: 'sec-shortcuts', title: 'Shortcuts', icon: Keyboard },
  { id: 'sec-sharing', title: 'Sharing', icon: Link2 },
  { id: 'sec-about', title: 'About', icon: Info },
]

/** Changelog row glyphs by entry label (the mockup's logIcons map). */
const LOG_ICONS: Record<string, LucideIcon> = {
  'Typewriter mode': AlignCenterVertical,
  'Anchored lead-in style': Anchor,
  'Line width': MoveHorizontal,
  'Prose size': Type,
  Spellcheck: SpellCheck,
  Model: Cpu,
  'Default reasoning level': AlignCenterVertical,
  'Checkpoint on close': History,
  'Keep history for': Calendar,
  Appearance: SunMedium,
  'Propose prose edits': PenLine,
  'Create files': FilePlus2,
  'Rename and move files': FolderSync,
  'Search and read the Workspace': FileSearch,
  'View mode': Eye,
  'Open files from browser links': Link2,
  'Watch for external changes': FolderSync,
  [SHOW_PLACE_LABEL]: TextCursorInput,
  'Diary folder': Folder,
  Tick: Volume2,
  'Typing sounds': Volume2,
  'Typing sound scheme': Volume2,
  'Typing sound volume': Volume2,
  'Ambient sound': AudioLines,
  'Ambient loop': AudioLines,
  'Ambient volume': AudioLines,
  Voice: Volume2,
  'Default speed': AudioLines,
  'Reading scroll': AlignCenterVertical,
  'Fixed line position': AlignCenterVertical,
  'Read-aloud highlight': AudioLines,
  'Highlight strength': AudioLines,
  'Reading Room side': BookOpen,
}

/** What an UNSET key means, in display terms — the surface each default lives on. */
const DEFAULT_DISPLAY: Record<string, string> = {
  'editor.typewriter': 'Off',
  'editor.fixedLine': 'Top third',
  'readAloud.colour': 'Terracotta',
  'readAloud.strength': 'Medium',
  'editor.spellcheck': 'On',
  'editor.focusMode': 'Off',
  'editor.leadStyle': 'Contrast',
  'editor.viewMode': 'Clean',
  'editor.lineWidth': 'Medium',
  'editor.proseSize': '19',
  'sounds.typing.enabled': 'Off',
  'sounds.typing.scheme': 'Deep',
  'sounds.typing.volume': '60%',
  'sounds.ambient.enabled': 'Off',
  'sounds.ambient.loop': 'Warm noise',
  'sounds.ambient.volume': '35%',
  'readAloud.voiceURI': 'System default',
  'readAloud.rate': '1.0×',
  'readAloud.scrollMode': 'Typewriter',
  'readingRoom.side': 'Left',
  'appearance.theme': 'Light',
  'snapshots.frequency': 'On',
  'snapshots.retention': '90 days',
  'permissions.proseEdits': 'On',
  'permissions.createFiles': 'On',
  'permissions.renameFiles': 'On',
  'permissions.readWorkspace': 'On',
  'integration.browserLinks': 'On',
  'workspace.watchExternalChanges': 'On',
  [SHOW_PLACE_KEY]: 'On',
  'diary.folder': 'Not designated',
  'diary.tick': 'On',
  'agent.thinkingLevel': 'medium',
}

const VALUE_DISPLAY: Record<string, Record<string, string>> = {
  'appearance.theme': { light: 'Light', dark: 'Dark' },
  'editor.focusMode': { '': 'Off', fade: 'Fade', sentence: 'Sentence', segment: 'Segment', breakup: 'Breakup', anchored: 'Anchored' },
  'editor.leadStyle': { bold: 'Bold', colour: 'Colour', contrast: 'Contrast' },
  'editor.lineWidth': { narrow: 'Narrow', medium: 'Medium', wide: 'Wide' },
  'editor.viewMode': { clean: 'Clean', markup: 'Markup', raw: 'Raw' },
  // `typewriter` is the value stored before there were two typewriters; it still reads as Deep.
  'sounds.typing.scheme': { deep: 'Deep', typewriter: 'Deep', crisp: 'Crisp', soft: 'Soft' },
  'sounds.ambient.loop': { white: 'Warm noise', rain: 'Rain' },
  'readAloud.scrollMode': { typewriter: 'Typewriter', page: 'Page' },
  'readingRoom.side': { left: 'Left', right: 'Right' },
  'snapshots.frequency': { manual: 'Off', every: 'On' },
  'snapshots.retention': { '30': '30 days', '90': '90 days', forever: 'Forever' },
  'agent.thinkingLevel': { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
}

/** The three machines, in the order they appear in the segmented control: heaviest to quietest.
 *  The hints name the actual recordings, which is what makes the choice meaningful. */
const TYPING_SCHEMES: readonly (readonly [TypingScheme, string, string])[] = [
  ['deep', 'Deep', 'A 1940 Erika 5 manual typewriter'],
  ['crisp', 'Crisp', 'An electric Smith-Corona Prestige Auto 12'],
  ['soft', 'Soft', 'A quiet computer keyboard'],
]

/** Human copy for a stored value in a changelog row ("Off → On", "GPT-5.4 → GPT-5.5"). */
function displayValue(
  key: string,
  value: SettingValue | null,
  models: ModelChoice[],
  voices: SpeechVoiceInfo[],
  entryLabel?: string,
): string {
  // Shortcut assignments store the WHOLE override map; the readable value is the chord the
  // entry's own command holds in that map (T6, `Shortcut: <label>` entries).
  if (key === SHORTCUT_OVERRIDES_KEY) return chordDisplayForLog(value, entryLabel ?? '')
  if (value === null) return DEFAULT_DISPLAY[key] ?? '—'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (key.endsWith('.volume') && typeof value === 'number') return `${Math.round(value * 100)}%`
  if (key === 'editor.fixedLine') {
    const fraction = normaliseFixedLine(value)
    const preset = fixedLinePreset(fraction)
    return preset === 'custom' ? fixedLineCustomLabel(fraction) : FIXED_LINE_PRESET_LABELS[preset]
  }
  if (key === 'readAloud.colour') {
    const colour = normaliseReadAloudColour(value)
    return isReadAloudPreset(colour) ? READ_ALOUD_PRESETS[colour].label : `Custom ${colour}`
  }
  if (key === 'readAloud.strength') {
    const strength = normaliseReadAloudStrength(value)
    return strength.charAt(0).toUpperCase() + strength.slice(1)
  }
  if (key === 'readAloud.rate') return `${normaliseReadAloudRate(value).toFixed(1)}×`
  if (key === 'readAloud.voiceURI') {
    return voices.find((voice) => voice.uri === String(value))?.name ?? String(value)
  }
  if (key === 'agent.model') {
    const raw = String(value)
    const model = models.find((m) => `${m.provider}::${m.id}` === raw)
    return model?.name ?? raw.split('::').at(-1) ?? raw
  }
  return VALUE_DISPLAY[key]?.[String(value)] ?? String(value)
}

/** "just now" / "today, 21:14" / "yesterday, 21:14" / "30 June" — the mockup's changelog datings. */
function displayWhen(at: number): string {
  const then = new Date(at)
  const now = new Date()
  if (now.getTime() - at < 60_000) return 'just now'
  const time = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(then, now)) return `today, ${time}`
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(then, yesterday)) return `yesterday, ${time}`
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

/** Display names for the auth lanes (the mockup's Account rows). */
const PROVIDER_NAMES: Record<string, string> = { 'openai-codex': 'ChatGPT', anthropic: 'Anthropic', zai: 'ZAI' }
/** The mockup's row order: ChatGPT, Anthropic, ZAI; unknown lanes sink to the end. */
const PROVIDER_ORDER = ['openai-codex', 'anthropic', 'zai']
const providerRank = (id: string): number => {
  const index = PROVIDER_ORDER.indexOf(id)
  return index === -1 ? PROVIDER_ORDER.length : index
}

export type ModelProviderState = {
  id: string
  configured: boolean
  authLanes: readonly string[]
}

export type ModelSettingsRowProps = {
  selectedModel: string
  modelNotice?: string | null
  /** When the model list was last checked; shown under the row's refresh control. */
  modelsChecked?: ModelsChecked | null
  models: ModelChoice[]
  /** The full static registry (unfiltered): names a selection whose provider is signed out, since
   *  `models` deliberately lists only configured lanes (0.7a usability review find). */
  catalogue: ModelChoice[]
  providers: ModelProviderState[]
  onChange: (raw: string) => void
  onStartLogin: (providerId: string) => void
  onSetKeyEntry: (providerId: string) => void
  hidden?: boolean
}

/** Locked M7 presentation: preserve the preference and warn when its provider cannot run it. */
export function ModelSettingsRow({
  selectedModel,
  modelNotice,
  modelsChecked = null,
  models,
  catalogue,
  providers,
  onChange,
  onStartLogin,
  onSetKeyEntry,
  hidden = false,
}: ModelSettingsRowProps): JSX.Element {
  const selectedProviderId = selectedModel.split('::')[0]
  const selectedProvider = selectedModel === '' ? undefined : providers.find((provider) => provider.id === selectedProviderId)
  const unavailable = selectedModel !== '' && selectedProvider !== undefined && !selectedProvider.configured
  const selectedModelChoice = models.find((model) => `${model.provider}::${model.id}` === selectedModel)
  const namedChoice = selectedModelChoice ?? catalogue.find((model) => `${model.provider}::${model.id}` === selectedModel)
  const modelName = namedChoice?.name ?? selectedModel.split('::').at(-1) ?? selectedModel
  // usability review verdict (skills-recheck-071): the picker lists ONLY what the user can actually run —
  // `models` is Pi's registry filtered to configured auth. `catalogue` exists to NAME a stored
  // selection whose provider signed out (the synthetic option + amber row), never as options.
  const optionChoices = models
  const providerName = selectedProvider ? (PROVIDER_NAMES[selectedProvider.id] ?? selectedProvider.id) : selectedProviderId
  const usesOauth = selectedProvider?.authLanes.includes('oauth') ?? false
  const warning = unavailable
    ? usesOauth
      ? `${modelName} — ${providerName} is signed out, so this model can't run.`
      : `${modelName} — ${providerName} has no key, so this model can't run.`
    : null

  return (
    <div className={`crow${unavailable ? ' amber-model' : ''}`} hidden={hidden}>
      {unavailable ? <TriangleAlert className="icon" aria-hidden="true" /> : <Cpu className="icon" aria-hidden="true" />}
      <span className="grow">
        <span className="lbl">Model</span>
        <small className={unavailable ? 'amber-model-copy' : undefined}>
          {warning ?? 'Used for suggestions and housekeeping'}
        </small>
        {modelNotice && <small role="status">{modelNotice}</small>}
        <ModelRefreshControl checked={modelsChecked} />
      </span>
      {unavailable && selectedProvider && (
        usesOauth ? (
          <button
            className="ghost"
            type="button"
            title={`Sign in to ${providerName}`}
            onClick={() => onStartLogin(selectedProvider.id)}
          >
            Sign in
          </button>
        ) : (
          <button
            className="ghost"
            type="button"
            title={`Add ${providerName} key`}
            onClick={() => onSetKeyEntry(selectedProvider.id)}
          >
            Add key
          </button>
        )
      )}
      <select aria-label="Model" title="Model" value={selectedModel}
        onPointerDown={() => { void window.writeflex.modelPickerOpened().catch(() => {}) }}
        onKeyDown={(event) => {
          if ([' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key)) {
            void window.writeflex.modelPickerOpened().catch(() => {})
          }
        }}
        onChange={(event) => onChange(event.target.value)}>
        {selectedModel === '' && <option value="">Choose a model</option>}
        {selectedModel !== '' && !optionChoices.some((model) => `${model.provider}::${model.id}` === selectedModel) && (
          <option value={selectedModel}>{modelName}</option>
        )}
        {optionChoices.map((model) => (
          <option key={`${model.provider}::${model.id}`} value={`${model.provider}::${model.id}`}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * A per-channel volume slider (Round A Task 4). Dragging previews live but silently (`log: false`);
 * releasing commits ONE honest changelog entry via the first-change-seed trick (see changeModel):
 * silently restore the gesture's start value, then log start → end in a single entry.
 */
function VolumeSlider({
  label,
  settingKey,
  value,
  onSet,
}: {
  label: string
  settingKey: string
  value: number
  onSet: SettingsWindowProps['onSet']
}): JSX.Element {
  const gestureStart = useRef<number | null>(null)
  const commit = (end: number): void => {
    const start = gestureStart.current
    gestureStart.current = null
    if (start === null || start === end) return
    onSet(settingKey, start, label, { log: false }) // seed the honest `old` for the logged entry
    onSet(settingKey, end, label)
  }
  return (
    <input
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={value}
      aria-label={label}
      title={label}
      onPointerDown={() => { gestureStart.current = value }}
      onKeyDown={() => { gestureStart.current ??= value }}
      onChange={(e) => onSet(settingKey, Number(e.target.value), label, { log: false })}
      onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onBlur={(e) => commit(Number(e.target.value))}
    />
  )
}

/**
 * The Settings window (Task 17, mockup `#settings`): a titlebar-and-two-pane sheet — searchable
 * nav on the left, sections on the right. Every control is live: switches and selects persist
 * through the settings store (and appear in the Changelog section with a working per-entry Reset),
 * the Account rows drive the real AuthFlowBroker channels, and Agent Permissions feed the
 * main-process policy filter. Search narrows rows and dims the nav (the mockup's filter).
 */
export function SettingsWindow({
  values,
  changelog,
  onSet,
  onRevert,
  onRefresh,
  typewriterOn,
  workspaceName,
  voices,
  selectedVoiceURI,
  initialSection,
  diarySessionRequired = false,
  onFlash,
  onClose,
  onConfigureActionBar,
  getStarted,
  onRestoreExample,
  onOpenGuide,
  onOpenSharingSetup,
}: SettingsWindowProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreRefusal, setRestoreRefusal] = useState<string | null>(null)
  const openGuideRef = useRef<HTMLButtonElement | null>(null)
  const restoreExample = useCallback(() => {
    if (!onRestoreExample) return
    setRestoring(true)
    setRestoreRefusal(null)
    void onRestoreExample().then(
      (result) => {
        if (!result.ok) setRestoreRefusal(result.message)
        // The button that was pressed leaves the row once the example is back: move focus to its
        // neighbour first, so the keyboard (Esc, Tab) is still inside Settings.
        else openGuideRef.current?.focus()
      },
      () => setRestoreRefusal('The Example collection could not be brought back.'),
    ).finally(() => setRestoring(false))
  }, [onRestoreExample])
  const [counted, setCounted] = useState<import('../../../preload').CountedCollection[]>([])
  const [activeSection, setActiveSection] = useState(initialSection ?? 'sec-account')
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const reloadCounted = useCallback(() => {
    void window.writeflex.diary.countedCollections().then(setCounted).catch(() => setCounted([]))
  }, [])
  useEffect(reloadCounted, [reloadCounted])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.writeflex.onCollectionChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(reloadCounted, 500)
    })
    return () => { if (timer) clearTimeout(timer); off() }
  }, [reloadCounted])
  const chooseDiaryFolder = useCallback(() => {
    void window.writeflex.diary.chooseFolder().then((path) => {
      if (!path) return
      onSet('diary.folder', path, 'Diary folder')
    }).catch(() => onFlash('Could not choose the Diary folder.'))
  }, [onFlash, onSet])
  const uncount = useCallback((dir: string, root: string) => {
    void window.writeflex.diary.setCounted(dir, false, root).then((next) => {
      setCounted(next)
      onRefresh()
    }).catch(() => onFlash('Could not stop counting that Collection.'))
  }, [onFlash, onRefresh])

  // --- Keycap Ledger state (Round A T6, ADR-0028): every bindable command, its EFFECTIVE chord,
  // and where the chord came from. Overrides live in ONE JSON-string setting; each assignment is
  // logged to the changelog as `Shortcut: <label>` with a working Reset.
  const bindableCommands = useMemo(() => allBindableCommands(), [])
  const bindableCommandGroups = useMemo(() => commandsByTaskGroup(bindableCommands), [bindableCommands])
  const overrides = useMemo<OverrideMap>(() => parseOverrides(values[SHORTCUT_OVERRIDES_KEY]), [values])
  const [ledgerQuery, setLedgerQuery] = useState('')
  const [capturing, setCapturing] = useState<string | null>(null)
  const persistOverrides = useCallback(
    (next: OverrideMap, commandLabel: string) => {
      onSet(SHORTCUT_OVERRIDES_KEY, JSON.stringify(next), `Shortcut: ${commandLabel}`)
    },
    [onSet],
  )
  const assignChord = useCallback(
    (command: RegistryCommand, chord: string) => {
      const next = { ...overrides }
      // Assigning the command's own default back is a return to Source: default, not a custom claim.
      if (defaultChords(command)[0] === chord) delete next[command.id]
      else next[command.id] = chord
      persistOverrides(next, command.label)
      setCapturing(null)
      onFlash(`${command.label}: ${chord}`)
    },
    [overrides, persistOverrides, onFlash],
  )
  const moveChordHere = useCallback(
    (command: RegistryCommand, chord: string) => {
      const next = { ...overrides }
      for (const id of conflictingBindableIds(chord, command.id, overrides)) {
        const claimant = bindableCommands.find((entry) => entry.id === id)
        const claimantDefaults = claimant ? defaultChords(claimant) : []
        // An override claim whose default is a DIFFERENT chord can simply drop (the default
        // resurfaces); a default claim (or a same-as-default override) must be explicitly unassigned.
        if (next[id] !== undefined && !claimantDefaults.includes(chord)) delete next[id]
        else next[id] = ''
      }
      if (defaultChords(command)[0] === chord) delete next[command.id]
      else next[command.id] = chord
      persistOverrides(next, command.label)
      setCapturing(null)
      onFlash(`${command.label}: ${chord}`)
    },
    [overrides, bindableCommands, persistOverrides, onFlash],
  )
  const resetChord = useCallback(
    (command: RegistryCommand) => {
      const next = { ...overrides }
      delete next[command.id]
      persistOverrides(next, command.label)
    },
    [overrides, persistOverrides],
  )

  // --- Account & Model state (Bridle auth migration 0.7a: the M1 AuthCard logic
  // now rides @bridle/electron's useIpcAuthFlow controller; the .crow rows stay
  // exactly as the locked Task-17 mockup drew them — same UI, framework engine.)
  const flow = useIpcAuthFlow(window.writeflex.auth, { defaultProviderId: 'openai-codex' })
  const [models, setModels] = useState<ModelChoice[]>([])
  const [modelNotice, setModelNotice] = useState<string | null>(null)
  const [modelsChecked, setModelsChecked] = useState<ModelsChecked | null>(null)
  const [catalogue, setCatalogue] = useState<ModelChoice[]>([])
  const [defaultModel, setDefaultModel] = useState<{ provider: string; id: string } | null>(null)
  const [defaultThinking, setDefaultThinking] = useState<'minimal' | 'low' | 'medium' | 'high'>('medium')
  const [inputValue, setInputValue] = useState('')
  /** Which api-key lane has its inline entry open, and the draft key (never echoed once saved). */
  const [keyEntry, setKeyEntry] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  /** What the in-flight controller action was, so completion/error flashes read right. */
  const pendingAction = useRef<'login' | 'key' | null>(null)

  useEffect(() => {
    searchRef.current?.focus() // keyboard-first: the sheet opens ready to search
    if (initialSection) {
      requestAnimationFrame(() => {
        paneRef.current?.querySelector(`#${initialSection}`)?.scrollIntoView({ block: 'start' })
      })
    }
  }, [initialSection])

  // Every provider-list read routes through the mockup-order sort (ChatGPT, Anthropic, ZAI).
  const providers = useMemo(
    () => [...flow.providers].sort((a, b) => providerRank(a.id) - providerRank(b.id)),
    [flow.providers],
  )

  useEffect(() => {
    const pullModels = (): void => {
      void window.writeflex
        .getAgentState()
        .then((state) => {
          setModelNotice(state.modelNotice)
          setModelsChecked(state.modelsChecked ?? null)
          setModels(state.models)
          setCatalogue(state.catalogue)
          setDefaultModel(state.defaults.model)
          setDefaultThinking(state.defaults.thinking)
        })
        .catch(() => {})
    }
    pullModels()
    // The agent boots in the background after a Workspace binds; Settings opened during the boot
    // window would otherwise show an empty model list until reopened.
    const offReady = window.writeflex.onAgentReady(pullModels)
    const offModels = window.writeflex.onModelsChanged((state) => {
      setModels(state.models)
      setCatalogue(state.catalogue)
      setModelNotice(state.modelNotice)
      setModelsChecked(state.modelsChecked ?? null)
    })
    return () => { offReady(); offModels() }
  }, [])

  // Terminal controller phases → the mockup's flash messages; transient phases render inline below.
  useEffect(() => {
    if (flow.state.phase === 'complete') {
      const name = PROVIDER_NAMES[flow.state.providerId] ?? flow.state.providerId
      onFlash(pendingAction.current === 'key' ? `${name} key saved` : `Signed in to ${name}`)
      pendingAction.current = null
      setKeyEntry(null)
      setKeyDraft('')
      setKeyBusy(false)
      setInputValue('')
    } else if (flow.state.phase === 'error') {
      onFlash(pendingAction.current === 'key' ? `Key not saved: ${flow.state.message}` : `Sign-in failed: ${flow.state.message}`)
      pendingAction.current = null
      setKeyBusy(false)
      setInputValue('')
    }
  }, [flow.state, onFlash])

  const loginBusy = flow.state.phase === 'authorising' || flow.state.phase === 'auth-url'
    || flow.state.phase === 'device-code' || flow.state.phase === 'progress' || flow.state.phase === 'input'
  const authProgress =
    flow.state.phase === 'authorising' ? 'Starting sign-in…'
    : flow.state.phase === 'auth-url' ? `Browser opened for sign-in.${flow.state.instructions ? ` ${flow.state.instructions}` : ''}`
    : flow.state.phase === 'device-code' ? `Enter code ${flow.state.userCode} at ${flow.state.verificationUri}`
    : flow.state.phase === 'progress' ? flow.state.message
    : null
  const inputRequest = flow.state.phase === 'input' ? flow.state.request : null

  const startLogin = useCallback((providerId: string) => {
    pendingAction.current = 'login'
    void flow.login(providerId)
  }, [flow])

  const signOut = useCallback(
    (providerId: string) => {
      flow.logout(providerId)
      onFlash(`Signed out of ${PROVIDER_NAMES[providerId] ?? providerId}`)
    },
    [flow, onFlash],
  )

  const respondAuth = useCallback(
    (value: string | undefined) => {
      if (!inputRequest) return
      flow.respond(inputRequest.requestId, value)
      setInputValue('')
    },
    [flow, inputRequest],
  )

  const saveKey = useCallback(
    (providerId: string) => {
      const key = keyDraft.trim()
      if (!key) return
      pendingAction.current = 'key'
      setKeyBusy(true)
      flow.setApiKey(providerId, key)
    },
    [flow, keyDraft],
  )

  // These rows edit workspace-wide defaults; the active thread may deliberately differ.
  const storedModel = typeof values['agent.model'] === 'string' ? (values['agent.model'] as string) : null
  const selectedModel = storedModel ?? (defaultModel ? `${defaultModel.provider}::${defaultModel.id}` : '')
  const storedThinking = typeof values['agent.thinkingLevel'] === 'string' ? values['agent.thinkingLevel'] : null
  const selectedThinking = storedThinking ?? defaultThinking
  const selectedProviderId = selectedModel.split('::')[0]
  const selectedProvider = selectedModel === '' ? undefined : providers.find((provider) => provider.id === selectedProviderId)
  const modelRowSearchText = selectedProvider && !selectedProvider.configured
    ? selectedProvider.authLanes.includes('oauth')
      ? `model signed out can't run sign in ${PROVIDER_NAMES[selectedProvider.id] ?? selectedProvider.id}`
      : `model no key can't run add key ${PROVIDER_NAMES[selectedProvider.id] ?? selectedProvider.id}`
    : 'model used for suggestions and housekeeping'
  const changeModel = useCallback(
    (raw: string) => {
      // First-change seed: the boot default was never in the store, so record it silently first —
      // the logged entry (and its Reset) then carries an honest, revertable `old`.
      if (storedModel === null && defaultModel) {
        onSet('agent.model', `${defaultModel.provider}::${defaultModel.id}`, 'Model', { log: false })
      }
      onSet('agent.model', raw, 'Model')
    },
    [storedModel, defaultModel, onSet],
  )
  const changeThinking = useCallback((level: 'minimal' | 'low' | 'medium' | 'high') => {
    if (storedThinking === null) onSet('agent.thinkingLevel', defaultThinking, 'Default reasoning level', { log: false })
    onSet('agent.thinkingLevel', level, 'Default reasoning level')
  }, [storedThinking, defaultThinking, onSet])

  // --- Search filter (the mockup's #setSearch wiring): a row shows when the query hits its text
  // or its section title; a section shows when its title hits or any row survives; nav entries of
  // filtered-out sections dim; no surviving section at all shows the designed empty state. ---
  const q = query.trim().toLowerCase()
  const hit = useCallback((...texts: Array<string | undefined>) => !q || texts.filter(Boolean).join(' ').toLowerCase().includes(q), [q])
  const sectionVisible = useMemo(() => {
    const visible: Record<string, boolean> = {}
    for (const section of SECTIONS) visible[section.id] = !q || section.title.toLowerCase().includes(q)
    return visible
  }, [q])

  /** Row visibility inside `sectionId`: a section-title hit shows every row (mockup rule). */
  const rowShown = useCallback(
    (sectionId: string, ...texts: Array<string | undefined>) => sectionVisible[sectionId] || hit(...texts),
    [sectionVisible, hit],
  )

  // Row texts per section, mirrored from the JSX below, so section/nav visibility can be computed
  // BEFORE render. Auth rows and changelog rows are dynamic; their texts are built from live state.
  const sectionHasRow = useMemo<Record<string, boolean>>(() => {
    const rows: Record<string, string[]> = {
      'sec-account': [
        ...providers.map((p) => `${PROVIDER_NAMES[p.id] ?? p.label} sign in manage replace add key metered billing plan subscription`),
        modelRowSearchText,
        'reasoning level minimal low medium high default agent thinking',
      ],
      'sec-perms': ['propose prose edits always staged', 'create files', 'rename and move files', 'search and read the workspace'],
      'sec-appearance': ['light default', 'dark optional theme'],
      'sec-get-started': [GET_STARTED_SEARCH, SHOW_PLACE_SEARCH],
      'sec-action-bar': ['action bar show hide row of buttons under the toolbar', 'configure the action bar commands order separators groups customise'],
      'sec-editor': ['typewriter mode centred cursor', 'read-aloud highlight colour strength soft medium strong terracotta amber green blue lilac grey custom preview wash', 'fixed line position top third middle lower third custom read aloud typewriter height', 'live preview seamless paper rendered blocks', 'line width narrow medium wide', 'prose size 17 19 21', 'spellcheck', 'text readability focus mode fade sentence segment breakup anchored', 'anchored lead-in style bold colour contrast reading focus', 'text overlay line focus ruler size follow dim covers opacity', 'open files from browser links external url scheme'],
      'sec-reading-room': ['reading room side left right rail paper margin mirror global'],
      'sec-read-aloud': [
        'voice system default premium enhanced show all voices installed language',
        ...voices.map((voice) => `${voice.name} ${voice.lang}${voice.isDefault ? ' default' : ''}`),
        'default speed reading rate 0.5 1.0 2.5',
        'reading scroll typewriter centred centre middle stable voice page turn top screen viewport',
      ],
      'sec-sounds': ['typing sounds a sound per keystroke while you write typewriter deep erika crisp smith corona electric soft keyboard scheme volume', 'ambient sound background loop warm white noise hush rain volume pauses in the background', 'sound credits attribution licence wikimedia commons work with sounds lonemonk'],
      'sec-library': [`${workspaceName} not a library promote`, 'watch for external changes other agents apps workspace folder', 'install command-line tool writeflex terminal shell agents claude code codex'],
      'sec-diary': ['diary folder designate choose change dormant counted collections un-count', ...counted.map((collection) => `${collection.name} ${collection.pieces} pieces`)],
      'sec-snapshots': ['checkpoint on close returnable point history', 'keep history for 30 90 days forever retention'],
      'sec-changelog': changelog.map((e) => `${e.label} reset`),
      'sec-shortcuts': [
        'keycap ledger chord assign custom default not assigned press keys now reset all shortcuts',
        ...bindableCommands.map((command) => `${command.label} ${command.task}`),
      ],
      'sec-sharing': [SHARING_SEARCH],
      'sec-about': [
        'about WriteFlex version release notes',
        ...(changelogSource.match(/^##\s+\[[^\]]+\].*$/gm) ?? []),
      ],
    }
    const out: Record<string, boolean> = {}
    for (const section of SECTIONS) {
      out[section.id] = sectionVisible[section.id] || (rows[section.id] ?? []).some((text) => hit(text))
    }
    return out
  }, [providers, modelRowSearchText, voices, workspaceName, counted, changelog, bindableCommands, sectionVisible, hit])
  const anyVisible = SECTIONS.some((section) => sectionHasRow[section.id])
  const voiceSearchQuery = q && voices.some((voice) =>
    `${voice.name} ${voice.lang}`.toLowerCase().includes(q),
  ) ? q : ''

  const goToSection = useCallback((id: string) => {
    setActiveSection(id)
    paneRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // The dialog root owns Esc and traps Tab within the sheet — the palette's modal focus loop.
  function onDialogKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('input, button, select')).filter(
      (el) => el.offsetParent !== null,
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else if (active === last || !dialog.contains(active)) {
      e.preventDefault()
      first.focus()
    }
  }

  const theme = values['appearance.theme'] === 'dark' ? 'dark' : 'light'
  const boolValue = (key: string, fallback: boolean): boolean => {
    const value = values[key]
    return typeof value === 'boolean' ? value : fallback
  }
  /** A pill-less select row for one Line focus / Ruler setting (Text overlay group). */
  const overlaySelect = (searchWords: string, label: string, key: string, current: string, options: Array<[string, string]>): JSX.Element => (
    <div className="crow" hidden={!rowShown('sec-editor', searchWords)}>
      <span className="grow">
        <span className="lbl">{label}</span>
      </span>
      <select aria-label={label} title={label} value={current} onChange={(e) => onSet(key, key.endsWith('.size') ? Number(e.target.value) : e.target.value, label)}>
        {options.map(([value, name]) => (
          <option key={value} value={value}>{name}</option>
        ))}
      </select>
    </div>
  )
  const overlaySwitch = (searchWords: string, label: string, key: string, Icon: LucideIcon): JSX.Element => (
    <div className="crow" hidden={!rowShown('sec-editor', searchWords)}>
      <Icon className="icon" aria-hidden="true" />
      <span className="grow">
        <span className="lbl">{label}</span>
      </span>
      <label className="switch" title={label}>
        <input type="checkbox" aria-label={label} checked={boolValue(key, false)} onChange={(e) => onSet(key, e.target.checked, label)} />
        <span className="knob" />
      </label>
    </div>
  )
  const volumeValue = (key: string, fallback: number): number => {
    const value = values[key]
    return typeof value === 'number' && !Number.isNaN(value) ? Math.min(1, Math.max(0, value)) : fallback
  }
  const typingScheme = normaliseTypingScheme(values['sounds.typing.scheme'])
  const fixedLineValue = normaliseFixedLine(values['editor.fixedLine'])
  const highlightColour = normaliseReadAloudColour(values[READ_ALOUD_COLOUR_SETTING])
  const highlightStrength = normaliseReadAloudStrength(values[READ_ALOUD_STRENGTH_SETTING])
  // The Custom… picker: live while dragging, one logged entry when it commits (see read-aloud-colour-pick.ts).
  const highlightColourRef = useRef(highlightColour)
  highlightColourRef.current = highlightColour
  const onSetRef = useRef(onSet)
  onSetRef.current = onSet
  const colourPick = useMemo(
    () => createColourPick({
      read: () => highlightColourRef.current,
      apply: (value, log) => onSetRef.current(READ_ALOUD_COLOUR_SETTING, value, 'Read-aloud highlight', { log }),
    }),
    [],
  )
  const highlightTheme = values['appearance.theme'] === 'dark' ? 'dark' : 'light'
  const fixedLineChoice = fixedLinePreset(fixedLineValue)
  const ambientLoop = values['sounds.ambient.loop'] === 'rain' ? 'rain' : 'white'

  return (
    <div
      ref={dialogRef}
      className="overlay open"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet settings-sheet">
        <div className="set-titlebar">
          <div className="traffic">
            <button className="r" title="Close settings (esc)" aria-label="Close settings" onClick={onClose} />
            <span className="y" aria-hidden="true" />
            <span className="g" aria-hidden="true" />
          </div>
          <div className="t">Settings</div>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label="Settings sections">
            <div className="set-search">
              <Search className="icon sm" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
              />
            </div>
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                className={q && !sectionHasRow[section.id] ? 'dim' : undefined}
                aria-current={activeSection === section.id ? 'true' : undefined}
                onClick={() => goToSection(section.id)}
              >
                <section.icon className="icon sm" aria-hidden="true" />
                {section.title}
              </button>
            ))}
          </nav>
          <div className="set-pane" ref={paneRef}>
            {!anyVisible && (
              <div className="set-empty">
                <SearchX className="icon" aria-hidden="true" />
                <p>
                  No settings match “<span>{query.trim()}</span>”.
                </p>
              </div>
            )}

            <div className="set-sec" id="sec-account" hidden={!sectionHasRow['sec-account']}>
              <h3>Account &amp; Model</h3>
              <p className="sub">WriteFlex signs in with your existing AI accounts. Keys never appear in the interface once saved.</p>
              <div className="card">
                {providers.map((provider) => {
                  const name = PROVIDER_NAMES[provider.id] ?? provider.label
                  const searchText = `${name} sign in manage replace add key metered billing plan subscription`
                  if (provider.authLanes.includes('oauth')) {
                    return (
                      <div className="crow" key={provider.id} hidden={!rowShown('sec-account', searchText)}>
                        <CircleUser className="icon" aria-hidden="true" />
                        <span className="grow">
                          <span className="lbl">{name}</span>
                          <small>
                            {provider.configured
                              ? `${provider.label ?? 'Signed in'} · plan subscription`
                              : 'Not signed in · plan subscription'}
                          </small>
                        </span>
                        {provider.configured ? (
                          <button className="ghost" title={`Sign out of ${name}`} aria-label={`Sign out of ${name}`} onClick={() => signOut(provider.id)}>
                            Sign out
                          </button>
                        ) : (
                          <button
                            className="ghost"
                            title={`Sign in to ${name}`}
                            aria-label={`Sign in to ${name}`}
                            disabled={loginBusy}
                            onClick={() => startLogin(provider.id)}
                          >
                            {loginBusy ? 'Signing in…' : 'Sign in'}
                          </button>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div className="crow" key={provider.id} hidden={!rowShown('sec-account', searchText)}>
                      <KeyRound className="icon" aria-hidden="true" />
                      <span className="grow">
                        <span className="lbl">{name}</span>
                        <small>{provider.configured ? 'API key saved · metered billing' : 'No key · metered billing'}</small>
                      </span>
                      {keyEntry === provider.id ? (
                        <span className="auth-entry">
                          <input
                            type="password"
                            value={keyDraft}
                            autoFocus
                            onChange={(e) => setKeyDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveKey(provider.id)
                            }}
                            placeholder="Paste API key"
                            aria-label={`${name} API key`}
                          />
                          <button
                            className="ghost"
                            title="Save key"
                            aria-label={`Save ${name} API key`}
                            disabled={keyBusy || !keyDraft.trim()}
                            onClick={() => saveKey(provider.id)}
                          >
                            Save
                          </button>
                          <button
                            className="ghost"
                            title="Cancel"
                            aria-label="Cancel key entry"
                            onClick={() => {
                              setKeyEntry(null)
                              setKeyDraft('')
                            }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="ghost"
                          title={provider.configured ? `Replace the ${name} key` : `Add a ${name} key`}
                          aria-label={provider.configured ? `Replace the ${name} key` : `Add a ${name} key`}
                          onClick={() => {
                            setKeyEntry(provider.id)
                            setKeyDraft('')
                          }}
                        >
                          {provider.configured ? 'Replace key' : 'Add key'}
                        </button>
                      )}
                    </div>
                  )
                })}
                {authProgress && (
                  <div className="crow" hidden={!rowShown('sec-account', 'sign-in progress')}>
                    <Sparkles className="icon" aria-hidden="true" />
                    <span className="grow auth-progress">{authProgress}</span>
                  </div>
                )}
                {inputRequest && (
                  <div className="crow">
                    <KeyRound className="icon" aria-hidden="true" />
                    <span className="auth-entry">
                      {inputRequest.inputKind === 'select' ? (
                        <select
                          aria-label={inputRequest.message ?? 'Choose an option'}
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                        >
                          <option value="">{inputRequest.message ?? 'Choose an option'}</option>
                          {(inputRequest.options ?? []).map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={inputValue}
                          autoFocus
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && inputValue.trim()) respondAuth(inputValue)
                          }}
                          placeholder={inputRequest.placeholder ?? inputRequest.message ?? 'Paste the redirect URL or authorisation code'}
                          aria-label={inputRequest.message ?? 'Sign-in input'}
                        />
                      )}
                      <button className="ghost" title="Submit" aria-label="Submit sign-in input" disabled={!inputValue.trim()} onClick={() => respondAuth(inputValue)}>
                        Submit
                      </button>
                      <button className="ghost" title="Cancel" aria-label="Cancel sign-in input" onClick={() => respondAuth(undefined)}>
                        Cancel
                      </button>
                    </span>
                  </div>
                )}
                <ModelSettingsRow
                  selectedModel={selectedModel}
                  modelNotice={modelNotice}
                  modelsChecked={modelsChecked}
                  models={models}
                  catalogue={catalogue}
                  providers={providers}
                  onChange={changeModel}
                  onStartLogin={startLogin}
                  onSetKeyEntry={setKeyEntry}
                  hidden={!rowShown('sec-account', modelRowSearchText)}
                />
                <div className="crow" hidden={!rowShown('sec-account', 'reasoning level minimal low medium high default agent thinking')}>
                  <AlignCenterVertical className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Default reasoning level</span>
                    <small>Used when a new chat starts</small>
                  </span>
                  <select
                    aria-label="Default reasoning level"
                    title="Default reasoning level"
                    value={selectedThinking}
                    onChange={(event) => changeThinking(event.target.value as 'minimal' | 'low' | 'medium' | 'high')}
                  >
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-perms" hidden={!sectionHasRow['sec-perms']}>
              <h3>Agent Permissions</h3>
              <p className="sub">
                Prose edits are always staged for your review — that cannot be switched off. Housekeeping applies immediately,
                is recorded, and can be undone per turn.
              </p>
              <div className="card">
                {(
                  [
                    { key: 'permissions.proseEdits', label: 'Propose prose edits', small: 'Always staged as suggestions', icon: PenLine },
                    { key: 'permissions.createFiles', label: 'Create files', icon: FilePlus2 },
                    { key: 'permissions.renameFiles', label: 'Rename and move files', icon: FolderSync },
                    { key: 'permissions.readWorkspace', label: 'Search and read the Workspace', icon: FileSearch },
                  ] as Array<{ key: string; label: string; small?: string; icon: LucideIcon }>
                ).map((row) => (
                  <div className="crow" key={row.key} hidden={!rowShown('sec-perms', row.label, row.small)}>
                    <row.icon className="icon" aria-hidden="true" />
                    <span className="grow">
                      <span className="lbl">{row.label}</span>
                      {row.small && <small>{row.small}</small>}
                    </span>
                    <label className="switch" title={row.label}>
                      <input
                        type="checkbox"
                        aria-label={row.label}
                        checked={boolValue(row.key, true)}
                        onChange={(e) => onSet(row.key, e.target.checked, row.label)}
                      />
                      <span className="knob" />
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div className="set-sec" id="sec-appearance" hidden={!sectionHasRow['sec-appearance']}>
              <h3>Appearance</h3>
              <p className="sub">Light is WriteFlex&rsquo;s default face; Dark is here when you want it.</p>
              <div className="radio-row">
                <label className={theme === 'light' ? 'radio-card on' : 'radio-card'} hidden={!rowShown('sec-appearance', 'light default')}>
                  <input
                    type="radio"
                    name="theme"
                    value="light"
                    checked={theme === 'light'}
                    onChange={() => onSet('appearance.theme', 'light', 'Appearance')}
                  />
                  <span>
                    Light<small>Default</small>
                  </span>
                </label>
                <label className={theme === 'dark' ? 'radio-card on' : 'radio-card'} hidden={!rowShown('sec-appearance', 'dark optional')}>
                  <input
                    type="radio"
                    name="theme"
                    value="dark"
                    checked={theme === 'dark'}
                    onChange={() => onSet('appearance.theme', 'dark', 'Appearance')}
                  />
                  <span>
                    Dark<small>Optional</small>
                  </span>
                </label>
              </div>
            </div>

            {/* The action bar (ADR-0040). The switch is the SAME global boolean the toolbar toggle
                writes, and Configure opens the SAME sheet the bar's own control does — this section
                is a way in, never a second copy of either. */}
            <div className="set-sec" id="sec-action-bar" hidden={!sectionHasRow['sec-action-bar']}>
              <h3>Action bar</h3>
              <p className="sub">A row of your most-used commands under the toolbar. What is on it, and in what order, is yours.</p>
              <div className="card">
                <div className="crow" hidden={!rowShown('sec-action-bar', 'action bar show hide row of buttons under the toolbar')}>
                  <PanelTop className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Show the action bar</span>
                    <small>One row, below the toolbar, in every window</small>
                  </span>
                  <label className="switch" title="Show the action bar">
                    <input
                      type="checkbox"
                      aria-label="Show the action bar"
                      checked={actionBarVisibleFrom(values[ACTION_BAR_VISIBLE_KEY])}
                      onChange={(e) => onSet(ACTION_BAR_VISIBLE_KEY, e.target.checked, ACTION_BAR_VISIBLE_LABEL)}
                    />
                    <span className="knob" />
                  </label>
                </div>
                <div className="crow" hidden={!rowShown('sec-action-bar', 'configure the action bar commands order separators groups customise')}>
                  <SlidersHorizontal className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">What is on the bar</span>
                    <small>Choose the commands, their order and their grouping</small>
                  </span>
                  <button type="button" className="btn" onClick={onConfigureActionBar}>
                    Configure…
                  </button>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-editor" hidden={!sectionHasRow['sec-editor']}>
              <h3>Editor</h3>
              <div className="card">
                <div className="crow" hidden={!rowShown('sec-editor', 'typewriter mode centred cursor')}>
                  <AlignCenterVertical className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Typewriter mode</span>
                    <small>Keep the cursor line on the fixed line as you write (⌘T)</small>
                  </span>
                  <label className="switch" title="Typewriter mode (⌘T)">
                    <input
                      type="checkbox"
                      aria-label="Typewriter mode"
                      checked={typewriterOn}
                      onChange={(e) => onSet('editor.typewriter', e.target.checked, 'Typewriter mode')}
                    />
                    <span className="knob" />
                  </label>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'fixed line position top third middle lower third custom read aloud typewriter height')}>
                  <AlignCenterVertical className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Fixed line position</span>
                    <small>Where the line sits in read-aloud and typewriter mode; drag the marker in the margin to set your own</small>
                  </span>
                  <div className="sw-seg" role="group" aria-label="Fixed line position">
                    {(Object.keys(FIXED_LINE_PRESETS) as (keyof typeof FIXED_LINE_PRESETS)[]).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        aria-pressed={fixedLineChoice === preset}
                        onClick={() => onSet('editor.fixedLine', FIXED_LINE_PRESETS[preset], 'Fixed line position')}
                      >
                        {FIXED_LINE_PRESET_LABELS[preset]}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-pressed={fixedLineChoice === 'custom'}
                      aria-disabled={fixedLineChoice !== 'custom'}
                      title="Drag the marker in the editor margin while reading aloud or in typewriter mode"
                      onClick={(event) => { if (fixedLineChoice !== 'custom') event.preventDefault() }}
                    >
                      {fixedLineChoice === 'custom' ? fixedLineCustomLabel(fixedLineValue) : 'Custom'}
                    </button>
                  </div>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'read-aloud highlight colour strength soft medium strong terracotta amber green blue lilac grey custom preview wash')}>
                  <AudioLines className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Read-aloud highlight</span>
                    <small>Colour of the washes. Terracotta is the default; Custom… opens the system colour picker</small>
                    <div className="ra-swatches" role="group" aria-label="Read-aloud highlight colour">
                      {READ_ALOUD_PRESET_IDS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className="ra-swatch"
                          data-colour={preset}
                          aria-pressed={highlightColour === preset}
                          style={{ ['--swatch' as string]: `rgb(${READ_ALOUD_PRESETS[preset].light.join(' ')})` }}
                          onClick={() => onSet(READ_ALOUD_COLOUR_SETTING, preset, 'Read-aloud highlight')}
                        >
                          <i />
                          {READ_ALOUD_PRESETS[preset].label}
                        </button>
                      ))}
                      <label
                        className="ra-swatch"
                        data-colour="custom"
                        aria-pressed={!isReadAloudPreset(highlightColour)}
                        style={{ ['--swatch' as string]: isReadAloudPreset(highlightColour) ? undefined : highlightColour, cursor: 'pointer' }}
                      >
                        <i className={isReadAloudPreset(highlightColour) ? 'custom' : ''} />
                        Custom…
                        <input
                          type="color"
                          className="ra-picker"
                          aria-label="Custom read-aloud highlight colour"
                          value={isReadAloudPreset(highlightColour) ? '#2e6be6' : highlightColour}
                          onChange={(event) => colourPick.tick(event.target.value.toLowerCase())}
                          ref={(input) => {
                            // React's onChange is the native input event (every drag tick); the native
                            // change event is the picker closing, which ends the pick.
                            if (input && !input.dataset.pickBound) {
                              input.dataset.pickBound = '1'
                              input.addEventListener('change', () => colourPick.commit())
                            }
                          }}
                        />
                      </label>
                    </div>
                  </span>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'read-aloud highlight colour strength soft medium strong terracotta amber green blue lilac grey custom preview wash')}>
                  <AudioLines className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Strength</span>
                    <small>How visible the washes are</small>
                  </span>
                  <div className="sw-seg" role="group" aria-label="Read-aloud highlight strength">
                    {READ_ALOUD_STRENGTHS.map((strength) => (
                      <button
                        key={strength}
                        type="button"
                        aria-pressed={highlightStrength === strength}
                        onClick={() => onSet(READ_ALOUD_STRENGTH_SETTING, strength, 'Highlight strength')}
                      >
                        {strength.charAt(0).toUpperCase() + strength.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'read-aloud highlight colour strength soft medium strong terracotta amber green blue lilac grey custom preview wash')}>
                  <span className="grow">
                    <span className="lbl">Preview</span>
                    <div
                      className="ra-preview"
                      data-testid="read-aloud-highlight-preview"
                      style={readAloudTokens(highlightColour, highlightStrength, highlightTheme)}
                    >
                      <div className="lab">Paragraph, sentence and word</div>
                      <div className="prose">
                        <div className="para">
                          A well-fitted bridle allows clear communication without pinching, rubbing, or restricting the horse's movement.{' '}
                          <span className="sent">
                            The noseband should sit two fingers below the <span className="word">cheekbone</span> and never pull the bit upwards.
                          </span>{' '}
                          Check the buckles after every ride.
                        </div>
                      </div>
                    </div>
                  </span>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'view mode clean markup raw seamless paper rendered source')}>
                  <Eye className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">View mode</span>
                    <small>Clean writing, visible markup, or full source</small>
                  </span>
                  <select
                    aria-label="View mode"
                    title="View mode"
                    value={String(values['editor.viewMode'] ?? 'clean')}
                    onChange={(e) => onSet('editor.viewMode', e.target.value, 'View mode')}
                  >
                    <option value="clean">Clean</option>
                    <option value="markup">Markup</option>
                    <option value="raw">Raw</option>
                  </select>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'line width narrow medium wide')}>
                  <MoveHorizontal className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Line width</span>
                  </span>
                  <select
                    aria-label="Line width"
                    title="Line width"
                    value={String(values['editor.lineWidth'] ?? 'medium')}
                    onChange={(e) => onSet('editor.lineWidth', e.target.value, 'Line width')}
                  >
                    <option value="narrow">Narrow</option>
                    <option value="medium">Medium</option>
                    <option value="wide">Wide</option>
                  </select>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'prose size 17 19 21')}>
                  <Type className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Prose size</span>
                  </span>
                  <select
                    aria-label="Prose size"
                    title="Prose size"
                    value={String(values['editor.proseSize'] ?? '19')}
                    onChange={(e) => onSet('editor.proseSize', e.target.value, 'Prose size')}
                  >
                    <option value="17">17</option>
                    <option value="19">19</option>
                    <option value="21">21</option>
                  </select>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'spellcheck')}>
                  <SpellCheck className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Spellcheck</span>
                  </span>
                  <label className="switch" title="Spellcheck">
                    <input
                      type="checkbox"
                      aria-label="Spellcheck"
                      checked={boolValue('editor.spellcheck', true)}
                      onChange={(e) => onSet('editor.spellcheck', e.target.checked, 'Spellcheck')}
                    />
                    <span className="knob" />
                  </label>
                </div>
                <div className="crow-sub" hidden={!rowShown('sec-editor', 'text readability focus mode fade sentence segment breakup anchored anchored lead-in style bold colour contrast reading focus')}>Text readability</div>
                <div className="crow" hidden={!rowShown('sec-editor', 'text readability focus mode fade sentence segment breakup anchored')}>
                  <Anchor className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Reading focus</span>
                    <small>How the text itself is shown, one at a time</small>
                  </span>
                  <select
                    aria-label="Reading focus"
                    title="Reading focus"
                    value={normaliseFocusMode(values['editor.focusMode'])}
                    onChange={(e) => onSet('editor.focusMode', e.target.value, 'Reading focus')}
                  >
                    <option value="">Off</option>
                    <option value="fade">Fade other paragraphs</option>
                    <option value="sentence">Highlight sentence</option>
                    <option value="segment">Segment focus</option>
                    <option value="breakup">Sentence breakup</option>
                    <option value="anchored">Anchored reading</option>
                  </select>
                </div>
                <div className="crow" hidden={!rowShown('sec-editor', 'anchored lead-in style bold colour contrast reading focus')}>
                  <Anchor className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Anchored lead-in style</span>
                    <small>How Anchored Reading emphasises each word's lead-in</small>
                  </span>
                  <select
                    aria-label="Anchored lead-in style"
                    title="Anchored lead-in style"
                    value={String(values['editor.leadStyle'] ?? 'contrast')}
                    onChange={(e) => onSet('editor.leadStyle', e.target.value, 'Anchored lead-in style')}
                  >
                    <option value="bold">Bold</option>
                    <option value="colour">Colour</option>
                    <option value="contrast">Contrast</option>
                  </select>
                </div>
                <div className="crow-sub" hidden={!rowShown('sec-editor', 'text overlay line focus ruler size follow dim covers opacity')}>Text overlay</div>
                {overlaySwitch('text overlay line focus ruler', 'Line focus', LINE_OVERLAY_SETTINGS.lineFocusOn, Scan)}
                {overlaySelect('text overlay line focus size lines', 'Line focus size', LINE_OVERLAY_SETTINGS.lineFocusSize, String(normaliseLineFocusSize(values[LINE_OVERLAY_SETTINGS.lineFocusSize])), LINE_FOCUS_SIZES.map((n) => [String(n), `${n} ${n === 1 ? 'line' : 'lines'}`]))}
                {overlaySelect('text overlay line focus follow', 'Line focus follow', LINE_OVERLAY_SETTINGS.lineFocusFollow, normaliseLineFollow(values[LINE_OVERLAY_SETTINGS.lineFocusFollow]), LINE_FOLLOWS.map((f) => [f, LINE_FOLLOW_NAMES[f]]))}
                {overlaySelect('text overlay line focus dim light medium dark', 'Line focus dim', LINE_OVERLAY_SETTINGS.lineFocusDim, normaliseLineFocusDim(values[LINE_OVERLAY_SETTINGS.lineFocusDim]), LINE_FOCUS_DIMS.map((d) => [d, LINE_FOCUS_DIM_NAMES[d]]))}
                {overlaySwitch('text overlay line focus ruler', 'Ruler', LINE_OVERLAY_SETTINGS.rulerOn, Minus)}
                {overlaySelect('text overlay ruler covers', 'Ruler covers', LINE_OVERLAY_SETTINGS.rulerCovers, normaliseRulerCovers(values[LINE_OVERLAY_SETTINGS.rulerCovers]), RULER_COVERS.map((c) => [c, RULER_COVER_NAMES[c]]))}
                <div className="crow" hidden={!rowShown('sec-editor', 'text overlay ruler opacity')}>
                  <span className="grow">
                    <span className="lbl">Ruler opacity</span>
                  </span>
                  <input
                    type="range"
                    aria-label="Ruler opacity"
                    min={RULER_OPACITY_MIN}
                    max={RULER_OPACITY_MAX}
                    step={RULER_OPACITY_STEP}
                    value={normaliseRulerOpacity(values[LINE_OVERLAY_SETTINGS.rulerOpacity])}
                    onChange={(e) => onSet(LINE_OVERLAY_SETTINGS.rulerOpacity, Number(e.target.value), 'Ruler opacity')}
                  />
                </div>
                {overlaySelect('text overlay ruler follow', 'Ruler follow', LINE_OVERLAY_SETTINGS.rulerFollow, normaliseLineFollow(values[LINE_OVERLAY_SETTINGS.rulerFollow]), LINE_FOLLOWS.map((f) => [f, LINE_FOLLOW_NAMES[f]]))}
                <div className="crow" hidden={!rowShown('sec-editor', 'open files from browser links external url scheme')}>
                  <Link2 className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Open files from browser links</span>
                  </span>
                  <label className="switch" title="Open files from browser links">
                    <input
                      type="checkbox"
                      aria-label="Open files from browser links"
                      checked={boolValue('integration.browserLinks', true)}
                      onChange={(e) => onSet('integration.browserLinks', e.target.checked, 'Open files from browser links')}
                    />
                    <span className="knob" />
                  </label>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-reading-room" hidden={!sectionHasRow['sec-reading-room']}>
              <h3>Reading Room</h3>
              <div className="card">
                <div className="crow" hidden={!rowShown('sec-reading-room', 'reading room side left right rail paper margin mirror global')}>
                  <BookOpen className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Reading Room side</span>
                    <small>The rail and paper margin mirror together for every document</small>
                  </span>
                  <select
                    aria-label="Reading Room side"
                    title="Reading Room side"
                    value={String(values['readingRoom.side'] ?? 'left')}
                    onChange={(event) => onSet('readingRoom.side', event.target.value, 'Reading Room side')}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-read-aloud" hidden={!sectionHasRow['sec-read-aloud']}>
              <h3>Read aloud</h3>
              <p className="sub">Choose the voice rarely; adjust the speed from the transport bar whenever the draft needs it.</p>
              <VoiceSettings
                voices={voices}
                selectedVoiceURI={selectedVoiceURI}
                query={voiceSearchQuery}
                onChoose={(voice) => onSet('readAloud.voiceURI', voice.uri, 'Voice')}
              />
              <div className="card read-aloud-speed-card">
                <div className="crow" hidden={!rowShown('sec-read-aloud', 'reading scroll typewriter centred centre middle stable voice page turn top screen viewport')}>
                  <AlignCenterVertical className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Reading scroll</span>
                    <small>Keep the voice centred, or turn each screenful back to the top</small>
                  </span>
                  <select
                    aria-label="Reading scroll"
                    title="Reading scroll"
                    value={normaliseReadAloudScrollMode(values['readAloud.scrollMode'])}
                    onChange={(event) => onSet('readAloud.scrollMode', event.target.value, 'Reading scroll')}
                  >
                    <option value="typewriter">Typewriter</option>
                    <option value="page">Page</option>
                  </select>
                </div>
                <div className="crow" hidden={!rowShown('sec-read-aloud', 'default speed reading rate 0.5 1.0 2.5')}>
                  <AudioLines className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Default speed</span>
                    <small>The transport bar can change this directly while reading</small>
                  </span>
                  <select
                    aria-label="Default speed"
                    title="Default speed"
                    value={normaliseReadAloudRate(values['readAloud.rate']).toFixed(1)}
                    onChange={(event) => onSet('readAloud.rate', Number(event.target.value), 'Default speed')}
                  >
                    {READ_ALOUD_RATES.map((rate) => (
                      <option key={rate} value={rate.toFixed(1)}>
                        {rate.toFixed(1)}×
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-sounds" hidden={!sectionHasRow['sec-sounds']}>
              <h3>Sounds</h3>
              <p className="sub">Both channels are off by default. Everything here is bundled — nothing streams.</p>
              <div className="card">
                <div className="crow" hidden={!rowShown('sec-sounds', 'typing sounds a sound per keystroke while you write typewriter deep erika crisp smith corona electric soft keyboard scheme volume')}>
                  <Volume2 className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Typing sounds</span>
                    <small>A sound per keystroke: two real typewriters, or a quiet keyboard</small>
                  </span>
                  <div className="sw-seg" role="group" aria-label="Typing sound scheme">
                    {TYPING_SCHEMES.map(([scheme, label, hint]) => (
                      <button
                        key={scheme}
                        type="button"
                        title={hint}
                        aria-pressed={typingScheme === scheme}
                        onClick={() => onSet('sounds.typing.scheme', scheme, 'Typing sound scheme')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <VolumeSlider label="Typing sound volume" settingKey="sounds.typing.volume" value={volumeValue('sounds.typing.volume', 0.6)} onSet={onSet} />
                  <label className="switch" title="Typing sounds">
                    <input
                      type="checkbox"
                      aria-label="Typing sounds"
                      checked={boolValue('sounds.typing.enabled', false)}
                      onChange={(e) => onSet('sounds.typing.enabled', e.target.checked, 'Typing sounds')}
                    />
                    <span className="knob" />
                  </label>
                </div>
                <div className="crow" hidden={!rowShown('sec-sounds', 'ambient sound background loop warm white noise hush rain volume pauses in the background')}>
                  <AudioLines className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Ambient sound</span>
                    <small>A background loop; pauses when WriteFlex is in the background</small>
                  </span>
                  <div className="sw-seg" role="group" aria-label="Ambient loop">
                    <button
                      type="button"
                      aria-pressed={ambientLoop === 'white'}
                      onClick={() => onSet('sounds.ambient.loop', 'white', 'Ambient loop')}
                    >
                      Warm noise
                    </button>
                    <button
                      type="button"
                      aria-pressed={ambientLoop === 'rain'}
                      onClick={() => onSet('sounds.ambient.loop', 'rain', 'Ambient loop')}
                    >
                      Rain
                    </button>
                  </div>
                  <VolumeSlider label="Ambient volume" settingKey="sounds.ambient.volume" value={volumeValue('sounds.ambient.volume', 0.35)} onSet={onSet} />
                  <label className="switch" title="Ambient sound">
                    <input
                      type="checkbox"
                      aria-label="Ambient sound"
                      checked={boolValue('sounds.ambient.enabled', false)}
                      onChange={(e) => onSet('sounds.ambient.enabled', e.target.checked, 'Ambient sound')}
                    />
                    <span className="knob" />
                  </label>
                </div>
              </div>
              {/* CC BY 4.0 obliges attribution wherever the recording travels, so it rides with the
                  feature rather than sitting only in the pack's CREDITS.md. */}
              <p
                className="sub set-credit"
                hidden={!rowShown('sec-sounds', 'sound credits attribution licence wikimedia commons work with sounds lonemonk')}
              >
                Sounds are field recordings from Wikimedia Commons: the Deep typewriter by Work With
                Sounds / Konrad Gutkowski (CC BY 4.0) and the Crisp one by lonemonk (CC BY 3.0); bell by
                _stubb and hush by jackthemurray (CC0); soft keys by teto_yasha and rain by cori (public
                domain). Full credits ship with the app in
                <code> resources/sounds/CREDITS.md</code>.
              </p>
            </div>

            <div className="set-sec" id="sec-library" hidden={!sectionHasRow['sec-library']}>
              <h3>Library</h3>
              <p className="sub">A Library is a promoted Workspace with an index: wiki links, backlinks, and the writing diary.</p>
              <div className="card">
                <div className="crow" hidden={!rowShown('sec-library', workspaceName, 'not a library promote')}>
                  <Library className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">{workspaceName}</span>
                    <small>Not a Library</small>
                  </span>
                  <button
                    className="ghost"
                    title="Promote to a Library"
                    aria-label="Promote to a Library"
                    onClick={() => onFlash('Libraries land with the index milestone')}
                  >
                    Promote…
                  </button>
                </div>
                <div className="crow" hidden={!rowShown('sec-library', 'watch for external changes other agents apps workspace folder')}>
                  <FolderSync className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Watch for external changes</span>
                    <small>Reflect edits made by other agents and apps</small>
                  </span>
                  <label className="switch" title="Watch for external changes">
                    <input
                      type="checkbox"
                      aria-label="Watch for external changes"
                      checked={boolValue('workspace.watchExternalChanges', true)}
                      onChange={(e) => onSet('workspace.watchExternalChanges', e.target.checked, 'Watch for external changes')}
                    />
                    <span className="knob" />
                  </label>
                </div>
                <div className="crow" hidden={!rowShown('sec-library', 'install command-line tool writeflex terminal shell agents claude code codex')}>
                  <Terminal className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Command-line tool</span>
                    <small>Lets Claude Code, Codex and other agents search and read your Collection with “writeflex”</small>
                  </span>
                  <button
                    className="ghost"
                    type="button"
                    title="Install command-line tool"
                    aria-label="Install command-line tool"
                    onClick={() => {
                      void window.writeflex.installCommandLineTool().then((result) => onFlash(result.message)).catch(() => onFlash('Could not install the command-line tool.'))
                    }}
                  >
                    Install command-line tool
                  </button>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-diary" hidden={!sectionHasRow['sec-diary']}>
              <h3>Diary</h3>
              {typeof values['diary.folder'] !== 'string' || values['diary.folder'] === '' ? (
                <div className="card diary-dormant">
                  <div className="crow" hidden={!rowShown('sec-diary', 'no diary folder designated dormant choose folder')}>
                    <span className="grow">
                      <span className="lbl">No diary folder is designated — the Diary stays dormant.</span>
                      {diarySessionRequired && <small>Choose a Diary folder before starting a session.</small>}
                    </span>
                    <button className="ghost" type="button" onClick={chooseDiaryFolder}>Choose folder…</button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="sub">One diary, designated once. Sessions land here from every Counted Collection.</p>
                  <div className="card">
                    <div className="crow" hidden={!rowShown('sec-diary', 'diary folder path change')}>
                      <Folder className="icon" aria-hidden="true" />
                      <span className="grow">
                        <span className="lbl">Diary folder</span>
                        <small className="diary-path">{String(values['diary.folder'])}</small>
                      </span>
                      <button className="ghost" type="button" onClick={chooseDiaryFolder}>Change…</button>
                    </div>
                  </div>
                  <p className="sub diary-counted-label">Counted Collections</p>
                  <div className="card">
                    {counted.length === 0 && <div className="crow"><span className="grow"><span className="lbl">No Collections count toward the Diary.</span></span></div>}
                    {counted.map((collection) => (
                      <div className="crow" key={`${collection.root}:${collection.dir || '__root'}`} hidden={!rowShown('sec-diary', collection.name, `${collection.pieces} pieces un-count`)}>
                        <BookOpen className="icon" aria-hidden="true" />
                        <span className="grow">
                          <span className="lbl">{collection.name}</span>
                          <small>{collection.pieces} {collection.pieces === 1 ? 'piece' : 'pieces'}</small>
                        </span>
                        <button className="ghost" type="button" onClick={() => uncount(collection.dir, collection.root)}><Minus className="icon sm" aria-hidden="true" /> Un-count</button>
                      </div>
                    ))}
                  </div>
                  <p className="sub diary-recorded-note"><History className="icon sm" aria-hidden="true" /> Recorded in the settings changelog.</p>
                </>
              )}
            </div>

            <div className="set-sec" id="sec-snapshots" hidden={!sectionHasRow['sec-snapshots']}>
              <h3>Saving &amp; history</h3>
              <p className="sub">Three ways your work is kept. <b>Automatic</b> — everything you type saves to disk continuously, so nothing is ever lost. <b>Checkpoint</b> — a point in history you can return to (⌘S, on closing a document, and around every agent edit). <b>Named version</b> — a labelled version you compare with others as a whole (⇧⌘S, arriving with the Change Ledger). History lives inside the Workspace: sync-safe and undoable.</p>
              <div className="card">
                <div className="crow" hidden={!rowShown('sec-snapshots', 'checkpoint on close returnable point history')}>
                  <History className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Checkpoint on close</span>
                  </span>
                  <select
                    aria-label="Checkpoint on close"
                    title="Checkpoint on close"
                    value={String(values['snapshots.frequency'] ?? 'every')}
                    onChange={(e) => onSet('snapshots.frequency', e.target.value, 'Checkpoint on close')}
                  >
                    <option value="every">On</option>
                    <option value="manual">Off</option>
                  </select>
                </div>
                <div className="crow" hidden={!rowShown('sec-snapshots', 'keep history for 30 90 days forever retention')}>
                  <Calendar className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">Keep history for</span>
                  </span>
                  <select
                    aria-label="Keep history for"
                    title="Keep history for"
                    value={String(values['snapshots.retention'] ?? '90')}
                    onChange={(e) => onSet('snapshots.retention', e.target.value, 'Keep history for')}
                  >
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="forever">Forever</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-changelog" hidden={!sectionHasRow['sec-changelog']}>
              <h3>Changelog</h3>
              <p className="sub">Every change made in Settings is recorded here — a tweak you forgot making is one click to undo.</p>
              <div className="card">
                {changelog.length === 0 && (
                  <div className="log-empty">No changes yet — settings you change appear here, each one click to undo.</div>
                )}
                {changelog.map((entry, index) => {
                  const Icon = LOG_ICONS[entry.label] ?? (entry.label.startsWith('Shortcut: ') ? Keyboard : Settings)
                  return (
                    <div
                      className={entry.reverted ? 'crow reverted' : 'crow'}
                      data-log
                      key={`${entry.key}-${entry.at}-${index}`}
                      hidden={!rowShown('sec-changelog', entry.label, 'reset')}
                    >
                      <Icon className="icon" aria-hidden="true" />
                      <span className="grow">
                        <span className="lbl">{entry.label}</span>
                        <small>
                          <span className="log-old">{displayValue(entry.key, entry.old, models, voices, entry.label)}</span> →{' '}
                          <span className="log-new">{displayValue(entry.key, entry.new, models, voices, entry.label)}</span> · {displayWhen(entry.at)}
                          {entry.reverted ? ' · reset' : ''}
                        </small>
                      </span>
                      <button
                        className="ghost log-reset"
                        title={`Reset ${entry.label} to ${displayValue(entry.key, entry.old, models, voices, entry.label)}`}
                        aria-label={`Reset ${entry.label} to ${displayValue(entry.key, entry.old, models, voices, entry.label)}`}
                        disabled={entry.reverted === true}
                        onClick={() => {
                          onRevert(index)
                          // Reverting disables THIS button; a focused button that goes disabled
                          // drops focus to <body>, killing the dialog's Esc/Tab handling. Move
                          // focus to the dialog root (tabIndex=-1) before the re-render disables
                          // us, so the container keeps keyboard ownership (the CheatSheet cure).
                          dialogRef.current?.focus()
                        }}
                      >
                        <Undo2 className="icon sm" aria-hidden="true" />
                        Reset
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Get started (ADR-0043, ticket 10; state 32): bring the example back, open the Guide, and
                the Place chip's switch. Bringing it back takes nothing from here: main holds the path. */}
            <div className="set-sec" id="sec-get-started" hidden={!sectionHasRow['sec-get-started']}>
              <h3>{GET_STARTED_TEXT.section}</h3>
              <div className="card">
                <div className="crow" data-row="get-started" hidden={!rowShown('sec-get-started', GET_STARTED_SEARCH)}>
                  <Compass className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">{GET_STARTED_TEXT.rowA.label}</span>
                    {getStarted?.removed ? <small>{GET_STARTED_TEXT.rowA.small}</small> : null}
                    {restoreRefusal !== null ? <small className="set-refusal" role="alert">{restoreRefusal}</small> : null}
                  </span>
                  {getStarted?.canRestore ? (
                    <button type="button" className="btn" data-action="restore-example" disabled={restoring} onClick={restoreExample}>{GET_STARTED_TEXT.rowA.b1}</button>
                  ) : null}
                  <button ref={openGuideRef} type="button" className="btn" data-action="open-guide" onClick={() => onOpenGuide?.()}>{GET_STARTED_TEXT.rowA.b2}</button>
                </div>
                <div className="crow" hidden={!rowShown('sec-get-started', SHOW_PLACE_SEARCH)}>
                  <TextCursorInput className="icon" aria-hidden="true" />
                  <span className="grow">
                    <span className="lbl">{SHOW_PLACE_LABEL}</span>
                    <small>{PLACE_CHIP_EXAMPLE}</small>
                  </span>
                  <label className="switch" title={SHOW_PLACE_LABEL}>
                    <input
                      type="checkbox"
                      aria-label={SHOW_PLACE_LABEL}
                      checked={boolValue(SHOW_PLACE_KEY, true)}
                      onChange={(e) => onSet(SHOW_PLACE_KEY, e.target.checked, SHOW_PLACE_LABEL)}
                    />
                    <span className="knob" />
                  </label>
                </div>
              </div>
            </div>

            <div className="set-sec" id="sec-shortcuts" hidden={!sectionHasRow['sec-shortcuts']}>
              <h3>Shortcuts</h3>
              <p className="sub">
                Every command, its chord, and where the chord came from — the Keycap Ledger. Click a chord to
                change it in a small capture popover. New focus commands ship unassigned; defaults arrive in the
                pre-v1 consolidation sweep. The full list is always one key away: press <kbd>?</kbd> anywhere.
              </p>
              <div className="kl-search">
                <Search className="icon sm" aria-hidden="true" />
                <input
                  type="text"
                  value={ledgerQuery}
                  onChange={(e) => setLedgerQuery(e.target.value)}
                  placeholder="Filter commands"
                  aria-label="Filter commands"
                />
              </div>
              <div className="card keycap-ledger">
                <div className="kl-row kl-head" aria-hidden="true">
                  <span className="grow">Command</span>
                  <span className="kl-chord">Chord</span>
                  <span className="kl-src">Source</span>
                </div>
                {bindableCommandGroups.map((group) => {
                  const filter = ledgerQuery.trim().toLowerCase()
                  const rows = group.rows.filter((command) => {
                    const chord = resolveChord(command.id, overrides)
                    return (filter === '' || `${command.label} ${command.task} ${chord ?? ''}`.toLowerCase().includes(filter))
                      && rowShown('sec-shortcuts', command.label, command.task)
                  })
                  if (rows.length === 0) return null
                  return <div className="kl-group" key={group.title}>
                    <h4 className="kl-group-title">{group.title}</h4>
                    {rows.map((command) => {
                      const chord = resolveChord(command.id, overrides)
                      const overridden = overrides[command.id] !== undefined
                      return <div className="kl-row" key={command.id}>
                      <span className="grow">{command.label}</span>
                      <span className="kl-chord">
                        <button
                          type="button"
                          className="kl-assign"
                          aria-label={`Change the chord for ${command.label}`}
                          title={`Change the chord for ${command.label}`}
                          onClick={() => setCapturing(capturing === command.id ? null : command.id)}
                        >
                          {chord ? (
                            <>
                              {splitChord(chord).mods.map((glyph, index) => (
                                <kbd key={index}>{glyph}</kbd>
                              ))}
                              <kbd>{splitChord(chord).key}</kbd>
                            </>
                          ) : (
                            <span className="kl-unset">not assigned</span>
                          )}
                        </button>
                        {capturing === command.id && (
                          <ShortcutCapture
                            label={command.label}
                            conflictsFor={(candidate) => conflictsFor(candidate, command.id, overrides)}
                            onAssign={(candidate) => assignChord(command, candidate)}
                            onMoveHere={(candidate) => moveChordHere(command, candidate)}
                            onCancel={() => setCapturing(null)}
                          />
                        )}
                      </span>
                      <span className="kl-src">
                        {overridden ? (
                          <>
                            <span className="kl-custom">custom</span>
                            <button
                              type="button"
                              className="kl-reset"
                              aria-label={`Reset ${command.label} to its default chord`}
                              title={`Reset ${command.label} to its default chord`}
                              onClick={() => resetChord(command)}
                            >
                              ↺
                            </button>
                          </>
                        ) : chord ? (
                          'default'
                        ) : (
                          '—'
                        )}
                      </span>
                      </div>
                    })}
                  </div>
                })}
              </div>
            </div>

            {sectionHasRow['sec-sharing'] && <SharingSettingsPanel onFlash={onFlash} onOpenSetup={onOpenSharingSetup} />}

            {sectionHasRow['sec-about'] && <AboutPanel onFlash={onFlash} />}
          </div>
        </div>
      </div>
    </div>
  )
}
