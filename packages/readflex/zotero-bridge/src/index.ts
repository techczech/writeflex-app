import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  discoverZoteroDataDirectory,
  type ZoteroDataDirectoryDiscovery,
} from "@readflex/zotero-paths";
import type {
  SqliteDatabase,
  SqliteDriver,
} from "@readflex/sqlite-driver";

// The write half (ADR-0031). Reads and writes live in one package because they share the schema
// knowledge; nothing in the read path below imports from it.
export * from "./annotation-write.js";

export interface ShelfIndexOptions {
  zoteroDatabasePath?: string;
  storageDirectory?: string;
  betterBibtexDatabasePath?: string;
  linkedAttachmentBaseDirectory?: string;
  immutable?: boolean;
}

export interface ZoteroReadOnlyOptions {
  immutable?: boolean;
}

export interface Creator {
  firstName: string;
  lastName: string;
  creatorType: string;
}

export interface ShelfAttachment {
  key: string;
  title: string;
  filename: string | null;
  contentType: string | null;
  storedPath: string | null;
  url: string | null;
  linkMode: number;
  kind: "pdf" | "snapshot" | "unsupported";
  resolution: AttachmentResolution;
}

export interface ShelfItem {
  libraryId: number;
  itemKey: string;
  title: string;
  year?: string;
  creators: Creator[];
  tags: string[];
  citationKey: string;
  citationKeyAmbiguity?: {
    itemCount: number;
  };
  attachments: ShelfAttachment[];
}

export interface ShelfIndexDiagnostic {
  source: "better-bibtex";
  message: string;
}

export interface ShelfIndex {
  readonly diagnostics: ShelfIndexDiagnostic[];
  readonly zoteroDataDirectory: ZoteroDataDirectoryDiscovery | {
    path: string;
    source: "explicit";
    warnings: string[];
  };
  list(): ShelfItem[];
  search(query: string): ShelfItem[];
}

export type AttachmentResolution =
  | {
      state: "stored";
      kind: "pdf" | "snapshot";
      path: string;
    }
  | {
      state: "missing";
      expectedKind: "pdf" | "snapshot";
      expectedPath: string | null;
    }
  | { state: "link"; url: string | null }
  | {
      state: "linked-file";
      kind: "pdf" | "snapshot";
      path: string | null;
      available: boolean;
    }
  | { state: "unsupported"; contentType: string | null };

export type ZoteroAnnotationType =
  | "highlight"
  | "note"
  | "image"
  | "ink"
  | "underline"
  | "text"
  | "unknown";

export interface ZoteroAnnotation {
  key: string;
  type: ZoteroAnnotationType;
  parentItemKey: string;
  tags: string[];
  authorName: string | null;
  text: string | null;
  comment: string | null;
  color: string | null;
  pageLabel: string | null;
  sortIndex: string;
  position: string;
  isExternal: boolean;
}

interface ShelfRow {
  itemId: number;
  libraryId: number;
  itemKey: string;
  title: string | null;
  date: string | null;
}

interface AttachmentRow {
  parentItemId: number;
  attachmentKey: string;
  attachmentTitle: string | null;
  url: string | null;
  linkMode: number;
  contentType: string | null;
  storedPath: string | null;
}

interface CreatorRow {
  itemId: number;
  firstName: string | null;
  lastName: string | null;
  creatorType: string;
}

interface TagRow {
  itemId: number;
  name: string;
}

interface CitationKeyRow {
  itemKey: string;
  libraryId: number;
  citationKey: string;
}

type ShelfItemDraft = Omit<
  ShelfItem,
  "citationKey" | "citationKeyAmbiguity"
>;

interface AnnotationTagRow {
  annotationKey: string;
  name: string;
}

function readOnlyUri(
  databasePath: string,
  options: ZoteroReadOnlyOptions,
): string {
  const suffix = options.immutable === false ? "?mode=ro" : "?mode=ro&immutable=1";
  return `${pathToFileURL(databasePath).href}${suffix}`;
}

export function openZoteroReadOnly(
  databaseDriver: SqliteDriver,
  databasePath: string,
  options: ZoteroReadOnlyOptions = {},
): SqliteDatabase {
  return databaseDriver.open(readOnlyUri(databasePath, options), {
    readonly: true,
  });
}

function normaliseSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractYear(date: string | null): string | undefined {
  return date?.match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1];
}

function authorYearKey(item: Omit<ShelfItemDraft, "libraryId">): string {
  const authorOrTitle =
    item.creators[0]?.lastName ||
    normaliseSearchText(item.title).split(" ")[0] ||
    item.itemKey;
  const author = authorOrTitle
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
  return `${author || item.itemKey}${item.year ?? "ND"}`;
}

function alphabeticSuffix(index: number): string {
  let remaining = index + 1;
  let suffix = "";
  while (remaining > 0) {
    remaining -= 1;
    suffix = String.fromCharCode(97 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26);
  }
  return suffix;
}

function fallbackCitationKeys(
  items: ShelfItemDraft[],
  citationKeys: ReadonlyMap<string, string>,
): Map<string, string> {
  const groups = new Map<string, ShelfItemDraft[]>();
  for (const item of items) {
    const identity = `${item.libraryId}:${item.itemKey}`;
    if (citationKeys.has(identity)) {
      continue;
    }
    const base = authorYearKey(item);
    const group = groups.get(base) ?? [];
    group.push(item);
    groups.set(base, group);
  }

  const fallbackKeys = new Map<string, string>();
  for (const [base, group] of groups) {
    group.sort(
      (left, right) =>
        left.title.localeCompare(right.title) ||
        left.itemKey.localeCompare(right.itemKey),
    );
    for (const [index, item] of group.entries()) {
      const identity = `${item.libraryId}:${item.itemKey}`;
      fallbackKeys.set(
        identity,
        group.length === 1 ? base : `${base}${alphabeticSuffix(index)}`,
      );
    }
  }
  return fallbackKeys;
}

function readCitationKeys(
  databaseDriver: SqliteDriver,
  betterBibtexDatabasePath: string | undefined,
): {
  citationKeys: Map<string, string>;
  diagnostic?: ShelfIndexDiagnostic;
} {
  const citationKeys = new Map<string, string>();
  if (
    !betterBibtexDatabasePath ||
    !existsSync(betterBibtexDatabasePath)
  ) {
    return { citationKeys };
  }

  let database: SqliteDatabase | undefined;
  try {
    database = openZoteroReadOnly(
      databaseDriver,
      betterBibtexDatabasePath,
    );
    const rows = database
      .prepare(
        `SELECT itemKey, libraryID AS libraryId, citationKey
         FROM citationkey`,
      )
      .all() as CitationKeyRow[];
    for (const row of rows) {
      citationKeys.set(`${row.libraryId}:${row.itemKey}`, row.citationKey);
    }
  } catch (error) {
    return {
      citationKeys,
      diagnostic: {
        message:
          error instanceof Error ? error.message : String(error),
        source: "better-bibtex",
      },
    };
  } finally {
    database?.close();
  }

  return { citationKeys };
}

function grams(value: string, size: number): Set<string> {
  if (value.length <= size) {
    return new Set([value]);
  }
  const result = new Set<string>();
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

class InMemoryShelfIndex implements ShelfIndex {
  readonly diagnostics: ShelfIndexDiagnostic[];
  readonly zoteroDataDirectory: ShelfIndex["zoteroDataDirectory"];
  readonly #items: ShelfItem[];
  readonly #searchText: string[];
  readonly #gramIndex = new Map<string, Set<number>>();

  constructor(
    items: ShelfItem[],
    diagnostics: ShelfIndexDiagnostic[],
    zoteroDataDirectory: ShelfIndex["zoteroDataDirectory"],
  ) {
    this.diagnostics = diagnostics;
    this.zoteroDataDirectory = zoteroDataDirectory;
    this.#items = [...items].sort((left, right) =>
      left.title.localeCompare(right.title),
    );
    this.#searchText = this.#items.map((item) =>
      normaliseSearchText(
        [
          item.title,
          item.creators
            .map((creator) => `${creator.firstName} ${creator.lastName}`)
            .join(" "),
          item.year ?? "",
          item.tags.join(" "),
          item.citationKey,
        ].join(" "),
      ),
    );

    this.#searchText.forEach((text, itemIndex) => {
      for (const size of [2, 3]) {
        for (const gram of grams(text, size)) {
          const itemIndexes = this.#gramIndex.get(gram) ?? new Set<number>();
          itemIndexes.add(itemIndex);
          this.#gramIndex.set(gram, itemIndexes);
        }
      }
    });
  }

  list(): ShelfItem[] {
    return [...this.#items];
  }

  search(query: string): ShelfItem[] {
    const normalisedQuery = normaliseSearchText(query);
    if (!normalisedQuery) {
      return [];
    }

    const queryTokens = normalisedQuery.split(" ");
    const queryGrams = [
      ...new Set(
        queryTokens.flatMap((token) =>
          token.length < 2
            ? []
            : [...grams(token, Math.min(3, token.length))],
        ),
      ),
    ];
    if (queryGrams.length === 0) {
      return this.#items.filter((_, itemIndex) =>
        queryTokens.every((token) =>
          this.#searchText[itemIndex]!.includes(token),
        ),
      );
    }
    const postings = queryGrams
      .map((gram) => this.#gramIndex.get(gram))
      .filter(
        (posting): posting is Set<number> => posting !== undefined,
      )
      .sort((left, right) => left.size - right.size);
    if (postings.length !== queryGrams.length || postings.length === 0) {
      return [];
    }

    const candidates = [...postings[0]!].filter((itemIndex) =>
      postings.every((posting) => posting.has(itemIndex)),
    );
    return candidates
      .filter((itemIndex) =>
        queryTokens.every((token) =>
          this.#searchText[itemIndex]!.includes(token),
        ),
      )
      .map((itemIndex) => this.#items[itemIndex]!);
  }
}

export function buildShelfIndex(
  databaseDriver: SqliteDriver,
  options: ShelfIndexOptions = {},
): ShelfIndex {
  const zoteroDataDirectory: ShelfIndex["zoteroDataDirectory"] =
    options.zoteroDatabasePath
      ? {
          path: dirname(options.zoteroDatabasePath),
          source: "explicit",
          warnings: [],
        }
      : discoverZoteroDataDirectory();
  const zoteroDatabasePath =
    options.zoteroDatabasePath ??
    join(zoteroDataDirectory.path, "zotero.sqlite");
  const storageDirectory =
    options.storageDirectory ??
    join(zoteroDataDirectory.path, "storage");
  const database = openZoteroReadOnly(
    databaseDriver,
    zoteroDatabasePath,
    { immutable: options.immutable },
  );
  let shelfRows: ShelfRow[];
  let attachmentRows: AttachmentRow[];
  let creatorRows: CreatorRow[];
  let tagRows: TagRow[];

  try {
    shelfRows = database
      .prepare(
        `SELECT
           item.itemID AS itemId,
           item.libraryID AS libraryId,
           item.key AS itemKey,
           (
             SELECT titleValue.value
             FROM itemData AS titleData
             JOIN fields AS titleField
               ON titleField.fieldID = titleData.fieldID
             JOIN itemDataValues AS titleValue
               ON titleValue.valueID = titleData.valueID
             WHERE titleData.itemID = item.itemID
               AND titleField.fieldName IN (
                 'title', 'caseName', 'nameOfAct', 'subject'
               )
               AND titleValue.value <> ''
             ORDER BY CASE titleField.fieldName
               WHEN 'title' THEN 0
               WHEN 'caseName' THEN 1
               WHEN 'nameOfAct' THEN 2
               WHEN 'subject' THEN 3
             END
             LIMIT 1
           ) AS title,
           dateValue.value AS date
         FROM items AS item
         JOIN itemTypes AS itemType
           ON itemType.itemTypeID = item.itemTypeID
         LEFT JOIN itemData AS dateData
           ON dateData.itemID = item.itemID
          AND dateData.fieldID = (
            SELECT fieldID FROM fields WHERE fieldName = 'date'
          )
         LEFT JOIN itemDataValues AS dateValue
           ON dateValue.valueID = dateData.valueID
         LEFT JOIN deletedItems AS deletedItem
           ON deletedItem.itemID = item.itemID
         WHERE itemType.typeName NOT IN ('attachment', 'annotation', 'note')
           AND deletedItem.itemID IS NULL`,
      )
      .all() as ShelfRow[];
    attachmentRows = database
      .prepare(
        `SELECT
           attachment.parentItemID AS parentItemId,
           attachmentItem.key AS attachmentKey,
           attachmentTitleValue.value AS attachmentTitle,
           attachmentUrlValue.value AS url,
           attachment.linkMode AS linkMode,
           attachment.contentType AS contentType,
           attachment.path AS storedPath
         FROM itemAttachments AS attachment
         JOIN items AS attachmentItem
           ON attachmentItem.itemID = attachment.itemID
         LEFT JOIN itemData AS attachmentTitleData
           ON attachmentTitleData.itemID = attachmentItem.itemID
          AND attachmentTitleData.fieldID = (
            SELECT fieldID FROM fields WHERE fieldName = 'title'
          )
         LEFT JOIN itemDataValues AS attachmentTitleValue
           ON attachmentTitleValue.valueID = attachmentTitleData.valueID
         LEFT JOIN itemData AS attachmentUrlData
           ON attachmentUrlData.itemID = attachmentItem.itemID
          AND attachmentUrlData.fieldID = (
            SELECT fieldID FROM fields WHERE fieldName = 'url'
          )
         LEFT JOIN itemDataValues AS attachmentUrlValue
           ON attachmentUrlValue.valueID = attachmentUrlData.valueID
         LEFT JOIN deletedItems AS deletedAttachment
           ON deletedAttachment.itemID = attachment.itemID
         WHERE attachment.parentItemID IS NOT NULL
           AND deletedAttachment.itemID IS NULL
         ORDER BY attachment.parentItemID, attachment.itemID`,
      )
      .all() as AttachmentRow[];
    creatorRows = database
      .prepare(
        `SELECT
           itemCreator.itemID AS itemId,
           creator.firstName AS firstName,
           creator.lastName AS lastName,
           creatorType.creatorType AS creatorType
         FROM itemCreators AS itemCreator
         JOIN creators AS creator
           ON creator.creatorID = itemCreator.creatorID
         JOIN creatorTypes AS creatorType
           ON creatorType.creatorTypeID = itemCreator.creatorTypeID
         ORDER BY itemCreator.itemID, itemCreator.orderIndex`,
      )
      .all() as CreatorRow[];
    tagRows = database
      .prepare(
        `SELECT itemTag.itemID AS itemId, tag.name AS name
         FROM itemTags AS itemTag
         JOIN tags AS tag ON tag.tagID = itemTag.tagID
         ORDER BY itemTag.itemID, tag.name`,
      )
      .all() as TagRow[];
  } finally {
    database.close();
  }

  const creatorsByItem = new Map<number, Creator[]>();
  for (const row of creatorRows) {
    const creators = creatorsByItem.get(row.itemId) ?? [];
    creators.push({
      creatorType: row.creatorType,
      firstName: row.firstName ?? "",
      lastName: row.lastName ?? "",
    });
    creatorsByItem.set(row.itemId, creators);
  }

  const tagsByItem = new Map<number, string[]>();
  for (const row of tagRows) {
    const tags = tagsByItem.get(row.itemId) ?? [];
    tags.push(row.name);
    tagsByItem.set(row.itemId, tags);
  }

  const citationKeyResult = readCitationKeys(
    databaseDriver,
    options.betterBibtexDatabasePath ??
      join(zoteroDataDirectory.path, "better-bibtex.sqlite"),
  );
  const citationKeys = citationKeyResult.citationKeys;
  const attachmentsByItem = new Map<number, ShelfAttachment[]>();
  for (const row of attachmentRows) {
    const kind =
      row.contentType === "application/pdf"
        ? "pdf"
        : row.contentType === "text/html"
          ? "snapshot"
          : "unsupported";
    const filename = attachmentFilename(row.storedPath, row.url);
    const unresolved: Omit<ShelfAttachment, "resolution"> = {
      contentType: row.contentType,
      filename,
      key: row.attachmentKey,
      kind,
      linkMode: row.linkMode,
      storedPath: row.storedPath,
      title: row.attachmentTitle ?? filename ?? "Untitled attachment",
      url: row.url,
    };
    const attachments = attachmentsByItem.get(row.parentItemId) ?? [];
    attachments.push({
      ...unresolved,
      resolution: resolveAttachment(
        unresolved,
        storageDirectory,
        options.linkedAttachmentBaseDirectory,
      ),
    });
    attachmentsByItem.set(row.parentItemId, attachments);
  }

  const drafts = shelfRows.map((row): ShelfItemDraft => {
    return {
      attachments: attachmentsByItem.get(row.itemId) ?? [],
      creators: creatorsByItem.get(row.itemId) ?? [],
      itemKey: row.itemKey,
      libraryId: row.libraryId,
      tags: tagsByItem.get(row.itemId) ?? [],
      title: row.title ?? "Untitled",
      year: extractYear(row.date),
    };
  });
  const fallbackKeys = fallbackCitationKeys(drafts, citationKeys);
  const keyedItems = drafts.map((item): ShelfItem => {
    const { libraryId } = item;
    const identity = `${libraryId}:${item.itemKey}`;
    return {
      ...item,
      citationKey:
        citationKeys.get(identity) ?? fallbackKeys.get(identity)!,
    };
  });
  const citationKeyCounts = new Map<string, number>();
  for (const item of keyedItems) {
    citationKeyCounts.set(
      item.citationKey,
      (citationKeyCounts.get(item.citationKey) ?? 0) + 1,
    );
  }
  const items = keyedItems.map((item): ShelfItem => {
    const itemCount = citationKeyCounts.get(item.citationKey)!;
    return itemCount > 1
      ? {
          ...item,
          citationKeyAmbiguity: { itemCount },
        }
      : item;
  });

  return new InMemoryShelfIndex(
    items,
    citationKeyResult.diagnostic ? [citationKeyResult.diagnostic] : [],
    zoteroDataDirectory,
  );
}

function attachmentFilename(
  storedPath: string | null,
  url: string | null,
): string | null {
  if (storedPath) {
    const withoutPrefix = storedPath.replace(
      /^(?:storage:|attachments:)/,
      "",
    );
    return basename(withoutPrefix) || null;
  }
  if (!url) {
    return null;
  }
  try {
    return basename(new URL(url).pathname) || null;
  } catch {
    return null;
  }
}

export interface ZoteroCollection {
  libraryId: number;
  key: string;
  name: string;
  /** Key of the parent collection in the same library, or null at the top. */
  parentKey: string | null;
}

export interface ZoteroCollections {
  collections: ZoteroCollection[];
  /**
   * Collection keys per item, keyed `${libraryId}:${itemKey}`. Holds regular
   * items and standalone attachments alike; a paper belongs to a collection
   * when its parent item (or, standalone, the attachment itself) is listed.
   */
  itemCollections: Record<string, string[]>;
}

/**
 * Reads the collection tree and item membership from zotero.sqlite through the
 * same read-only open as the rest of the bridge. Collections listed in
 * deletedCollections and items listed in deletedItems are skipped. Databases
 * without collection tables yield an empty result.
 */
export function readCollections(
  databaseDriver: SqliteDriver,
  databasePath: string,
  options: ZoteroReadOnlyOptions = {},
): ZoteroCollections {
  const database = openZoteroReadOnly(databaseDriver, databasePath, options);
  try {
    const tables = new Set(
      (database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]).map((row) => row.name),
    );
    if (!tables.has("collections") || !tables.has("collectionItems")) {
      return { collections: [], itemCollections: {} };
    }
    const hasDeletedCollections = tables.has("deletedCollections");
    const hasDeletedItems = tables.has("deletedItems");
    const rows = database
      .prepare(
        `SELECT
           collection.collectionID AS collectionId,
           collection.libraryID AS libraryId,
           collection.key AS key,
           collection.collectionName AS name,
           parent.key AS parentKey
         FROM collections AS collection
         LEFT JOIN collections AS parent
           ON parent.collectionID = collection.parentCollectionID
         ${hasDeletedCollections
           ? `LEFT JOIN deletedCollections AS deleted
                ON deleted.collectionID = collection.collectionID
              WHERE deleted.collectionID IS NULL`
           : ""}
         ORDER BY collection.libraryID, collection.collectionID`,
      )
      .all() as {
        collectionId: number;
        libraryId: number;
        key: string;
        name: string;
        parentKey: string | null;
      }[];
    const memberRows = database
      .prepare(
        `SELECT
           collection.key AS collectionKey,
           item.libraryID AS libraryId,
           item.key AS itemKey
         FROM collectionItems AS member
         JOIN collections AS collection
           ON collection.collectionID = member.collectionID
         JOIN items AS item
           ON item.itemID = member.itemID
         ${hasDeletedItems
           ? "LEFT JOIN deletedItems AS deletedItem ON deletedItem.itemID = item.itemID"
           : ""}
         ${hasDeletedCollections
           ? "LEFT JOIN deletedCollections AS deleted ON deleted.collectionID = collection.collectionID"
           : ""}
         WHERE 1 = 1
           ${hasDeletedItems ? "AND deletedItem.itemID IS NULL" : ""}
           ${hasDeletedCollections ? "AND deleted.collectionID IS NULL" : ""}
         ORDER BY collection.collectionID, item.itemID`,
      )
      .all() as { collectionKey: string; libraryId: number; itemKey: string }[];
    const itemCollections: Record<string, string[]> = {};
    for (const row of memberRows) {
      (itemCollections[`${row.libraryId}:${row.itemKey}`] ??= []).push(
        row.collectionKey,
      );
    }
    return {
      collections: rows.map((row) => ({
        key: row.key,
        libraryId: row.libraryId,
        name: row.name,
        parentKey: row.parentKey,
      })),
      itemCollections,
    };
  } finally {
    database.close();
  }
}

export function resolveAttachment(
  attachment: Omit<ShelfAttachment, "resolution">,
  storageDirectory: string,
  linkedAttachmentBaseDirectory?: string,
): AttachmentResolution {
  if (attachment.linkMode === 3) {
    return { state: "link", url: attachment.url };
  }
  if (attachment.kind === "unsupported") {
    return {
      contentType: attachment.contentType,
      state: "unsupported",
    };
  }

  const storedPath = attachment.storedPath;
  if (
    attachment.linkMode === 2 ||
    storedPath?.startsWith("attachments:") ||
    (storedPath !== null && isAbsolute(storedPath))
  ) {
    if (storedPath?.startsWith("attachments:")) {
      const path = linkedAttachmentBaseDirectory
        ? join(
            linkedAttachmentBaseDirectory,
            storedPath.slice("attachments:".length),
          )
        : storedPath;
      return {
        available:
          linkedAttachmentBaseDirectory !== undefined && existsSync(path),
        kind: attachment.kind,
        path,
        state: "linked-file",
      };
    }
    return {
      available: storedPath !== null && existsSync(storedPath),
      kind: attachment.kind,
      path: storedPath,
      state: "linked-file",
    };
  }

  if (storedPath === null) {
    return {
      expectedKind: attachment.kind,
      expectedPath: null,
      state: "missing",
    };
  }

  const relativePath = storedPath.startsWith("storage:")
    ? storedPath.slice("storage:".length)
    : storedPath;
  if (
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    return {
      expectedKind: attachment.kind,
      expectedPath: null,
      state: "missing",
    };
  }
  const expectedPath = join(
    storageDirectory,
    attachment.key,
    relativePath,
  );

  return existsSync(expectedPath)
    ? { kind: attachment.kind, path: expectedPath, state: "stored" }
    : {
        expectedKind: attachment.kind,
        expectedPath,
        state: "missing",
      };
}

export function readAnnotations(
  databaseDriver: SqliteDriver,
  zoteroDatabasePath: string,
  libraryId: number,
  attachmentKey: string,
  options: ZoteroReadOnlyOptions = {},
): ZoteroAnnotation[] {
  const database = openZoteroReadOnly(
    databaseDriver,
    zoteroDatabasePath,
    options,
  );
  try {
    const rows = database
      .prepare(
        `SELECT
           annotationItem.key AS key,
           annotation.type AS type,
           attachmentItem.key AS parentItemKey,
           annotation.authorName AS authorName,
           annotation.text AS text,
           annotation.comment AS comment,
           annotation.color AS color,
           annotation.pageLabel AS pageLabel,
           annotation.sortIndex AS sortIndex,
           annotation.position AS position,
           annotation.isExternal AS isExternal
         FROM itemAnnotations AS annotation
         JOIN items AS annotationItem
           ON annotationItem.itemID = annotation.itemID
         JOIN items AS attachmentItem
           ON attachmentItem.itemID = annotation.parentItemID
         LEFT JOIN deletedItems AS deletedAnnotation
           ON deletedAnnotation.itemID = annotation.itemID
         WHERE attachmentItem.libraryID = ?
           AND attachmentItem.key = ?
           AND deletedAnnotation.itemID IS NULL
         ORDER BY annotation.sortIndex`,
      )
      .all(libraryId, attachmentKey) as Array<
      Omit<ZoteroAnnotation, "isExternal" | "tags" | "type"> & {
        isExternal: number;
        type: number;
      }
    >;
    const tagRows = database
      .prepare(
        `SELECT
           annotationItem.key AS annotationKey,
           tag.name AS name
         FROM itemAnnotations AS annotation
         JOIN items AS annotationItem
           ON annotationItem.itemID = annotation.itemID
         JOIN items AS attachmentItem
           ON attachmentItem.itemID = annotation.parentItemID
         JOIN itemTags AS itemTag
           ON itemTag.itemID = annotation.itemID
         JOIN tags AS tag
           ON tag.tagID = itemTag.tagID
         LEFT JOIN deletedItems AS deletedAnnotation
           ON deletedAnnotation.itemID = annotation.itemID
         WHERE attachmentItem.libraryID = ?
           AND attachmentItem.key = ?
           AND deletedAnnotation.itemID IS NULL
         ORDER BY annotationItem.key, tag.name`,
      )
      .all(libraryId, attachmentKey) as AnnotationTagRow[];
    const tagsByAnnotation = new Map<string, string[]>();
    for (const row of tagRows) {
      const tags = tagsByAnnotation.get(row.annotationKey) ?? [];
      tags.push(row.name);
      tagsByAnnotation.set(row.annotationKey, tags);
    }

    return rows.map((row) => ({
      ...row,
      isExternal: row.isExternal !== 0,
      tags: tagsByAnnotation.get(row.key) ?? [],
      type: annotationType(row.type),
    }));
  } finally {
    database.close();
  }
}

function annotationType(type: number): ZoteroAnnotationType {
  return (
    {
      1: "highlight",
      2: "note",
      3: "image",
      4: "ink",
      5: "underline",
      6: "text",
    } as const
  )[type as 1 | 2 | 3 | 4 | 5 | 6] ?? "unknown";
}
