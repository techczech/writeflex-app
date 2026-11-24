/** Presentation metadata only: no merge, transport or staging policy lives here. */
import type { SyncGit } from './git-vault-sync-git'
export async function incomingComputer(git: SyncGit, head: string, remote: string): Promise<string | null> {
  const metadata = await git.text(['log', '-1', '--format=%cn%x00%ce%x00%B', remote, '--not', head])
  if (!metadata) return null
  const [committer, email, message = ''] = metadata.split('\0')
  if (!committer.startsWith('WriteFlex on ') || email !== 'writeflex@localhost') return 'another computer'
  const trailer = /^WriteFlex-Computer:[ \t]*(.+)$/m.exec(message)?.[1]
  const subject = /^WriteFlex: \d+ documents? from (.+)$/.exec(message.split('\n')[0])?.[1]
  // One bounded filename-safe label is used in both the receipt and the kept-copy name.
  return (trailer ?? subject ?? '').replace(/[\x00-\x1f\x7f/\\:<>"|?*]/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || 'another computer'
}
