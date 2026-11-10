import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackScratch } from './scratch-dirs'

/** Unix sun_path is bounded independently of TMPDIR and checkout length (enrolment: 103 bytes). */
export function shortSocketDir(): string {
  return trackScratch(realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'wfs-'))))
}
