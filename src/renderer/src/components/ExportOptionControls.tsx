import type { KeyboardEvent } from 'react'
import type { ExportFormat } from '../../../preload'
import {
  EXPORT_MASTHEAD_FIELDS,
  type ExportMastheadField,
  type ExportSheetOptions,
} from './export-sheet-options'
import type { ExportPresetField } from '../../../shared/export-presets'

export type ExportOptionControlsProps = {
  format: ExportFormat
  options: ExportSheetOptions
  onChange: (options: ExportSheetOptions) => void
  changedFields?: readonly ExportPresetField[]
}

const FIELD_LABELS: Record<ExportMastheadField, string> = {
  date: 'Date',
  status: 'Status',
  author: 'Author',
  purpose: 'Purpose',
  tags: 'Tags',
  series: 'Series',
}

function focusSibling(event: KeyboardEvent<HTMLButtonElement>, index: number, length: number): void {
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  buttons?.[(index + length) % length]?.focus()
}

function SwitchRow({
  label,
  checked,
  disabled = false,
  changed = false,
  onToggle,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  changed?: boolean
  onToggle?: () => void
}): JSX.Element {
  return (
    <div className={`export-switch-row${disabled ? ' disabled' : ''}`}>
      <span className="export-switch-copy">
        <b>{label}</b>
        {disabled && <small className="export-coming">Coming</small>}
      </span>
      <button
        className={`export-switch${checked ? ' on' : ''}${changed ? ' changed' : ''}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${label} ${checked ? 'on' : 'off'}`}
        disabled={disabled}
        onClick={onToggle}
      />
    </div>
  )
}

/** Locked frame (a)'s HTML-only controls. One complete value crosses its props/events seam. */
export function ExportOptionControls({ format, options, onChange, changedFields = [] }: ExportOptionControlsProps): JSX.Element {
  const disabled = format === 'docx'
  const change = (patch: Partial<ExportSheetOptions>): void => onChange({ ...options, ...patch })
  const toggleField = (field: ExportMastheadField): void => {
    const selected = options.frontmatterFields.includes(field)
    change({
      frontmatterFields: selected
        ? options.frontmatterFields.filter((candidate) => candidate !== field)
        : [...options.frontmatterFields, field],
    })
  }

  return (
    <fieldset className={`export-html-options${disabled ? ' disabled' : ''}`} disabled={disabled} aria-label="HTML-only options">
      {disabled && <p className="export-html-only-note">These choices apply to HTML exports.</p>}
      <div className="export-field">
        <div className="export-flabel">Document features <span>Tab, then Space</span></div>
        <div className="export-switch-list">
          <SwitchRow label="Contents sidebar" checked={options.sidebar} changed={changedFields.includes('sidebar')} onToggle={() => change({ sidebar: !options.sidebar })} />
          <SwitchRow label="Title block and details" checked={options.titleBlock} changed={changedFields.includes('titleBlock')} onToggle={() => change({ titleBlock: !options.titleBlock })} />
          <SwitchRow label="Front page" checked={options.frontPage} changed={changedFields.includes('frontPage')} onToggle={() => change({ frontPage: !options.frontPage })} />
          <SwitchRow label="Reader can add notes" checked={options.readerNotes} changed={changedFields.includes('readerNotes')} onToggle={() => change({ readerNotes: !options.readerNotes })} />
          <SwitchRow label="Reader can edit and return changes" checked={options.readerEdits} changed={changedFields.includes('readerEdits')} onToggle={() => change({ readerEdits: !options.readerEdits })} />
          <SwitchRow label="Include word count and dates" checked={options.summaryTiles} changed={changedFields.includes('summaryTiles')} onToggle={() => change({ summaryTiles: !options.summaryTiles })} />
        </div>
      </div>

      <div className="export-field">
        <div className="export-flabel" id="export-design-label">Design <span>Tab, then ← →</span></div>
        <div className="export-design-grid" role="radiogroup" aria-labelledby="export-design-label">
          {(['a', 'b'] as const).map((design, index) => (
            <button
              key={design}
              className={`export-design-choice${options.design === design ? ' on' : ''}`}
              type="button"
              role="radio"
              aria-checked={options.design === design}
              aria-label={`${design === 'a' ? 'Report' : 'Editorial'} design`}
              tabIndex={options.design === design ? 0 : -1}
              onClick={() => change({ design })}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const next = event.key === 'ArrowRight' ? (index + 1) % 2 : (index + 1) % 2
                change({ design: next === 0 ? 'a' : 'b' })
                focusSibling(event, next, 2)
              }}
            >
              <span className={`export-design-swatch ${design === 'a' ? 'report' : 'editorial'}`} aria-hidden="true" />
              <span><b>{design === 'a' ? 'Report' : 'Editorial'}</b><small>{design === 'a' ? 'Light document' : 'Dark numbered rail'}</small></span>
            </button>
          ))}
        </div>
      </div>

      <div className="export-field">
        <div className="export-flabel" id="export-masthead-label">Masthead fields <span>Tab, then ← → Space</span></div>
        <div className="export-chipset" role="group" aria-labelledby="export-masthead-label">
          {EXPORT_MASTHEAD_FIELDS.map((field, index) => {
            const selected = options.frontmatterFields.includes(field)
            return (
              <button
                key={field}
                className={`export-chip${selected ? ' on' : ''}`}
                type="button"
                role="checkbox"
                aria-checked={selected}
                aria-label={`${FIELD_LABELS[field]} masthead field ${selected ? 'on' : 'off'}`}
                onClick={() => toggleField(field)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const offset = event.key === 'ArrowRight' ? 1 : EXPORT_MASTHEAD_FIELDS.length - 1
                  focusSibling(event, index + offset, EXPORT_MASTHEAD_FIELDS.length)
                }}
              >
                {selected && <span aria-hidden="true">✓</span>}
                {FIELD_LABELS[field]}
              </button>
            )
          })}
        </div>
      </div>
    </fieldset>
  )
}
