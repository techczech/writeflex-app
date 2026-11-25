import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

// Exercise real file changes through the application's watch port without depending on FSEvents delivery.
export function watchTestTarget(folder, name, listener, identityOnly = false) {
  const path = join(folder, name)
  const events = new EventEmitter()
  const signature = () => {
    const stat = statSync(path, { throwIfNoEntry: false, bigint: true })
    if (!stat) return null
    const identity = `${stat.dev}:${stat.ino}`
    return identityOnly ? identity : `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  }
  // Establish the baseline synchronously so an immediate replacement is observable.
  let previous = signature()
  const timer = setInterval(() => {
    let next
    try { next = signature() }
    catch (error) { clearInterval(timer); events.emit('error', error); return }
    if (next === previous) return
    previous = next
    listener(name)
  }, 25)
  return { close: () => clearInterval(timer), on: events.on.bind(events) }
}

export async function waitForWatch(check, description, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`No watch notice for ${description}`)
    await pause(25)
  }
}
