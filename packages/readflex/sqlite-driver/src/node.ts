import {
  DatabaseSync,
  type StatementSync,
} from "node:sqlite";
import type {
  SqliteDatabase,
  SqliteDriver,
  SqliteRunResult,
  SqliteStatement,
} from "./index.js";

function databaseLocation(path: string): string | URL {
  return path.startsWith("file:") ? new URL(path) : path;
}

function normaliseRow(row: unknown): unknown {
  return row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    Object.getPrototypeOf(row) === null
    ? { ...row }
    : row;
}

/**
 * The `node:sqlite` database constructor the driver calls. Injectable so a test can
 * substitute a fake without a real file or the experimental warning (ADR-0019 addendum).
 */
export interface NodeSqliteDatabaseConstructor {
  new (
    location: string | URL,
    options?: { readOnly?: boolean },
  ): DatabaseSync;
}

export function createNodeSqliteDriver(
  DatabaseConstructor: NodeSqliteDatabaseConstructor = DatabaseSync,
): SqliteDriver {
  return {
    open(path, options = {}) {
      const database = new DatabaseConstructor(databaseLocation(path), {
        readOnly: options.readonly ?? false,
      });
      const wrapStatement = (
        statement: StatementSync,
      ): SqliteStatement => ({
        all: (...parameters) =>
          statement
            .all(...(parameters as never[]))
            .map(normaliseRow),
        get: (...parameters) =>
          normaliseRow(statement.get(...(parameters as never[]))),
        run: (...parameters) =>
          statement.run(
            ...(parameters as never[]),
          ) as SqliteRunResult,
      });
      const wrapped: SqliteDatabase = {
        all: (sql, ...parameters) =>
          wrapStatement(database.prepare(sql)).all(...parameters),
        close: () => database.close(),
        get: (sql, ...parameters) =>
          wrapStatement(database.prepare(sql)).get(...parameters),
        prepare: (sql) => wrapStatement(database.prepare(sql)),
        run: (sql, ...parameters) =>
          wrapStatement(database.prepare(sql)).run(...parameters),
        transaction: (operation) =>
          (...arguments_) => {
            database.exec("BEGIN");
            try {
              const result = operation(...arguments_);
              database.exec("COMMIT");
              return result;
            } catch (error) {
              try {
                database.exec("ROLLBACK");
              } catch {
                // Preserve the operation error that required the rollback.
              }
              throw error;
            }
          },
      };
      return wrapped;
    },
  };
}
