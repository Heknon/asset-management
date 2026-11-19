import { Kysely, Migrator, PostgresDialect, sql, type Migration, type Transaction } from 'kysely';
import pg from 'pg';
import type { BaseConfig } from './config.js';

// DATE stays a calendar string; NUMERIC and BIGINT (counts/sums) become numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export interface Database<DB> {
  db: Kysely<DB>;
  pool: pg.Pool;
  schema: string;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Each service owns exactly one Postgres schema. The pool's search_path pins
 * every unqualified table to that schema, so a service cannot accidentally
 * reach into another service's tables.
 */
export function createDatabase<DB>(config: Pick<BaseConfig, 'DATABASE_URL' | 'DATABASE_SSL' | 'DATABASE_POOL_MAX'>, schema: string): Database<DB> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    max: config.DATABASE_POOL_MAX,
    options: `-c search_path=${schema}`,
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    schema,
    ping: async () => {
      await sql`select 1`.execute(db);
    },
    close: () => db.destroy(),
  };
}

export async function migrate(database: Database<unknown>, migrations: Record<string, Migration>): Promise<string[]> {
  await sql`create schema if not exists ${sql.id(database.schema)}`.execute(database.db);
  const migrator = new Migrator({
    db: database.db,
    migrationTableSchema: database.schema,
    provider: { getMigrations: async () => migrations },
  });
  const { error, results } = await migrator.migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) throw new Error(`Migration ${failed?.migrationName ?? ''} failed: ${String(error)}`);
  return (results ?? []).map((r) => r.migrationName);
}

export type Tx<DB> = Transaction<DB>;

/** Shared column helpers so every migration declares audit columns the same way. */
export const now = sql`now()`;
export const genUuid = sql`gen_random_uuid()`;

/**
 * Runs an optional statement (e.g. an extension that may not be permitted)
 * inside a savepoint, so a failure doesn't abort the surrounding migration.
 * Returns whether it succeeded.
 */
export async function trySavepoint(db: Kysely<any>, name: string, fn: () => Promise<unknown>): Promise<boolean> {
  await sql`savepoint ${sql.id(name)}`.execute(db);
  try {
    await fn();
    await sql`release savepoint ${sql.id(name)}`.execute(db);
    return true;
  } catch {
    await sql`rollback to savepoint ${sql.id(name)}`.execute(db);
    return false;
  }
}
