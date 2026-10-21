export const COLLECTION_PAGE_COMMANDS = [
  ['search', 'Search this collection'], ['menu', 'Open Collection menu'],
  ['status', 'Filter collection by status'], ['purpose', 'Filter collection by purpose'], ['tags', 'Filter collection by tags'], ['modified', 'Filter collection by modified date'],
  ['group', 'Group collection documents'], ['sort', 'Sort collection documents'], ['search-in', 'Choose collection search scope'], ['clear', 'Clear collection search and filters'],
  ['make-folio', 'Make a Folio…'], ['index', 'Create index note or edit cover note'], ['rename', 'Rename this collection…'],
  ['select-all', 'Select all matching collection documents'], ['clear-selection', 'Clear collection selection'],
  ['bulk-status', 'Set status for selected documents…'], ['bulk-move', 'Move selected documents to…'], ['bulk-folio', 'Add selected documents to Folio…'], ['bulk-tag', 'Tag selected documents…'],
] as const
export type CollectionPageCommand = typeof COLLECTION_PAGE_COMMANDS[number][0]
