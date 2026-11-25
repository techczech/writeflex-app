import { test } from 'bun:test'

const probe = String.raw`
  import { mock, expect } from 'bun:test'
  import { EventEmitter } from 'node:events'

  const changed = 'collection:query-changed'
  const requests = []
  let api
  const ipc = Object.assign(new EventEmitter(), {
    invoke(channel, args) {
      if (channel !== 'collection:query') throw new Error('Unexpected invoke: ' + channel)
      const request = Promise.withResolvers()
      requests.push({ args, ...request })
      return request.promise
    },
  })
  mock.module('electron', () => ({
    clipboard: {}, webUtils: {}, ipcRenderer: ipc,
    contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed } },
  }))
  mock.module('@bridle/electron/preload', () => ({ createAuthTransport: () => ({}) }))
  await import('./src/preload/index.ts')
  const { query, onChanged } = api.collection

  for (const rejectOld of [false, true]) {
    api.resetE2eCollectionQueryCount()
    const start = requests.length
    const args = ['notes', 'status: draft']
    const change = { paths: ['notes/piece.md'] }
    let refreshed
    let received
    const off = onChanged(payload => { received = payload; refreshed = query(...args) })
    const offSibling = onChanged(() => {})
    const old = query(...args)
    const oldResult = old.then(value => value, error => error.message)
    expect(query(...args)).toBe(old)
    expect(requests.length - start).toBe(1)
    expect(ipc.listenerCount(changed)).toBe(1)

    ipc.emit(changed, {}, change)
    expect(received).toEqual(change)
    expect(requests.length - start).toBe(2)
    expect(refreshed).not.toBe(old)
    expect(requests[start + 1].args).toEqual({ dir: args[0], source: args[1] })
    expect(api.e2eCollectionQueryCount()).toBe(2)

    if (rejectOld) requests[start].reject(new Error('old query failed'))
    else requests[start].resolve('old rows')
    expect(await oldResult).toBe(rejectOld ? 'old query failed' : 'old rows')
    expect(query(...args)).toBe(refreshed)
    expect(requests.length - start).toBe(2)

    off()
    off()
    offSibling()
    expect(ipc.listenerCount(changed)).toBe(1)
    requests[start + 1].resolve('fresh rows')
    expect(await refreshed).toBe('fresh rows')
    expect(ipc.listenerCount(changed)).toBe(0)
  }

  const start = requests.length
  const first = query('notes', 'status: draft')
  const otherDir = query('other', 'status: draft')
  const otherSource = query('notes', 'status: done')
  expect(requests.length - start).toBe(3)
  expect(ipc.listenerCount(changed)).toBe(1)
  ipc.emit(changed, {}, { paths: [] })
  const fresh = query('notes', 'status: draft')
  expect(fresh).not.toBe(first)
  expect(query('notes', 'status: draft')).toBe(fresh)
  expect(requests.length - start).toBe(4)
  for (const request of requests.slice(start)) request.resolve(null)
  await Promise.all([first, otherDir, otherSource, fresh])
  expect(ipc.listenerCount(changed)).toBe(0)
`

test('the exposed Collection query bridge coalesces only within an invalidation generation', async () => {
  // Isolate the Electron mock from other preload and main tests.
  const child = Bun.spawn([process.execPath, '-e', probe], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Collection query bridge probe exited ${exitCode}:\n${stderr}`)
})
