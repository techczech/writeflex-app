/**
 * ADR-0031, "the same defect through a second door": the exclusive-lock probe cannot be taught to
 * recognise us, so the drain stops racing our own reads instead.
 *
 * Each test names the property that would break if the gate were removed, rather than asserting on
 * the gate's internals — a mutual-exclusion guard with no test that fails when it is deleted is
 * decoration, and the point of these is to fail then.
 */
import { describe, expect, test } from 'bun:test'
import {
  createZoteroLibraryAccess,
  NESTED_ZOTERO_READ_MESSAGE,
} from '../../src/main/zotero-library-access'

/** A promise plus its resolver, so a test can hold an operation open at a chosen moment. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = () => resolve()
  })
  return { open, promise }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the Zotero library gate', () => {
  test('a drain waits for a read that is already in flight', async () => {
    const access = createZoteroLibraryAccess()
    const held = gate()
    const order: string[] = []

    const reading = access.read(async () => {
      order.push('read-start')
      await held.promise
      order.push('read-end')
    })
    await settle()

    const draining = access.drain(async () => {
      order.push('drain')
    })
    await settle()

    // The drain has NOT run: this is the whole defect. Without the gate it would already have probed
    // the lock with our own read holding the database open.
    expect(order).toEqual(['read-start'])

    held.open()
    await Promise.all([reading, draining])
    expect(order).toEqual(['read-start', 'read-end', 'drain'])
  })

  test('a read that arrives during a drain waits for it, and both complete', async () => {
    const access = createZoteroLibraryAccess()
    const held = gate()
    const order: string[] = []

    const draining = access.drain(async () => {
      order.push('drain-start')
      await held.promise
      order.push('drain-end')
    })
    await settle()

    // Shaped like ADR-0029's repaint: a read of the annotations arriving while the drain has the
    // library. It must finish, not deadlock, which is the failure that would be worse than the flake.
    const repaint = access.read(async () => {
      order.push('repaint')
      return 'painted'
    })
    await settle()
    expect(order).toEqual(['drain-start'])

    held.open()
    await draining
    await expect(repaint).resolves.toBe('painted')
    expect(order).toEqual(['drain-start', 'drain-end', 'repaint'])
  })

  test('two drains never hold the library at once', async () => {
    const access = createZoteroLibraryAccess()
    let concurrent = 0
    let mostAtOnce = 0
    const probe = async (): Promise<void> => {
      concurrent += 1
      mostAtOnce = Math.max(mostAtOnce, concurrent)
      await settle()
      concurrent -= 1
    }

    await Promise.all([
      access.drain(probe),
      access.drain(probe),
      access.drain(probe),
    ])
    expect(mostAtOnce).toBe(1)
  })

  test('reads are not serialised against each other', async () => {
    const access = createZoteroLibraryAccess()
    let concurrent = 0
    let mostAtOnce = 0
    const held = gate()
    const read = async (): Promise<void> => {
      concurrent += 1
      mostAtOnce = Math.max(mostAtOnce, concurrent)
      await held.promise
      concurrent -= 1
    }

    const all = Promise.all([access.read(read), access.read(read), access.read(read)])
    await settle()
    // The Shelf must never wait behind painting: that would be a worse outcome than the refusal the
    // gate prevents.
    expect(mostAtOnce).toBe(3)
    held.open()
    await all
  })

  test('a waiting drain is not starved by a steady stream of reads', async () => {
    const access = createZoteroLibraryAccess()
    const held = gate()
    const order: string[] = []

    const first = access.read(async () => {
      order.push('read-1')
      await held.promise
    })
    await settle()
    const draining = access.drain(async () => {
      order.push('drain')
    })
    await settle()
    // Queued AFTER the drain, so it must land after it however short it is.
    const later = access.read(async () => {
      order.push('read-2')
    })
    await settle()

    held.open()
    await Promise.all([first, draining, later])
    expect(order).toEqual(['read-1', 'drain', 'read-2'])
  })

  test('a read nested inside a drain is refused rather than left to hang', async () => {
    const access = createZoteroLibraryAccess()
    // The only shape that could deadlock. It throws with its own message, so a builder who ever
    // introduces it sees a named error instead of a frozen app.
    await expect(
      access.drain(async () => {
        await access.read(() => 'never')
      }),
    ).rejects.toThrow(NESTED_ZOTERO_READ_MESSAGE)

    // And the gate is not left holding exclusivity after the rejection.
    await expect(access.read(() => 'after')).resolves.toBe('after')
  })

  test('a read that throws releases the gate', async () => {
    const access = createZoteroLibraryAccess()
    await expect(access.read(() => {
      throw new Error('the library could not be read')
    })).rejects.toThrow('the library could not be read')
    await expect(access.drain(() => 'drained')).resolves.toBe('drained')
  })

  test('a drain that throws releases the gate', async () => {
    const access = createZoteroLibraryAccess()
    await expect(access.drain(() => {
      throw new Error('the write refused')
    })).rejects.toThrow('the write refused')
    await expect(access.read(() => 'read')).resolves.toBe('read')
  })
})
