import { File, FileText, FileType, Image, type LucideIcon } from 'lucide-react'
import type { SourceFile, SourceKind } from '../../../preload'

/** The kind → row icon map (Task 21, PRD S30): the four shapes the brief names, keyed by classifier. */
const KIND_ICON: Record<SourceKind, LucideIcon> = {
  md: FileText,
  pdf: FileType,
  image: Image,
  other: File,
}

/** Human-readable file size — B / KB / MB, one decimal below ten of the unit so tiny files stay legible. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

type SourcesSectionProps = {
  sources: SourceFile[]
  /** Open a Markdown source in a tab (md sources are editable Workspace files). */
  onOpen: (path: string) => void
  /** Reveal a non-Markdown source (PDF, image, other) in the OS file manager. */
  onReveal: (path: string) => void
}

/**
 * The Sources section (Task 21, PRD S30): reference material under research/, listed inside the Scratchpad
 * pane below the cuttings. Each row is a kind icon, name and size; a Markdown source opens in a tab,
 * anything else reveals in Finder. Rows are native buttons, so they are focusable and Enter/Space
 * activate with no extra key wiring. Folio-manifest `source` dirs feed the same list in Task 24.
 */
export function SourcesSection({ sources, onOpen, onReveal }: SourcesSectionProps): JSX.Element {
  return (
    <section className="sources" aria-label="Sources">
      <div className="scrap-sec">Sources</div>
      {sources.length === 0 ? (
        <p className="sources-empty">
          Put reference material in <code>research/</code> and it appears here.
        </p>
      ) : (
        <ul className="source-list" role="list">
          {sources.map((source) => (
            <SourceRow key={source.path} source={source} onOpen={onOpen} onReveal={onReveal} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SourceRow({ source, onOpen, onReveal }: { source: SourceFile } & Pick<SourcesSectionProps, 'onOpen' | 'onReveal'>): JSX.Element {
  const Icon = KIND_ICON[source.kind]
  const isMarkdown = source.kind === 'md'
  const label = isMarkdown ? `Open ${source.name}` : `Reveal ${source.name} in Finder`
  return (
    <li>
      <button
        type="button"
        className="source-row"
        data-kind={source.kind}
        data-path={source.path}
        title={label}
        aria-label={label}
        onClick={() => (isMarkdown ? onOpen(source.path) : onReveal(source.path))}
      >
        <Icon className="icon sm" aria-hidden="true" />
        <span className="source-name">{source.name}</span>
        <span className="source-size">{humanSize(source.size)}</span>
      </button>
    </li>
  )
}
