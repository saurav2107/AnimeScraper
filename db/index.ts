import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { recoverOrphans } from "../lib/scrape";

export type DB = Database.Database;

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/** Open (and migrate) a SQLite database. Use ":memory:" for tests. */
export function createDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(drizzle(db), { migrationsFolder: MIGRATIONS });
  return db;
}

const g = globalThis as unknown as { __live?: DB };

export function liveDb(): DB {
  if (!g.__live) {
    g.__live = createDb(process.env.DB_PATH || path.join(process.cwd(), "data", "animecartel.sqlite"));
    recoverOrphans(g.__live); // a restart interrupts any in-flight run
  }
  return g.__live;
}
