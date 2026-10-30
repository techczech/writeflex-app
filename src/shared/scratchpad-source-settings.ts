// Settings › Scratchpad (ADR-0050, ticket 05): the two independent optional-source switches and
// the TalkWeaver vaults the writer chose to browse. Both switches are OFF unless the stored value
// is exactly `true` — unset, malformed or reverted all read as off, and while a source is off the
// app must not discover, scan or query it at all. The chosen vaults are TalkWeaver vault ids
// (from TalkWeaver's own registry, read through the read-only adapter in main), stored as one
// JSON string because a settings value is a primitive.

export const SCRATCHPAD_TALKWEAVER_KEY = 'scratchpad.talkweaver'
export const SCRATCHPAD_SLIDEWELL_KEY = 'scratchpad.slidewell'
export const SCRATCHPAD_TALKWEAVER_VAULTS_KEY = 'scratchpad.talkweaverVaults'

export type ScratchExternalSourceId = 'talkweaver' | 'slidewell'

/** The switch key of one optional source. */
export const scratchpadSourceKey = (source: ScratchExternalSourceId): string =>
  source === 'talkweaver' ? SCRATCHPAD_TALKWEAVER_KEY : SCRATCHPAD_SLIDEWELL_KEY

/** Only an exact stored `true` enables a source; anything else is off. */
export const scratchpadSourceEnabled = (value: unknown): boolean => value === true

const MAX_CHOSEN_VAULTS = 50
const MAX_VAULT_ID = 200

/** The chosen TalkWeaver vault ids, as stored. Anything malformed reads as "none chosen". */
export function chosenTalkweaverVaults(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry === '' || entry.length > MAX_VAULT_ID || out.includes(entry)) continue
    out.push(entry)
    if (out.length >= MAX_CHOSEN_VAULTS) break
  }
  return out
}

/** The settings value for a chosen-vault list (the same cleaning the reader applies). */
export function chosenTalkweaverVaultsValue(ids: readonly string[]): string {
  return JSON.stringify(chosenTalkweaverVaults(JSON.stringify([...ids])))
}
