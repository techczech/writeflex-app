import { CircleUser, Library, AudioLines, Check, type LucideIcon } from 'lucide-react'
import { CONNECTION_TEXT, connectionRows, type ConnectionActionId, type ConnectionId, type ConnectionRow, type ConnectionSources } from '../../../shared/guide-connections'
import { TopicsView, type TopicsViewProps } from './GuideTopics'

/**
 * The Guide's Features to delight you tab: eleven topics, then What it connects to (ticket 08, states 13 to
 * 16). The three rows read this machine (`src/shared/guide-connections.ts`); each has one action at most.
 */
const ICON: Record<ConnectionId, LucideIcon> = { model: CircleUser, zotero: Library, voices: AudioLines }

function Connections({ sources, onAction }: { sources: ConnectionSources; onAction: (action: ConnectionActionId) => void }): JSX.Element {
  return (
    <div className="g-card" data-guide="connects">
      <div className="g-bar"><span>{CONNECTION_TEXT.bar}</span></div>
      {connectionRows(sources).map((row: ConnectionRow) => {
        const Icon = ICON[row.id]
        return (
          <div className="g-conn" key={row.id} data-connection={row.id} data-state={row.state}>
            <span className="g-ico"><Icon className="icon sm" aria-hidden="true" /></span>
            <div className="g-t2">
              <span className="g-name">{row.name}</span>
              <span className={row.state === 'on' ? 'st-done' : row.state === 'off' ? 'st-off' : 'st-none'} data-conn-state>
                {row.state === 'on' ? <Check className="icon sm" aria-hidden="true" /> : row.state === 'off' ? <i className="dot" /> : null}{row.stateText}
              </span>
              <span className="g-dim">{row.need}</span>
              {row.action && <>
                <span className="g-dim">{row.without}</span>
                <button type="button" className="g-btn sm" data-action={row.action.id} onClick={() => onAction(row.action!.id)}>{row.action.label}</button>
              </>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function GuideFeaturesTab({ sources, onConnectionAction, ...rest }: Omit<TopicsViewProps, 'tab'> & { sources: ConnectionSources; onConnectionAction: (action: ConnectionActionId) => void }): JSX.Element {
  return <TopicsView {...rest} tab="features" after={<Connections sources={sources} onAction={onConnectionAction} />} />
}
