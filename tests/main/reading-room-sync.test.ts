import { expect, test } from 'bun:test'

type SyncRunner = {
  runAutomatic: () => Promise<void>
  runLifecycle: () => Promise<void>
  runManual: () => Promise<void>
}

async function loadCreateOutboxSyncRunner(): Promise<(options: {
  readCounts: () => Promise<{ waiting: number; rejected: number }>
  drain: () => Promise<{ waiting: number }>
  onCounts: (counts: { waiting: number; rejected: number }) => void
  onResult: (result: { waiting: number }) => void
  onDrainError: (error: unknown) => void
  now?: () => number
}) => SyncRunner> {
  const module = await import('../../src/renderer/src/reading-room-sync').catch(() => ({}))
  const create = (module as Record<string, unknown>).createOutboxSyncRunner
  expect(typeof create).toBe('function')
  return create as ReturnType<typeof loadCreateOutboxSyncRunner> extends Promise<infer Value> ? Value : never
}

test('an outbox sync refreshes the count and does not drain when nothing is waiting', async () => {
  let drains = 0
  const countReadings: Array<{ waiting: number; rejected: number }> = []
  const create = await loadCreateOutboxSyncRunner()
  const runner = create({
    readCounts: async () => ({ waiting: 0, rejected: 2 }),
    drain: async () => {
      drains += 1
      return { waiting: 0 }
    },
    onCounts: (counts) => countReadings.push(counts),
    onResult: () => {
      throw new Error('No result exists when no drain ran')
    },
    onDrainError: (error) => {
      throw error
    },
  })

  await runner.runAutomatic()

  expect(countReadings).toEqual([{ waiting: 0, rejected: 2 }])
  expect(drains).toBe(0)
})

test('simultaneous automatic sync requests share one count read and one drain', async () => {
  let releaseCounts: ((counts: { waiting: number; rejected: number }) => void) | null = null
  let countReads = 0
  let drains = 0
  const results: Array<{ waiting: number }> = []
  const create = await loadCreateOutboxSyncRunner()
  const runner = create({
    readCounts: () => {
      countReads += 1
      return new Promise<{ waiting: number; rejected: number }>((resolve) => {
        releaseCounts = resolve
      })
    },
    drain: async () => {
      drains += 1
      return { waiting: 0 }
    },
    onCounts: () => {},
    onResult: (result) => results.push(result),
    onDrainError: (error) => {
      throw error
    },
  })

  const first = runner.runAutomatic()
  const second = runner.runAutomatic()
  releaseCounts?.({ waiting: 1, rejected: 0 })
  await Promise.all([first, second])

  expect(countReads).toBe(1)
  expect(drains).toBe(1)
  expect(results).toEqual([{ waiting: 0 }])
})

test('automatic attempts stay at least ten seconds apart', async () => {
  let now = 100_000
  let reads = 0
  let drains = 0
  const create = await loadCreateOutboxSyncRunner()
  const runner = create({
    readCounts: async () => {
      reads += 1
      return { waiting: 1, rejected: 0 }
    },
    drain: async () => {
      drains += 1
      return { waiting: 0 }
    },
    onCounts: () => {},
    onResult: () => {},
    onDrainError: (error) => {
      throw error
    },
    now: () => now,
  })

  await runner.runAutomatic()
  now += 9_999
  await runner.runAutomatic()
  now += 1
  await runner.runAutomatic()

  expect({ drains, reads }).toEqual({ drains: 2, reads: 2 })
})

test('Room and document lifecycle retries are never swallowed by the focus throttle', async () => {
  let reads = 0
  let drains = 0
  let noteFirstReadStarted: (() => void) | null = null
  let releaseFirstRead: ((counts: { waiting: number; rejected: number }) => void) | null = null
  const firstReadStarted = new Promise<void>((resolve) => {
    noteFirstReadStarted = resolve
  })
  const create = await loadCreateOutboxSyncRunner()
  const runner = create({
    readCounts: () => {
      reads += 1
      if (reads === 1) {
        noteFirstReadStarted?.()
        return new Promise<{ waiting: number; rejected: number }>((resolve) => {
          releaseFirstRead = resolve
        })
      }
      return Promise.resolve({ waiting: 1, rejected: 0 })
    },
    drain: async () => {
      drains += 1
      return { waiting: 0 }
    },
    onCounts: () => {},
    onResult: () => {},
    onDrainError: (error) => {
      throw error
    },
    now: () => 100_000,
  })

  const roomOpened = runner.runLifecycle()
  await firstReadStarted
  const documentOpened = runner.runLifecycle()
  releaseFirstRead?.({ waiting: 0, rejected: 0 })
  await Promise.all([roomOpened, documentOpened])

  expect({ drains, reads }).toEqual({ drains: 1, reads: 2 })
})

test('manual requests are serial but are never throttled or coalesced away', async () => {
  let drains = 0
  let drainsInFlight = 0
  let maximumDrainsInFlight = 0
  let releaseFirstDrain: (() => void) | null = null
  let noteFirstDrainStarted: (() => void) | null = null
  const firstDrainStarted = new Promise<void>((resolve) => {
    noteFirstDrainStarted = resolve
  })
  const create = await loadCreateOutboxSyncRunner()
  const runner = create({
    readCounts: async () => ({ waiting: 1, rejected: 0 }),
    drain: async () => {
      drains += 1
      drainsInFlight += 1
      maximumDrainsInFlight = Math.max(maximumDrainsInFlight, drainsInFlight)
      if (drains === 1) {
        noteFirstDrainStarted?.()
        await new Promise<void>((resolve) => {
          releaseFirstDrain = resolve
        })
      }
      drainsInFlight -= 1
      return { waiting: 0 }
    },
    onCounts: () => {},
    onResult: () => {},
    onDrainError: (error) => {
      throw error
    },
  })

  const first = runner.runManual()
  const second = runner.runManual()
  await firstDrainStarted
  releaseFirstDrain?.()
  await Promise.all([first, second])

  expect(drains).toBe(2)
  expect(maximumDrainsInFlight).toBe(1)
})

test('a broken count read stays silent while a failed drain is surfaced', async () => {
  const surfaced: string[] = []
  let drainAttempts = 0
  const create = await loadCreateOutboxSyncRunner()
  const brokenCount = create({
    readCounts: async () => {
      throw new Error('count IPC broke')
    },
    drain: async () => {
      drainAttempts += 1
      return { waiting: 0 }
    },
    onCounts: () => {},
    onResult: () => {},
    onDrainError: (error) => surfaced.push(String(error)),
  })

  await brokenCount.runManual()
  expect(drainAttempts).toBe(0)
  expect(surfaced).toEqual([])

  const brokenDrain = create({
    readCounts: async () => ({ waiting: 1, rejected: 0 }),
    drain: async () => {
      throw new Error('drain IPC broke')
    },
    onCounts: () => {},
    onResult: () => {},
    onDrainError: (error) => surfaced.push(
      error instanceof Error ? error.message : String(error),
    ),
  })

  await brokenDrain.runManual()
  expect(surfaced).toEqual(['drain IPC broke'])
})

test('SHOULD-FIX false success: success is announced only for rows written, and a refused last row is said as such', async () => {
  const { outboxResultAnnouncement } = await import('../../src/renderer/src/reading-room-sync')
  // The last waiting row was refused: the queue is empty, but nothing reached Zotero.
  expect(outboxResultAnnouncement(1, { refusedNow: 1, waiting: 0, written: 0 }))
    .toBe('1 change could not be written to Zotero. It is kept here with the reason.')
  expect(outboxResultAnnouncement(3, { refusedNow: 2, waiting: 0, written: 1 }))
    .toBe('2 changes could not be written to Zotero. They are kept here with the reason.')
  expect(outboxResultAnnouncement(2, { refusedNow: 0, waiting: 0, written: 2 })).toBe('New highlights synced to Zotero.')
  // Emptied with nothing written and nothing refused (an older main process, a cancel): say nothing.
  expect(outboxResultAnnouncement(1, { waiting: 0 })).toBeNull()
  // Still waiting, never waiting, or a kept-here create: no announcement.
  expect(outboxResultAnnouncement(2, { waiting: 1, written: 1 })).toBeNull()
  expect(outboxResultAnnouncement(0, { waiting: 0, written: 1 })).toBeNull()
  expect(outboxResultAnnouncement(1, { keptLocal: { created: true }, waiting: 0, written: 1 })).toBeNull()
})
