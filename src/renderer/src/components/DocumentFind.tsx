import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, Replace, Search, X } from 'lucide-react'

export type FindStatus = { current: number; total: number }

type Props = {
  query: string
  replacement: string
  replaceOpen: boolean
  status: FindStatus
  onQuery: (query: string) => void
  onReplacement: (replacement: string) => void
  onToggleReplace: () => void
  onMove: (direction: 1 | -1) => void
  onReplace: (all: boolean) => void
  onClose: () => void
}

export function DocumentFind({ query, replacement, replaceOpen, status, onQuery, onReplacement, onToggleReplace, onMove, onReplace, onClose }: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  return (
    <div className="findbox" role="search" aria-label="Find in document">
      <div className="find-line">
        <button type="button" className="find-disc" aria-expanded={replaceOpen} aria-label="Show replace" title="Replace (⌥⌘F)" onClick={onToggleReplace}><ChevronRight className="icon xs" /></button>
        <label className="search-field find-field">
          <Search className="icon sm" aria-hidden="true" />
          <input ref={inputRef} value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onMove(event.shiftKey ? -1 : 1) }
            else if (event.key === 'Escape') { event.preventDefault(); onClose() }
          }} aria-label="Find" />
          <span className="fcount" aria-live="polite">{status.total ? `${status.current} of ${status.total}` : '0 of 0'}</span>
        </label>
        <div className="fnav">
          <button type="button" className="fbtn" aria-label="Previous match" title="Previous match (⇧⌘G or ⇧↵)" onClick={() => onMove(-1)}><ChevronUp className="icon sm" /></button>
          <button type="button" className="fbtn" aria-label="Next match" title="Next match (⌘G or ↵)" onClick={() => onMove(1)}><ChevronDown className="icon sm" /></button>
          <button type="button" className="fbtn" aria-label="Close find" title="Close (Esc)" onClick={onClose}><X className="icon sm" /></button>
        </div>
      </div>
      {replaceOpen && <div className="find-rep">
        <span className="find-indent" aria-hidden="true" />
        <label className="search-field find-field"><Replace className="icon sm" aria-hidden="true" /><input value={replacement} onChange={(event) => onReplacement(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }} placeholder="Replace with…" aria-label="Replace with" /></label>
        <button type="button" className="rbtn" onClick={() => onReplace(false)}>Replace</button>
        <button type="button" className="rbtn" onClick={() => onReplace(true)}>All</button>
      </div>}
      <div className="find-foot"><span className="scope">this document</span><span className="sp" /><span className="fk"><kbd>↵</kbd>next</span><span className="fk"><kbd>⇧↵</kbd>prev</span><span className="fk"><kbd>Esc</kbd></span></div>
    </div>
  )
}
