import type { SourceFile } from '../../../preload'
import type { ArchiveResult } from '../../../shared/scout'
import ArchiveSearchDock from './ArchiveSearchDock'
import { SourcesSection } from './SourcesSection'

/** The two things the Research tab holds. Sources is the open piece's own supporting files; Archive is the search of everything the writer has written, tweeted and highlighted. */
export type ResearchScope = 'sources' | 'archive'

/**
 * The right sidebar's Research tab (house rule R6, owner decision D1). It replaces the archive's own dock and
 * the Sources list that sat at the foot of the Scratchpad tab: one scope switch, in the look of the archive's corpus
 * chips, and the two lists under it. Both stay mounted so a query and a scroll position survive a switch.
 */
export function ResearchPane({ scope, onScope, sources, onOpenSource, onRevealSource, active, onInsertQuote, onInsertLink, onExit }: {
  scope: ResearchScope
  onScope: (scope: ResearchScope) => void
  sources: SourceFile[]
  onOpenSource: (path: string) => void
  onRevealSource: (path: string) => void
  /** The Research tab is the one showing. */
  active: boolean
  onInsertQuote: (result: ArchiveResult, block: string) => boolean
  onInsertLink: (result: ArchiveResult, link: string) => boolean
  onExit: () => void
}): JSX.Element {
  return (
    <section className="research-pane" aria-label="Research">
      <div className="archive-scope research-scope" role="group" aria-label="Research scope">
        <button type="button" className={scope === 'sources' ? 'on' : ''} aria-pressed={scope === 'sources'} onClick={() => onScope('sources')}>Sources</button>
        <button type="button" className={scope === 'archive' ? 'on' : ''} aria-pressed={scope === 'archive'} onClick={() => onScope('archive')}>Archive</button>
      </div>
      <div className="research-body" hidden={scope !== 'sources'}>
        <SourcesSection sources={sources} onOpen={onOpenSource} onReveal={onRevealSource} />
      </div>
      <div className="research-body research-archive" hidden={scope !== 'archive'}>
        <ArchiveSearchDock active={active && scope === 'archive'} onInsertQuote={onInsertQuote} onInsertLink={onInsertLink} onExit={onExit} />
      </div>
    </section>
  )
}
