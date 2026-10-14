import { expect, test } from 'bun:test'
import {
  createExportPresetState,
  DEFAULT_EXPORT_PRESET_CHOICE,
  reduceExportPresetState,
  snapshotExportPresetLastUsed,
  shippedExportPresetSettings,
  snapshotExportPresetSettings,
} from '../../src/shared/export-presets'

test('the four shipped presets are ordinary ordered records with their complete choices', () => {
  const settings = shippedExportPresetSettings()
  expect(settings.presets.map((preset) => preset.name)).toEqual([
    'Reading document',
    'For comments',
    'For edits',
    'Plain',
  ])
  expect(settings.presets.every((preset) => !('privileged' in preset))).toBe(true)
  expect(settings.presets[1].choice.readerNotes).toBe(true)
  expect(settings.presets[2].choice.readerEdits).toBe(true)
  expect(settings.presets[3].choice).toEqual({
    ...DEFAULT_EXPORT_PRESET_CHOICE,
    sidebar: false,
    titleBlock: false,
    frontmatterFields: [],
  })
})

test('applying sets exactly the stored switches, format and design, then any changed value drifts', () => {
  const settings = shippedExportPresetSettings()
  const comments = settings.presets[1]
  let state = createExportPresetState(settings)
  state = reduceExportPresetState(state, { type: 'apply', presetId: comments.id })
  expect(state.choice).toEqual(comments.choice)
  expect(state.status).toBe('applied')
  expect(state.sourcePresetId).toBe(comments.id)

  state = reduceExportPresetState(state, {
    type: 'change',
    choice: { ...state.choice, readerEdits: true },
  })
  expect(state.status).toBe('drifted')
  expect(state.changedFields).toEqual(['readerEdits'])
})

test('updating rewrites the applied preset while save-as creates a new applied preset', () => {
  const comments = shippedExportPresetSettings().presets[1]
  let state = createExportPresetState(shippedExportPresetSettings())
  state = reduceExportPresetState(state, { type: 'apply', presetId: comments.id })
  state = reduceExportPresetState(state, {
    type: 'change',
    choice: { ...state.choice, design: 'b', readerEdits: true },
  })
  state = reduceExportPresetState(state, { type: 'update' })
  expect(state.status).toBe('applied')
  expect(state.presets.find((preset) => preset.id === comments.id)?.choice).toEqual(state.choice)

  state = reduceExportPresetState(state, {
    type: 'change',
    choice: { ...state.choice, format: 'docx' },
  })
  state = reduceExportPresetState(state, { type: 'begin-save-as' })
  expect(state.mode).toBe('saving-as')
  state = reduceExportPresetState(state, { type: 'save-as', id: 'collaborative', name: 'For collaborative review' })
  expect(state.mode).toBe('sheet')
  expect(state.status).toBe('applied')
  expect(state.sourcePresetId).toBe('collaborative')
  expect(state.presets.at(-1)).toMatchObject({ id: 'collaborative', name: 'For collaborative review', choice: state.choice })
})

test('last-used drift, deletion and order survive a state-machine reopen', () => {
  const comments = shippedExportPresetSettings().presets[1]
  let state = createExportPresetState(shippedExportPresetSettings())
  state = reduceExportPresetState(state, { type: 'apply', presetId: comments.id })
  state = reduceExportPresetState(state, {
    type: 'change',
    choice: { ...state.choice, summaryTiles: true },
  })
  const reopened = createExportPresetState(snapshotExportPresetSettings(state), snapshotExportPresetLastUsed(state))
  expect(reopened.status).toBe('drifted')
  expect(reopened.choice.summaryTiles).toBe(true)

  state = reduceExportPresetState(reopened, { type: 'rename', presetId: comments.id, name: 'For review comments' })
  state = reduceExportPresetState(state, { type: 'move', presetId: comments.id, direction: 1 })
  state = reduceExportPresetState(state, { type: 'delete', presetId: comments.id })
  const afterRestart = createExportPresetState(snapshotExportPresetSettings(state), snapshotExportPresetLastUsed(state))
  expect(afterRestart.presets.some((preset) => preset.id === comments.id)).toBe(false)
  expect(afterRestart.choice.summaryTiles).toBe(true)
  expect(afterRestart.status).toBe('unnamed')
})
