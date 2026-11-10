// The agent-skill offer as the window holds it: asked once from main when the window opens, shared by the dialog
// over the start screen and the status-bar mark so they never disagree, cleared when answered.
import { useEffect, useState } from 'react'
import type { Offer } from '../../../shared/agent-skill/types'

export const agentSkillBridge = (): Window['writeflex']['agentSkill'] | undefined => (typeof window === 'undefined' ? undefined : window.writeflex?.agentSkill)

let current: Offer | null = null
let asked = false
const subs = new Set<() => void>()
const publish = (next: Offer | null): void => { current = next; subs.forEach((f) => f()) }

export function useAgentSkillOffer(): [Offer | null, (next: Offer | null) => void] {
  const [, tick] = useState(0)
  useEffect(() => {
    const sub = (): void => tick((n) => n + 1)
    subs.add(sub)
    if (!asked) {
      asked = true
      void agentSkillBridge()?.offer().then((o) => { if (o.kind !== 'none') publish(o) }).catch(() => {})
    }
    return () => { subs.delete(sub) }
  }, [])
  return [current, publish]
}
