// The old in-window Settings sheet named its sections by element id ('sec-read-aloud'); the Settings
// window (0.27) names its pages by schema section or custom page. Callers keep their words.
const PAGE_OF_SECTION: Readonly<Record<string, string>> = {
  'sec-backup': 'backup',
  'sec-sharing': 'sharing',
  'sec-scratchpad': 'scratchpad',
  'sec-library': 'command-line',
  'sec-perms': 'assistant',
  'sec-editor': 'writing',
  'sec-snapshots': 'history',
  'sec-action-bar': 'general',
  'sec-reading-room': 'reading-room',
  'sec-sounds': 'sounds',
  'sec-read-aloud': 'read-aloud',
  'sec-diary': 'diary',
  'sec-about': 'updates',
  'sec-account': 'accounts',
  'sec-appearance': 'appearance',
  'sec-shortcuts': 'shortcuts',
  'sec-changelog': 'changes',
  'sec-get-started': 'get-started',
}

/** The Settings window's page for an old section id (or a page id as it is); undefined opens it where it was. */
export function settingsPageOf(section: string | undefined): string | undefined {
  if (!section) return undefined
  return PAGE_OF_SECTION[section] ?? (section.startsWith('sec-') ? undefined : section)
}
