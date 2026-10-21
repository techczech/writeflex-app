/**
 * Named build errors (contracts §7): the closed list of codes with their severity, and the one shape a build
 * reports, `{ code, severity, source: { path, line?, pointer?, record?, field? }, value?, detail?, message }`.
 * `message` is a plain sentence that names the place. Errors are collected per build and capped at 50.
 */
import type { WidgetIssue } from './recipe'

export type Severity = 'error' | 'warning'

const WARNINGS = new Set(['source-original-missing', 'source-original-unreadable', 'origin-not-on-this-mac', 'sync-grant-mismatch', 'output-hand-edited'])

/** Every code §7 names (tests/fixtures/standard-widgets/build-error-codes.json). */
export const BUILD_ERROR_CODES: readonly string[] = [
  'recipe-unreadable', 'recipe-invalid', 'recipe-schema-unsupported', 'recipe-unknown-template', 'recipe-template-version-unsupported',
  'recipe-mapping-missing', 'recipe-mapping-incompatible',
  'source-missing', 'source-outside', 'source-unreadable', 'source-too-large', 'source-not-utf8', 'source-empty',
  'source-original-missing', 'source-original-unreadable', 'origin-not-on-this-mac', 'sync-grant-mismatch',
  'csv-malformed', 'csv-header-duplicate', 'csv-header-empty',
  'json-malformed', 'json-selector-not-found', 'json-selector-not-array', 'json-record-not-object',
  'table-not-found', 'table-ambiguous',
  'section-not-found', 'structure-no-records', 'fields-block-malformed',
  'column-missing', 'id-missing', 'id-duplicate', 'value-invalid-number', 'value-invalid-date',
  'date-missing', 'date-ambiguous-local-time', 'date-nonexistent-local-time', 'date-offset-mismatch', 'zone-unknown', 'zone-missing', 'span-reversed', 'span-mixed-kinds',
  'resource-outside', 'resource-link-refused', 'resource-missing', 'resource-unreadable', 'resource-id-duplicate', 'resource-id-invalid', 'resource-id-unknown',
  'resource-declaration-invalid', 'folder-missing', 'folder-member-missing', 'folder-too-large',
  'output-outside', 'output-hand-edited', 'output-write-failed',
]

export const severityOf = (code: string): Severity => WARNINGS.has(code) ? 'warning' : 'error'

export const BUILD_ERROR_CAP = 50

export type BuildError = {
  code: string
  severity: Severity
  source: { path: string; line?: number; pointer?: string; record?: number; field?: string }
  value?: unknown
  detail?: string
  first_line?: number
  first_pointer?: string
  message: string
}

const SENTENCE: Record<string, string> = {
  'recipe-unreadable': 'The widget settings cannot be read',
  'recipe-invalid': 'A widget setting is not valid',
  'recipe-schema-unsupported': 'The widget settings were written for another version of WriteFlex',
  'recipe-unknown-template': 'This kind of widget is not one WriteFlex can build',
  'recipe-template-version-unsupported': 'This version of the widget template is not one WriteFlex can build',
  'recipe-mapping-missing': 'A required field is not chosen',
  'recipe-mapping-incompatible': 'A chosen field or source cannot be used by this widget',
  'source-missing': 'The source file is not there',
  'source-outside': 'The source file is outside the document\'s folder',
  'source-unreadable': 'The source file cannot be read',
  'source-too-large': 'The source file is too large',
  'source-not-utf8': 'The source file is not UTF-8 text',
  'source-empty': 'The source has no records',
  'source-original-missing': 'The original of a file kept in sync is not there',
  'source-original-unreadable': 'The original of a file kept in sync cannot be read',
  'origin-not-on-this-mac': 'The original of a file kept in sync is not known on this Mac, so the last copy was used',
  'sync-grant-mismatch': 'The sync record of this file belongs to another document or resource, so the original was not read and the last copy was used',
  'csv-malformed': 'The CSV file is malformed',
  'csv-header-duplicate': 'Two CSV columns have the same name',
  'csv-header-empty': 'A CSV column has no name',
  'json-malformed': 'The JSON file is malformed',
  'json-selector-not-found': 'Nothing in the JSON file is at the chosen place',
  'json-selector-not-array': 'The chosen place in the JSON file is not a list',
  'json-record-not-object': 'An item in the chosen JSON list is not a record',
  'column-missing': 'A chosen field is not in the source',
  'id-missing': 'A record has no id',
  'id-duplicate': 'Two records have the same id',
  'value-invalid-number': 'A value is not a number',
  'resource-outside': 'The resource is outside the Folio',
  'resource-link-refused': 'The resource is reached through a link, which WriteFlex does not follow',
  'resource-missing': 'The resource file is not there',
  'resource-unreadable': 'The resource cannot be read',
  'resource-id-invalid': 'A resource id is not valid',
  'resource-id-unknown': 'A resource is not declared in the Folio',
  'resource-declaration-invalid': 'A resource declaration is not valid',
  'output-outside': 'The widget is not inside a visualisations folder of a document',
  'output-hand-edited': 'The built page was edited by hand, so it was kept and the new build was saved beside it',
  'output-write-failed': 'The built widget could not be saved',
}

/** A problem as the build reports it: severity from the closed list, the place, and a sentence naming it. */
export function buildError(issue: WidgetIssue, path: string): BuildError {
  const { code, line, pointer, record, field, value, detail, first_line, first_pointer } = issue as WidgetIssue & {
    line?: number; pointer?: string; record?: number; field?: string; value?: unknown; detail?: string; first_line?: number; first_pointer?: string
  }
  const source: BuildError['source'] = { path }
  if (line !== undefined) source.line = line
  if (pointer !== undefined) source.pointer = pointer
  if (record !== undefined) source.record = record
  if (field !== undefined) source.field = field
  const where = [path, line !== undefined ? `line ${line}` : null, pointer !== undefined ? `at ${pointer}` : null, record !== undefined ? `record ${record}` : null, field !== undefined ? `field ${field}` : null]
    .filter((part): part is string => part !== null).join(', ')
  const said = [SENTENCE[code] ?? code, value !== undefined && value !== null && typeof value !== 'object' ? `(“${String(value)}”)` : null, detail ? `: ${detail}` : null].filter(Boolean).join(' ').replace(/ :/, ':')
  const out: BuildError = { code, severity: severityOf(code), source, message: `${said} (${where}).` }
  if (value !== undefined) out.value = value
  if (detail !== undefined) out.detail = detail
  if (first_line !== undefined) out.first_line = first_line
  if (first_pointer !== undefined) out.first_pointer = first_pointer
  return out
}
