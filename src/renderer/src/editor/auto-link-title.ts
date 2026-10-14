import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** True for clipboard text that is nothing but a single http(s) URL: no leading/trailing prose,
 *  no embedded whitespace (which would also rule out a second line). Anything else falls through
 *  to CodeMirror's default paste handling untouched. */
export function isBareUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text)
}

/** What to insert for a URL paste, and (when relevant) where the just-inserted text still reads
 *  as the bare URL and so is a candidate for later replacement by a fetched page title.
 *
 *  - Non-empty selection: wrap it as `[selected](url)` — the user supplied their own link text,
 *    so there's nothing to fetch a title for (`titleTo: null` signals "no fetch needed").
 *  - Empty selection: `[url](url)` — the link TEXT (the first `url` occurrence, inside the
 *    brackets) is what a fetched title should later replace. `titleFrom`/`titleTo` are offsets
 *    into `insert` itself; the caller translates them into document positions once it knows
 *    where `insert` landed. */
export function pasteReplacement(
  selectedText: string,
  url: string
): { insert: string; titleFrom: number; titleTo: number | null } {
  if (selectedText.length > 0) {
    return { insert: `[${selectedText}](${url})`, titleFrom: 1, titleTo: null }
  }
  const insert = `[${url}](${url})`
  return { insert, titleFrom: 1, titleTo: 1 + url.length }
}

/** A title fetch still in flight for one pasted URL. `id` disambiguates concurrent pastes (each
 *  gets its own entry); `from`/`to` are document positions that get remapped through every
 *  subsequent change so they keep pointing at the link-text span even as the user keeps typing. */
type PendingTitle = { id: number; from: number; to: number; url: string }

let nextPendingId = 0

/** Registers a newly pasted URL's link-text range as "awaiting a title". The `map` option lets
 *  this effect's own value survive being carried through a mapping (e.g. if it were ever combined
 *  with other changes before landing in the field) rather than only relying on the field's manual
 *  remapping below — belt and braces for the same reason both are used for decorations. */
const addPendingTitle = StateEffect.define<PendingTitle>({
  map: (value, changes) => ({ ...value, from: changes.mapPos(value.from, -1), to: changes.mapPos(value.to, 1) })
})

/** Removes one pending entry by id once its fetch has resolved (title applied, rejected as stale,
 *  or the fetch failed) — otherwise resolved pastes would leak in the field forever. */
const clearPendingTitle = StateEffect.define<number>()

/** All URL pastes in this document still waiting on a title fetch. Positions are kept current
 *  across every transaction: `-1`/`1` associativity keeps the range hugging exactly the pasted
 *  link text, so text typed immediately after the paste (past the closing `)`) never gets pulled
 *  into the tracked span. */
const pendingTitlesField = StateField.define<PendingTitle[]>({
  create: () => [],
  update(value, tr) {
    let next = value.map((p) => ({
      ...p,
      from: tr.changes.mapPos(p.from, -1),
      to: tr.changes.mapPos(p.to, 1)
    }))
    for (const effect of tr.effects) {
      if (effect.is(addPendingTitle)) next = [...next, effect.value]
      else if (effect.is(clearPendingTitle)) next = next.filter((p) => p.id !== effect.value)
    }
    return next
  }
})

/** `EditorView.domEventHandlers({ paste })` that turns pasting a bare URL into a Markdown link,
 *  fetching a page title in the background for the no-selection case.
 *
 *  - Selection paste: `[selected](url)` inserted synchronously, no fetch.
 *  - Empty-selection paste: `[url](url)` inserted synchronously (so the doc is never left showing
 *    a bare URL mid-fetch), the link-text range registered in `pendingTitlesField`, then once
 *    `fetchTitle` resolves the MAPPED range is re-read and — only if it still reads exactly
 *    `url` (the user hasn't edited it away in the meantime) — replaced with the title. A `null`
 *    title (fetch failed, blocked host, timeout, ...) leaves `[url](url)` as the final result. */
export function autoLinkTitle(fetchTitle: (url: string) => Promise<string | null>): Extension {
  return [
    pendingTitlesField,
    EditorView.domEventHandlers({
      paste(event, view) {
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (!isBareUrl(text)) return false
        event.preventDefault()

        const range = view.state.selection.main
        const selectedText = view.state.sliceDoc(range.from, range.to)
        const url = text
        const replacement = pasteReplacement(selectedText, url)
        const insertFrom = range.from
        const cursorPos = insertFrom + replacement.insert.length
        const id = nextPendingId++

        view.dispatch({
          changes: { from: range.from, to: range.to, insert: replacement.insert },
          selection: { anchor: cursorPos },
          effects:
            replacement.titleTo !== null
              ? [
                  addPendingTitle.of({
                    id,
                    from: insertFrom + replacement.titleFrom,
                    to: insertFrom + replacement.titleTo,
                    url
                  })
                ]
              : []
        })

        if (replacement.titleTo !== null) {
          const settle = (title: string | null): void => {
            const pending = view.state.field(pendingTitlesField, false)?.find((p) => p.id === id)
            if (!pending) return
            const stillBareUrl = view.state.sliceDoc(pending.from, pending.to) === url
            if (title !== null && stillBareUrl) {
              view.dispatch({
                changes: { from: pending.from, to: pending.to, insert: title },
                effects: clearPendingTitle.of(id)
              })
            } else {
              view.dispatch({ effects: clearPendingTitle.of(id) })
            }
          }
          fetchTitle(url).then(settle, () => settle(null))
        }

        return true
      }
    })
  ]
}
