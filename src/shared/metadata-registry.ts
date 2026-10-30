import { PLAN_ROLES } from './plan-line'
import { REFERENCE_STATUS_ORDER } from './collection-status'

export type MetadataOption = { value: string; label: string; explanation: string }
export type MetadataEntry = { key: string; label: string; explanation: string; list?: boolean; system?: boolean; primary?: boolean; /** A new value of this field is written bare when it strictly is this type, else as text. */ type?: 'number' | 'date'; options?: readonly MetadataOption[]; suggestions?: readonly string[] }
const field = (key: string, label: string, explanation: string, rest: Partial<MetadataEntry> = {}): MetadataEntry => ({ key, label, explanation, ...rest })

/** Document header vocabulary. Status stays open: custom Board lanes are part of WriteFlex's contract. */
export const METADATA_REGISTRY: readonly MetadataEntry[] = [
  field('title', 'Title', 'The declared document title used by export and sharing; changing it does not rename the file.', { primary: true }),
  field('standfirst', 'Standfirst', 'A short introduction used by the Folio Details card and its cover.', { primary: true }),
  field('author', 'Author', 'Who wrote the document. Choose a name used in this workspace or type a new one.', { primary: true }),
  field('date', 'Date', 'The document date, normally YYYY-MM-DD; shown in collection listings and selected exports.', { primary: true, type: 'date' }),
  field('status', 'Status', 'The Board lane for this document. Custom lane names are allowed.', { primary: true, suggestions: REFERENCE_STATUS_ORDER }),
  field('status_label', 'Status label', 'The status text shown on a shared page, in place of the Board lane name.'),
  field('audience', 'Audience', 'Who the document is for; also used by Folio Details and cover metadata.', { primary: true }),
  field('language', 'Language', 'The language of the document, shared with the Folio Details card.', { primary: true }),
  field('tags', 'Tags', 'Properties used to find and group documents. Values used in this workspace are offered here.', { primary: true, list: true }),
  field('description', 'Description', 'A description available to collection views and selected export metadata.'),
  field('purpose', 'Purpose', 'What this document is for; part of the default collection pattern.'),
  field('related', 'Related', 'Related documents, listed in collection metadata and selected exports.', { list: true }),
  field('series', 'Series', 'The series this document belongs to; available to listings and exports.'),
  field('series-order', 'Series order', 'The document’s numeric position within its series.', { type: 'number' }),
  field('project', 'Project', 'The project used by collection query projections.'),
  field('aliases', 'Aliases', 'Alternate names used by document lookup.', { list: true }),
  field('alias', 'Alias', 'An alternate name used by document lookup.'),
  field('role', 'Folio role', 'The role used for an unlisted Folio part.', { options: PLAN_ROLES.map(value => ({ value, label: value, explanation: `Use this part as ${value}.` })) }),
  field('folio', 'Folio page', 'Set section on a section opening. Every later contents part belongs to it until the next section page.', { options: [{ value: 'section', label: 'Section page', explanation: 'Start a section here.' }] }),
  field('section-title-pages', 'Section title pages', 'On the Index Note, set true to put each section opening on its own page in paged HTML or print.'),
  field('section-contents', 'Section contents', 'On the Index Note, set true to show links to a section’s parts at its opening in HTML.'),
  field('heading', 'Heading', 'Set none to omit a Folio part heading; otherwise the document heading determines its title.', { system: true }),
  field('year', 'Publication year', 'The publication year used when matching author–year citations to research notes.', { type: 'number' }),
  field('published', 'Published', 'A publication date used as a fallback year for research note citation matching.', { type: 'date' }),
  field('authors', 'Authors', 'Authors of a research note, used for matching author–year citations.', { list: true }),
  field('sources', 'Sources', 'Research notes attached to this piece, shown in the Board sources rail.', { list: true }),
  field('goal', 'Word goal', 'The document word target used by the writing goal gauge.', { type: 'number' }),
  field('due', 'Due date', 'The deadline used by the writing goal gauge, normally YYYY-MM-DD.', { type: 'date' }),
  field('toc_depth', 'Contents depth', 'How many heading levels the exported contents includes.', { options: [1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: String(n), explanation: `Include headings through level ${n}.` })), type: 'number' }),
  field('piece', 'Folder pieces', 'On an Index Note, whether the folder is treated as one piece or many.', { options: [{ value: 'one', label: 'One piece', explanation: 'Treat the folder as one piece.' }, { value: 'many', label: 'Many pieces', explanation: 'List the folder’s individual pieces.' }] }),
  ...[
    ['pattern', 'Collection pattern', 'The ordered metadata columns written when a collection pattern is chosen.'],
    ['diary', 'Diary', 'The collection counting mode managed by WriteFlex diary settings.'],
    ['created-by', 'Created by', 'Records the app or agent that created this document.'],
    ['created', 'Created', 'The creation timestamp recorded for an agent note.'],
    ['agent_note_status', 'Agent note status', 'Controls whether an agent note is still active.'],
    ['agent_note_kind', 'Agent note kind', 'Identifies the kind of agent note.'],
    ['source_document', 'Source document', 'Connects an agent note to its source document.'],
    ['object_kind', 'Object kind', 'Identifies the object captured in an agent note.'],
    ['recorded_at', 'Recorded at', 'The time an object note was recorded.'],
    ['skill', 'Skill', 'The skill that produced an agent note.'],
  ].map(([key, label, explanation]) => field(key, label, explanation, { system: true })),
]
export const metadataEntry = (key: string): MetadataEntry | undefined => METADATA_REGISTRY.find(entry => entry.key === key)
export type MetadataValues = Record<string, Array<{ value: string; count: number }>>
