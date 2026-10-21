// The eight How it works pictures (ticket 08). Words in them are labels, not the topic text.
import { Arrow, Card, Label, Page, Pic } from './guide-picture-parts'

const Folder = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }): JSX.Element => (
  <g><path d={`M${x} ${y + 8}a4 4 0 0 1 4-4h${w * 0.3}l6 6h${w - w * 0.3 - 10}a4 4 0 0 1 4 4v${h - 14}a4 4 0 0 1-4 4h${-w + 8}a4 4 0 0 1-4-4z`} className="pg" /></g>
)

export const PictureFolder = (): JSX.Element => (
  <Pic label="One folder, one window">
    <rect x="10" y="10" width="270" height="116" rx="8" className="pg" /><path d="M10 28h270" className="ln" />
    <circle cx="20" cy="19" r="2" className="dotc" /><circle cx="27" cy="19" r="2" className="dotc" /><circle cx="34" cy="19" r="2" className="dotc" />
    <Folder x={26} y={42} w={90} h={66} />
    <Label x={34} y={80} strong>your folder</Label><Label x={34} y={96}>any folder</Label>
    <Arrow x={124} y={74} len={20} />
    <Page x={152} y={40} lines={3} /><Page x={192} y={40} lines={3} /><Page x={232} y={40} lines={3} />
    <Label x={152} y={104}>its files, as they are</Label>
    <Label x={146} y={144} mid>one window is one folder</Label>
  </Pic>
)

export const PicturePlain = (): JSX.Element => (
  <Pic label="Your file is never changed; WriteFlex keeps its extras beside it">
    <Page x={14} y={14} w={70} h={92} lines={9} />
    <Label x={49} y={122} mid strong>Chapter 1.md</Label><Label x={49} y={138} mid>never changed</Label>
    <Arrow x={94} y={58} len={26} />
    <Folder x={130} y={26} w={150} h={90} />
    <Label x={142} y={64} strong>kept beside it</Label>
    {['history', 'scraps', 'agent’s notes'].map((t, i) => <g key={t}><circle cx="146" cy={80 + i * 16} r="3" className="fp" /><Label x={156} y={84 + i * 16}>{t}</Label></g>)}
  </Pic>
)

export const PictureSave = (): JSX.Element => (
  <Pic label="Saved as you type, with checkpoints and a named version">
    <Label x={14} y={24} strong>saved as you type</Label>
    <path d="M14 62H276" className="pl accent" />
    <g className="ticks">{Array.from({ length: 33 }, (_, i) => <path key={i} d={`M${18 + i * 8} 58v8`} />)}</g>
    {([[62, '⌘S'], [128, 'close'], [196, 'agent turn']] as const).map(([x, t]) => (
      <g key={t}><circle cx={x} cy="62" r="6" className="cp" /><path d={`M${x} 68v16`} className="pl thin" /><Label x={x} y={98} mid>{t}</Label></g>
    ))}
    <path d="M254 62V36" className="pl flag" /><path d="M254 36h20l-5 6 5 6h-20z" className="flagf" /><circle cx="254" cy="62" r="6" className="cp v" />
    <Label x={254} y={98} mid strong>⇧⌘S</Label><Label x={276} y={26} end>First draft</Label>
    <circle cx="20" cy="130" r="5" className="cp" /><Label x={31} y={134}>checkpoint</Label>
    <circle cx="124" cy="130" r="5" className="cp v" /><Label x={135} y={134}>named version</Label>
  </Pic>
)

export const PictureBlocks = (): JSX.Element => (
  <Pic label="Each line is a block you can move, fold, hear or fade">
    <rect x="14" y="12" width="150" height="26" rx="5" className="pg tone-accent" /><Label x={24} y={30} strong>A heading</Label>
    <rect x="30" y="46" width="134" height="22" rx="5" className="pg" /><path d="M40 57h100" className="ln" />
    <rect x="30" y="74" width="134" height="22" rx="5" className="pg" /><path d="M40 85h80" className="ln" />
    <rect x="30" y="102" width="134" height="22" rx="5" className="pg" /><path d="M40 113h110" className="ln" />
    <path d="M22 44v84" className="pl thin" />
    {['move', 'fold', 'hear', 'fade'].map((t, i) => <g key={t}><rect x="190" y={16 + i * 28} width="84" height="22" rx="11" className="pg" /><Label x={232} y={31 + i * 28} mid>{t}</Label></g>)}
    <Arrow x={168} y={80} len={18} />
  </Pic>
)

export const PictureModes = (): JSX.Element => (
  <Pic label="Drafting hides the marks; Reviewing shows them">
    <Label x={74} y={20} mid strong>Drafting</Label><Label x={216} y={20} mid strong>Reviewing</Label>
    <Page x={14} y={30} w={120} h={88} lines={7} />
    <Page x={156} y={30} w={120} h={88} lines={7}>
      <rect x="162" y="39" width="64" height="7" rx="1.5" className="hl" />
      <path d="M162 53h50" className="strike" /><rect x="162" y="60" width="44" height="7" rx="1.5" className="fp soft" />
    </Page>
    <Label x={145} y={140} mid>your edits are recorded in both</Label>
  </Pic>
)

export const PictureAgent = (): JSX.Element => (
  <Pic label="The agent proposes changes to your words; tidying is undoable">
    <Page x={12} y={14} w={64} h={84} lines={7} /><Label x={44} y={114} mid strong>your words</Label>
    <Arrow x={82} y={40} len={22} />
    <Card x={112} y={14} w={168} h={50} title="Suggestion">
      <path d="M120 38h110" className="ln" /><rect x="120" y="44" width="50" height="15" rx="7.5" className="fp" /><Label x={145} y={55} mid><tspan fill="#fff">Accept</tspan></Label>
      <rect x="176" y="44" width="50" height="15" rx="7.5" className="pg" /><Label x={201} y={55} mid>Reject</Label>
    </Card>
    <Card x={112} y={74} w={168} h={50} title="Tidy-up, done at once">
      <Label x={120} y={104}>renames, files</Label><rect x="226" y="92" width="46" height="15" rx="7.5" className="pg tone-green" /><Label x={249} y={103} mid>Undo</Label>
    </Card>
    <Label x={196} y={142} mid>reviews live in its own folder</Label>
  </Pic>
)

export const PictureSkills = (): JSX.Element => (
  <Pic label="Skills are instruction files">
    {['Copy-edit', 'Review', 'Clean-up', 'your own'].map((t, i) => (
      <g key={t}><Page x={10 + i * 70} y={20} w={58} h={66} lines={4} /><Label x={39 + i * 70} y={102} mid strong={i === 3}>{t}</Label></g>
    ))}
    <rect x="212" y="20" width="58" height="66" rx="3" className="pg dash" />
    <Label x={145} y={134} mid>plain files you can read, edit and add to</Label>
  </Pic>
)

export const PictureCollections = (): JSX.Element => (
  <Pic label="A collection of pieces shown as a Board, a Folio outline and one exported document">
    <Folder x={8} y={14} w={70} h={56} /><Label x={16} y={48} strong>collection</Label>
    <Page x={14} y={80} w={18} h={26} /><Page x={36} y={80} w={18} h={26} /><Page x={58} y={80} w={18} h={26} />
    <Arrow x={86} y={44} len={16} />
    <Card x={108} y={14} w={96} h={56} title="Board">
      {[0, 1, 2].map((i) => <rect key={i} x={114 + i * 30} y={34} width="26" height={i === 1 ? 24 : 16} rx="3" className="pg tone-accent" />)}
    </Card>
    <Card x={108} y={80} w={96} h={46} title="Folio outline">
      {[0, 1, 2].map((i) => <g key={i}><circle cx="120" cy={96 + i * 9} r="2" className="fp" /><path d={`M128 ${96 + i * 9}h${50 - i * 8}`} className="ln" /></g>)}
    </Card>
    <Arrow x={210} y={70} len={22} />
    <Page x={242} y={40} w={38} h={52} lines={4} /><Label x={261} y={108} mid strong>Export</Label>
  </Pic>
)
