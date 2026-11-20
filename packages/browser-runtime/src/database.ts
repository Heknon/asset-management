import { PGlite, types, type Extension } from '@electric-sql/pglite';
import { isSchemaName, type Database } from '@am/platform';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';

/**
 * Postgres in the browser: one PGlite database stored in IndexedDB, with a
 * schema per service exactly as on the server.
 *
 * Every statement runs as one atomic step "point search_path at my schema,
 * then execute", so services can share the single PGlite session without
 * reaching each other's tables. Transactions are plain BEGIN/COMMIT on that
 * session: a query made outside the transaction object while it is open
 * simply joins it (on the server it would use another pool connection), which
 * avoids the deadlock a transaction lock would cause.
 */

/** Same conversions as the server's pg type parsers (DATE as text, NUMERIC and BIGINT as numbers). */
const parsers = {
  [types.DATE]: (v: string) => v,
  [types.NUMERIC]: (v: string) => Number(v),
  [types.INT8]: (v: string) => Number(v),
};

export interface PgliteAssets {
  /** Where pglite.wasm, initdb.wasm, pglite.data and the extension bundles are served. */
  baseUrl: string;
}

export async function openPglite(dataDir: string, assets: PgliteAssets): Promise<PGlite> {
  const url = (file: string) => new URL(file, assets.baseUrl).href;
  const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
    WebAssembly.compileStreaming(fetch(url('pglite.wasm'))),
    WebAssembly.compileStreaming(fetch(url('initdb.wasm'))),
    fetch(url('pglite.data')).then((r) => r.blob()),
  ]);
  // Typo-tolerant search (registry) uses pg_trgm, as on the server.
  const pg_trgm: Extension = { name: 'pg_trgm', setup: async () => ({ bundlePath: new URL(url('pg_trgm.tar.gz')) }) };
  // Flushing to IndexedDB happens in the background instead of after every statement (a crash can lose the last moment of work, never corrupt it).
  return PGlite.create({ dataDir, pgliteWasmModule, initdbWasmModule, fsBundle, parsers, extensions: { pg_trgm }, relaxedDurability: true });
}

/** One statement at a time across all services (pairs of "set search_path" + statement must not interleave). */
class StatementLock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const TRANSACTION_CONTROL = /^\s*(begin|start\s+transaction|commit|end|rollback|savepoint|release)\b/i;
const WRITES = /^\s*(insert|update|delete|merge)\b/i;

class PgliteConnection implements DatabaseConnection {
  constructor(
    private readonly pg: PGlite,
    private readonly schema: string,
    private readonly lock: StatementLock,
  ) {}

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    return this.lock.run(async () => {
      // A failed statement aborts the transaction; only transaction control may follow, so it must not be preceded by SET.
      if (!TRANSACTION_CONTROL.test(query.sql)) await this.pg.query(`set search_path to ${this.schema}`);
      const result = await this.pg.query<R>(query.sql, [...query.parameters]);
      return {
        rows: result.rows,
        ...(WRITES.test(query.sql) && { numAffectedRows: BigInt(result.affectedRows ?? 0) }),
      };
    });
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming queries are not supported in the browser runtime');
  }
}

class PgliteDriver implements Driver {
  private readonly connection: PgliteConnection;
  constructor(pg: PGlite, schema: string, lock: StatementLock) {
    this.connection = new PgliteConnection(pg, schema, lock);
  }
  async init() {}
  async acquireConnection() {
    return this.connection;
  }
  async beginTransaction(c: DatabaseConnection) {
    await c.executeQuery(CompiledQuery.raw('begin'));
  }
  async commitTransaction(c: DatabaseConnection) {
    await c.executeQuery(CompiledQuery.raw('commit'));
  }
  async rollbackTransaction(c: DatabaseConnection) {
    await c.executeQuery(CompiledQuery.raw('rollback'));
  }
  async releaseConnection() {}
  async destroy() {}
}

const lock = new StatementLock();

/** A service's database on the shared PGlite: the browser counterpart of `createDatabase` in `@am/platform/node`. */
export function pgliteDatabase<DB>(pg: PGlite, schema: string): Database<DB> {
  if (!isSchemaName(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PgliteDriver(pg, schema, lock),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  const db = new Kysely<DB>({ dialect });
  return {
    db,
    schema,
    ping: async () => {
      await db.executeQuery(CompiledQuery.raw('select 1'));
    },
    close: async () => undefined,
  };
}
