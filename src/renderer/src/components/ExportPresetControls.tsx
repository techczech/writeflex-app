import { useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  type ExportPresetAction,
  type ExportPresetChoice,
  type ExportPresetState,
} from '../../../shared/export-presets'

export type ExportPresetControlsProps = {
  state: ExportPresetState
  onAction: (action: ExportPresetAction) => void
  initialManagementAction?: 'rename'
}

const choiceSummary = (choice: ExportPresetChoice): string => {
  const features = [
    choice.sidebar ? 'contents' : '',
    choice.titleBlock ? 'title details' : '',
    choice.readerNotes ? 'reader comments' : '',
    choice.readerEdits ? 'reader editing' : '',
    choice.summaryTiles ? 'word count and dates' : '',
  ].filter(Boolean)
  return `${features.length ? features.join(' · ') : 'Everything off'} · ${choice.design === 'a' ? 'Report' : 'Editorial'} · ${choice.format === 'html' ? 'HTML' : 'Word'}`
}

const generatedPresetId = (): string => {
  try { return crypto.randomUUID() } catch { return `preset-${Date.now()}` }
}

function NamingMode({ state, onAction }: ExportPresetControlsProps): JSX.Element {
  const [name, setName] = useState('For collaborative review')
  const save = (): void => {
    if (name.trim()) onAction({ type: 'save-as', id: generatedPresetId(), name })
  }
  return (
    <div className="export-preset-naming">
      <p className="export-context-summary">
        <b>Current combination:</b> {choiceSummary(state.choice)}. Scope is not saved because it follows the selected piece or collection.
      </p>
      <div className="export-name-card">
        <h3>Save as new preset</h3>
        <p>Name this combination. Presets are stored in this Mac’s app settings, not in the writing folder.</p>
        <div className="export-name-input-wrap">
          <input
            className="export-name-input"
            autoFocus
            value={name}
            aria-label="Preset name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); save() }
              if (event.key === 'Escape') { event.preventDefault(); onAction({ type: 'show-sheet' }) }
            }}
          />
          <span className="export-key-path">⌘A selects name</span>
        </div>
        <div className="export-name-actions">
          <button className="btn ghost" type="button" onClick={() => onAction({ type: 'show-sheet' })}>Cancel <kbd>Esc</kbd></button>
          <span className="grow" />
          <button className="btn primary" type="button" onClick={save}>Save preset <kbd>↵</kbd></button>
        </div>
      </div>
    </div>
  )
}

function ManageMode({ state, onAction, initialManagementAction }: ExportPresetControlsProps): JSX.Element {
  const initialEditingId = initialManagementAction === 'rename' ? state.sourcePresetId ?? state.presets[0]?.id ?? null : null
  const [editingId, setEditingId] = useState<string | null>(initialEditingId)
  const [name, setName] = useState(() => state.presets.find((preset) => preset.id === initialEditingId)?.name ?? '')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const rename = (presetId: string): void => {
    if (name.trim()) onAction({ type: 'rename', presetId, name })
    setEditingId(null)
  }
  const move = (presetId: string, direction: -1 | 1): void => onAction({ type: 'move', presetId, direction })
  const drop = (event: DragEvent, targetId: string): void => {
    event.preventDefault()
    if (!draggingId || draggingId === targetId) return
    const from = state.presets.findIndex((preset) => preset.id === draggingId)
    const to = state.presets.findIndex((preset) => preset.id === targetId)
    const direction = from < to ? 1 : -1
    for (let index = from; index !== to; index += direction) move(draggingId, direction)
    setDraggingId(null)
  }
  return (
    <div className="export-preset-management">
      <div className="export-manage-note">
        <span>All presets are editable. Their order becomes the order in the export sheet.</span>
        <span>{state.presets.length} presets · stored on this Mac</span>
      </div>
      <div className="export-preset-list">
        {state.presets.map((preset, index) => (
          <div
            className={`export-manage-row${editingId === preset.id ? ' editing' : ''}`}
            key={preset.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, preset.id)}
          >
            <button
              className="export-order-handle"
              type="button"
              draggable
              aria-label={`Reorder ${preset.name}`}
              onDragStart={() => setDraggingId(preset.id)}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                event.preventDefault()
                move(preset.id, event.key === 'ArrowUp' ? -1 : 1)
              }}
            >⠿</button>
            {editingId === preset.id ? (
              <div>
                <input
                  className="export-rename-input"
                  autoFocus
                  value={name}
                  aria-label={`Rename ${preset.name}`}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); rename(preset.id) }
                    if (event.key === 'Escape') { event.preventDefault(); setEditingId(null) }
                  }}
                />
                <small>↵ saves · Esc cancels rename</small>
              </div>
            ) : (
              <div className="export-manage-title"><b>{preset.name}</b><small>{choiceSummary(preset.choice)}</small></div>
            )}
            <button
              className="export-row-action"
              type="button"
              onClick={() => editingId === preset.id
                ? rename(preset.id)
                : (setEditingId(preset.id), setName(preset.name))}
            >{editingId === preset.id ? 'Save' : 'Rename'}</button>
            <button className="export-row-action delete" type="button" onClick={() => onAction({ type: 'delete', presetId: preset.id })}>Delete</button>
            <div className="export-row-path">
              <span>Tab to handle · ↑ ↓ reorder</span>
              <span aria-label="Move export preset up">Move export preset up</span>
              <span aria-label="Move export preset down">Move export preset down</span>
              <span>{index + 1}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="export-management-palette"><b>Palette parity:</b> Manage export presets, Rename export preset, Delete export preset, Move export preset up, and Move export preset down are all reachable from ⌘⇧P.</p>
      <div className="export-name-actions">
        <button className="btn ghost" type="button" onClick={() => onAction({ type: 'show-sheet' })}>Back to export <kbd>Esc</kbd></button>
        <span className="grow" />
        <button className="btn primary" type="button" onClick={() => onAction({ type: 'show-sheet' })}>Done <kbd>↵</kbd></button>
      </div>
    </div>
  )
}

function focusPreset(event: KeyboardEvent<HTMLButtonElement>, index: number, length: number): void {
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.export-preset')
  buttons?.[(index + length) % length]?.focus()
}

export function ExportPresetControls(props: ExportPresetControlsProps): JSX.Element {
  const { state, onAction } = props
  if (state.mode === 'saving-as') return <NamingMode {...props} />
  if (state.mode === 'managing') return <ManageMode {...props} />
  const source = state.sourcePresetId ? state.presets.find((preset) => preset.id === state.sourcePresetId) : undefined
  return (
    <>
      {state.status === 'drifted' && source && (
        <div className="export-preset-drift changed" role="status">
          <span className="export-drift-mark">!</span>
          <div><b>Changed from “{source.name}”</b><p>The current choices no longer match that preset.</p></div>
          <div className="export-drift-actions">
            <button className="btn warn" type="button" onClick={() => onAction({ type: 'update' })}>Update “{source.name}” <kbd>↵</kbd></button>
            <button className="btn" type="button" onClick={() => onAction({ type: 'begin-save-as' })}>Save as new</button>
          </div>
        </div>
      )}
      <div className="export-field export-preset-field">
        <div className="export-flabel">Preset <span>Tab, then ← → ↵</span></div>
        <div className="export-preset-row" role="group" aria-label="Export presets">
          {state.presets.map((preset, index) => {
            const applied = state.status === 'applied' && state.sourcePresetId === preset.id
            const driftSource = state.status === 'drifted' && state.sourcePresetId === preset.id
            return (
              <button
                className={`export-preset${applied ? ' on' : ''}${driftSource ? ' drift-source' : ''}`}
                key={preset.id}
                type="button"
                aria-pressed={applied}
                onClick={() => onAction({ type: 'apply', presetId: preset.id })}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const offset = event.key === 'ArrowRight' ? 1 : state.presets.length - 1
                  focusPreset(event, index + offset, state.presets.length)
                }}
              ><b>{preset.name}</b><small><span>{choiceSummary(preset.choice)}</span><kbd>{index + 1}</kbd></small></button>
            )
          })}
        </div>
        <div className="export-preset-tools">
          <button className="export-text-button" type="button" onClick={() => onAction({ type: 'manage' })}>Manage presets <span>Tab ↵</span></button>
        </div>
      </div>
    </>
  )
}
