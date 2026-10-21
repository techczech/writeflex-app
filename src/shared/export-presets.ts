export const EXPORT_PRESET_FIELDS = [
  'sidebar',
  'titleBlock',
  'readerNotes',
  'readerEdits',
  'summaryTiles',
  'frontPage',
  'design',
  'tocDepth',
  'frontmatterFields',
  'format',
] as const

export type ExportPresetField = (typeof EXPORT_PRESET_FIELDS)[number]
export type ExportPresetFormat = 'html' | 'docx'
export type ExportPresetDesign = 'a' | 'b'
export const EXPORT_PRESET_MASTHEAD_FIELDS = ['date', 'status', 'author', 'purpose', 'tags', 'series'] as const
export type ExportPresetMastheadField = (typeof EXPORT_PRESET_MASTHEAD_FIELDS)[number]

export type ExportPresetChoice = {
  format: ExportPresetFormat
  sidebar: boolean
  titleBlock: boolean
  readerNotes: boolean
  readerEdits: boolean
  summaryTiles: boolean
  frontPage: boolean
  design: ExportPresetDesign
  /** Heading levels the HTML contents lists, 1-6 (6 is All); absent keeps the default. */
  tocDepth?: number
  frontmatterFields: ExportPresetMastheadField[]
}

export type ExportPreset = { id: string; name: string; choice: ExportPresetChoice }
export type ExportPresetSettings = { presets: ExportPreset[] }
export type ExportPresetLastUsed = { choice: ExportPresetChoice; sourcePresetId: string | null }

export const DEFAULT_EXPORT_PRESET_CHOICE: ExportPresetChoice = {
  format: 'html',
  sidebar: true,
  titleBlock: true,
  readerNotes: false,
  readerEdits: false,
  summaryTiles: false,
  frontPage: false,
  design: 'a',
  frontmatterFields: ['date', 'status', 'author'],
}

const cloneChoice = (choice: ExportPresetChoice): ExportPresetChoice => ({
  ...choice,
  frontmatterFields: [...choice.frontmatterFields],
})

const clonePreset = (preset: ExportPreset): ExportPreset => ({ ...preset, choice: cloneChoice(preset.choice) })

export function shippedExportPresetSettings(): ExportPresetSettings {
  const reading = cloneChoice(DEFAULT_EXPORT_PRESET_CHOICE)
  return {
    presets: [
      { id: 'reading-document', name: 'Reading document', choice: reading },
      { id: 'for-comments', name: 'For comments', choice: { ...cloneChoice(reading), readerNotes: true } },
      { id: 'for-edits', name: 'For edits', choice: { ...cloneChoice(reading), readerEdits: true } },
      {
        id: 'plain',
        name: 'Plain',
        choice: { ...cloneChoice(DEFAULT_EXPORT_PRESET_CHOICE), sidebar: false, titleBlock: false, frontmatterFields: [] },
      },
    ],
  }
}

const isMastheadField = (value: unknown): value is ExportPresetMastheadField =>
  typeof value === 'string' && (EXPORT_PRESET_MASTHEAD_FIELDS as readonly string[]).includes(value)

export const isTocDepth = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6

function normaliseChoice(value: unknown): ExportPresetChoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if ((input.format !== 'html' && input.format !== 'docx')
    || typeof input.sidebar !== 'boolean'
    || typeof input.titleBlock !== 'boolean'
    || typeof input.readerNotes !== 'boolean'
    || typeof input.readerEdits !== 'boolean'
    || typeof input.summaryTiles !== 'boolean'
    || (input.frontPage !== undefined && typeof input.frontPage !== 'boolean')
    || (input.design !== 'a' && input.design !== 'b')
    || (input.tocDepth !== undefined && !isTocDepth(input.tocDepth))
    || !Array.isArray(input.frontmatterFields)
    || !input.frontmatterFields.every(isMastheadField)) return null
  return {
    format: input.format,
    sidebar: input.sidebar,
    titleBlock: input.titleBlock,
    readerNotes: input.readerNotes,
    readerEdits: input.readerEdits,
    summaryTiles: input.summaryTiles,
    frontPage: input.frontPage === true,
    design: input.design,
    ...(input.tocDepth === undefined ? {} : { tocDepth: input.tocDepth as number }),
    frontmatterFields: [...new Set(input.frontmatterFields)],
  }
}

export function normaliseExportPresetSettings(value: unknown): ExportPresetSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.presets)) return null
  const presets: ExportPreset[] = []
  const ids = new Set<string>()
  for (const raw of input.presets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const preset = raw as Record<string, unknown>
    const choice = normaliseChoice(preset.choice)
    if (typeof preset.id !== 'string' || preset.id.length === 0 || ids.has(preset.id)
      || typeof preset.name !== 'string' || preset.name.trim().length === 0 || !choice) return null
    ids.add(preset.id)
    presets.push({ id: preset.id, name: preset.name.trim(), choice })
  }
  return { presets }
}

export function normaliseExportPresetLastUsed(value: unknown): ExportPresetLastUsed | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const choice = normaliseChoice(input.choice)
  if (!choice || !(input.sourcePresetId === null || typeof input.sourcePresetId === 'string')) return null
  return { choice, sourcePresetId: input.sourcePresetId }
}

const sameArray = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

export function changedExportPresetFields(choice: ExportPresetChoice, preset: ExportPresetChoice): ExportPresetField[] {
  return EXPORT_PRESET_FIELDS.filter((field) => field === 'frontmatterFields'
    ? !sameArray(choice.frontmatterFields, preset.frontmatterFields)
    : choice[field] !== preset[field])
}

export type ExportPresetMode = 'sheet' | 'saving-as' | 'managing'
export type ExportPresetStatus = 'unnamed' | 'applied' | 'drifted'
export type ExportPresetState = {
  presets: ExportPreset[]
  choice: ExportPresetChoice
  sourcePresetId: string | null
  status: ExportPresetStatus
  changedFields: ExportPresetField[]
  mode: ExportPresetMode
}

export type ExportPresetAction =
  | { type: 'apply'; presetId: string }
  | { type: 'change'; choice: ExportPresetChoice }
  | { type: 'update' }
  | { type: 'begin-save-as' }
  | { type: 'save-as'; id: string; name: string }
  | { type: 'manage' }
  | { type: 'show-sheet' }
  | { type: 'rename'; presetId: string; name: string }
  | { type: 'delete'; presetId: string }
  | { type: 'move'; presetId: string; direction: -1 | 1 }

function derive(state: Omit<ExportPresetState, 'status' | 'changedFields'>): ExportPresetState {
  const source = state.sourcePresetId
    ? state.presets.find((preset) => preset.id === state.sourcePresetId)
    : undefined
  const changedFields = source ? changedExportPresetFields(state.choice, source.choice) : []
  return {
    ...state,
    status: source ? (changedFields.length === 0 ? 'applied' : 'drifted') : 'unnamed',
    changedFields,
  }
}

export function createExportPresetState(settings: ExportPresetSettings, lastUsed: ExportPresetLastUsed | null = null): ExportPresetState {
  const safe = normaliseExportPresetSettings(settings) ?? shippedExportPresetSettings()
  const restored = normaliseExportPresetLastUsed(lastUsed)
  return derive({
    presets: safe.presets.map(clonePreset),
    choice: cloneChoice(restored?.choice ?? DEFAULT_EXPORT_PRESET_CHOICE),
    sourcePresetId: restored?.sourcePresetId && safe.presets.some((preset) => preset.id === restored.sourcePresetId)
      ? restored.sourcePresetId
      : null,
    mode: 'sheet',
  })
}

export function snapshotExportPresetSettings(state: ExportPresetState): ExportPresetSettings {
  return { presets: state.presets.map(clonePreset) }
}

export function snapshotExportPresetLastUsed(state: ExportPresetState): ExportPresetLastUsed {
  return { choice: cloneChoice(state.choice), sourcePresetId: state.sourcePresetId }
}

export function reduceExportPresetState(state: ExportPresetState, action: ExportPresetAction): ExportPresetState {
  if (action.type === 'apply') {
    const preset = state.presets.find((candidate) => candidate.id === action.presetId)
    return preset ? derive({ ...state, choice: cloneChoice(preset.choice), sourcePresetId: preset.id, mode: 'sheet' }) : state
  }
  if (action.type === 'change') return derive({ ...state, choice: cloneChoice(action.choice) })
  if (action.type === 'update') {
    if (!state.sourcePresetId) return state
    const presets = state.presets.map((preset) => preset.id === state.sourcePresetId
      ? { ...preset, choice: cloneChoice(state.choice) }
      : preset)
    return derive({ ...state, presets, mode: 'sheet' })
  }
  if (action.type === 'begin-save-as') return { ...state, mode: 'saving-as' }
  if (action.type === 'save-as') {
    const name = action.name.trim()
    if (!name || !action.id || state.presets.some((preset) => preset.id === action.id)) return state
    const preset = { id: action.id, name, choice: cloneChoice(state.choice) }
    return derive({ ...state, presets: [...state.presets, preset], sourcePresetId: preset.id, mode: 'sheet' })
  }
  if (action.type === 'manage') return { ...state, mode: 'managing' }
  if (action.type === 'show-sheet') return { ...state, mode: 'sheet' }
  if (action.type === 'rename') {
    const name = action.name.trim()
    if (!name) return state
    return derive({ ...state, presets: state.presets.map((preset) => preset.id === action.presetId ? { ...preset, name } : preset) })
  }
  if (action.type === 'delete') {
    return derive({
      ...state,
      presets: state.presets.filter((preset) => preset.id !== action.presetId),
      sourcePresetId: state.sourcePresetId === action.presetId ? null : state.sourcePresetId,
    })
  }
  const index = state.presets.findIndex((preset) => preset.id === action.presetId)
  const target = index + action.direction
  if (index < 0 || target < 0 || target >= state.presets.length) return state
  const presets = [...state.presets]
  ;[presets[index], presets[target]] = [presets[target], presets[index]]
  return derive({ ...state, presets })
}
