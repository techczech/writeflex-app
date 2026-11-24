import { FolderSearch, Headphones, History, Inbox, ListTree, PenLine, Settings, Share2, Sparkles, Target, type LucideIcon } from 'lucide-react'
import { TASK_GROUP_ICONS, type TaskGroup, type TaskGroupIconName } from '../commands/command-task-groups'

// Name → component for TASK_GROUP_ICONS; the names themselves live with the group definitions.
const BY_NAME: Readonly<Record<TaskGroupIconName, LucideIcon>> = {
  PenLine, ListTree, Target, Headphones, History, FolderSearch, Inbox, Sparkles, Share2, Settings,
}

/** A task group's icon. Decorative: the group's name is always written beside it. */
export function TaskGroupIcon({ group, className = 'icon sm' }: { group: TaskGroup; className?: string }): JSX.Element {
  const Icon = BY_NAME[TASK_GROUP_ICONS[group]]
  return <Icon className={className} aria-hidden="true" data-group-icon={TASK_GROUP_ICONS[group]} />
}
