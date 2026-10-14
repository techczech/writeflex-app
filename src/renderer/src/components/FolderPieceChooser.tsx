import { useEffect, useRef } from 'react'
import { Folder } from 'lucide-react'

export type FolderPieceChoice = {
  dir: string
  folderPath: string
  mode: 'one' | 'many'
}

function relativeFolderPath(choice: FolderPieceChoice): string {
  if (choice.dir === '') return choice.folderPath
  const prefix = `${choice.dir.replace(/\/+$/, '')}/`
  return choice.folderPath.startsWith(prefix) ? choice.folderPath.slice(prefix.length) : choice.folderPath
}

type FolderPieceChooserProps = {
  choices: FolderPieceChoice[]
  onChoose: (choice: FolderPieceChoice) => void
  onClose: () => void
}

/** The small palette follow-up used when no Folder Piece row or Board card is selected. */
export function FolderPieceChooser({ choices, onChoose, onClose }: FolderPieceChooserProps): JSX.Element {
  const firstRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => firstRef.current?.focus(), [])

  return (
    <div
      className="overlay open"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a folder"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="sheet folder-piece-chooser">
        <header><Folder className="icon" aria-hidden="true" /><strong>Choose a folder</strong></header>
        <div className="folder-piece-choice-list">
          {choices.map((choice, index) => {
            const name = relativeFolderPath(choice)
            const target = choice.mode === 'one' ? 'separate pieces' : 'one piece'
            return (
              <button
                ref={index === 0 ? firstRef : undefined}
                type="button"
                key={choice.folderPath}
                onClick={() => onChoose(choice)}
              >
                <Folder className="icon sm" aria-hidden="true" />
                <span>{`Treat "${name}" as ${target}`}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
