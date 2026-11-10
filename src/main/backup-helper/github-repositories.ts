/** Account/installation/repository intersection; candidates never grant or enrol a vault. */
import type { BackupGitHubConfig } from '../backup-github-config'
import type { GitHubRequest } from './github-device-flow'
import { GitHubRequestError } from './github-device-flow'
export function parseGitHubOrigin(remote: string): { repository: string; credentialPath: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,104})$/.exec(remote)
  if (!match || ['.', '..'].includes(match[2]!) || match[2]!.replace(/\.git$/, '').length === 0) return null
  return { repository: `${match[1]}/${match[2]!.replace(/\.git$/, '')}`, credentialPath: `${match[1]}/${match[2]}` }
}
export async function inspectGitHubAccess(config: BackupGitHubConfig, request: GitHubRequest, token: string, repository: string, signal?: AbortSignal): Promise<{ repositoryId: number; installationId: number }> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new GitHubRequestError('invalid-response')
  const list = async (path: string, key: 'installations' | 'repositories') => {
    const rows: any[] = []; let total: number | null = null
    for (let page = 1; page <= 10; page++) {
      const v = await request(`${path}?per_page=100&page=${page}`, undefined, token, signal)
      if (!Number.isSafeInteger(v.total_count) || v.total_count < 0 || v.total_count > 1000 || !Array.isArray(v[key]) || v[key].length > 100 || (total !== null && total !== v.total_count)) throw new GitHubRequestError('invalid-response')
      total = v.total_count; rows.push(...v[key])
      if (rows.length === total) return rows
      if (rows.length > v.total_count || v[key].length < 100) throw new GitHubRequestError('invalid-response')
    }
    throw new GitHubRequestError('invalid-response')
  }
  const installations = (await list('/user/installations', 'installations')).filter(v => v.app_id === config.appId)
  if (installations.some(i => !Number.isSafeInteger(i.id) || i.id < 1 || i.suspended_at)) throw new GitHubRequestError('not-authorised')
  const repo = await request(`/repos/${repository}`, undefined, token, signal)
  if (!Number.isSafeInteger(repo.id) || repo.id < 1 || typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== repository.toLowerCase() || repo.permissions?.push !== true) throw new GitHubRequestError('not-authorised')
  const matches: number[] = []
  for (const install of installations) {
    const rows = await list(`/user/installations/${install.id}/repositories`, 'repositories')
    const same = rows.filter(v => v.id === repo.id && typeof v.full_name === 'string' && v.full_name.toLowerCase() === repository.toLowerCase() && v.permissions?.push === true)
    if (same.length > 1) throw new GitHubRequestError('invalid-response')
    if (same.length === 1) matches.push(install.id)
  }
  if (matches.length !== 1) throw new GitHubRequestError('not-authorised')
  return { repositoryId: repo.id, installationId: matches[0]! }
}
