import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import * as schema from './schema.js';
import * as relations from './relations.js';

const sqlite = new Database(process.env.DATABASE_URL || './sqlite/kiku.db', {
  strict: true,
});

sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA busy_timeout = 1000');
sqlite.exec('PRAGMA foreign_keys = ON');

export const db = drizzle(sqlite, { schema: { ...schema, ...relations } });

// Run pending migrations on startup (idempotent via __drizzle_migrations table)
migrate(db, { migrationsFolder: './src/db/migrations' });
