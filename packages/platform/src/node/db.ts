import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { BaseConfig } from '../config.js';
import { isSchemaName, type Database } from '../db.js';

// DATE stays a calendar string; NUMERIC and BIGINT (counts/sums) become numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export interface PgDatabase<DB> extends Database<DB> {
  pool: pg.Pool;
}

/**
 * Each service owns exactly one Postgres schema. The pool's search_path pins
 * every unqualified table to that schema, so a service cannot accidentally
 * reach into another service's tables.
 */
export function createDatabase<DB>(config: Pick<BaseConfig, 'DATABASE_URL' | 'DATABASE_SSL' | 'DATABASE_POOL_MAX'>, schema: string): PgDatabase<DB> {
  if (!isSchemaName(schema)) throw new Error(`Invalid schema name: ${schema}`);
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
