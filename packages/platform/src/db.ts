import { Migrator, sql, type Kysely, type Migration, type Transaction } from 'kysely';

/**
 * A service's database: a Kysely instance whose unqualified tables resolve to
 * the one schema the service owns. On the server it is a Postgres pool
 * (`@am/platform/node`); in the browser, PGlite (`@am/browser-runtime`).
 */
export interface Database<DB> {
  db: Kysely<DB>;
  schema: string;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const isSchemaName = (s: string) => /^[a-z_][a-z0-9_]*$/.test(s);

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
