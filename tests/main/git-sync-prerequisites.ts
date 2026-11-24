import { measureSyncGitRenames, renameStopMessage } from '../../src/main/git-vault-sync-rename-probe'
import { createGitSyncScanner } from '../../src/main/git-vault-sync'
import { testRequiring } from '../helpers/built-output'

const verdict = await measureSyncGitRenames()
// Git can report success while silently moving an edit onto the other side's rename.
// Keep behavioural suites on Git that honours the merge option. The refusal has separate coverage.
export const unsafeSyncGit = verdict.honoured ? undefined : renameStopMessage(verdict.version)
const scanner = unsafeSyncGit ? undefined : await createGitSyncScanner()([])
const missingSyncScanner = scanner && 'unavailable' in scanner
  ? 'gitleaks is absent from the Git sync scanner locations (/opt/homebrew/bin or /usr/local/bin)'
  : undefined
export const missingSyncPrerequisite = unsafeSyncGit ?? missingSyncScanner
export const testWithSafeSyncGit = testRequiring(unsafeSyncGit)
export const testWithSafeSyncGitAndGitleaks = testRequiring(missingSyncPrerequisite)
