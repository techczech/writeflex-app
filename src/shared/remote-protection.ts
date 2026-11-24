/** The remote-copy status of a Git vault reads a private backup tool's records, so the public WriteFlex shows none. */
export const REMOTE_COPY_AVAILABLE: boolean = false
export type RemoteProtection = { readAt: number }
export type WriteFlexRoute = { enabled: boolean; state: number | null; lastSentAt?: number; busy?: boolean }
export type ProtectionTone = 'green' | 'amber' | 'red' | 'grey'
export type RouteStatus = { name: string; tone: ProtectionTone; text: string }
export type ProtectionView = { label: string; tone: ProtectionTone; heading: string; routes: RouteStatus[]; lines: string[]; gaps: string[] }
export function presentProtection(_protection: RemoteProtection | null | undefined, _route: WriteFlexRoute, _now = Date.now()): ProtectionView {
  return { label: '', tone: 'grey', heading: '', routes: [], lines: [], gaps: [] }
}
