import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { plainErrorForScreen } from '../error-text'
import { folioScope, undoStepKeptAmong, undoStepUsableOnScreen } from '../../../shared/folio-running-order'
import type { TitleFixAnswer, TitleFixDirection } from '../../../preload'
import type { FlashAction } from './folio-running-order'

/**
 * The renderer's side of the title-conflict buttons on the Plan and the Outline (title-conflict buttons,
 * 2026-10-19). It writes nothing itself: each fix is one call over the preload bridge naming the part and
 * the version it saw, and main writes (main/title-conflict-fix.ts). This keeps the one Undo step (main's
 * token), the flash that offers it, and the refusal for a part open with unsaved edits.
 *
 * The open document's own bar does not come here: it edits the editor buffer (TitleConflictBar.tsx).
 *
 * Decision: a part that is open with unsaved edits is refused ("Save or close <name> first") rather than
 * routed through its buffer. That is what the Plan's heading choice does today in effect: it never routes
 * through the buffer (only the margin card's owner route does), and a disk write under a dirty buffer would
 * raise the changed-on-disk notice. A clean open buffer takes the new text from the changed-on-disk event.
 *
 * The Undo step belongs to the Folio it was made in, as the running order's does (folio-running-order.ts):
 * offered and run only while that Folio is the one on screen (`undoStepUsableOnScreen`: the Plan's own Folio
 * while a Plan is shown, else the open file's), and dropped once another Folio comes on screen.
 */

export type TitleFixTarget = { path: string; fingerprint: string }

export type TitleConflictActions = {
  /** Fix one part of the Folio at `dir`. */
  fixPart: (dir: string, part: TitleFixTarget, direction: TitleFixDirection) => Promise<boolean>
  /** Fix every part named, in one Undo step. */
  fixAll: (dir: string, parts: readonly TitleFixTarget[], direction: TitleFixDirection) => Promise<boolean>
  undo: () => Promise<void>
  canUndo: boolean
}

type Deps = {
  say: (message: string, action?: FlashAction) => void
  /** Whether the document at `path` is open with edits not yet saved. */
  unsaved: (path: string) => boolean
  /** The workspace root, the open file's Folio folder (the Outline), and the folder whose Plan is shown. */
  root: string | null
  openDir: string | null
  planDir: string | null
}

/** What the screen shows of Folios: the Outline's and the Plan's, as `folioScope`s. */
export type TitleUndoScreen = { outlineScope: string | null; planScope: string | null }

export function titleUndoScreen(root: string | null, openDir: string | null, planDir: string | null): TitleUndoScreen {
  return { outlineScope: openDir === null ? null : folioScope(root, openDir), planScope: planDir === null ? null : folioScope(root, planDir) }
}

/** Whether a title step made for the Folio `scope` may be offered and run on `screen`, and whether it is kept at all. */
export function titleUndoOnScreen(scope: string, screen: TitleUndoScreen): { usable: boolean; kept: boolean } {
  const open = [screen.outlineScope, screen.planScope].flatMap((item) => (item === null ? [] : [item]))
  return { usable: undoStepUsableOnScreen(scope, screen.outlineScope, screen.planScope), kept: undoStepKeptAmong(scope, open) }
}

type HeldStep = { token: string; scope: string }

const nameOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')

export const TitleConflictContext = createContext<TitleConflictActions | null>(null)

/** The actions, or null where the app gave none (a test render): the surfaces then show the warning without buttons. */
export function useTitleConflictContext(): TitleConflictActions | null {
  return useContext(TitleConflictContext)
}

function fixedSentence(direction: TitleFixDirection, count: number): string {
  const what = direction === 'heading-to-title' ? 'title' : 'heading'
  return count === 1 ? `The ${what} now matches.` : `${count} ${what}s now match.`
}

export function useTitleConflictActions({ say, unsaved, root, openDir, planDir }: Deps): TitleConflictActions {
  const [step, setStep] = useState<HeldStep | null>(null)
  const stepRef = useRef<HeldStep | null>(null)
  const busy = useRef(false)
  const screen = titleUndoScreen(root, openDir, planDir)
  // Read by answers and clicks that come later: the Folios on screen at that moment.
  const screenRef = useRef(screen)
  screenRef.current = screen
  const rootRef = useRef(root)
  rootRef.current = root
  const keep = useCallback((next: HeldStep | null) => { stepRef.current = next; setStep(next) }, [])

  // Another Folio came on screen: the step made in the one before is not offered again.
  const screenKey = `${screen.outlineScope ?? ''}\u0001${screen.planScope ?? ''}`
  useEffect(() => {
    const held = stepRef.current
    if (held && !titleUndoOnScreen(held.scope, screenRef.current).kept) keep(null)
  }, [screenKey, keep])

  const undo = useCallback(async (): Promise<void> => {
    const held = stepRef.current
    if (!held || busy.current) return
    // Only in its own Folio: an Undo asked while another Folio (or none) is on screen changes nothing.
    if (!titleUndoOnScreen(held.scope, screenRef.current).usable) return
    busy.current = true
    keep(null)
    try {
      const answer = await window.writeflex.titleConflict.undo(held.token)
      if (!answer.ok) { say(answer.message); return }
      if (answer.kept.length === 0) say(answer.restored.length === 1 ? 'Title change undone.' : `Title changes undone in ${answer.restored.length} files.`)
      else say(`Undone in ${answer.restored.length} ${answer.restored.length === 1 ? 'file' : 'files'}. ${answer.kept.map((item) => `${nameOf(item.path)}: ${item.message}`).join(' ')}`)
    } catch (error) {
      say(plainErrorForScreen(error, 'Could not undo the title change.'))
    } finally {
      busy.current = false
    }
  }, [keep, say])

  const finish = useCallback((answer: TitleFixAnswer, direction: TitleFixDirection, dir: string): boolean => {
    if (!answer.ok) { say(answer.message); return false }
    const scope = folioScope(rootRef.current, dir)
    // An answer that arrives after another Folio came on screen does not put a step back.
    if (answer.undo) keep(titleUndoOnScreen(scope, screenRef.current).kept ? { token: answer.undo, scope } : null)
    const skipped = answer.skipped.map((item) => `${nameOf(item.path)}: ${item.message}`).join(' ')
    const message = answer.written.length ? fixedSentence(direction, answer.written.length) : 'Nothing was changed.'
    const action = answer.undo ? { label: 'Undo', run: () => { void undo() } } : undefined
    say(skipped ? `${message} ${skipped}` : message, action)
    return answer.written.length > 0
  }, [keep, say, undo])

  const run = useCallback(async (dir: string, parts: readonly TitleFixTarget[], direction: TitleFixDirection, bulk: boolean): Promise<boolean> => {
    if (busy.current || parts.length === 0) return false
    const open = parts.find((part) => unsaved(part.path))
    if (open) { say(`Save or close ${nameOf(open.path)} first.`); return false }
    busy.current = true
    try {
      const answer = bulk
        ? await window.writeflex.titleConflict.fixFolio(dir, parts.map(({ path, fingerprint }) => ({ path, fingerprint })), direction)
        : await window.writeflex.titleConflict.fixPart(dir, { path: parts[0].path, fingerprint: parts[0].fingerprint }, direction)
      return finish(answer, direction, dir)
    } catch (error) {
      say(plainErrorForScreen(error, 'Could not change the title. Nothing was changed.'))
      return false
    } finally {
      busy.current = false
    }
  }, [finish, say, unsaved])

  const fixPart = useCallback((dir: string, part: TitleFixTarget, direction: TitleFixDirection) => run(dir, [part], direction, false), [run])
  const fixAll = useCallback((dir: string, parts: readonly TitleFixTarget[], direction: TitleFixDirection) => run(dir, parts, direction, true), [run])

  const canUndo = step !== null && titleUndoOnScreen(step.scope, screen).usable
  return useMemo(() => ({ fixPart, fixAll, undo, canUndo }), [canUndo, fixAll, fixPart, undo])
}
