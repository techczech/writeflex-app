import { app } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { SidecarStore, OutboxEntry, ReadingRoomDocument } from '@readflex/sidecar'
import { createNodeSqliteDriver } from '@readflex/sqlite-driver/node'
import { buildShelfIndex, readCollections, type ShelfIndex, type ShelfIndexOptions, type ShelfItem } from '@readflex/zotero-bridge'
import { discoverZoteroDataDirectory } from '@readflex/zotero-paths'
import type { ShelfCollectionData } from '../shared/shelf-collections'
import { readLibrarySegments, type LibrarySegments } from './zotero-links'
import { type annotationPayload, type CitationSelectionAnnotation, type SavedAnnotation } from './zotero-annotation-writes'
import type { ZoteroLibraryAccess } from './zotero-library-access'

export const DEFAULT_ROOM_WIDTH = 448
export const MIN_ROOM_WIDTH = 280

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export const OUTBOX_STATUSES = ['pending', 'retrying', 'confirmed', 'failed', 'conflict'] as const

export function allOutboxEntries(store: SidecarStore): OutboxEntry[] {
  return OUTBOX_STATUSES
    .flatMap((status) => store.outboxByStatus(status))
    .sort((left, right) => left.id - right.id)
}

export type ReadingRoomOutboxCounts = {
  waiting: number
  rejected: number
}

/** Sync signals only. The painted union continues to read `outboxUnconfirmed` independently. */
export function zoteroOutboxCounts(store: SidecarStore): ReadingRoomOutboxCounts {
  return {
    waiting: store.countOutboxWaiting(),
    rejected: store.countOutboxRejected(),
  }
}

export function citationSelection(value: unknown): CitationSelectionAnnotation | null {
  if (
    !isRecord(value)
    || value.type !== 'highlight'
    || typeof value.position !== 'string'
    || typeof value.sortIndex !== 'string'
    || !value.sortIndex
  ) {
    return null
  }
  return {
    color: typeof value.color === 'string' ? value.color : null,
    pageLabel: typeof value.pageLabel === 'string' ? value.pageLabel : null,
    position: value.position,
    sortIndex: value.sortIndex,
    text: typeof value.text === 'string' ? value.text : null,
    type: 'highlight',
  }
}

export function annotationFromOutbox(entry: OutboxEntry): SavedAnnotation | null {
  if (!entry.itemKey) return null
  try {
    const payload = JSON.parse(entry.payload) as ReturnType<typeof annotationPayload>
    if (
      payload.annotationType !== 'highlight'
      || typeof payload.annotationSortIndex !== 'string'
      || !payload.annotationSortIndex
    ) {
      return null
    }
    return {
      color: payload.annotationColor || null,
      comment: payload.annotationComment || null,
      key: entry.itemKey,
      pageLabel: payload.annotationPageLabel || null,
      position: JSON.stringify(payload.annotationPosition),
      sortIndex: payload.annotationSortIndex,
      tags: (payload.tags ?? [])
        .map((tag) => tag.tag)
        .filter((tag): tag is string => typeof tag === 'string'),
      text: payload.annotationText || null,
      type: 'highlight',
    }
  } catch {
    return null
  }
}

/**
 * There is no maximum (ADR-0033). A cap here would overrule the person about their own screen, and
 * the only real constraint — the draft staying usable — is a fact about the live window, which the
 * main process cannot see. The renderer clamps the stored width down to what the current window can
 * honour when it reads it, so a width dragged wide on a large display degrades on a laptop.
 */
export function clampRoomWidth(width: number): number {
  return Math.max(MIN_ROOM_WIDTH, Math.round(width))
}

export function readerBundleDirectory(entryFile: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'readflex-reader')
    : join(dirname(entryFile), '..', '..', 'node_modules', '@readflex', 'reader-embed', 'vendor')
}


export function e2eDocument(): ReadingRoomDocument | null {
  if (process.env.WRITEFLEX_E2E !== '1') return null
  const path = process.env.WRITEFLEX_E2E_READING_DOCUMENT?.trim()
  if (!path || !existsSync(path)) return null
  const extension = extname(path).toLocaleLowerCase('en')
  return {
    attachmentKey: 'WRITEFLEXE2E',
    authorYear: 'Lakoff · 1987',
    itemKey: 'WRITEFLEXE2E',
    kind: extension === '.pdf' ? 'pdf' : 'snapshot',
    libraryId: 0,
    path,
    shortTitle: 'Women, Fire…',
  }
}

/**
 * A fixture library for the Shelf's own e2e coverage. It replaces the SOURCE the Shelf indexes, never
 * the path a person takes to open a document — the Shelf is reached, searched and opened through the
 * same IPC either way, which is the blindfold ADR-0025 names.
 */
export function shelfIndexOptions(): ShelfIndexOptions {
  if (process.env.WRITEFLEX_E2E !== '1') return {}
  const directory = process.env.WRITEFLEX_E2E_ZOTERO_DIRECTORY?.trim()
  if (!directory) return {}
  return {
    betterBibtexDatabasePath: join(directory, 'better-bibtex.sqlite'),
    linkedAttachmentBaseDirectory: join(directory, 'linked'),
    storageDirectory: join(directory, 'storage'),
    zoteroDatabasePath: join(directory, 'zotero.sqlite'),
  }
}

/** Where `zotero.sqlite` is: the e2e fixture when one is set, otherwise Zotero's own preference
 *  (never a hardcoded ~/Zotero guess — ADR-0012 §2). */
export function zoteroDatabasePath(): string {
  const override = shelfIndexOptions().zoteroDatabasePath
  return override ?? join(discoverZoteroDataDirectory().path, 'zotero.sqlite')
}

/** Zotero's data directory, where the WriteFlex plugin leaves `writeflex/bridge.json`. Null when it
 *  cannot be worked out; the plugin is then reached on Zotero's default port without a key. */
export function zoteroDataDirectory(): string | null {
  try {
    return dirname(zoteroDatabasePath())
  } catch {
    return null
  }
}

/**
 * The WriteFlex plugin file shipped with the app (`extraResources`), for him to install in Zotero.
 * In development it is the one `bun run build:zotero-plugin` left in `zotero-plugin/dist`.
 */
export function bundledZoteroPluginFile(): string | null {
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'zotero-plugin')
    : join(app.getAppPath(), 'zotero-plugin', 'dist')
  try {
    const file = readdirSync(directory).filter((name) => /^writeflex-zotero-.+\.xpi$/.test(name)).sort().at(-1)
    return file ? join(directory, file) : null
  } catch {
    return null
  }
}

/** Collections for the Shelf, read-only from the same database file as the index. A library without
 *  collection tables, or one that cannot be read for them, simply has none: the Shelf still works. */
export function readShelfCollections(databasePath: string): ShelfCollectionData {
  try {
    return readCollections(createNodeSqliteDriver(), databasePath)
  } catch {
    return { collections: [], itemCollections: {} }
  }
}

export type ShelfState = {
  index: ShelfIndex | null
  /** libraryId → the `zotero://` URL segment, so a group item's link is not silently wrong. */
  librarySegments: LibrarySegments
  items: ShelfItem[]
  byKey: Map<string, ShelfItem>
  /** Zotero's collections and their members, read with the index and refreshed with it. */
  collections: ShelfCollectionData
  error: string | null
  /** `zotero.sqlite`'s modification time when this index was built; the staleness signal. */
  builtFrom: number | null
}

/** The `zotero.sqlite` mtime, or null when it cannot be read. Never opens the file. */
export function libraryModifiedAt(databasePath: string | undefined): number | null {
  try {
    return databasePath ? statSync(databasePath).mtimeMs : null
  } catch {
    return null
  }
}

/**
 * The in-memory Shelf index. Built once, on the first
 * Shelf request rather than at startup, so a launch that never opens the Room pays nothing and a
 * machine with no Zotero degrades to a message instead of a failed boot (ADR-0010).
 *
 * `refresh` rebuilds it when Zotero's database has changed on disk since the build — called only for
 * an empty query, which is the state the Shelf is raised in, so a session that adds a paper in Zotero
 * finds it without relaunching and no keystroke ever pays for a rebuild.
 */
export function createShelfLoader(
  access: ZoteroLibraryAccess,
): { load: () => Promise<ShelfState>; refresh: () => void } {
  let pending: Promise<ShelfState> | null = null
  let current: ShelfState | null = null
  const load = (): Promise<ShelfState> => {
    pending ??= (async () => {
      // Off the current tick, so the handler's reply path is not the thing holding the build.
      await new Promise((resolve) => setImmediate(resolve))
      const options = shelfIndexOptions()
      try {
        // The Shelf build and the library-segment read are one read of `zotero.sqlite`, through the gate.
        current = await access.read(() => {
          const index = buildShelfIndex(createNodeSqliteDriver(), options)
          const items = index.list()
          const databasePath = options.zoteroDatabasePath
            ?? join(index.zoteroDataDirectory.path, 'zotero.sqlite')
          const librarySegments = readLibrarySegments(createNodeSqliteDriver(), databasePath)
          const collections = readShelfCollections(databasePath)
          return {
            builtFrom: libraryModifiedAt(databasePath),
            byKey: new Map(items.map((item) => [`${item.libraryId}:${item.itemKey}`, item])),
            collections,
            error: null,
            index,
            items,
            librarySegments,
          } satisfies ShelfState
        })
      } catch (error) {
        current = {
          builtFrom: null,
          byKey: new Map<string, ShelfItem>(),
          collections: { collections: [], itemCollections: {} },
          librarySegments: new Map(),
          error: `The Shelf could not read your Zotero library. ${
            error instanceof Error ? error.message : String(error)
          }`,
          index: null,
          items: [],
        }
      }
      return current
    })()
    return pending
  }
  return {
    load,
    refresh() {
      if (!current?.index || current.builtFrom === null) return
      const path = shelfIndexOptions().zoteroDatabasePath
        ?? join(current.index.zoteroDataDirectory.path, 'zotero.sqlite')
      const modifiedAt = libraryModifiedAt(path)
      if (modifiedAt !== null && modifiedAt !== current.builtFrom) {
        current = null
        pending = null
      }
    },
  }
}

