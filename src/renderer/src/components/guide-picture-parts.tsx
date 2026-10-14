// Drawing parts for the Guide's topic pictures (ticket 08): SVG in the app's own look, drawn from the
// mockup's picture classes (styled under `.guide .g-pic` in app.css). Each picture is 290 wide.
import type { ReactNode } from 'react'

export const W = 290

/** A page: a white sheet with `n` text lines. */
export const Page = ({ x, y, w = 34, h = 44, lines = 0, children }: { x: number; y: number; w?: number; h?: number; lines?: number; children?: ReactNode }): JSX.Element => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={3} className="pg" />
    {Array.from({ length: lines }, (_, i) => <path key={i} d={`M${x + 6} ${y + 10 + i * 7}h${i % 3 === 2 ? (w - 12) * 0.6 : w - 12}`} className="ln" />)}
    {children}
  </g>
)

export const Label = ({ x, y, children, mid, end, strong }: { x: number; y: number; children: ReactNode; mid?: boolean; end?: boolean; strong?: boolean }): JSX.Element => (
  <text x={x} y={y} className={`pt${mid ? ' mid' : ''}${end ? ' end' : ''}${strong ? ' strong' : ''}`}>{children}</text>
)

/** A right-pointing arrow from (x, y) of length `len`. */
export const Arrow = ({ x, y, len = 22, down = false }: { x: number; y: number; len?: number; down?: boolean }): JSX.Element => (
  <path d={down ? `M${x} ${y}v${len}m-4 -5 4 5 4 -5` : `M${x} ${y}h${len}m-5 -4 5 4-5 4`} className="pl arrow" />
)

/** A rounded card with a title strip, used for suggestion cards, files and panels. */
export const Card = ({ x, y, w, h, title, tone, children }: { x: number; y: number; w: number; h: number; title?: string; tone?: 'accent' | 'green' | 'amber'; children?: ReactNode }): JSX.Element => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={5} className={`pg${tone ? ` tone-${tone}` : ''}`} />
    {title && <text x={x + 8} y={y + 14} className="pt strong">{title}</text>}
    {children}
  </g>
)

export const Pic = ({ height = 150, label, children }: { height?: number; label: string; children: ReactNode }): JSX.Element => (
  <svg viewBox={`0 0 ${W} ${height}`} className="pic" role="img" aria-label={label}>{children}</svg>
)
