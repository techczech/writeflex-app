import { useCallback, useRef, useState } from 'react'
import { FileText, Search, SquarePen } from 'lucide-react'
import type { MarkdownFile } from '../../../preload'
import { relativeTime } from './relative-time'

export type WorkspaceEmptyProps = {
  files: MarkdownFile[]
  onNewFile: () => void
  onSearchFiles: () => void
  onOpenFile: (path: string) => void
}

type WorkspaceRecentRowProps = {
  file: MarkdownFile
  index: number
  active: number
  count: number
  rowRef: (element: HTMLButtonElement | null) => void
  onFocus: () => void
  onKeyDown: (event: React.KeyboardEvent, index: number, count: number) => void
  onOpenFile: (path: string) => void
}

export function WorkspaceRecentRow({
  file,
  index,
  active,
  count,
  rowRef,
  onFocus,
  onKeyDown,
  onOpenFile,
}: WorkspaceRecentRowProps): JSX.Element {
  return (
    <button
      ref={rowRef}
      className="workspace-rec-row"
      tabIndex={index === active ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={(event) => onKeyDown(event, index, count)}
      onClick={() => onOpenFile(file.path)}
      title={file.path}
    >
      <FileText className="icon" aria-hidden="true" />
      <span className="workspace-rec-text">
        <span className="workspace-rec-name">{file.name}</span>
        <span className="workspace-rec-date">{relativeTime(file.modifiedAt)}</span>
      </span>
    </button>
  )
}

/** The workspace-scoped empty editor from locked mockup frame M6. */
export function WorkspaceEmpty({ files, onNewFile, onSearchFiles, onOpenFile }: WorkspaceEmptyProps): JSX.Element {
  const [active, setActive] = useState(0)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  // Closed tabs are deliberately purged from tab-state's recent list, so last-modified is the
  // durable recency fact available precisely when no tabs remain; it also matches M6's labels.
  const recentFiles = [...files].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 3)

  const focusRow = useCallback((index: number) => {
    setActive(index)
    rowRefs.current[index]?.focus()
  }, [])

  const onRowKeyDown = useCallback(
    (event: React.KeyboardEvent, index: number, count: number) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        focusRow(Math.min(index + 1, count - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        focusRow(Math.max(index - 1, 0))
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusRow(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusRow(count - 1)
      }
    },
    [focusRow],
  )

  return (
    <div className="workspace-empty-state">
      <FileText className="workspace-empty-icon" aria-hidden="true" />
      <h2>No file open</h2>
      <p>Pick a file from the sidebar, or start something new.</p>
      <div className="workspace-empty-actions">
        <button className="ghost" type="button" onClick={onNewFile} title="New file (⌘N)">
          <SquarePen className="icon sm" aria-hidden="true" />
          New file <kbd>⌘N</kbd>
        </button>
        <button className="ghost" type="button" onClick={onSearchFiles} title="Search files (⇧⌘F)">
          <Search className="icon sm" aria-hidden="true" />
          Search files <kbd>⇧⌘F</kbd>
        </button>
      </div>
      {recentFiles.length > 0 && (
        <div className="workspace-recents">
          <div className="side-label">Recent in this workspace</div>
          <ul className="workspace-rec-card">
            {recentFiles.map((file, index) => (
              <li key={file.path}>
                <WorkspaceRecentRow
                  file={file}
                  index={index}
                  active={active}
                  count={recentFiles.length}
                  rowRef={(element) => { rowRefs.current[index] = element }}
                  onFocus={() => setActive(index)}
                  onKeyDown={onRowKeyDown}
                  onOpenFile={onOpenFile}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
