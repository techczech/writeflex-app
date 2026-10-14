export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...parameters: unknown[]): SqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  run(sql: string, ...parameters: unknown[]): SqliteRunResult;
  get(sql: string, ...parameters: unknown[]): unknown;
  all(sql: string, ...parameters: unknown[]): unknown[];
  transaction<Arguments extends unknown[], Result>(
    operation: (...arguments_: Arguments) => Result,
  ): (...arguments_: Arguments) => Result;
  close(): void;
}

export interface SqliteOpenOptions {
  create?: boolean;
  readonly?: boolean;
}

export interface SqliteDriver {
  open(
    path: string,
    options?: SqliteOpenOptions,
  ): SqliteDatabase;
}
