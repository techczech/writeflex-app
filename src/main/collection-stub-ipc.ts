import type { StubInput } from './wikilinks'

export type CollectionStubIpcInput = StubInput & { windowId?: number }

export function validateCollectionStubIpcInput(input: CollectionStubIpcInput): void {
  if (typeof input?.title !== 'string' || typeof input?.gist !== 'string') throw new Error('Invalid Collection Stub input.')
  if (input.path !== undefined && typeof input.path !== 'string') throw new Error('Invalid Collection Stub path.')
  if (input.role !== undefined && typeof input.role !== 'string') throw new Error('Invalid Collection Stub role.')
  if (input.bodyLead !== undefined && typeof input.bodyLead !== 'string') throw new Error('Invalid Collection Stub body lead.')
  if (input.titleInFrontmatter !== undefined && typeof input.titleInFrontmatter !== 'boolean') throw new Error('Invalid Collection Stub title flag.')
  if (input.suppressBacklink !== undefined && typeof input.suppressBacklink !== 'boolean') throw new Error('Invalid Collection Stub backlink flag.')
}
