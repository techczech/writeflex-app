import { expect, test } from 'bun:test'

const preloadProbe = String.raw`
  import { mock } from 'bun:test'

  let exposed
  let response
  void mock.module('electron', () => ({
    clipboard: { readText: () => '' }, webUtils: { getPathForFile: () => '' },
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } },
    ipcRenderer: {
      invoke: async (channel) => (
        channel === 'file:rename-repair-paths' || channel === 'file:rename' ? response : null
      ),
      on: () => {},
      removeListener: () => {},
    },
  }))
  void mock.module('@bridle/electron/preload', () => ({ createAuthTransport: () => ({}) }))
  await import('./src/preload/index.ts')

  response = { newPath: 'report/2026-08-10.md', repairPaths: ['report/ref.md'] }
  const valid = await exposed.planFileRename('report/old.md', '2026/08/10.md')
  const invalid = []
  for (const value of [
    { newPath: 'report/new.md', repairPaths: 'report/ref.md' },
    { newPath: 'report/new.md', repairPaths: ['../outside.md'] },
    { newPath: '/absolute.md', repairPaths: [] },
  ]) {
    response = value
    try {
      await exposed.planFileRename('report/old.md', 'new.md')
      invalid.push('accepted')
    } catch (error) {
      invalid.push(error instanceof Error ? error.message : String(error))
    }
  }

  response = {
    file: { path: 'report/new.md', name: 'new.md', directory: 'report', modifiedAt: 1, size: 6 },
    content: 'Body.\\n',
    ignoredAtRoot: true,
    repair: {
      writtenPaths: [],
      unrepairedReferences: ['report/ref.md: [[old]]'],
      ignoredInRepair: true,
      issues: [
        { kind: 'reference', text: 'report/ref.md: [[old]]' },
        { kind: 'file', text: 'report/ref.md' },
        { kind: 'reason', text: 'Reference repair failed. No partial repair was left behind.' },
        { kind: 'outcome', text: 'report/_report-structure.json: part.md was removed because archive/part.md left the report folder.' },
        { kind: 'preserved', text: 'report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.' },
        { kind: 'available', text: 'report/_report_INDEX.md: [[new]] can join the plan.' },
      ],
    },
  }
  const validResult = await exposed.renameFile('report/old.md', 'report/new.md')
  const malformedResults = []
  for (const value of [
    { file: { path: '../outside.md', name: 'outside.md', directory: '..', modifiedAt: 1, size: 6 }, content: 'Body.\\n', repair: { writtenPaths: [], unrepairedReferences: [], issues: [] } },
    { file: { path: 'report/new.md', name: 'new.md', directory: 'report', modifiedAt: 1, size: 6 }, content: 42, repair: { writtenPaths: [], unrepairedReferences: [], issues: [] } },
    { file: { path: 'report/new.md', name: 'other.md', directory: 'elsewhere', modifiedAt: 1, size: 6 }, content: 'Body.\\n', repair: { writtenPaths: [], unrepairedReferences: [], issues: [] } },
  ]) {
    response = value
    try {
      await exposed.renameFile('report/old.md', 'report/new.md')
      malformedResults.push('accepted')
    } catch (error) {
      malformedResults.push(error instanceof Error ? error.message : String(error))
    }
  }
  const malformedIssues = []
  for (const issues of [
    'not-an-array',
    [{ kind: 'warning', text: 'wrong kind' }],
    [{ kind: 'reason', text: 42 }],
  ]) {
    response = {
      file: { path: 'report/new.md', name: 'new.md', directory: 'report', modifiedAt: 1, size: 6 },
      content: 'Body.\\n',
      repair: { writtenPaths: [], unrepairedReferences: [], issues },
    }
    try {
      await exposed.renameFile('report/old.md', 'report/new.md')
      malformedIssues.push('accepted')
    } catch (error) {
      malformedIssues.push(error instanceof Error ? error.message : String(error))
    }
  }
  console.log(JSON.stringify({ valid, invalid, validResult, malformedResults, malformedIssues }))
`

test('preload accepts only a prepared workspace-relative target and workspace-relative repair-path list', async () => {
  const child = Bun.spawn([process.execPath, '-e', preloadProbe], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`The preload boundary probe failed: ${stderr}`)
  const result = JSON.parse(stdout)
  expect(result.valid).toEqual({ newPath: 'report/2026-08-10.md', repairPaths: ['report/ref.md'] })
  expect(result.invalid).toEqual([
    'Invalid file rename plan received from the main process.',
    'Invalid file rename plan received from the main process.',
    'Invalid file rename plan received from the main process.',
  ])
  expect(result.validResult.repair.issues).toEqual([
    { kind: 'reference', text: 'report/ref.md: [[old]]' },
    { kind: 'file', text: 'report/ref.md' },
    { kind: 'reason', text: 'Reference repair failed. No partial repair was left behind.' },
    // A move out of a report reports its preserved plan lines and completed outcomes; the bridge must
    // carry every kind main can send (2026-09-27: 'preserved' was refused after the move had landed).
    { kind: 'outcome', text: 'report/_report-structure.json: part.md was removed because archive/part.md left the report folder.' },
    { kind: 'preserved', text: 'report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.' },
    { kind: 'available', text: 'report/_report_INDEX.md: [[new]] can join the plan.' },
  ])
  expect(result.validResult).not.toHaveProperty('ignoredAtRoot')
  expect(result.validResult.repair).not.toHaveProperty('ignoredInRepair')
  expect(result.malformedResults).toEqual([
    'Invalid file rename result received from the main process.',
    'Invalid file rename result received from the main process.',
    'Invalid file rename result received from the main process.',
  ])
  expect(result.malformedIssues).toEqual([
    'Invalid file rename result received from the main process.',
    'Invalid file rename result received from the main process.',
    'Invalid file rename result received from the main process.',
  ])
})
