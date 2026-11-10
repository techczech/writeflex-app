/**
 * The trusted projections the WriteFlex helper entry is built with (writeflex-helper.ts): by name, as
 * vault-sync's `HelperExtensions.projections`. The vault's ordinary scope decides which documents' named
 * versions are in scope, the same test capture applies to the documents themselves.
 */
import { HISTORY_APPROVAL_ENV } from './history-approvals'
import { ordinaryScopeTest, type ProjectionFactory } from '@app-patterns/vault-sync/helper/host'
import { WRITEFLEX_HISTORY_NAME, writeflexHistoryProjection } from './history-projection'
import { insertedFileScopeTest } from './inserted-scope'

export const WRITEFLEX_PROJECTIONS: Readonly<Record<string, ProjectionFactory>> = Object.freeze({
  [WRITEFLEX_HISTORY_NAME]: (vault) => writeflexHistoryProjection(ordinaryScopeTest(vault.scope), undefined, process.env[HISTORY_APPROVAL_ENV], insertedFileScopeTest(vault.scope)),
})
