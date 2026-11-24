import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace, type FileReadResult } from '../../src/main/workspace'
import { planRenameRepair } from '../../src/main/rename-repair'
import { listAgentObjectNotes, listAgentProseNotes } from '../../src/main/agent-notes'

// The reference retains the old all-at-once read step, then serves those exact
// read results to the unchanged planner/readers, including their file metadata.
class CountedWorkspace extends Workspace {
  inFlight = 0
  maximum = 0
  reference = false
  private cached = new Map<string, FileReadResult>()

  override async readFile(path: string): Promise<FileReadResult> {
    const cached = this.cached.get(path)
    if (cached) return cached
    this.maximum = Math.max(this.maximum, ++this.inFlight)
    try { return await super.readFile(path) }
    finally { this.inFlight-- }
  }

  override async listFiles() {
    const files = await super.listFiles()
    if (this.reference && !this.cached.size) {
      const results = await Promise.all(files.map(async (file) => ({
        path: file.path, result: await this.readFile(file.path),
      })))
      this.cached = new Map(results.map(({ path, result }) => [path, result]))
    }
    return files
  }
}

test('rename and agent-note readers bound real vault reads without changing results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-bounded-reads-'))
  try {
    await mkdir(join(root, 'agent-notes'))
    // Exactly 2,000 Markdown files, including the rename target.
    await writeFile(join(root, 'target.md'), '# Original heading\n')
    for (let index = 0; index < 1999; index++) {
      const content = index % 2
        ? '---\nauthor: agent\nsource_document: target.md\nagent_note_kind: review\ncreated: 2026-11-24\n---\n# Review\n\n[[target]]\n'
        : '---\nagent_note_status: accepted\nsource_document: target.md\nobject_kind: mermaid\nrecorded_at: 2026-11-24T00:00:00Z\n---\n# Diagram\n\n## Object source\n\n````markdown\n```mermaid\ngraph TD; A-->B\n```\n````\n\n## Settlement history\n\n- accepted — 2026-11-24T00:00:00Z\n\n[[target]]\n'
      await writeFile(index === 1998 ? join(root, 'reference.md') : join(root, 'agent-notes', `note-${String(index).padStart(4, '0')}.md`), index === 1998 ? '[[target]]\n' : content)
    }
    const operations = [
      (ws: Workspace) => planRenameRepair(ws, 'target.md', 'renamed.md'),
      (ws: Workspace) => listAgentObjectNotes(ws),
      (ws: Workspace) => listAgentProseNotes(ws),
    ]
    for (const [index, operation] of operations.entries()) {
      const reference = new CountedWorkspace(root)
      reference.reference = true
      const expected = await operation(reference)
      const bounded = new CountedWorkspace(root)
      const actual = await operation(bounded)
      console.log(`reader ${index}: all-at-once maximum=${reference.maximum}; actual maximum=${bounded.maximum}`)
      expect(reference.maximum).toBe(2000)
      expect(bounded.maximum).toBeLessThanOrEqual(16)
      expect(actual).toEqual(expected)
      if (Array.isArray(actual)) expect(actual.length).toBeGreaterThan(0)
      else expect(actual.writes.length).toBeGreaterThan(0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
