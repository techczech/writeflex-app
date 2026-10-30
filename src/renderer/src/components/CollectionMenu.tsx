import { BookMarked, BookOpenText, ChevronDown, Download, FolderOpen, Pencil, Sparkles, Undo2 } from 'lucide-react'
import type { CollectionPageCommand } from './collection-page-commands'
export function CollectionMenu({ folio, canCreateFolio = true, hasCover, open, onToggle, onCommand, onTurnBack, onAssemble, onExport }: { folio: boolean; canCreateFolio?: boolean; hasCover?: boolean; open: boolean; onToggle: () => void; onCommand: (command: CollectionPageCommand) => void; onTurnBack: () => void; onAssemble: () => void; onExport: () => void }): JSX.Element {
  return <div className="cv-menu-anchor">
    <button className="ghost cv-menu-trigger" aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>{folio ? <BookOpenText className="icon sm" /> : <FolderOpen className="icon sm" />}{folio ? 'Folio' : 'Collection'}<ChevronDown className="icon sm" /></button>
    {open && <div className="cv-collection-menu" role="menu" aria-label={`This ${folio ? 'Folio' : 'collection'}`}>
      <div className="cv-menu-label">This {folio ? 'Folio' : 'collection'}</div>
      {(folio || canCreateFolio) && <><button role="menuitem" className="cv-menu-primary" onClick={folio ? onTurnBack : () => onCommand('make-folio')}>{folio ? <Undo2 /> : <BookMarked />}{folio ? 'Turn back into a collection' : 'Make a Folio…'}</button>
      <p>{folio ? 'The parts stay as documents. The Index Note keeps the running order.' : 'Turns this collection into a Folio: documents become ordered parts.'}</p></>}
      {(folio || canCreateFolio) && <button role="menuitem" onClick={onAssemble}><Sparkles />Ask the agent to assemble a Folio…</button>}<hr />
      <button role="menuitem" onClick={() => onCommand('index')}><BookOpenText />{folio || hasCover ? 'Edit cover note' : 'Create index note'}</button>
      <button role="menuitem" onClick={() => onCommand('rename')}><Pencil />Rename…</button>
      <button role="menuitem" onClick={onExport}><Download />Export…</button>
    </div>}
  </div>
}
