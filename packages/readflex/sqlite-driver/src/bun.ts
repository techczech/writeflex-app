import { Database } from "bun:sqlite";
import type {
  SqliteDatabase,
  SqliteDriver,
  SqliteRunResult,
  SqliteStatement,
} from "./index.js";

export function createBunSqliteDriver(): SqliteDriver {
  return {
    open(path, options = {}) {
      const database = new Database(path, {
        create: options.create,
        readonly: options.readonly,
        strict: true,
      });
      const wrapStatement = (
        statement: ReturnType<Database["prepare"]>,
      ): SqliteStatement => ({
        all: (...parameters) =>
          statement.all(...(parameters as never[])),
        get: (...parameters) =>
          statement.get(...(parameters as never[])),
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
          parameters.length === 0
            ? (database.run(sql) as SqliteRunResult)
            : wrapStatement(database.prepare(sql)).run(...parameters),
        transaction: (operation) =>
          database.transaction(operation),
      };
      return wrapped;
    },
  };
}
