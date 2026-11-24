/** Synthetic backup tool records for the record reader's tests (shapes: config.toml, catalogue-local.json schema 3,
 *  sync-status.json schema 1). No real machine, folder or account. */
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const NOW = Date.now()
export const s = (ms: number) => Math.floor(ms / 1000)
export const ID = 'repo-' + 'a'.repeat(64)
export const HEAD = 'b'.repeat(40), TREE = 'c'.repeat(40)

export type Over = { catalogue?: (c: any) => void; status?: (s: any) => void; entry?: (e: any) => void; noStatus?: boolean; noConfig?: boolean; setup?: (h: { home: string; folder: string }) => Promise<void> }
/** A synthetic home folder with a backup tool's records in `<home>/<dir>` and `<home>/.local/state/<dir without the dot>`. */
export async function home(over: Over = {}, dir = '.examplesync'): Promise<{ home: string; folder: string; records: string }> {
  const name = dir.replace(/^\./, '')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-records-')))
  const folder = join(home, 'repos', '02_writing-creation', 'book')
  await mkdir(join(folder, 'chapters'), { recursive: true })
  await mkdir(join(folder, '.git'), { recursive: true }); await writeFile(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await mkdir(join(home, dir), { recursive: true })
  await mkdir(join(home, '.local', 'state', name), { recursive: true })
  if (!over.noConfig) await writeFile(join(home, dir, 'config.toml'), 'repos_dir = "~/repos"\nmachine_id = "air"\n\n[other]\nmachine_id = "not-this"\n')
  const catalogue: any = { accepted: { schema: 3, revision: 32,
    machines: { air: { name: 'Desk Mac' }, 'macbook-pro': { name: 'MacBook Pro' } },
    buckets: { 'bucket-02': { path: '02_writing-creation', default_mode: 'automatic_documents', default_selected_machines: ['macbook-pro', 'air'] } },
    repositories: { [ID]: { id: ID, remote: 'https://example.invalid/x/book.git', branch: 'main', path: '02_writing-creation/book', bucket: 'bucket-02', mode: null, selections: {}, unmanaged: false } },
    unbucketed_default_selected_machines: ['macbook-pro', 'air'] }, pending: null }
  over.catalogue?.(catalogue)
  await writeFile(join(home, dir, 'catalogue-local.json'), JSON.stringify(catalogue))
  const observed = s(NOW - 60_000)
  const entry: any = { relative_path: '02_writing-creation/book', managed_branch: 'main', branch: 'main', mode: 'automatic_document', head: HEAD, tree: TREE, clean: true, dirty_count: 0,
    last_successful_remote_check: { head: HEAD, evidence: { sequence: 9, observed_at: observed } },
    last_publish: { head: HEAD, tree: TREE, evidence: { sequence: 4, observed_at: observed } },
    last_agreement: { head: HEAD, tree: TREE, remote_head: HEAD, evidence: { sequence: 9, observed_at: observed } },
    eligible_current: true, outcome_stage: 'verify', application_result: 'complete', blocker: null, retry: null, pending_remote_failure: null, conflict_paths: [] }
  over.entry?.(entry)
  const status: any = { schema: 1, machine_id: 'air', generated_at: observed, last_resident_cycle_at: observed, scheduler: 'running', git: { healthy: true },
    accepted_config_revision: 32, capabilities: ['sync-proof-v1', 'catalogue-v3'], repositories: { [ID]: entry }, folder_readiness: { [ID]: { state: 'ready' } } }
  over.status?.(status)
  if (!over.noStatus) await writeFile(join(home, '.local', 'state', name, 'sync-status.json'), JSON.stringify(status))
  await over.setup?.({ home, folder })
  return { home, folder, records: join(home, dir) }
}
