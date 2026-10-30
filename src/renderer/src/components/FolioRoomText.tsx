import { ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RoomPart } from '../../../preload'
import { stageClass, textPaneKind } from '../../../shared/folio-room'

/**
 * The text pane of the Folio room (Text view and Split, interactions 4 and 5). The text is the app's own editor on the part's
 * file, not a second one: this pane asks the app to show the file (`onShowText`) and leaves an empty box where the editor goes.
 * The editor (the one that is already mounted under the room, with its buffers, saves, history and conflict handling) is
 * lifted over that box by `.editor-wrap[data-room-text]` and the `--rt-*` variables set here. An unwritten part has no file,
 * so it shows "not written yet" and no editor. READ ONLY: showing a part opens the file as any open does and writes nothing.
 */

export type FolioRoomTextProps = {
  part: RoomPart | null
  /** The part before and after the shown one, in running order (unwritten parts included). */
  prev: RoomPart | null
  next: RoomPart | null
  onSelect: (part: RoomPart) => void
  /** The app shows this file in its editor (null: no file is wanted any more). */
  onShowText: (path: string | null) => void
  /** The file the app's editor now holds, so the box is revealed only once it holds this part, never another document. */
  textLoaded: string | null
}

/** Put the app's editor over `box` while `active`; take it back on cleanup. No-op outside the app shell (no `.editor-wrap`). */
function useEditorWindow(box: React.RefObject<HTMLDivElement>, active: boolean): void {
  useLayoutEffect(() => {
    const element = box.current
    const wrap = element?.closest<HTMLElement>('.editor-wrap')
    if (!element || !wrap || !active) return
    const place = (): void => {
      const outer = wrap.getBoundingClientRect()
      const inner = element.getBoundingClientRect()
      wrap.style.setProperty('--rt-x', `${inner.left - outer.left}px`)
      wrap.style.setProperty('--rt-y', `${inner.top - outer.top}px`)
      wrap.style.setProperty('--rt-w', `${inner.width}px`)
      wrap.style.setProperty('--rt-h', `${inner.height}px`)
    }
    place()
    wrap.setAttribute('data-room-text', '')
    const observer = new ResizeObserver(place)
    observer.observe(element)
    observer.observe(wrap)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      wrap.removeAttribute('data-room-text')
      for (const name of ['--rt-x', '--rt-y', '--rt-w', '--rt-h']) wrap.style.removeProperty(name)
    }
  }, [box, active])
}

export function FolioRoomText({ part, prev, next, onSelect, onShowText, textLoaded }: FolioRoomTextProps): JSX.Element {
  const kind = textPaneKind(part)
  const path = kind === 'editor' ? part?.key.path ?? null : null
  const box = useRef<HTMLDivElement>(null)
  const ready = path !== null && textLoaded === path
  useEffect(() => {
    onShowText(path)
    return () => onShowText(null)
  }, [path, onShowText])
  useEditorWindow(box, kind === 'editor' && textLoaded !== null)

  const nav = (target: RoomPart | null, side: 'prev' | 'next'): JSX.Element => (
    <button type="button" className={`fr-nav${side === 'next' ? ' r' : ''}`} data-nav={side} disabled={target === null} onClick={() => target && onSelect(target)}
      title={target ? `${side === 'prev' ? 'Previous' : 'Next'} part: ${target.title}` : side === 'prev' ? 'This is the first part' : 'This is the last part'}>
      {side === 'prev' && <ChevronLeft aria-hidden="true" />}{target ? `${target.index + 1} ${target.title}` : side === 'prev' ? 'First part' : 'Last part'}{side === 'next' && <ChevronRight aria-hidden="true" />}
    </button>
  )

  return (
    <div className="fr-text" data-testid="room-text" data-text-kind={kind}>
      <div className="fr-tbar">
        {nav(prev, 'prev')}
        {part && <span className="fr-tcur"><b>{part.index + 1}</b> {part.title}</span>}
        {part && <span className="fr-tw">{part.resolution ? part.status : part.written ? `${part.words.toLocaleString('en-GB')} ${part.words === 1 ? 'word' : 'words'}` : 'not written yet'} · <span className={`fr-stage ${part.written || part.status === 'idea' ? stageClass(part.status) : 'idea'}`}><span className="sd" />{part.resolution ? part.status : part.written ? part.status : 'idea'}</span></span>}
        {nav(next, 'next')}
      </div>
      {kind === 'editor' && <div className="fr-textbox" ref={box} data-testid="room-text-box" data-ready={ready}>{!ready && <div className="fr-note">Opening the text…</div>}</div>}
      {kind === 'not-written' && part?.resolution && <div className="fr-unwritten"><b>{part.status}</b><span>Use “Link to a file…” on this part to choose its chapter file.</span></div>}
      {kind === 'not-written' && !part?.resolution && (
        <div className="fr-unwritten" data-testid="room-text-unwritten"><Lightbulb className="icon idea" aria-hidden="true" /><b>not written yet</b>
          <span>This part is a plan line in the Index Note with no file yet, so there is no text to show.</span></div>
      )}
      {kind === 'none' && <div className="fr-unwritten"><b>No parts yet</b><span>Add parts to the Folio’s running order and their text appears here.</span></div>}
    </div>
  )
}
