import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { schema } from '@gaido/core';
import fs from 'node:fs';
import path from 'node:path';

export type Db = ReturnType<typeof openDb>['db'];

export function openDb(dbFile: string, migrationsFolder: string) {
  const dir = path.dirname(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(dbFile);
  // Sensible defaults for local-first single-writer usage.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  }
  return { db, sqlite };
}
