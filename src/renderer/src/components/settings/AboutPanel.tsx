import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Copy, Info } from 'lucide-react'
import changelogSource from '../../../../../CHANGELOG.md?raw'
import { parseReleaseNotes, type ReleaseNoteRelease } from './release-notes'

type RuntimeInfo = { electron: string; chrome: string; node: string; macOS: string }

type AboutPanelProps = { onFlash: (message: string) => void }

function ReleaseBody({ release }: { release: ReleaseNoteRelease }): JSX.Element {
  return (
    <div className="about-release-body">
      {release.groups.map((group) => (
        <div className="about-release-group" key={group.title}>
          <h5>{group.title}</h5>
          <ul>
            {group.items.map((item, index) => (
              <li key={`${group.title}-${index}`}>
                {item.lead && <strong>{item.lead}</strong>}
                {item.lead && item.body ? ' ' : ''}
                {item.body}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ReleaseRow({ release, expanded, onToggle }: { release: ReleaseNoteRelease; expanded: boolean; onToggle: () => void }): JSX.Element {
  return (
    <div className="about-release">
      <button type="button" className="crow about-release-toggle" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDown className="icon sm" aria-hidden="true" />
        <span className="grow">
          <span className="lbl">{release.version}</span>
          {release.date && <small>{release.date}</small>}
        </span>
      </button>
      {expanded && <ReleaseBody release={release} />}
    </div>
  )
}

export function AboutPanel({ onFlash }: AboutPanelProps): JSX.Element {
  const [version, setVersion] = useState<string | null>(null)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    void window.writeflex.getAppVersion().then(setVersion).catch(() => setVersion(null))
    void window.writeflex.getRuntimeInfo().then(setRuntime).catch(() => setRuntime(null))
  }, [])

  const parsed = useMemo(() => parseReleaseNotes(changelogSource, version), [version])
  const copySupportDetails = (): void => {
    if (!version || !runtime) return
    const line = `WriteFlex ${version} · Electron ${runtime.electron} · Chrome ${runtime.chrome} · Node ${runtime.node} · macOS ${runtime.macOS}`
    void window.writeflex.copyToClipboard(line, 'plain').then(() => {
      setCopied(true)
      onFlash('Copied WriteFlex support details')
      window.setTimeout(() => setCopied(false), 2200)
    }).catch(() => onFlash('Could not copy WriteFlex support details.'))
  }

  return (
    <div className="set-sec" id="sec-about">
      <h3>About</h3>
      <p className="sub">The app identity and bundled release notes.</p>
      <div className="card about-identity">
        <div className="crow">
          <Info className="icon" aria-hidden="true" />
          <span className="grow">
            <span className="lbl">WriteFlex</span>
            <small><span className="about-version" aria-label={`WriteFlex version ${version ?? 'loading'}`}>{version ?? 'Loading version…'}</span></small>
          </span>
          <button type="button" className="ghost about-copy" onClick={copySupportDetails} disabled={!version || !runtime} aria-label="Copy WriteFlex support details">
            {copied ? <Check className="icon sm" aria-hidden="true" /> : <Copy className="icon sm" aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <h4 className="about-heading">Release notes for {version ?? 'the running release'}</h4>
      <div className="card about-releases">
        {parsed.currentRelease && <ReleaseRow release={parsed.currentRelease} expanded onToggle={() => {}} />}
        {parsed.releases.filter((release) => release !== parsed.currentRelease).map((release) => (
          <ReleaseRow key={release.version} release={release} expanded={expanded === release.version} onToggle={() => setExpanded((open) => open === release.version ? null : release.version)} />
        ))}
        {parsed.releases.length === 0 && <div className="log-empty">No bundled release notes are available.</div>}
      </div>
      {parsed.hasEarlierReleases && <p className="about-overflow">Earlier releases are in the repository changelog.</p>}
    </div>
  )
}
