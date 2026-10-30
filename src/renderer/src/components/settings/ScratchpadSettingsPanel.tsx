// Settings › Scratchpad (ADR-0050 ticket 05, design states 12–14): the two independent
// optional-source switches, both off by default. Standalone WriteFlex needs neither app;
// while a switch is off nothing about that source appears in the Scratchpad and main makes
// no discovery call for it at all. Turning TalkWeaver on lists the vaults its own registry
// names (read-only in main) so the writer chooses which to browse; the choice is a settings
// value. Copy: docs/design/2026-10-28-floating-scratchpad/mockup/copy/ui-settings.md.
import { useCallback, useEffect, useState } from 'react'
import { Images, LibraryBig, RefreshCw } from 'lucide-react'
import type { ScratchExternalStatus } from '../../../../shared/scratchpad-items'
import {
  SCRATCHPAD_SLIDEWELL_KEY, SCRATCHPAD_TALKWEAVER_KEY, SCRATCHPAD_TALKWEAVER_VAULTS_KEY,
  chosenTalkweaverVaults, chosenTalkweaverVaultsValue, scratchpadSourceEnabled,
} from '../../../../shared/scratchpad-source-settings'

type SettingValue = string | number | boolean

export function ScratchpadSettingsPanel({
  values, onSet, onFlash, workspaceRoot,
}: {
  values: Record<string, SettingValue>
  onSet: (key: string, value: SettingValue, label: string) => void
  onFlash: (message: string) => void
  /** The open folder, for the rooted Scratchpad bridge; null on the start screen. */
  workspaceRoot: string | null
}): JSX.Element {
  const talkweaverOn = scratchpadSourceEnabled(values[SCRATCHPAD_TALKWEAVER_KEY])
  const slidewellOn = scratchpadSourceEnabled(values[SCRATCHPAD_SLIDEWELL_KEY])
  const [status, setStatus] = useState<{ talkweaver: ScratchExternalStatus | null; slidewell: ScratchExternalStatus | null }>({ talkweaver: null, slidewell: null })
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    if (!workspaceRoot) return
    setChecking(true)
    try {
      const bridge = window.writeflex.scratchpad
      const [tw, sw] = await Promise.all([
        talkweaverOn ? bridge.externalStatus({ root: workspaceRoot, source: 'talkweaver' }) : Promise.resolve(null),
        slidewellOn ? bridge.externalStatus({ root: workspaceRoot, source: 'slidewell' }) : Promise.resolve(null),
      ])
      setStatus({
        talkweaver: tw && tw.ok ? tw.status : null,
        slidewell: sw && sw.ok ? sw.status : null,
      })
    } catch { /* the rows keep their last known state; Check again is right there */ } finally { setChecking(false) }
  }, [workspaceRoot, talkweaverOn, slidewellOn])

  useEffect(() => { void check() }, [check])

  const stateWord = (on: boolean, current: ScratchExternalStatus | null): string => {
    if (!on) return 'Off'
    if (!workspaceRoot) return 'On'
    if (checking && !current) return 'Checking…'
    if (!current) return 'On'
    return current.state === 'connected' ? 'Connected' : current.state === 'unavailable' ? 'Unavailable' : 'Off'
  }

  const twStatus = status.talkweaver
  const chosen = chosenTalkweaverVaults(values[SCRATCHPAD_TALKWEAVER_VAULTS_KEY])
  const toggleVault = (id: string, on: boolean): void => {
    const next = on ? [...chosen, id] : chosen.filter((entry) => entry !== id)
    onSet(SCRATCHPAD_TALKWEAVER_VAULTS_KEY, chosenTalkweaverVaultsValue(next), 'TalkWeaver vaults to browse')
  }

  const sourceRow = (
    source: 'talkweaver' | 'slidewell',
    label: string,
    description: string,
    on: boolean,
    current: ScratchExternalStatus | null,
  ): JSX.Element => (
    <div className="crow">
      {source === 'talkweaver' ? <LibraryBig className="icon" aria-hidden="true" /> : <Images className="icon" aria-hidden="true" />}
      <span className="grow">
        <span className="lbl">{label}</span>
        <small>
          {description}{' '}
          <b>{stateWord(on, current)}.</b>
          {on && current?.state === 'unavailable' && current.reason ? <> {current.reason}</> : null}
          {on && !workspaceRoot ? <> Open a folder to see whether the app is there.</> : null}
          {source === 'slidewell' && on && current?.state === 'connected'
            ? <> {current.semantic ? 'Its index is ready for semantic search.' : 'Its catalogue can be browsed by file name; semantic search needs SlideWell running.'}</>
            : null}
        </small>
      </span>
      <label className="switch" title={label}>
        <input
          type="checkbox"
          aria-label={label}
          checked={on}
          onChange={(event) => {
            onSet(source === 'talkweaver' ? SCRATCHPAD_TALKWEAVER_KEY : SCRATCHPAD_SLIDEWELL_KEY, event.target.checked, label)
            onFlash(event.target.checked
              ? `${source === 'talkweaver' ? 'TalkWeaver vaults' : 'SlideWell'} is on. It now appears at the top of the Scratchpad.`
              : `${source === 'talkweaver' ? 'TalkWeaver vaults' : 'SlideWell'} is off. It no longer appears in the Scratchpad.`)
          }}
        />
        <span className="knob" />
      </label>
    </div>
  )

  return (
    <div className="set-sec" id="sec-scratchpad">
      <h3>Scratchpad</h3>
      <p className="set-note">The Scratchpad works on its own, with your documents and Folios. These two connections add places to look for pictures. Both are off, and nothing appears in the Scratchpad for them until you turn one on.</p>
      <div className="set-card">
        {sourceRow('talkweaver', 'Browse TalkWeaver vaults', 'Adds a TalkWeaver vaults tab to the Scratchpad so you can browse the pictures, SVG files and widgets in vaults you choose. Choosing one collects it; the file is copied into your document only when you insert it.', talkweaverOn, twStatus)}
        {talkweaverOn && workspaceRoot && twStatus?.vaults ? (
          <div className="crow sp-settings-vaults">
            <span className="grow">
              <span className="lbl">Vaults to browse{twStatus.vaults.length ? ` · ${twStatus.vaults.length} vault${twStatus.vaults.length === 1 ? '' : 's'} found` : ''}</span>
              {twStatus.vaults.length === 0 ? <small> TalkWeaver has no vaults on this Mac yet.</small> : null}
              {twStatus.vaults.map((vault) => (
                <label key={vault.id} className="sp-settings-vault">
                  <input
                    type="checkbox"
                    aria-label={`Browse ${vault.name}`}
                    checked={chosen.includes(vault.id)}
                    disabled={!vault.available}
                    onChange={(event) => toggleVault(vault.id, event.target.checked)}
                  />
                  <span>{vault.name}</span>
                  <small>{vault.note}</small>
                </label>
              ))}
              {twStatus.vaults.length > 0 && chosen.length === 0 ? <small> No vault is selected, so the TalkWeaver tab will say so.</small> : null}
            </span>
          </div>
        ) : null}
        {sourceRow('slidewell', 'Search SlideWell', 'Adds a SlideWell tab so you can search your indexed pictures by what they show. Semantic picture search needs SlideWell running. You can browse a readable catalogue by file name while it is closed. Nothing leaves this Mac.', slidewellOn, status.slidewell)}
        {(talkweaverOn || slidewellOn) && workspaceRoot ? (
          <div className="crow">
            <RefreshCw className="icon" aria-hidden="true" />
            <span className="grow"><span className="lbl">Check again</span><small> Ask each switched-on source how it stands now.</small></span>
            <button type="button" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check again'}</button>
          </div>
        ) : null}
      </div>
      <p className="set-note">Inserting a picture from either source copies it into the document’s <b>assets/</b> folder and records where it came from. The document keeps working if the vault or SlideWell is later unavailable.</p>
    </div>
  )
}
