/**
 * What WriteFlex backs up in an enrolled vault as ordinary files: authored documents and the vault's
 * settings file. The history files are never ordinary files: only the projection sends them, as a whole.
 * Kept here, free of the backup service, so the Folio version save can ask the same question a backup
 * asks (`ordinaryScopeTest(WRITEFLEX_SCOPE)`) before it writes anything.
 */
export const WRITEFLEX_SCOPE = {
  include: ['**/*.md', '**/*.markdown', '.writeflex/vault.json'],
  // Owner locks left by WriteFlex before the lock was removed (2026-11-03), the agent inbox/outbox, rescue copies, history records and agent-private material are never sent.
  exclude: ['.writeflex/inbox', '.writeflex/outbox', '.writeflex/rescue', '.writeflex/owner.lock', '.writeflex/versions.jsonl', '.writeflex/changes.jsonl', '.bridle', 'node_modules', '.trash', '**/.venv/**', '**/.cache/**'],
}
