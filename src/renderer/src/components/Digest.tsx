import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Bot, Sparkles } from 'lucide-react'
import type { CollectionDigest } from '../../../preload'
import { digestDisplayGist } from '../../../shared/digest-display'

type DigestPiece = CollectionDigest['pieces'][number]

type DigestProps = {
  dir: string | null
  onOpenPiece: (path: string) => void
}

function summary(digest: CollectionDigest): string {
  const statuses = Object.entries(digest.summary.statuses)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
  return `${digest.collection} — ${digest.summary.pieces} ${digest.summary.pieces === 1 ? 'piece' : 'pieces'}${statuses.length ? ` · ${statuses.join(' · ')}` : ''}`
}

function pieceCount(piece: DigestPiece): string {
  const links = piece.links.degree === 1 ? '1 link' : `${piece.links.degree} links`
  return `${piece.words.toLocaleString()} · ${links}`
}

export function Digest({ dir, onOpenPiece }: DigestProps): JSX.Element | null {
  const [digest, setDigest] = useState<CollectionDigest | null>(null)
  const [showAll, setShowAll] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (dir === null) {
      setDigest(null)
      return
    }
    try {
      setDigest(await window.writeflex.collection.digest(dir))
    } catch {
      setDigest(null)
    }
  }, [dir])

  useEffect(() => {
    setShowAll(false)
    void reload()
    const stopCollection = window.writeflex.collection.onChanged((event) => {
      if (dir === '' || event.paths.some((path) => path === dir || path.startsWith(`${dir}/`))) void reload()
    })
    return () => {
      stopCollection()
    }
  }, [dir, reload])

  if (!digest) return null
  const visiblePieces = showAll ? digest.pieces : digest.pieces.slice(0, 6)
  const readPieces = digest.readThisTurn
    .map((path) => digest.pieces.find((piece) => piece.path === path))
    .filter((piece): piece is DigestPiece => piece !== undefined)

  return (
    <section className="digest" aria-label="Active Collection Digest">
      <div className="d-head">
        <Sparkles className="icon sm" aria-hidden="true" />
        <strong className="d-t">Digest</strong>
        <span className="d-live">live</span>
      </div>
      <p className="d-sum">{summary(digest)}</p>
      <div className="dg-list">
        {visiblePieces.map((piece) => (
          <button
            type="button"
            className={`dg-row${piece.agentAuthored ? ' agent-authored' : ''}`}
            key={piece.path}
            onClick={() => onOpenPiece(piece.path)}
            title={`${piece.path} · ${piece.links.inbound} inbound, ${piece.links.outbound} outbound`}
            aria-label={`${piece.title}, ${pieceCount(piece)}`}
          >
            <span className="ti">{piece.title}{piece.agentAuthored && <Bot className="prov" aria-label="Agent-authored Piece" />}</span>
            <span className="gi" aria-hidden="true">{digestDisplayGist(piece.gist) || 'No description yet'}</span>
            <span className="ct">{pieceCount(piece)}</span>
          </button>
        ))}
        {!showAll && digest.pieces.length > 6 && (
          <button type="button" className="dg-view-all" onClick={() => setShowAll(true)}>View all {digest.pieces.length} Pieces</button>
        )}
      </div>
      <div className="d-divider">read last turn</div>
      {readPieces.map((piece) => (
        <button type="button" className="d-read" key={piece.path} onClick={() => onOpenPiece(piece.path)}>
          <BookOpen className="icon sm" aria-hidden="true" />
          <span>{piece.title}</span>
          <small>in full</small>
        </button>
      ))}
    </section>
  )
}
