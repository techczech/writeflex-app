import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SqliteDatabase,
  SqliteDriver,
} from "@readflex/sqlite-driver";
import {
  assertNotInZoteroDataDirectory,
  type ZoteroWriteGuardReport,
} from "@readflex/zotero-paths";
import {
  createShelfWorkspaceTables,
  ShelfWorkspaceStore,
  type ActivityEntry,
  type NewActivityEntry,
  type NewPlanToReadEntry,
  type NewRecentSearch,
  type PlanToReadEntry,
  type RecentSearch,
  type RecentlyReadDocument,
  type SidecarDocumentId,
} from "./shelf-workspace.js";

export type {
  ActivityEntry,
  ActivityPayload,
  ActivityPayloadValue,
  ActivityType,
  NewActivityEntry,
  NewPlanToReadEntry,
  NewRecentSearch,
  PlanToReadEntry,
  PlanToReadProvenance,
  RecentSearch,
  RecentlyReadDocument,
  SearchFilters,
  SearchFilterValue,
  SidecarDocumentId,
} from "./shelf-workspace.js";

const SIDECAR_SCHEMA_VERSION = 8;
const LEGACY_LOCAL_ONLY_POSITION_REASON =
  "Marks on web pages and EPUBs stay here for now — sending them to Zotero isn't built yet";

export interface SidecarStoreOptions {
  zoteroDataDirectory?: string;
}

export interface Bookmark {
  id: number;
  libraryId: number;
  itemKey: string;
  position: string;
  label: string | null;
  createdAt: string;
}

export interface NewBookmark {
  libraryId: number;
  itemKey: string;
  position: string;
  label?: string | null;
  createdAt?: string;
}

export interface ReadingPosition {
  libraryId: number;
  itemKey: string;
  position: string;
}

export interface FigureNote {
  id: number;
  libraryId: number;
  itemKey: string;
  assetId: string;
  kind: "figure" | "table";
  label: string;
  caption: string;
  page: number | null;
  dataUrl: string;
  createdAt: string;
}

export type NewFigureNote = Omit<FigureNote, "id" | "createdAt"> & {
  createdAt?: string;
};

export interface ReadingRoomDocument {
  attachmentKey: string;
  authorYear: string;
  itemKey: string;
  kind: "pdf" | "snapshot";
  libraryId: number;
  path: string;
  shortTitle: string;
}

export interface StandaloneDocumentTab extends ReadingRoomDocument {
  active: boolean;
  position: number;
}

/**
 * The outbox — the durability boundary for annotation writes (ADR-0002). A highlight is safe once it is
 * HERE, not once it reaches the network: `resolve` is called on a durable local write, so an offline save
 * is never lost and the reader is never stalled waiting for `api.zotero.org` (ADR-0014, consequence 1).
 */
export type OutboxOperation = "create" | "update" | "delete";
export type OutboxStatus =
  | "pending"
  | "retrying"
  | "failed"
  | "conflict"
  | "confirmed";

export interface NewOutboxEntry {
  libraryId: number;
  /**
   * The annotation's key. Set from the moment it is queued, including on a create, because the painted
   * union of Zotero-plus-outbox is deduplicated by this key (ADR-0029) — a queued mark without one
   * cannot be matched against the same mark after it syncs, and would paint twice. On confirmation the
   * server's assigned key replaces it.
   */
  itemKey: string | null;
  /** The attachment the annotation belongs to — the API's `parentItem`. */
  parentItemKey: string;
  operation: OutboxOperation;
  /** The verified API payload, JSON-encoded. Stored whole so a retry needs no re-derivation. */
  payload: string;
}

export interface OutboxEntry extends NewOutboxEntry {
  id: number;
  status: OutboxStatus;
  attemptCount: number;
  /** Stored classification: this mark is painted locally but is not work Zotero can accept. */
  localOnly: 0 | 1;
  /** Human-readable reason a write was rejected. Never raw API error text in the UI. */
  lastError: string | null;
  /** On an edit conflict, the version that LOST — kept, never dropped (ADR-0002 failure handling). */
  conflictPayload: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OutboxRow {
  id: number;
  libraryId: number;
  itemKey: string | null;
  parentItemKey: string;
  operation: OutboxOperation;
  payload: string;
  status: OutboxStatus;
  attemptCount: number;
  localOnly: 0 | 1;
  lastError: string | null;
  conflictPayload: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One entry in the global history of papers opened (ADR-0032, decision 3). It records **keys, not the
 * file path** — so the entry still resolves after the paper is reindexed, renamed in Zotero or moved
 * on disk, which a stored path would not survive. `authorYear` and `shortTitle` are a display cache,
 * refreshed every time the paper is opened, so the list can be drawn before the Shelf index exists.
 */
export interface RecentDocument {
  attachmentKey: string;
  authorYear: string;
  itemKey: string;
  libraryId: number;
  /** ISO-8601, newest first. */
  openedAt: string;
  shortTitle: string;
}

export interface ReadingRoomLayout {
  roomWidth: number;
  side: "left" | "right";
  lastRoomView: "document" | "highlights";
}

export type ShellLeftPanel = "contents" | "bookmarks" | "highlights" | "open-documents";
export type ShellRightPanel = "companion" | "gallery" | "notes";

export interface ShellLayout {
  leftCollapsed: boolean;
  leftPanel: ShellLeftPanel;
  leftWidth: number;
  rightOpen: boolean;
  rightPanel: ShellRightPanel;
  rightWidth: number;
}

export interface PdfOutlineEntry {
  level: number;
  pageIndex: number;
  pageLabel: string;
  title: string;
}

export interface PdfOutlineResult {
  entries: PdfOutlineEntry[];
  state: "available" | "failed" | "unavailable";
}

export interface CachedPdfOutline extends PdfOutlineResult {
  attachmentKey: string;
  fileMtimeMs: number;
  fileSize: number;
  libraryId: number;
}

interface BookmarkRow {
  id: number;
  libraryId: number;
  itemKey: string;
  position: string;
  label: string | null;
  createdAt: string;
}

interface PositionRow {
  libraryId: number;
  itemKey: string;
  position: string;
}

interface LayoutRow {
  roomWidth: number;
  side: "left" | "right";
  lastRoomView: "document" | "highlights";
}

interface ShellLayoutRow {
  leftCollapsed: number;
  leftPanel: ShellLeftPanel;
  leftWidth: number;
  rightOpen: number;
  rightPanel: ShellRightPanel;
  rightWidth: number;
}

interface LastDocumentRow {
  attachmentKey: string;
  authorYear: string;
  itemKey: string;
  kind: "pdf" | "snapshot";
  libraryId: number;
  path: string;
  shortTitle: string;
}

interface RecentDocumentRow {
  attachmentKey: string;
  authorYear: string;
  itemKey: string;
  libraryId: number;
  openedAt: string;
  shortTitle: string;
}

interface StandaloneDocumentTabRow extends ReadingRoomDocument {
  active: number;
  position: number;
}

function createSchemaTables(database: SqliteDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS figure_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('figure', 'table')),
      label TEXT NOT NULL,
      caption TEXT NOT NULL,
      page INTEGER,
      data_url TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS figure_notes_by_document
    ON figure_notes (library_id, item_key, created_at)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      position TEXT NOT NULL,
      label TEXT,
      created TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS bookmarks_by_item_key
    ON bookmarks (library_id, item_key, created)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS positions (
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      position TEXT NOT NULL,
      PRIMARY KEY (library_id, item_key)
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS layout (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_width REAL NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('left', 'right')),
      last_room_view TEXT NOT NULL
        CHECK (last_room_view IN ('document', 'highlights')),
      left_panel TEXT NOT NULL DEFAULT 'contents',
      left_collapsed INTEGER NOT NULL DEFAULT 0,
      left_width REAL NOT NULL DEFAULT 234,
      right_panel TEXT NOT NULL DEFAULT 'companion',
      right_open INTEGER NOT NULL DEFAULT 0,
      right_width REAL NOT NULL DEFAULT 262
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS pdf_outlines (
      library_id INTEGER NOT NULL,
      attachment_key TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_mtime_ms REAL NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('available', 'unavailable', 'failed')),
      entries_json TEXT NOT NULL,
      PRIMARY KEY (library_id, attachment_key)
    )
  `);
  // Which paper is open is scoped PER DRAFT (ADR-0032, decision 1): the key is the absolute path of
  // the Markdown file the Room was opened beside. A draft with no row here opens the Shelf, and a
  // draft whose file has moved simply has no row — it degrades to the Shelf, never to another
  // draft's paper (decision 2). The table kept its name; only its scope was wrong.
  database.run(`
    CREATE TABLE IF NOT EXISTS last_document (
      draft_path TEXT PRIMARY KEY,
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      attachment_key TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pdf', 'snapshot')),
      author_year TEXT NOT NULL,
      short_title TEXT NOT NULL
    )
  `);
  // Recently opened papers are GLOBAL and persistent (ADR-0032, decision 3) — a property of the
  // library and of the reader, not of any draft. Keyed by the attachment actually opened, because a
  // chaptered book's twelfth PDF is a different reading from its first.
  database.run(`
    CREATE TABLE IF NOT EXISTS recent_documents (
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      attachment_key TEXT NOT NULL,
      author_year TEXT NOT NULL,
      short_title TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      PRIMARY KEY (library_id, item_key, attachment_key)
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS recent_documents_by_opened
    ON recent_documents (opened_at)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS external_documents (
      library_id INTEGER NOT NULL CHECK (library_id = 0),
      item_key TEXT NOT NULL,
      attachment_key TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind = 'pdf'),
      author_year TEXT NOT NULL,
      short_title TEXT NOT NULL,
      PRIMARY KEY (library_id, attachment_key)
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS standalone_tabs (
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      attachment_key TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pdf', 'snapshot')),
      author_year TEXT NOT NULL,
      short_title TEXT NOT NULL,
      tab_position INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
      PRIMARY KEY (library_id, attachment_key)
    )
  `);
  database.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS standalone_tabs_by_position
    ON standalone_tabs (tab_position)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      item_key TEXT,
      parent_item_key TEXT NOT NULL,
      operation TEXT NOT NULL
        CHECK (operation IN ('create', 'update', 'delete')),
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
          status IN (
            'pending', 'retrying', 'failed', 'conflict', 'confirmed'
          )
        ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      conflict_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      local_only INTEGER NOT NULL DEFAULT 0
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS outbox_by_status
    ON outbox (status, created_at)
  `);
  createShelfWorkspaceTables(database);
}

/**
 * Schema 2 → 3. `last_document` was a singleton (`id INTEGER PRIMARY KEY CHECK (id = 1)`), so its one
 * row means "the last paper opened anywhere" and carries **no draft to attribute it to**.
 *
 * The row is therefore **not migrated onto any draft** — inventing an owner is precisely the
 * degradation ADR-0032 decision 2 forbids, and it would survive as a wrong answer. It is instead
 * seeded into `recent_documents`, where "the last paper I had open" is a true statement, so nothing
 * he can see is lost: the paper is one keystroke away in Recents rather than wrongly reopened.
 *
 * Returns the seed rows; the caller writes them once the new tables exist.
 */
function migrateSingletonLastDocument(database: SqliteDatabase): RecentDocument[] {
  const columns = database.all("PRAGMA table_info(last_document)") as {
    name: string;
  }[];
  // A fresh database (no table yet) or one already keyed by draft needs nothing.
  if (
    columns.length === 0 ||
    columns.some((column) => column.name === "draft_path")
  ) {
    return [];
  }
  const rows = database.all(
    `SELECT
       library_id AS libraryId,
       item_key AS itemKey,
       attachment_key AS attachmentKey,
       author_year AS authorYear,
       short_title AS shortTitle
     FROM last_document`,
  ) as Omit<RecentDocument, "openedAt">[];
  database.run("DROP TABLE last_document");
  const openedAt = new Date().toISOString();
  return rows.map((row) => ({ ...row, openedAt }));
}

/**
 * Schema 3 → 4. The added column is append-only so every existing outbox row and identifier survives.
 * The old release encoded one local-only cause in `last_error`; that exact sentence is backfilled once
 * while the database still reports an older schema. Similar or later failure prose is not classified.
 */
function migrateOutboxLocalOnly(
  database: SqliteDatabase,
  installedVersion: number,
): void {
  const columns = database.all("PRAGMA table_info(outbox)") as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === "local_only")) {
    database.run(
      "ALTER TABLE outbox ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (installedVersion < 4) {
    database
      .prepare(
        `UPDATE outbox
         SET local_only = 1
         WHERE last_error = ?`,
      )
      .run(LEGACY_LOCAL_ONLY_POSITION_REASON);
  }
}

function migrateShellLayout(database: SqliteDatabase): void {
  const columns = new Set((database.all("PRAGMA table_info(layout)") as { name: string }[])
    .map((column) => column.name));
  const additions = [
    ["left_panel", "TEXT NOT NULL DEFAULT 'contents'"],
    ["left_collapsed", "INTEGER NOT NULL DEFAULT 0"],
    ["left_width", "REAL NOT NULL DEFAULT 234"],
    ["right_panel", "TEXT NOT NULL DEFAULT 'companion'"],
    ["right_open", "INTEGER NOT NULL DEFAULT 0"],
    ["right_width", "REAL NOT NULL DEFAULT 262"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.run(`ALTER TABLE layout ADD COLUMN ${name} ${definition}`);
  }
}

function initialiseSchema(database: SqliteDatabase): void {
  const { user_version: installedVersion } = database.get(
    "PRAGMA user_version",
  ) as { user_version: number };
  if (installedVersion > SIDECAR_SCHEMA_VERSION) {
    throw new Error(
      `Sidecar schema version ${installedVersion} is newer than supported version ${SIDECAR_SCHEMA_VERSION}`,
    );
  }

  // The migration runs BEFORE the creates: `CREATE TABLE IF NOT EXISTS` cannot rekey an existing
  // table, so the old singleton has to be read and dropped first.
  const seededRecents = migrateSingletonLastDocument(database);
  createSchemaTables(database);
  migrateOutboxLocalOnly(database, installedVersion);
  migrateShellLayout(database);
  for (const recent of seededRecents) {
    insertRecentDocument(database, recent);
  }
  if (installedVersion < SIDECAR_SCHEMA_VERSION) {
    database.run(`PRAGMA user_version = ${SIDECAR_SCHEMA_VERSION}`);
  }
}

function insertRecentDocument(
  database: SqliteDatabase,
  recent: RecentDocument,
): void {
  database
    .prepare(
      `INSERT INTO recent_documents (
         library_id, item_key, attachment_key, author_year, short_title, opened_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (library_id, item_key, attachment_key) DO UPDATE SET
         author_year = excluded.author_year,
         short_title = excluded.short_title,
         opened_at = excluded.opened_at`,
    )
    .run(
      recent.libraryId,
      recent.itemKey,
      recent.attachmentKey,
      recent.authorYear,
      recent.shortTitle,
      recent.openedAt,
    );
}

export class SidecarStore {
  readonly #database: SqliteDatabase;
  readonly #shelfWorkspace: ShelfWorkspaceStore;
  readonly zoteroWriteGuardReport?: ZoteroWriteGuardReport;

  constructor(
    databaseDriver: SqliteDriver,
    databasePath: string,
    options: SidecarStoreOptions = {},
  ) {
    if (databasePath !== ":memory:") {
      this.zoteroWriteGuardReport = assertNotInZoteroDataDirectory(
        databasePath,
        options,
      );
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = databaseDriver.open(databasePath, {
      create: true,
    });
    try {
      this.#database.run("PRAGMA journal_mode = WAL");
      initialiseSchema(this.#database);
      this.#shelfWorkspace = new ShelfWorkspaceStore(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  addToPlanToRead(entry: NewPlanToReadEntry): PlanToReadEntry {
    return this.#shelfWorkspace.addToPlanToRead(entry);
  }

  removeFromPlanToRead(id: SidecarDocumentId): void {
    this.#shelfWorkspace.removeFromPlanToRead(id);
  }

  listPlanToRead(limit = 100): PlanToReadEntry[] {
    return this.#shelfWorkspace.listPlanToRead(limit);
  }

  recordActivity(entry: NewActivityEntry): ActivityEntry {
    return this.#shelfWorkspace.recordActivity(entry);
  }

  listRecentActivity(limit = 100): ActivityEntry[] {
    return this.#shelfWorkspace.listRecentActivity(limit);
  }

  recordRecentSearch(search: NewRecentSearch): RecentSearch {
    return this.#shelfWorkspace.recordRecentSearch(search);
  }

  recordSearchResultOpened(id: number): RecentSearch {
    return this.#shelfWorkspace.recordSearchResultOpened(id);
  }

  listRecentSearches(limit = 100): RecentSearch[] {
    return this.#shelfWorkspace.listRecentSearches(limit);
  }

  listRecentlyRead(limit = 100): RecentlyReadDocument[] {
    return this.#shelfWorkspace.listRecentlyRead(limit);
  }

  saveFigureNote(note: NewFigureNote): FigureNote {
    const createdAt = note.createdAt ?? new Date().toISOString();
    const result = this.#database.prepare(
      `INSERT INTO figure_notes (
         library_id, item_key, asset_id, kind, label, caption, page, data_url, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      note.libraryId,
      note.itemKey,
      note.assetId,
      note.kind,
      note.label,
      note.caption,
      note.page,
      note.dataUrl,
      createdAt,
    );
    return { ...note, createdAt, id: Number(result.lastInsertRowid) };
  }

  listFigureNotes(libraryId: number, itemKey: string): FigureNote[] {
    return this.#database.prepare(
      `SELECT
         id,
         library_id AS libraryId,
         item_key AS itemKey,
         asset_id AS assetId,
         kind,
         label,
         caption,
         page,
         data_url AS dataUrl,
         created_at AS createdAt
       FROM figure_notes
       WHERE library_id = ? AND item_key = ?
       ORDER BY created_at, id`,
    ).all(libraryId, itemKey) as FigureNote[];
  }

  addBookmark(bookmark: NewBookmark): Bookmark {
    const createdAt = bookmark.createdAt ?? new Date().toISOString();
    const result = this.#database
      .prepare(
        `INSERT INTO bookmarks (
           library_id, item_key, position, label, created
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        bookmark.libraryId,
        bookmark.itemKey,
        bookmark.position,
        bookmark.label ?? null,
        createdAt,
      );

    return {
      createdAt,
      id: Number(result.lastInsertRowid),
      itemKey: bookmark.itemKey,
      label: bookmark.label ?? null,
      libraryId: bookmark.libraryId,
      position: bookmark.position,
    };
  }

  listBookmarks(libraryId: number, itemKey: string): Bookmark[] {
    return this.#database
      .prepare(
        `SELECT
           id,
           library_id AS libraryId,
           item_key AS itemKey,
           position,
           label,
           created AS createdAt
         FROM bookmarks
         WHERE library_id = ? AND item_key = ?
         ORDER BY created, id`,
      )
      .all(libraryId, itemKey) as BookmarkRow[];
  }

  savePosition(position: ReadingPosition): void {
    this.#database
      .prepare(
        `INSERT INTO positions (library_id, item_key, position)
         VALUES (?, ?, ?)
         ON CONFLICT (library_id, item_key)
         DO UPDATE SET position = excluded.position`,
      )
      .run(position.libraryId, position.itemKey, position.position);
  }

  getPosition(
    libraryId: number,
    itemKey: string,
  ): ReadingPosition | undefined {
    return this.#database
      .prepare(
        `SELECT
           library_id AS libraryId,
           item_key AS itemKey,
           position
         FROM positions
         WHERE library_id = ? AND item_key = ?`,
      )
      .get(libraryId, itemKey) as PositionRow | undefined;
  }

  /**
   * Remember the paper open beside one draft (ADR-0032, decision 1). `draftPath` is the absolute path
   * of the Markdown file; nothing here is global, so writing draft A's reading cannot change draft B's.
   */
  saveDraftDocument(draftPath: string, document: ReadingRoomDocument): void {
    this.#database
      .prepare(
        `INSERT INTO last_document (
           draft_path,
           library_id,
           item_key,
           attachment_key,
           path,
           kind,
           author_year,
           short_title
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (draft_path) DO UPDATE SET
           library_id = excluded.library_id,
           item_key = excluded.item_key,
           attachment_key = excluded.attachment_key,
           path = excluded.path,
           kind = excluded.kind,
           author_year = excluded.author_year,
           short_title = excluded.short_title`,
      )
      .run(
        draftPath,
        document.libraryId,
        document.itemKey,
        document.attachmentKey,
        document.path,
        document.kind,
        document.authorYear,
        document.shortTitle,
      );
  }

  /**
   * The paper remembered for one draft, or `undefined` — which is the Shelf. A draft whose file has
   * been moved or renamed simply has no row under its new path, so it opens the Shelf rather than
   * inheriting another draft's reading (ADR-0032, decision 2).
   */
  getDraftDocument(draftPath: string): ReadingRoomDocument | undefined {
    return (this.#database
      .prepare(
        `SELECT
           library_id AS libraryId,
           item_key AS itemKey,
           attachment_key AS attachmentKey,
           path,
           kind,
           author_year AS authorYear,
           short_title AS shortTitle
         FROM last_document
         WHERE draft_path = ?`,
      )
      // The driver answers a missing row with null; the seam above promises undefined, and callers
      // branch on it, so the two are reconciled here rather than at every call site.
      .get(draftPath) as LastDocumentRow | null) ?? undefined;
  }

  /** Stop remembering a paper for one draft. */
  forgetDraftDocument(draftPath: string): void {
    this.#database
      .prepare("DELETE FROM last_document WHERE draft_path = ?")
      .run(draftPath);
  }

  /**
   * Record a paper as opened, for the global recents history. Reopening the same attachment moves it
   * to the front and refreshes its label rather than adding a second entry.
   */
  recordRecentDocument(
    document: ReadingRoomDocument,
    openedAt = new Date().toISOString(),
  ): void {
    insertRecentDocument(this.#database, {
      attachmentKey: document.attachmentKey,
      authorYear: document.authorYear,
      itemKey: document.itemKey,
      libraryId: document.libraryId,
      openedAt,
      shortTitle: document.shortTitle,
    });
  }

  /** Recently opened papers, newest first. Stored unbounded; `limit` bounds what a surface draws. */
  listRecentDocuments(limit = 20): RecentDocument[] {
    return this.#database
      .prepare(
        `SELECT
           library_id AS libraryId,
           item_key AS itemKey,
           attachment_key AS attachmentKey,
           author_year AS authorYear,
           short_title AS shortTitle,
           opened_at AS openedAt
         FROM recent_documents
         ORDER BY opened_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as RecentDocumentRow[];
  }

  /** External PDFs are local ReadFlex documents, so their paths remain in the sidecar, never Zotero. */
  registerExternalDocument(document: ReadingRoomDocument): void {
    if (document.libraryId !== 0 || document.kind !== "pdf") {
      throw new Error("An external ReadFlex document must be a local PDF.");
    }
    this.#database
      .prepare(
        `INSERT INTO external_documents (
           library_id, item_key, attachment_key, path, kind, author_year, short_title
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (library_id, attachment_key) DO UPDATE SET
           item_key = excluded.item_key,
           path = excluded.path,
           author_year = excluded.author_year,
           short_title = excluded.short_title`,
      )
      .run(
        document.libraryId,
        document.itemKey,
        document.attachmentKey,
        document.path,
        document.kind,
        document.authorYear,
        document.shortTitle,
      );
  }

  listExternalDocuments(): ReadingRoomDocument[] {
    return this.#database
      .prepare(
        `SELECT
           library_id AS libraryId,
           item_key AS itemKey,
           attachment_key AS attachmentKey,
           path,
           kind,
           author_year AS authorYear,
           short_title AS shortTitle
         FROM external_documents
         ORDER BY rowid`,
      )
      .all() as ReadingRoomDocument[];
  }

  /** The standalone window's persistent document tabs, left to right. The Shelf is not a row. */
  listStandaloneTabs(): StandaloneDocumentTab[] {
    const rows = this.#database
      .prepare(
        `SELECT
           library_id AS libraryId,
           item_key AS itemKey,
           attachment_key AS attachmentKey,
           path,
           kind,
           author_year AS authorYear,
           short_title AS shortTitle,
           tab_position AS position,
           active
         FROM standalone_tabs
         ORDER BY tab_position`,
      )
      .all() as StandaloneDocumentTabRow[];
    return rows.map((row) => ({
      ...row,
      active: row.active === 1,
    }));
  }

  /** Open or refresh one tab and make it active without disturbing its existing position. */
  openStandaloneTab(document: ReadingRoomDocument): void {
    this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT tab_position AS position
           FROM standalone_tabs
           WHERE library_id = ? AND attachment_key = ?`,
        )
        .get(document.libraryId, document.attachmentKey) as
        | { position: number }
        | undefined;
      const position = existing?.position ?? Number(
        (this.#database
          .prepare(
            "SELECT COALESCE(MAX(tab_position), -1) + 1 AS position FROM standalone_tabs",
          )
          .get() as { position: number }).position,
      );
      this.#database.run("UPDATE standalone_tabs SET active = 0");
      this.#database
        .prepare(
          `INSERT INTO standalone_tabs (
             library_id, item_key, attachment_key, path, kind,
             author_year, short_title, tab_position, active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT (library_id, attachment_key) DO UPDATE SET
             item_key = excluded.item_key,
             path = excluded.path,
             kind = excluded.kind,
             author_year = excluded.author_year,
             short_title = excluded.short_title,
             active = 1`,
        )
        .run(
          document.libraryId,
          document.itemKey,
          document.attachmentKey,
          document.path,
          document.kind,
          document.authorYear,
          document.shortTitle,
          position,
        );
    })();
  }

  activateStandaloneTab(libraryId: number, attachmentKey: string): void {
    const tab = this.#database
      .prepare(
        `SELECT 1 AS present FROM standalone_tabs
         WHERE library_id = ? AND attachment_key = ?`,
      )
      .get(libraryId, attachmentKey);
    if (!tab) {
      throw new Error("The document tab is not open.");
    }
    this.#database.transaction(() => {
      this.#database.run("UPDATE standalone_tabs SET active = 0");
      this.#database
        .prepare(
          `UPDATE standalone_tabs SET active = 1
           WHERE library_id = ? AND attachment_key = ?`,
        )
        .run(libraryId, attachmentKey);
    })();
  }

  closeStandaloneTab(libraryId: number, attachmentKey: string): void {
    this.#database.transaction(() => {
      const removed = this.#database
        .prepare(
          `SELECT active, tab_position AS position
           FROM standalone_tabs
           WHERE library_id = ? AND attachment_key = ?`,
        )
        .get(libraryId, attachmentKey) as
        | { active: number; position: number }
        | undefined;
      if (!removed) {
        return;
      }
      this.#database
        .prepare(
          `DELETE FROM standalone_tabs
           WHERE library_id = ? AND attachment_key = ?`,
        )
        .run(libraryId, attachmentKey);
      this.#database
        .prepare(
          `UPDATE standalone_tabs
           SET tab_position = tab_position - 1
           WHERE tab_position > ?`,
        )
        .run(removed.position);
      if (removed.active === 1) {
        this.#database.run("UPDATE standalone_tabs SET active = 0");
        this.#database
          .prepare(
            `UPDATE standalone_tabs SET active = 1
             WHERE tab_position = (
               SELECT MIN(tab_position) FROM standalone_tabs
             )`,
          )
          .run();
      }
    })();
  }

  saveLayout(layout: ReadingRoomLayout): void {
    this.#database
      .prepare(
        `INSERT INTO layout (id, room_width, side, last_room_view)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           room_width = excluded.room_width,
           side = excluded.side,
           last_room_view = excluded.last_room_view`,
      )
      .run(layout.roomWidth, layout.side, layout.lastRoomView);
  }

  getLayout(): ReadingRoomLayout | undefined {
    return this.#database
      .prepare(
        `SELECT
           room_width AS roomWidth,
           side,
           last_room_view AS lastRoomView
         FROM layout
         WHERE id = 1`,
      )
      .get() as LayoutRow | undefined;
  }

  saveShellLayout(layout: ShellLayout): void {
    this.#database.prepare(
      `INSERT INTO layout (
         id, room_width, side, last_room_view, left_panel, left_collapsed,
         left_width, right_panel, right_open, right_width
       ) VALUES (1, 520, 'right', 'document', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         left_panel = excluded.left_panel,
         left_collapsed = excluded.left_collapsed,
         left_width = excluded.left_width,
         right_panel = excluded.right_panel,
         right_open = excluded.right_open,
         right_width = excluded.right_width`,
    ).run(
      layout.leftPanel,
      layout.leftCollapsed ? 1 : 0,
      layout.leftWidth,
      layout.rightPanel,
      layout.rightOpen ? 1 : 0,
      layout.rightWidth,
    );
  }

  getShellLayout(): ShellLayout | undefined {
    const row = this.#database.prepare(
      `SELECT
         left_panel AS leftPanel,
         left_collapsed AS leftCollapsed,
         left_width AS leftWidth,
         right_panel AS rightPanel,
         right_open AS rightOpen,
         right_width AS rightWidth
       FROM layout WHERE id = 1`,
    ).get() as ShellLayoutRow | undefined;
    return row ? {
      leftCollapsed: row.leftCollapsed === 1,
      leftPanel: row.leftPanel,
      leftWidth: row.leftWidth,
      rightOpen: row.rightOpen === 1,
      rightPanel: row.rightPanel,
      rightWidth: row.rightWidth,
    } : undefined;
  }

  savePdfOutline(outline: CachedPdfOutline): void {
    this.#database.prepare(
      `INSERT INTO pdf_outlines (
         library_id, attachment_key, file_size, file_mtime_ms, state, entries_json
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (library_id, attachment_key) DO UPDATE SET
         file_size = excluded.file_size,
         file_mtime_ms = excluded.file_mtime_ms,
         state = excluded.state,
         entries_json = excluded.entries_json`,
    ).run(
      outline.libraryId,
      outline.attachmentKey,
      outline.fileSize,
      outline.fileMtimeMs,
      outline.state,
      JSON.stringify(outline.entries),
    );
  }

  getPdfOutline(
    libraryId: number,
    attachmentKey: string,
    fileSize: number,
    fileMtimeMs: number,
  ): PdfOutlineResult | undefined {
    const row = this.#database.prepare(
      `SELECT state, entries_json AS entriesJson
       FROM pdf_outlines
       WHERE library_id = ? AND attachment_key = ?
         AND file_size = ? AND file_mtime_ms = ?`,
    ).get(libraryId, attachmentKey, fileSize, fileMtimeMs) as
      | { entriesJson: string; state: PdfOutlineResult["state"] }
      | undefined;
    return row ? {
      entries: JSON.parse(row.entriesJson) as PdfOutlineEntry[],
      state: row.state,
    } : undefined;
  }

  /**
   * Queue a write. Returns the durable entry — the caller may only tell the reader "saved" after this
   * has returned, which is what keeps an offline highlight from being lost.
   */
  enqueueOutbox(entry: NewOutboxEntry): OutboxEntry {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `INSERT INTO outbox (
           library_id, item_key, parent_item_key, operation, payload,
           status, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        entry.libraryId,
        entry.itemKey,
        entry.parentItemKey,
        entry.operation,
        entry.payload,
        now,
        now,
      );
    return {
      attemptCount: 0,
      conflictPayload: null,
      createdAt: now,
      id: Number(result.lastInsertRowid),
      itemKey: entry.itemKey,
      lastError: null,
      libraryId: entry.libraryId,
      localOnly: 0,
      operation: entry.operation,
      parentItemKey: entry.parentItemKey,
      payload: entry.payload,
      status: "pending",
      updatedAt: now,
    };
  }

  #outboxQuery(where: string): string {
    return `SELECT
        id,
        library_id AS libraryId,
        item_key AS itemKey,
        parent_item_key AS parentItemKey,
        operation,
        payload,
        status,
        attempt_count AS attemptCount,
        local_only AS localOnly,
        last_error AS lastError,
        conflict_payload AS conflictPayload,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM outbox
      ${where}
      ORDER BY created_at, id`;
  }

  /** Everything still owed to Zotero, oldest first — what a drain works through. */
  outboxDue(limit = 50): OutboxEntry[] {
    return this.#database
      .prepare(
        this.#outboxQuery(
          "WHERE status IN ('pending', 'retrying') AND local_only = 0",
        ) + " LIMIT ?",
      )
      .all(limit) as OutboxRow[];
  }

  /**
   * Everything Zotero has not taken yet — including entries that were REJECTED or hit a conflict, not
   * only those still due for a retry. This is the set that gets drawn (ADR-0029): the mark exists
   * locally whatever the sync outcome was, and dropping a failed one from the display would make the
   * highlight vanish, which is the apparent data loss the whole design forbids.
   */
  outboxUnconfirmed(limit = 500): OutboxEntry[] {
    return this.#database
      .prepare(
        this.#outboxQuery("WHERE status <> 'confirmed'") + " LIMIT ?",
      )
      .all(limit) as OutboxRow[];
  }

  /** The complete unconfirmed log, for ordering decisions that must never be windowed. */
  outboxUnconfirmedAll(): OutboxEntry[] {
    return this.#database
      .prepare(this.#outboxQuery("WHERE status <> 'confirmed'"))
      .all() as OutboxRow[];
  }

  /** Rows that can still affect drain coalescing, without materialising local-only residue. */
  outboxCoalescingLog(): OutboxEntry[] {
    return this.#database
      .prepare(this.#outboxQuery(
        `WHERE local_only = 0
           AND (
             status IN ('pending', 'retrying')
             OR (status = 'failed' AND operation = 'create')
           )`,
      ))
      .all() as OutboxRow[];
  }

  outboxByStatus(status: OutboxStatus): OutboxEntry[] {
    return this.#database
      .prepare(this.#outboxQuery("WHERE status = ?"))
      .all(status) as OutboxRow[];
  }

  /** How many rows a drain can move now. Kept identical to `outboxDue` by the status predicate. */
  countOutboxWaiting(): number {
    const row = this.#database
      .prepare(
        `SELECT count(*) AS waiting FROM outbox
         WHERE status IN ('pending', 'retrying')
           AND local_only = 0`,
      )
      .get() as { waiting: number };
    return row.waiting;
  }

  /** How many rows Zotero refused permanently or left in conflict, excluding local-only marks. */
  countOutboxRejected(): number {
    const row = this.#database
      .prepare(
        `SELECT count(*) AS rejected FROM outbox
         WHERE status IN ('failed', 'conflict')
           AND local_only = 0`,
      )
      .get() as { rejected: number };
    return row.rejected;
  }

  /** The server took it. `itemKey` records the key it assigned to a create. */
  markOutboxConfirmed(id: number, itemKey?: string): void {
    this.#database
      .prepare(
        `UPDATE outbox
         SET status = 'confirmed',
             item_key = COALESCE(?, item_key),
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(itemKey ?? null, new Date().toISOString(), id);
  }

  /**
   * The write was rejected. It STAYS in the outbox with a reason and a retry action — no data is ever
   * dropped. `retryable` distinguishes "try again later" from "a person must look at this".
   */
  markOutboxFailed(id: number, reason: string, retryable = true): void {
    this.#database
      .prepare(
        `UPDATE outbox
         SET status = ?,
             attempt_count = attempt_count + 1,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        retryable ? "retrying" : "failed",
        reason,
        new Date().toISOString(),
        id,
      );
  }

  /** Keep a structurally unsupported mark painted here without presenting it as Zotero work. */
  markOutboxLocalOnly(id: number, reason: string): void {
    this.#database
      .prepare(
        `UPDATE outbox
         SET status = 'failed',
             attempt_count = attempt_count + 1,
             local_only = 1,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(reason, new Date().toISOString(), id);
  }

  /**
   * An edit conflict: last writer wins, and the version that lost is kept here rather than discarded,
   * so nothing a reader wrote can vanish because someone else edited the same annotation.
   */
  markOutboxConflict(id: number, losingPayload: string, reason: string): void {
    this.#database
      .prepare(
        `UPDATE outbox
         SET status = 'conflict',
             attempt_count = attempt_count + 1,
             conflict_payload = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(losingPayload, reason, new Date().toISOString(), id);
  }

  /** Put a failed or conflicted entry back in the queue — the UI's retry action. */
  retryOutbox(id: number): void {
    this.#database
      .prepare(
        `UPDATE outbox
         SET status = 'pending', last_error = NULL, updated_at = ?
         WHERE id = ?
           AND status IN ('failed', 'conflict', 'retrying')
           AND local_only = 0`,
      )
      .run(new Date().toISOString(), id);
  }

  close(): void {
    this.#database.close();
  }
}
