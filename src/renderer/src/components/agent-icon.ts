import { Sparkles, type LucideIcon } from 'lucide-react'
import { commandAnnotations } from '../commands/registry-annotations'

/**
 * The agent's icon (ticket 12). The right pane's Agent tab wears it, and so does every control that
 * hands work to the agent — the folder menu's and the palette's Help with this report, the Plan
 * pane's trigger, a skill's Run as-is — so the writer can see it is the agent doing the helping.
 * One constant, so the tab and the launch points cannot drift apart.
 */
export const AGENT_ICON: LucideIcon = Sparkles

/** The class every launch point's agent icon carries, on top of the usual `icon` sizing. */
export const AGENT_ICON_CLASS = 'agent-icon'

/**
 * Does this registry command start an agent run? The content-verb annotations already say so:
 * `thread.run` is exactly the skill launches (the `skill.run.*` rows and the folder menu's report
 * skill), so a new skill command carries the agent icon without anyone remembering to add it.
 */
export function launchesAgent(commandId: string): boolean {
  return commandAnnotations[commandId]?.verb === 'thread.run' || commandId === 'agent.askHere'
}
