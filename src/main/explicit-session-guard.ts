export const SESSION_TAKEOVER_MESSAGE = 'Session ended by a new session in another window'

type RecorderState = { explicitSession: { active: boolean } | null }

export async function endRunningExplicitSessions<T extends RecorderState>(
  states: T[],
  nextOwner: T,
  close: (state: T) => Promise<void>,
  notify: (state: T, message: string) => void,
): Promise<void> {
  const owners = states.filter((state) => state.explicitSession?.active)
  if (owners.length === 0) return
  for (const owner of owners) await close(owner)
  for (const state of new Set([...owners, nextOwner])) notify(state, SESSION_TAKEOVER_MESSAGE)
}
