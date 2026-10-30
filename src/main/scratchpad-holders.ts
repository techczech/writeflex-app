/** Main-process placement liveness shared by floating, Board, agent and headless readers.
 * No Electron dependency: main supplies the live window registry; a standalone CLI has no editors. */
import { randomBytes } from 'node:crypto'
const RUN = randomBytes(6).toString('hex')
export const scratchpadHolder = (senderId: number): string => `${RUN}:${senderId}`
export const liveScratchpadHolders = (senderIds: readonly number[]): ReadonlySet<string> => new Set(senderIds.map(scratchpadHolder))
let liveSenders: (root: string) => readonly number[] = () => []
/** Main-only configuration. Never exposed through preload or IPC. Evaluated on every read. */
export function configureScratchpadHolders(senders: (root: string) => readonly number[]): void { liveSenders = senders }
export const currentScratchpadHolders = (root: string): ReadonlySet<string> => liveScratchpadHolders(liveSenders(root))
