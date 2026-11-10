// Settings › Library › "Give your agents skills to use WriteFlex" (design element 19; mockup frames 5 and 7).
// Always present. One row per agent found (or with a copy): Installed at version N, Not installed, Installed
// separately, Kept as it is, Changed. Install, Remove and Replace go through main, which writes only the skill's
// own folder and never through a link. A failed write shows here, with where the skill is and a Copy button.
// The command-line tool is the last row: connecting an agent installs it, and this is the one control for it
// (it replaces the earlier stand-alone "Command-line tool" row, so there is one path and one control).
import { useCallback, useEffect, useState } from 'react'
import { Plug, Terminal } from 'lucide-react'
import { skillWording, rowWords, cliWords } from '../../../../shared/agent-skill/wording'
import { AGENT_TABLE } from '../../../../shared/agent-skill/agents'
import type { AgentRow, StatusReport } from '../../../../shared/agent-skill/types'
import { AGENT_SKILL_IDENTITY } from '../../../../shared/agent-skill-identity'

const W = skillWording(AGENT_SKILL_IDENTITY)

export default function AgentSkillSettings({ onFlash }: { onFlash: (message: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<StatusReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const api = typeof window === 'undefined' ? undefined : window.writeflex?.agentSkill
  const load = useCallback(() => { void api?.status().then(setStatus).catch(() => {}) }, [api])
  useEffect(load, [load])
  if (!api) return null
  const act = (kind: 'install' | 'remove' | 'replace', row: AgentRow): void => {
    setBusy(row.id)
    void api[kind]([row.id]).catch(() => {}).finally(() => { setBusy(null); load() })
  }
  const installCli = (): void => {
    setBusy('cli')
    void window.writeflex.installCommandLineTool().then((result) => onFlash(result.message)).catch(() => onFlash('Could not install the command-line tool.')).finally(() => { setBusy(null); load() })
  }
  const rows = (status?.agents ?? []).filter((r) => r.state !== 'not-found' || r.found)
  const visible = rows.filter((r) => r.state !== 'via' || r.found)
  const names = AGENT_TABLE.filter((a) => !a.via).map((a) => a.name)
  const connected = visible.some((r) => r.state === 'installed' || r.state === 'shared')
  return (
    <div data-agent-skill-card>
      <div className="crow">
        <Plug className="icon" aria-hidden="true" />
        <span className="grow">
          <span className="lbl" data-setting="agent-skill">{W.title}</span>
          <small>{status && status.noneFound && visible.length === 0 ? `${W.noneFoundTitle}. ${W.noneFound(names)}` : W.refreshNote}</small>
          {status && !status.skillAvailable && <small data-agent-skill-unavailable> The skill that comes with this copy of {AGENT_SKILL_IDENTITY.appName} cannot be read, so it cannot be installed.</small>}
        </span>
      </div>
      {visible.map((row) => {
        const words = rowWords(row)
        // Replace may override a newer or changed copy, so it sits beside Remove when both apply.
        const actions = [
          ...(row.canInstall ? [{ label: row.state === 'installed' ? 'Update' : W.install, run: () => act('install', row), attr: 'data-agent-install' }] : []),
          ...(row.canRemove ? [{ label: 'Remove', run: () => act('remove', row), attr: 'data-agent-remove' }] : []),
          ...(row.canReplace && !row.canInstall ? [{ label: 'Replace', run: () => act('replace', row), attr: 'data-agent-replace' }] : [])
        ]
        return (
          <div className="crow" key={row.id} data-agent-row={row.id} data-agent-state={row.state}>
            <span className="grow">
              <span className="lbl">{row.name} <span data-agent-status>· {words.status}</span></span>
              {words.detail && <small>{words.detail}</small>}
              {row.state === 'failed' && status?.skillLocation && (
                <small>
                  {' '}The skill is in <code>{status.skillLocation}</code>.{' '}
                  <button type="button" className="ghost" data-agent-copy-location
                    onClick={() => { void navigator.clipboard?.writeText(status.skillLocation ?? '').then(() => setCopied(true)).catch(() => {}) }}>{copied ? 'Copied' : 'Copy'}</button>
                </small>
              )}
            </span>
            {actions.map((action) => (
              <button key={action.attr} type="button" className="ghost" disabled={busy === row.id} {...{ [action.attr]: '' }} onClick={action.run}>{action.label}</button>
            ))}
          </div>
        )
      })}
      <div className="crow" data-agent-cli data-agent-cli-state={status?.cli.state ?? 'unknown'}>
        <Terminal className="icon" aria-hidden="true" />
        <span className="grow">
          <span className="lbl">Command-line tool</span>
          <small>
            {status && status.cli.state !== 'not-installed'
              ? cliWords(status.cli, connected)
              : 'Lets Claude Code, Codex and other agents search and read your Collection with “writeflex”. Connecting an agent installs it too.'}
          </small>
        </span>
        {status && (status.cli.state === 'not-installed' || status.cli.state === 'failed') && (
          <button type="button" className="ghost" title="Install command-line tool" aria-label="Install command-line tool" disabled={busy === 'cli'} data-agent-install-cli onClick={installCli}>
            Install command-line tool
          </button>
        )}
      </div>
      <details className="crow" data-agent-what-this-does>
        <summary>{W.whatThisDoes}</summary>
        {W.disclosure(
          visible.filter((r) => r.folder && r.state !== 'via').map((r) => ({ name: r.name, folder: `${r.folder}/${AGENT_SKILL_IDENTITY.skillName}` })),
          AGENT_SKILL_IDENTITY.cli.command, []
        ).map((line, i) => <small key={i} style={{ display: 'block', marginTop: 4 }}>{line}</small>)}
      </details>
    </div>
  )
}
