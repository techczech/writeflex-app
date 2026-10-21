/**
 * How a writer that needs BOTH the scrap store's queue and the Collection's write turn takes them,
 * and what it must have in hand before it takes either.
 *
 * THE ONE ORDER: the scrap store's queue first, then the Collection's write turn. Never the turn and
 * then the queue. Everything that holds both takes them through `queueThenTurn` (a request carried
 * out for the command line, a decision on a Change, the Board desk's steps and undo; the scrap
 * store's own writes take the turn inside its queue, which is the same order). A writer that holds
 * only the turn never asks for the queue.
 *
 * Both are re-entered by code already running inside them (collection-write-turn.ts), so a holder of
 * both may call anything that asks for either again.
 */

type Exclusive = <T>(work: () => Promise<T>) => Promise<T>

/** Run `work` holding the scrap store's queue and then the Collection's write turn. With no scrap store, the turn alone. */
export function queueThenTurn<T>(scraps: { exclusive: Exclusive } | null | undefined, workspace: { exclusiveAll: Exclusive }, work: () => Promise<T>): Promise<T> {
  return scraps ? scraps.exclusive(() => workspace.exclusiveAll(work)) : workspace.exclusiveAll(work)
}

/** How a request's work is run: `operation` is the request's, so the wiring can tell what it needs. */
type ExclusiveFor = <T>(work: () => Promise<T>, operation?: string) => Promise<T>

/**
 * How long a request that needs the agent waits for it to be ready before it is carried out
 * without it. Five seconds: half of what the command line itself waits for an answer
 * (`REPLY_WAIT_MS`, 10 s, cli/request-format.ts), so the answer still reaches the command that
 * asked, and more than the author lookup that is part of readiness may take (`GIT_CONFIG_WAIT_MS`, 3 s).
 */
export const REQUEST_READINESS_WAIT_MS = 5_000

export type ReadinessBound = {
  /** Whether a request of this operation needs what `ready` gives. Every other request does not wait at all. */
  needs: (operation: string) => boolean
  limitMs: number
  /** @internal Test seam: the limit passes when this settles, in place of the clock (as bounded-child.ts). */
  expired?: () => Promise<void>
}

/**
 * Whatever work will need that can wait on a model service, the network or a person is waited for
 * BEFORE the queue and the turn are taken, never inside them: every save of the Collection waits
 * behind a turn. And only work that needs it waits, and for no longer than a limit: a machine that
 * is offline, or a model service that never answers, must not stop a request that needs no agent.
 *
 * For an operation `bound.needs`, `ready` is asked and raced against the limit, holding nothing;
 * then `take(work)` runs, and inside it `had()` answers at once with what `ready` gave: null when it
 * failed, when the limit passed first, or when the operation did not need it. One piece of work at
 * a time, as the request executor runs them.
 */
export function readyBeforeTurn<R>(ready: () => Promise<R | null> | R | null, take: Exclusive, bound: ReadinessBound): { exclusive: ExclusiveFor; had: () => R | null } {
  let had: R | null = null
  const withinLimit = (): Promise<R | null> => new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (value: R | null): void => {
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    Promise.resolve().then(ready).then(settle, () => settle(null))
    if (bound.expired) void bound.expired().then(() => settle(null), () => settle(null))
    else timer = setTimeout(() => settle(null), bound.limitMs)
  })
  return {
    exclusive: async (work, operation) => {
      had = null
      if (operation !== undefined && bound.needs(operation)) had = await withinLimit()
      return take(work)
    },
    had: () => had,
  }
}
