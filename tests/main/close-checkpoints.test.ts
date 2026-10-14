// A closing window's checkpoints (src/main/close-checkpoints.ts): made in main after the window has
// gone, in order, within a budget, and never in the way of the quit that follows.
import { describe, expect, it } from 'bun:test'
import { CLOSE_CHECKPOINT_MAX_PATHS, parseCloseCheckpointPaths, startCloseCheckpoints } from '../../src/main/close-checkpoints'
import { registerWindow, trackPendingDisposal, waitForAgentDisposals } from '../../src/main/state'

function fakeRun(paths: string[], checkpoint: (path: string) => Promise<void>, options: { prepareFails?: boolean } = {}) {
  let clock = 0
  let budget: (() => void) | null = null
  let armed = false
  const settled: Array<Record<string, unknown>> = []
  let prepared = 0
  const run = startCloseCheckpoints(paths, {
    prepare: async () => {
      prepared += 1
      if (options.prepareFails) throw new Error('No agent for this window.')
      return checkpoint
    },
    record: (event, details) => { if (event === 'close.checkpoints.settled') settled.push(details) },
    now: () => clock,
    setTimer: (fire) => { budget = fire; armed = true; return fire },
    clearTimer: () => { armed = false },
  })
  return {
    run, settled,
    tick: (ms: number) => { clock += ms },
    spendBudget: () => budget?.(),
    get prepared() { return prepared }, get armed() { return armed },
  }
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('startCloseCheckpoints', () => {
  it('checkpoints every path once, in the order given, and resolves what they share once', async () => {
    const made: string[] = []
    const w = fakeRun(['changed.md', 'a.md', 'b.md'], async (path) => { made.push(path) })
    await w.run.done
    expect(made).toEqual(['changed.md', 'a.md', 'b.md'])
    expect(w.prepared).toBe(1)
    expect(w.settled).toEqual([{ count: 3, elapsedMs: 0, dropped: 0 }])
    expect(w.armed).toBe(false)
  })

  it('at the budget it starts no further path, and is over only when the checkpoint in flight has finished', async () => {
    const started: string[] = []
    const release: Array<() => void> = []
    const w = fakeRun(['one.md', 'two.md', 'three.md'], (path) => new Promise((resolve) => { started.push(path); release.push(resolve) }))
    let over = false
    void w.run.done.then(() => { over = true })
    await turn()
    release[0]() // one.md finishes
    await turn()
    expect(started).toEqual(['one.md', 'two.md'])
    w.tick(1000)
    w.spendBudget()
    await turn()
    // two.md is still being written (a snapshot, a journal line): the run is not over, so the quit that
    // tracks `done` and the agent disposal that waits on it do not go ahead under it.
    expect(over).toBe(false)
    expect(w.settled).toEqual([])
    w.tick(200)
    release[1]()
    await w.run.done
    expect(started).toEqual(['one.md', 'two.md']) // three.md was never started
    expect(w.settled).toEqual([{ count: 3, elapsedMs: 1200, dropped: 1 }])
  })

  it('quit tracking holds while a checkpoint is in flight past the budget: waitForAgentDisposals does not return', async () => {
    let finish!: () => void
    let checkpointFinished = false
    const w = fakeRun(['slow.md', 'never-started.md'], () => new Promise<void>((resolve) => { finish = () => { checkpointFinished = true; resolve() } }))
    trackPendingDisposal(w.run.done) // as window:close does (ipc.ts)
    await turn()
    w.tick(1000)
    w.spendBudget()
    let waited = false
    const wait = waitForAgentDisposals().then(() => { waited = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(waited).toBe(false)
    finish()
    await wait
    expect(checkpointFinished).toBe(true)
    expect(w.settled).toEqual([{ count: 2, elapsedMs: 1000, dropped: 1 }])
  })

  it('a path that fails is counted and the others are still made', async () => {
    const made: string[] = []
    const w = fakeRun(['a.md', 'gone.md', 'b.md'], async (path) => {
      if (path === 'gone.md') throw new Error('ENOENT')
      made.push(path)
    })
    await w.run.done
    expect(made).toEqual(['a.md', 'b.md'])
    expect(w.settled).toEqual([{ count: 3, elapsedMs: 0, dropped: 1 }])
  })

  it('never rejects: with no agent every path is dropped', async () => {
    const w = fakeRun(['a.md', 'b.md'], async () => {}, { prepareFails: true })
    await w.run.done
    expect(w.settled).toEqual([{ count: 2, elapsedMs: 0, dropped: 2 }])
  })

  it('the closed window\'s agent is disposed only after the checkpoint in flight past the budget has finished', async () => {
    let finish!: () => void
    const w = fakeRun(['slow.md'], () => new Promise<void>((resolve) => { finish = resolve }))
    let closed: (() => void) | null = null
    const state = registerWindow({ webContents: { id: 987_001 }, on: (_event: string, listener: () => void) => { closed = listener } } as never)
    let disposed = false
    state.agent = { dispose: async () => { disposed = true } } as never
    state.closeWork = w.run
    await turn()
    w.tick(1000)
    w.spendBudget()
    closed!() // the window has gone
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    finish()
    await waitForAgentDisposals()
    expect(disposed).toBe(true)
  })

  it('stop() starts no further path and waits for the one in flight', async () => {
    const started: string[] = []
    let finish!: () => void
    const w = fakeRun(['a.md', 'b.md'], (path) => new Promise<void>((resolve) => { started.push(path); finish = resolve }))
    await turn()
    w.run.stop()
    let over = false
    void w.run.done.then(() => { over = true })
    await turn()
    expect(over).toBe(false)
    finish()
    await w.run.done
    expect(started).toEqual(['a.md'])
    expect(w.settled).toEqual([{ count: 2, elapsedMs: 0, dropped: 1 }])
  })
})

describe('parseCloseCheckpointPaths', () => {
  const allow = (path: string): boolean => { if (path.startsWith('/') || path.startsWith('../')) throw new Error('outside'); return true }

  it('reads relative path strings, each once, in order', () => {
    expect(parseCloseCheckpointPaths({ checkpoint: ['b.md', 'a.md', 'b.md'] }, allow)).toEqual(['b.md', 'a.md'])
  })

  it('anything else is no paths', () => {
    expect(parseCloseCheckpointPaths(undefined, allow)).toEqual([])
    expect(parseCloseCheckpointPaths('a.md', allow)).toEqual([])
    expect(parseCloseCheckpointPaths({ checkpoint: 'a.md' }, allow)).toEqual([])
    expect(parseCloseCheckpointPaths({ checkpoint: [1, null, '', { path: 'a.md' }] }, allow)).toEqual([])
  })

  it('drops a path the workspace check refuses and keeps the rest', () => {
    expect(parseCloseCheckpointPaths({ checkpoint: ['/etc/passwd', '../up.md', 'ok.md'] }, allow)).toEqual(['ok.md'])
  })

  it('cuts a list longer than any window has tabs', () => {
    const many = Array.from({ length: CLOSE_CHECKPOINT_MAX_PATHS + 50 }, (_, index) => `${index}.md`)
    expect(parseCloseCheckpointPaths({ checkpoint: many }, allow)).toHaveLength(CLOSE_CHECKPOINT_MAX_PATHS)
  })
})
