interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): SqliteRunResult;
}

interface ShelfSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  run(sql: string, ...parameters: unknown[]): SqliteRunResult;
}

export interface SidecarDocumentId {
  attachmentKey: string;
  itemKey: string;
  libraryId: number;
}

export type PlanToReadProvenance =
  | { kind: "added-directly" }
  | { kind: "added-from-search"; query: string }
  | { kind: "related-to"; document: SidecarDocumentId };

export interface NewPlanToReadEntry extends SidecarDocumentId {
  addedAt?: string;
  provenance: PlanToReadProvenance;
}

export interface PlanToReadEntry extends SidecarDocumentId {
  addedAt: string;
  provenance: PlanToReadProvenance;
}

export type ActivityType =
  | "marked"
  | "bookmarked"
  | "captured"
  | "synced"
  | "finished"
  | "searched";

export type ActivityPayloadValue = string | number | boolean | null;
export type ActivityPayload = Record<string, ActivityPayloadValue>;

export interface NewActivityEntry {
  document?: SidecarDocumentId;
  occurredAt?: string;
  payload: ActivityPayload;
  type: ActivityType;
}

export interface ActivityEntry extends NewActivityEntry {
  id: number;
  occurredAt: string;
}

export type SearchFilterValue =
  | string
  | number
  | boolean
  | null
  | string[];
export type SearchFilters = Record<string, SearchFilterValue>;

export interface NewRecentSearch {
  filters: SearchFilters;
  openedCount: number;
  query: string;
  resultCount: number;
  searchedAt?: string;
}

export interface RecentSearch extends NewRecentSearch {
  id: number;
  searchedAt: string;
}

export interface RecentlyReadDocument extends SidecarDocumentId {
  authorYear: string;
  /** The existing serialized reader position, or null when no position has been saved yet. */
  lastPosition: string | null;
  openedAt: string;
  shortTitle: string;
}

interface PlanToReadRow extends SidecarDocumentId {
  addedAt: string;
  provenanceQuery: string | null;
  provenanceType: PlanToReadProvenance["kind"];
  relatedAttachmentKey: string | null;
  relatedItemKey: string | null;
  relatedLibraryId: number | null;
}

interface ActivityRow {
  attachmentKey: string | null;
  id: number;
  itemKey: string | null;
  libraryId: number | null;
  occurredAt: string;
  payloadJson: string;
  type: ActivityType;
}

interface RecentSearchRow {
  filtersJson: string;
  id: number;
  openedCount: number;
  query: string;
  resultCount: number;
  searchedAt: string;
}

export function createShelfWorkspaceTables(database: ShelfSqliteDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS plan_to_read (
      library_id INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      attachment_key TEXT NOT NULL,
      added_at TEXT NOT NULL,
      provenance_type TEXT NOT NULL
        CHECK (provenance_type IN ('added-from-search', 'related-to', 'added-directly')),
      provenance_query TEXT,
      related_library_id INTEGER,
      related_item_key TEXT,
      related_attachment_key TEXT,
      PRIMARY KEY (library_id, item_key, attachment_key),
      CHECK (
        (provenance_type = 'added-from-search'
          AND provenance_query IS NOT NULL
          AND related_library_id IS NULL
          AND related_item_key IS NULL
          AND related_attachment_key IS NULL)
        OR
        (provenance_type = 'related-to'
          AND provenance_query IS NULL
          AND related_library_id IS NOT NULL
          AND related_item_key IS NOT NULL
          AND related_attachment_key IS NOT NULL)
        OR
        (provenance_type = 'added-directly'
          AND provenance_query IS NULL
          AND related_library_id IS NULL
          AND related_item_key IS NULL
          AND related_attachment_key IS NULL)
      )
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS plan_to_read_by_added
    ON plan_to_read (added_at)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL
        CHECK (type IN ('marked', 'bookmarked', 'captured', 'synced', 'finished', 'searched')),
      library_id INTEGER,
      item_key TEXT,
      attachment_key TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      CHECK (
        (library_id IS NULL AND item_key IS NULL AND attachment_key IS NULL)
        OR
        (library_id IS NOT NULL AND item_key IS NOT NULL AND attachment_key IS NOT NULL)
      )
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS activity_by_occurred
    ON activity (occurred_at)
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS recent_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      result_count INTEGER NOT NULL CHECK (result_count >= 0),
      opened_count INTEGER NOT NULL CHECK (
        opened_count >= 0 AND opened_count <= result_count
      ),
      searched_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS recent_searches_by_searched
    ON recent_searches (searched_at)
  `);
}

function provenanceColumns(provenance: PlanToReadProvenance): [
  PlanToReadProvenance["kind"],
  string | null,
  number | null,
  string | null,
  string | null,
] {
  if (provenance.kind === "added-from-search") {
    return [provenance.kind, provenance.query, null, null, null];
  }
  if (provenance.kind === "related-to") {
    return [
      provenance.kind,
      null,
      provenance.document.libraryId,
      provenance.document.itemKey,
      provenance.document.attachmentKey,
    ];
  }
  return [provenance.kind, null, null, null, null];
}

function planEntry(row: PlanToReadRow): PlanToReadEntry {
  let provenance: PlanToReadProvenance;
  if (row.provenanceType === "added-from-search") {
    provenance = {
      kind: row.provenanceType,
      query: row.provenanceQuery!,
    };
  } else if (row.provenanceType === "related-to") {
    provenance = {
      kind: row.provenanceType,
      document: {
        attachmentKey: row.relatedAttachmentKey!,
        itemKey: row.relatedItemKey!,
        libraryId: row.relatedLibraryId!,
      },
    };
  } else {
    provenance = { kind: row.provenanceType };
  }
  return {
    addedAt: row.addedAt,
    attachmentKey: row.attachmentKey,
    itemKey: row.itemKey,
    libraryId: row.libraryId,
    provenance,
  };
}

export class ShelfWorkspaceStore {
  readonly #database: ShelfSqliteDatabase;

  constructor(database: ShelfSqliteDatabase) {
    this.#database = database;
  }

  addToPlanToRead(entry: NewPlanToReadEntry): PlanToReadEntry {
    const addedAt = entry.addedAt ?? new Date().toISOString();
    const [type, query, relatedLibraryId, relatedItemKey, relatedAttachmentKey] =
      provenanceColumns(entry.provenance);
    this.#database
      .prepare(
        `INSERT INTO plan_to_read (
           library_id, item_key, attachment_key, added_at, provenance_type,
           provenance_query, related_library_id, related_item_key,
           related_attachment_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (library_id, item_key, attachment_key) DO UPDATE SET
           added_at = excluded.added_at,
           provenance_type = excluded.provenance_type,
           provenance_query = excluded.provenance_query,
           related_library_id = excluded.related_library_id,
           related_item_key = excluded.related_item_key,
           related_attachment_key = excluded.related_attachment_key`,
      )
      .run(
        entry.libraryId,
        entry.itemKey,
        entry.attachmentKey,
        addedAt,
        type,
        query,
        relatedLibraryId,
        relatedItemKey,
        relatedAttachmentKey,
      );
    return { ...entry, addedAt };
  }

  removeFromPlanToRead(id: SidecarDocumentId): void {
    this.#database
      .prepare(
        `DELETE FROM plan_to_read
         WHERE library_id = ? AND item_key = ? AND attachment_key = ?`,
      )
      .run(id.libraryId, id.itemKey, id.attachmentKey);
  }

  listPlanToRead(limit = 100): PlanToReadEntry[] {
    return (this.#database
      .prepare(
        `SELECT
           library_id AS libraryId,
           item_key AS itemKey,
           attachment_key AS attachmentKey,
           added_at AS addedAt,
           provenance_type AS provenanceType,
           provenance_query AS provenanceQuery,
           related_library_id AS relatedLibraryId,
           related_item_key AS relatedItemKey,
           related_attachment_key AS relatedAttachmentKey
         FROM plan_to_read
         ORDER BY added_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as PlanToReadRow[]).map(planEntry);
  }

  recordActivity(entry: NewActivityEntry): ActivityEntry {
    const occurredAt = entry.occurredAt ?? new Date().toISOString();
    const result = this.#database
      .prepare(
        `INSERT INTO activity (
           type, library_id, item_key, attachment_key, occurred_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.type,
        entry.document?.libraryId ?? null,
        entry.document?.itemKey ?? null,
        entry.document?.attachmentKey ?? null,
        occurredAt,
        JSON.stringify(entry.payload),
      );
    return {
      ...entry,
      id: Number(result.lastInsertRowid),
      occurredAt,
    };
  }

  listRecentActivity(limit = 100): ActivityEntry[] {
    return (this.#database
      .prepare(
        `SELECT
           id,
           type,
           library_id AS libraryId,
           item_key AS itemKey,
           attachment_key AS attachmentKey,
           occurred_at AS occurredAt,
           payload_json AS payloadJson
         FROM activity
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as ActivityRow[]).map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt,
        payload: JSON.parse(row.payloadJson) as ActivityPayload,
        type: row.type,
        ...(row.libraryId === null
          ? {}
          : {
              document: {
                attachmentKey: row.attachmentKey!,
                itemKey: row.itemKey!,
                libraryId: row.libraryId,
              },
            }),
      }));
  }

  recordRecentSearch(search: NewRecentSearch): RecentSearch {
    const searchedAt = search.searchedAt ?? new Date().toISOString();
    const result = this.#database
      .prepare(
        `INSERT INTO recent_searches (
           query, filters_json, result_count, opened_count, searched_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        search.query,
        JSON.stringify(search.filters),
        search.resultCount,
        search.openedCount,
        searchedAt,
      );
    return {
      ...search,
      id: Number(result.lastInsertRowid),
      searchedAt,
    };
  }

  recordSearchResultOpened(id: number): RecentSearch {
    const result = this.#database
      .prepare(
        `UPDATE recent_searches
         SET opened_count = opened_count + 1
         WHERE id = ? AND opened_count < result_count`,
      )
      .run(id);
    if (result.changes !== 1) {
      throw new Error(
        "ReadFlex could not record another opened result for that search.",
      );
    }
    return this.#recentSearch(id)!;
  }

  #recentSearch(id: number): RecentSearch | undefined {
    const row = this.#database
      .prepare(
        `SELECT
           id,
           query,
           filters_json AS filtersJson,
           result_count AS resultCount,
           opened_count AS openedCount,
           searched_at AS searchedAt
         FROM recent_searches
         WHERE id = ?`,
      )
      .get(id) as RecentSearchRow | undefined;
    return row
      ? {
          filters: JSON.parse(row.filtersJson) as SearchFilters,
          id: row.id,
          openedCount: row.openedCount,
          query: row.query,
          resultCount: row.resultCount,
          searchedAt: row.searchedAt,
        }
      : undefined;
  }

  listRecentSearches(limit = 100): RecentSearch[] {
    return (this.#database
      .prepare(
        `SELECT
           id,
           query,
           filters_json AS filtersJson,
           result_count AS resultCount,
           opened_count AS openedCount,
           searched_at AS searchedAt
         FROM recent_searches
         ORDER BY searched_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as RecentSearchRow[]).map((row) => ({
        filters: JSON.parse(row.filtersJson) as SearchFilters,
        id: row.id,
        openedCount: row.openedCount,
        query: row.query,
        resultCount: row.resultCount,
        searchedAt: row.searchedAt,
      }));
  }

  listRecentlyRead(limit = 100): RecentlyReadDocument[] {
    return this.#database
      .prepare(
        `SELECT
           recent.library_id AS libraryId,
           recent.item_key AS itemKey,
           recent.attachment_key AS attachmentKey,
           recent.author_year AS authorYear,
           recent.short_title AS shortTitle,
           recent.opened_at AS openedAt,
           positions.position AS lastPosition
         FROM recent_documents AS recent
         LEFT JOIN positions
           ON positions.library_id = recent.library_id
          AND positions.item_key = recent.attachment_key
         ORDER BY recent.opened_at DESC, recent.rowid DESC
         LIMIT ?`,
      )
      .all(limit) as RecentlyReadDocument[];
  }
}
