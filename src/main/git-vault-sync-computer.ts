import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
let cached: string | undefined
export function friendlyComputerName(): string {
  if (cached) return cached
  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding:'utf8', timeout:1000, stdio:['ignore','pipe','ignore'] }).trim()
      if (value) return cached = value.replace(/[\r\n\0]/g,' ').slice(0,100)
    } catch { /* a missing system label must never block writing or sync */ }
  }
  return cached = hostname().replace(/\.local$/i,'').replace(/[\r\n\0]/g,' ').slice(0,100)
}
