// The eleven Features to delight you pictures (ticket 08). Words in them are labels, not the topic text.
import { Arrow, Card, Label, Page, Pic } from './guide-picture-parts'

export const PictureSend = (): JSX.Element => (
  <Pic label="A document exported as HTML or Word, read in a browser, with comments sent back" height={160}>
    <Page x={20} y={26} /><Page x={15} y={21} /><Page x={10} y={16} lines={4} />
    <Label x={8} y={88}>your pieces</Label>
    <Arrow x={62} y={40} len={22} />
    <Page x={92} y={14} w={38} h={50}><rect x="98" y="21" width="26" height="9" rx="1.5" className="fp" /></Page>
    <Page x={138} y={14} w={38} h={50}><rect x="144" y="21" width="26" height="9" rx="1.5" className="fp w" /></Page>
    <Label x={111} y={80} mid strong>HTML</Label><Label x={157} y={80} mid strong>Word</Label>
    <Arrow x={184} y={40} len={20} />
    <rect x="212" y="12" width="68" height="56" rx="5" className="pg" /><path d="M212 24h68" className="ln" />
    <rect x="219" y="37" width="24" height="6" rx="1" className="hl" /><rect x="258" y="31" width="17" height="14" rx="3" className="note" />
    <Label x={282} y={84} end>reader’s browser</Label>
    <path d="M246 96c0 28-40 34-96 34-66 0-116-6-116-32m-5 6 5-6 5 6" className="pl back" />
    <Label x={145} y={150} mid>comments and edits come back, no account</Label>
  </Pic>
)

export const PictureListen = (): JSX.Element => (
  <Pic label="Read aloud marks the sentence and the word">
    <rect x="14" y="16" width="262" height="18" rx="4" className="hl soft" />
    <path d="M20 25h96" className="ln" /><rect x="120" y="20" width="34" height="10" rx="2" className="fp" /><path d="M160 25h80" className="ln" />
    {[0, 1, 2, 3].map((i) => <path key={i} d={`M20 ${50 + i * 14}h${230 - i * 20}`} className="ln" />)}
    <Label x={137} y={14} mid>word</Label>
    {[['⌃⌥→', 'next sentence'], ['⌃⌥↓', 'next paragraph']].map(([k, t], i) => <g key={k}><rect x={14 + i * 140} y="112" width="38" height="18" rx="4" className="pg" /><Label x={33 + i * 140} y={125} mid strong>{k}</Label><Label x={58 + i * 140} y={125}>{t}</Label></g>)}
  </Pic>
)

export const PictureFocus = (): JSX.Element => (
  <Pic label="Other paragraphs fade; one stays clear">
    {[0, 1, 2, 3, 4].map((i) => (
      <g key={i} opacity={i === 2 ? 1 : 0.28}><path d={`M20 ${24 + i * 20}h${i === 2 ? 170 : 150}`} className="ln dark" /><path d={`M20 ${32 + i * 20}h${i === 2 ? 130 : 110}`} className="ln dark" /></g>
    ))}
    <rect x="14" y="52" width="186" height="30" rx="4" className="pg tone-accent" opacity="0.5" />
    {['fade', 'sentence', 'segment', 'breakup', 'anchored'].map((t, i) => <g key={t}><rect x="214" y={14 + i * 22} width="62" height="17" rx="8.5" className="pg" /><Label x={245} y={26 + i * 22} mid>{t}</Label></g>)}
    <Label x={14} y={142}>typewriter mode: a line you place</Label>
  </Pic>
)

export const PictureSession = (): JSX.Element => (
  <Pic label="A timed session with a word target, and a diary of sittings">
    <circle cx="52" cy="56" r="34" className="pg" /><path d="M52 22a34 34 0 1 1-24 58" className="pl accent" />
    <Label x={52} y={60} mid strong>25:00</Label><Label x={52} y={108} mid>timed session</Label>
    <rect x="104" y="30" width="170" height="10" rx="5" className="pg" /><rect x="104" y="30" width="104" height="10" rx="5" className="fp" />
    <Label x={104} y={26}>word target</Label><Label x={274} y={58} end strong>312 of 500</Label>
    <Card x={104} y={72} w={170} h={52} title="Diary">
      {[0, 1].map((i) => <g key={i}><circle cx="114" cy={92 + i * 14} r="2.5" className="fp" /><path d={`M122 ${92 + i * 14}h${100 - i * 24}`} className="ln" /></g>)}
    </Card>
    <Label x={145} y={146} mid>a goal on a piece; each sitting is recorded</Label>
  </Pic>
)

export const PictureReader = (): JSX.Element => (
  <Pic label="A PDF from Zotero beside the draft; a passage dragged in as a quote">
    <Card x={10} y={10} w={120} h={110} title="Zotero PDF">
      <path d="M20 34h96M20 44h80M20 54h92" className="ln" /><rect x="20" y="62" width="92" height="9" rx="1.5" className="hl" /><path d="M20 80h70M20 90h88" className="ln" />
    </Card>
    <Arrow x={136} y={66} len={24} />
    <Page x={168} y={10} w={112} h={110} lines={5}>
      <rect x="176" y="72" width="96" height="26" rx="3" className="pg tone-accent" /><Label x={182} y={88}>“quote” (Smith)</Label>
    </Page>
    <Label x={145} y={140} mid>highlights go back to Zotero</Label>
  </Pic>
)

export const PictureDiagrams = (): JSX.Element => (
  <Pic label="An outline turned into a mind map; a flow diagram; a live table">
    <circle cx="48" cy="56" r="16" className="pg tone-accent" /><Label x={48} y={60} mid strong>idea</Label>
    {[[12, 16], [12, 96], [96, 20], [96, 92]].map(([x, y], i) => <g key={i}><path d={`M${48} 56L${x + 14} ${y + 8}`} className="pl thin" /><rect x={x} y={y} width="28" height="16" rx="8" className="pg" /></g>)}
    <rect x="142" y="14" width="40" height="20" rx="4" className="pg" /><Arrow x={186} y={24} len={14} down={false} /><rect x="204" y="14" width="40" height="20" rx="4" className="pg" />
    <path d="M162 34v20m-4-5 4 5 4-5" className="pl arrow" /><rect x="142" y="58" width="40" height="20" rx="4" className="pg tone-green" />
    <rect x="142" y="92" width="136" height="44" rx="4" className="pg" />
    {[0, 1, 2].map((r) => <path key={r} d={`M142 ${106 + r * 10}h136`} className="ln thin" />)}<path d="M200 92v44M244 92v44" className="ln thin" />
    <Label x={148} y={103} strong>piece</Label><Label x={206} y={103} strong>status</Label><Label x={250} y={103} strong>tag</Label>
  </Pic>
)

export const PictureCapture = (): JSX.Element => (
  <Pic label="A link to a piece that does not exist yet becomes that piece">
    <Page x={12} y={14} w={130} h={96} lines={3}><Label x={20} y={62} strong>see [[Hedgerows]]</Label></Page>
    <Label x={20} y={128}>⌘↵ makes it a piece</Label>
    <Arrow x={150} y={60} len={22} />
    <Page x={188} y={30} w={90} h={80} lines={4}><Label x={196} y={48} strong>Hedgerows</Label></Page>
    <Label x={233} y={128} mid>a new piece</Label>
  </Pic>
)

export const PictureVersions = (): JSX.Element => (
  <Pic label="Two versions side by side, coloured by who wrote what">
    {[0, 1].map((c) => (
      <g key={c}><Page x={12 + c * 140} y={14} w={126} h={100} /><Label x={20 + c * 140} y={28} strong>{c === 0 ? 'Version 1' : 'Version 2'}</Label>
        {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={20 + c * 140} y={38 + i * 14} width={i === 2 && c === 1 ? 108 : 90 - i * 6} height="7" rx="1.5" className={i === 2 && c === 1 ? 'fp soft' : i === 3 && c === 1 ? 'hl' : 'ln-fill'} />)}
      </g>
    ))}
    <circle cx="18" cy="134" r="4" className="fp soft" /><Label x={26} y={138}>you</Label><circle cx="68" cy="134" r="4" className="hl" /><Label x={76} y={138}>agent</Label>
    <rect x="200" y="122" width="78" height="18" rx="9" className="pg" /><Label x={239} y={135} mid>restore row</Label>
  </Pic>
)

export const PictureCopy = (): JSX.Element => (
  <Pic label="Copied as rich text, pasted into Word or Teams with headings and pictures">
    <Page x={12} y={18} w={70} h={92} lines={6}><rect x="18" y="24" width="40" height="8" rx="1.5" className="fp" /></Page>
    <Arrow x={90} y={60} len={22} />
    <rect x="124" y="36" width="42" height="54" rx="5" className="pg tone-accent" /><rect x="136" y="30" width="18" height="10" rx="3" className="pg" /><Label x={145} y={110} mid>clipboard</Label>
    <Arrow x={174} y={60} len={22} />
    <Card x={206} y={18} w={72} h={42} title="Word" /><Card x={206} y={68} w={72} h={42} title="Teams" />
    <Label x={145} y={140} mid>headings and pictures kept</Label>
  </Pic>
)

export const PictureSearch = (): JSX.Element => (
  <Pic label="Search across a collection with phrases, excluded words and tags">
    <rect x="12" y="12" width="266" height="26" rx="13" className="pg" /><Label x={26} y={29}>“slow walking” -rain #draft</Label>
    {['phrase', 'excluded', 'tag'].map((t, i) => <g key={t}><rect x={12 + i * 72} y="46" width="62" height="16" rx="8" className="pg tone-accent" /><Label x={43 + i * 72} y={58} mid>{t}</Label></g>)}
    {[0, 1, 2].map((i) => <g key={i}><Page x={12 + i * 92} y={72} w={80} h={54} lines={3}><Label x={18 + i * 92} y={140}>{['Chapter 1', 'Notes', 'Draft'][i]}</Label></Page></g>)}
  </Pic>
)

export const PictureSettings = (): JSX.Element => (
  <Pic label="Choose the action bar's buttons, rebind keys, pick sounds">
    <Card x={12} y={12} w={266} h={34} title="">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={22 + i * 32} y={20} width="22" height="18" rx="4" className={i === 3 ? 'pg tone-accent' : 'pg'} />)}
    </Card>
    <Label x={14} y={64}>action bar</Label>
    <rect x="14" y="76" width="30" height="18" rx="4" className="pg" /><Label x={29} y={89} mid strong>⌘J</Label><Arrow x={52} y={85} len={18} /><rect x="78" y="76" width="30" height="18" rx="4" className="pg tone-accent" /><Label x={93} y={89} mid strong>⌥J</Label>
    <Label x={14} y={112}>rebind any key</Label>
    <rect x="160" y="80" width="118" height="8" rx="4" className="pg" /><circle cx="214" cy="84" r="7" className="fp" /><Label x={160} y={70}>typing sound</Label>
    <rect x="160" y="112" width="118" height="8" rx="4" className="pg" /><circle cx="250" cy="116" r="7" className="fp" /><Label x={160} y={102}>ambient sound</Label>
  </Pic>
)
