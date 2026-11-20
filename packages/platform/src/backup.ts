import { AppError, BACKUP_FORMAT, type BackupColumn, type BackupTable, type ServiceBackupInfo } from '@am/core';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import { parse, requireAdmin, textStream } from './http.js';

/**
 * Backup and restore of one service's schema, for administrators.
 *
 * Each service can only see its own schema, so each one serves its own part
 * and the web app puts the parts together into one zip (and takes it apart
 * again for a restore).
 *
 *   backup   one streamed response, read in a single snapshot, with every
 *            value as Postgres text, which casts back to the column's type
 *            unchanged
 *   restore  rows are uploaded in chunks into staging tables next to the real
 *            ones; nothing changes until `commit`, which swaps everything in
 *            one transaction (all or nothing for this service)
 *
 * A backup is only restored into the same schema version: the list of applied
 * migrations has to match.
 */

export interface BackupRules {
  /** Tables that are not backed up and are emptied by a restore (sessions, single-use codes). */
  transient?: string[];
  /** Runs after a restore was committed (e.g. make sure the break-glass administrator exists). */
  afterRestore?: () => Promise<void>;
}

const MIGRATION_TABLES = new Set(['kysely_migration', 'kysely_migration_lock']);
const STAGING = '_restore_';
const SESSION = '_restore_session';
/** Only events that were not handed to the queue yet travel with a backup; a restore relays them again. */
const ROW_FILTERS: Record<string, string> = { outbox: 'published_at is null' };
const DUMP_BATCH = 500;
/** Uploaded chunks; matches the web proxy's request size limit. */
const ROWS_BODY_LIMIT = 4 * 1_048_576;

type Db = Kysely<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Any service's database: the backup reads the catalog instead of typed tables. */
export type BackupDatabase = { db: Db; schema: string };

interface TableShape {
  name: string;
  columns: BackupColumn[];
  /** Computed by Postgres (search vectors); never backed up or written. */
  generated: string[];
}

/** The service's own tables, without migration bookkeeping and restore staging. */
async function readShape(db: Db, schema: string): Promise<TableShape[]> {
  const { rows } = await sql<{ table: string; name: string; type: string; generated: boolean }>`
    select c.relname as "table", a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attgenerated <> '' as generated
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`.execute(db);
  const tables = new Map<string, TableShape>();
  for (const r of rows) {
    if (MIGRATION_TABLES.has(r.table) || r.table.startsWith(STAGING)) continue;
    const t = tables.get(r.table) ?? { name: r.table, columns: [], generated: [] };
    if (r.generated) t.generated.push(r.name);
    else t.columns.push({ name: r.name, type: r.type });
    tables.set(r.table, t);
  }
  return [...tables.values()];
}

async function appliedMigrations(db: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db);
  return rows.map((r) => r.name);
}

const filterOf = (table: string) => (ROW_FILTERS[table] ? sql` where ${sql.raw(ROW_FILTERS[table]!)}` : sql``);

async function countRows(db: Db, table: string): Promise<number> {
  const { rows } = await sql<{ n: string | number }>`select count(*) as n from ${sql.id(table)}${filterOf(table)}`.execute(db);
  return Number(rows[0]!.n);
}

/** What a backup taken now would contain. */
export async function backupInfo(database: BackupDatabase, rules: BackupRules = {}): Promise<ServiceBackupInfo> {
  const db = database.db;
  const transient = new Set(rules.transient ?? []);
  const tables: BackupTable[] = [];
  for (const t of (await readShape(db, database.schema)).filter((t) => !transient.has(t.name))) {
    tables.push({ name: t.name, columns: t.columns, rows: await countRows(db, t.name) });
  }
  return { service: database.schema, migrations: await appliedMigrations(db), tables };
}

/**
 * Runs `produce` and yields what it emits, a few items ahead at most, so a
 * transaction can feed a response that is read slowly. Stops the producer
 * when the reader goes away.
 */
async function* pump<T>(produce: (emit: (value: T) => Promise<void>) => Promise<void>): AsyncGenerator<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let resume: (() => void) | null = null;
  let finished = false;
  let failure: unknown;
  let cancelled = false;
  const cancelledError = new Error('cancelled');

  const emit = async (value: T) => {
    if (cancelled) throw cancelledError;
    queue.push(value);
    wake?.();
    if (queue.length >= 4) await new Promise<void>((r) => (resume = r));
    if (cancelled) throw cancelledError;
  };
  const task = produce(emit)
    .catch((err) => {
      if (err !== cancelledError) failure = err;
    })
    .finally(() => {
      finished = true;
      wake?.();
    });

  try {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        if (queue.length < 2 && resume) {
          const r: () => void = resume;
          resume = null;
          r();
        }
      } else if (finished) break;
      else {
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    }
    if (failure) throw failure;
  } finally {
    cancelled = true;
    (resume as (() => void) | null)?.();
    await task;
  }
}

/**
 * The whole schema as lines of JSON, read in one snapshot:
 *
 *   {"format":1,"service":"registry","migrations":[…]}
 *   {"table":"assets","columns":[{"name":"id","type":"uuid"},…]}
 *   ["6f1c…","Adobe CC",null,…]            one line per row, values as text
 *   …
 *   {"end":true,"rows":{"assets":1204,…}}   missing when the stream was cut short
 */
export function dumpSchema(database: BackupDatabase, rules: BackupRules = {}): AsyncGenerator<string> {
  const transient = new Set(rules.transient ?? []);
  return pump<string>((emit) =>
    database.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const tables = (await readShape(trx, database.schema)).filter((t) => !transient.has(t.name));
        await emit(`${JSON.stringify({ format: BACKUP_FORMAT, service: database.schema, migrations: await appliedMigrations(trx) })}\n`);
        const counts: Record<string, number> = {};
        for (const t of tables) {
          await emit(`${JSON.stringify({ table: t.name, columns: t.columns })}\n`);
          const values = sql.join(t.columns.map((c) => sql`${sql.id(c.name)}::text`));
          const filter = ROW_FILTERS[t.name] ? sql` and ${sql.raw(ROW_FILTERS[t.name]!)}` : sql``;
          let after = '(0,0)';
          let n = 0;
          for (;;) {
            // Pages by physical row position: needs no key, and is stable inside the snapshot.
            const { rows } = await sql<{ at: string; line: string }>`
              select ctid::text as at, to_json(array[${values}]::text[])::text as line
              from ${sql.id(t.name)} where ctid > ${after}::tid${filter} order by ctid limit ${DUMP_BATCH}`.execute(trx);
            if (!rows.length) break;
            n += rows.length;
            after = rows[rows.length - 1]!.at;
            await emit(rows.map((r) => `${r.line}\n`).join(''));
            if (rows.length < DUMP_BATCH) break;
          }
          counts[t.name] = n;
        }
        await emit(`${JSON.stringify({ end: true, rows: counts })}\n`);
      }),
  );
}

const beginSchema = z.object({
  migrations: z.array(z.string()),
  tables: z.array(z.object({ name: z.string(), columns: z.array(z.string()).min(1) })),
});
export type RestorePlan = z.infer<typeof beginSchema>;

const rowsSchema = z.object({
  table: z.string(),
  rows: z.array(z.array(z.string().nullable())).min(1),
});

const commitSchema = z.object({ rows: z.record(z.number().int().nonnegative()) });

const staging = (table: string) => `${STAGING}${table}`;

/** A Postgres error an administrator can act on (bad value, missing reference), without the stack. */
function dataError(what: string, err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { message?: string; detail?: string };
  return AppError.validation(`${what}: ${[e.message, e.detail].filter(Boolean).join(' — ') || 'the database refused the data'}`);
}

async function dropStaging(db: Db, schema: string): Promise<void> {
  const { rows } = await sql<{ name: string }>`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind = 'r' and left(c.relname, ${STAGING.length}) = ${STAGING}`.execute(db);
  for (const r of rows) await sql`drop table ${sql.id(r.name)}`.execute(db);
}

interface Session {
  id: string;
  tables: Record<string, string[]>;
}

async function session(db: Db, schema: string, id: string): Promise<Session> {
  const gone = AppError.conflict('This restore is no longer open: it was finished, cancelled, or replaced by another one. Start again.');
  const exists = await sql`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${schema} and c.relname = ${SESSION}`.execute(db);
  if (!exists.rows.length) throw gone;
  const { rows } = await sql<{ id: string; tables: string }>`select id, tables::text as tables from ${sql.id(SESSION)}`.execute(db);
  if (rows[0]?.id !== id) throw gone;
  return { id, tables: JSON.parse(rows[0].tables) as Record<string, string[]> };
}

/**
 * Opens a restore: checks that the backup fits this schema exactly, then
 * creates empty staging tables. Replaces a restore that was left unfinished.
 */
export async function beginRestore(database: BackupDatabase, rules: BackupRules, plan: RestorePlan, startedBy: string): Promise<{ id: string }> {
  const db = database.db;
  const transient = new Set(rules.transient ?? []);
  const live = (await readShape(db, database.schema)).filter((t) => !transient.has(t.name));

  const current = await appliedMigrations(db);
  if (current.join('\n') !== plan.migrations.join('\n')) {
    const newer = plan.migrations.length > current.length || plan.migrations.some((m) => !current.includes(m));
    throw AppError.conflict(
      newer
        ? `This backup was made by a newer version of the app (${database.schema} data is at “${plan.migrations.at(-1) ?? 'nothing'}”, this installation is at “${current.at(-1) ?? 'nothing'}”). Upgrade this installation, then restore.`
        : `This backup was made by an older version of the app (${database.schema} data is at “${plan.migrations.at(-1) ?? 'nothing'}”, this installation is at “${current.at(-1) ?? 'nothing'}”). Restore it into that version, upgrade, and take a new backup.`,
    );
  }
  const given = new Map(plan.tables.map((t) => [t.name, t.columns]));
  for (const t of live) {
    const columns = given.get(t.name);
    if (!columns) throw AppError.validation(`The backup has no “${t.name}” table for ${database.schema}`);
    const expected = t.columns.map((c) => c.name);
    if (columns.length !== expected.length || new Set(columns).size !== columns.length || !columns.every((c) => expected.includes(c))) {
      throw AppError.validation(`The columns of “${t.name}” in the backup do not match this installation`);
    }
  }
  const unknown = plan.tables.find((t) => !live.some((l) => l.name === t.name));
  if (unknown) throw AppError.validation(`The backup has a table this installation does not know: “${unknown.name}”`);

  const id = globalThis.crypto.randomUUID();
  await db.transaction().execute(async (trx) => {
    await dropStaging(trx, database.schema);
    for (const t of live) {
      await sql`create unlogged table ${sql.id(staging(t.name))} (like ${sql.id(t.name)})`.execute(trx);
      for (const g of t.generated) await sql`alter table ${sql.id(staging(t.name))} drop column ${sql.id(g)}`.execute(trx);
    }
    await sql`create unlogged table ${sql.id(SESSION)} (id text not null, started_by text not null, started_at timestamptz not null default now(), tables jsonb not null)`.execute(trx);
    await sql`insert into ${sql.id(SESSION)} (id, started_by, tables) values (${id}, ${startedBy}, ${JSON.stringify(Object.fromEntries(given))}::jsonb)`.execute(trx);
  });
  return { id };
}

/** Adds a chunk of rows (values as Postgres text, in the column order given at `beginRestore`) to a staging table. */
export async function stageRows(database: BackupDatabase, id: string, table: string, rows: (string | null)[][]): Promise<void> {
  const db = database.db;
  const s = await session(db, database.schema, id);
  const columns = s.tables[table];
  if (!columns) throw AppError.validation(`“${table}” is not part of this restore`);
  if (rows.some((r) => r.length !== columns.length)) throw AppError.validation(`A row of “${table}” does not have ${columns.length} values`);
  const types = new Map((await readShape(db, database.schema)).find((t) => t.name === table)?.columns.map((c) => [c.name, c.type]));
  const values = sql.join(columns.map((c, i) => sql`(r->>${sql.lit(i)})::${sql.raw(types.get(c)!)}`));
  try {
    await sql`insert into ${sql.id(staging(table))} (${sql.join(columns.map((c) => sql.id(c)))}) select ${values} from json_array_elements(${JSON.stringify(rows)}::json) r`.execute(db);
  } catch (err) {
    throw dataError(`“${table}” has a row that does not fit`, err);
  }
}

/**
 * Replaces everything this service stores with the staged rows, in one
 * transaction. `expected` (rows per table, from the backup's manifest) guards
 * against an upload that stopped half-way.
 *
 * `dryRun` does all of it and then rolls back: the web app checks every
 * service this way before committing the first one, so a backup that one
 * service would refuse does not leave the others already replaced.
 */
export async function commitRestore(database: BackupDatabase, rules: BackupRules, id: string, expected: Record<string, number>, { dryRun = false }: { dryRun?: boolean } = {}): Promise<{ rows: number }> {
  const db = database.db;
  const schema = database.schema;
  let total = 0;
  const checked = new Error('checked');
  try {
    await db.transaction().execute(async (trx) => {
      const s = await session(trx, schema, id);
      const shape = await readShape(trx, schema);
      for (const table of Object.keys(s.tables)) {
        const { rows } = await sql<{ n: string | number }>`select count(*) as n from ${sql.id(staging(table))}`.execute(trx);
        if (Number(rows[0]!.n) !== (expected[table] ?? 0)) {
          throw AppError.validation(`“${table}” is incomplete: ${Number(rows[0]!.n)} of ${expected[table] ?? 0} rows arrived. Start the restore again.`);
        }
        total += Number(rows[0]!.n);
      }

      // Rows go in table by table, so references are checked once at the end instead of per statement.
      const { rows: fks } = await sql<{ table: string; name: string }>`
        select c.relname as "table", k.conname as name
        from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${schema} and k.contype = 'f' and not k.condeferrable and left(c.relname, ${STAGING.length}) <> ${STAGING}`.execute(trx);
      for (const k of fks) await sql`alter table ${sql.id(k.table)} alter constraint ${sql.id(k.name)} deferrable initially deferred`.execute(trx);

      await sql`truncate table ${sql.join(shape.map((t) => sql.id(t.name)))}`.execute(trx);
      for (const [table, columns] of Object.entries(s.tables)) {
        const list = sql.join(columns.map((c) => sql.id(c)));
        await sql`insert into ${sql.id(table)} (${list}) select ${list} from ${sql.id(staging(table))}`.execute(trx);
      }
      await sql`set constraints all immediate`.execute(trx);
      for (const k of fks) await sql`alter table ${sql.id(k.table)} alter constraint ${sql.id(k.name)} not deferrable`.execute(trx);

      // Counters continue after the highest restored number and never go back (no reference is handed out twice).
      const { rows: sequences } = await sql<{ table: string; column: string; sequence: string }>`
        select c.relname as "table", a.attname as "column", pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) as sequence
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${schema} and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and left(c.relname, ${STAGING.length}) <> ${STAGING}
          and pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) is not null`.execute(trx);
      for (const q of sequences) {
        await sql`
          select setval(${q.sequence}::regclass, m.top)
          from (select max(${sql.id(q.column)}) as top from ${sql.id(q.table)}) m, ${sql.raw(q.sequence)} s
          where m.top is not null and (m.top > s.last_value or (m.top = s.last_value and not s.is_called))`.execute(trx);
      }
      if (dryRun) throw checked;
      await dropStaging(trx, schema);
    });
  } catch (err) {
    if (err === checked) return { rows: total };
    throw dataError(`The ${schema} data could not be restored and was left as it was`, err);
  }
  await rules.afterRestore?.();
  return { rows: total };
}

/** Drops the staging tables of a restore that will not be committed. */
export async function abortRestore(database: BackupDatabase, id: string): Promise<void> {
  const db = database.db;
  await session(db, database.schema, id);
  await db.transaction().execute((trx) => dropStaging(trx, database.schema));
}

export interface BackupRoutesOptions {
  /** Service (and schema) name; routes live under /api/<name>/backup. */
  name: string;
  database: BackupDatabase;
  logger: Logger;
  /** BACKUP_ENABLED; when off, every route answers 403. */
  enabled: boolean;
  rules?: BackupRules;
}

/** Administrator-only routes for backing up and restoring a service's data. */
export function registerBackupRoutes(app: FastifyInstance, { name, database, logger, enabled, rules = {} }: BackupRoutesOptions): void {
  const prefix = `/api/${name}/backup`;
  const idParam = z.object({ id: z.string().uuid() });
  const admin = (req: Parameters<typeof requireAdmin>[0]) => {
    const principal = requireAdmin(req);
    if (!enabled) throw AppError.forbidden('Backup and restore are turned off for this installation');
    return principal;
  };
  // Who took or restored a backup is always logged: the file holds everything this service stores.
  const audit = (action: string, principal: { userId: string; username: string }, extra: object = {}) =>
    logger.info({ audit: 'backup', action, service: name, userId: principal.userId, username: principal.username, ...extra }, `backup: ${action}`);

  app.get(`${prefix}/info`, async (req) => {
    admin(req);
    return backupInfo(database, rules);
  });

  app.get(`${prefix}/data`, async (req, reply) => {
    audit('download', admin(req));
    return reply.header('content-type', 'application/x-ndjson; charset=utf-8').send(textStream(dumpSchema(database, rules)));
  });

  app.post(`${prefix}/restore`, async (req) => {
    const principal = admin(req);
    const result = await beginRestore(database, rules, parse(beginSchema, req.body), principal.username);
    audit('restore started', principal, { restoreId: result.id });
    return result;
  });

  app.post(`${prefix}/restore/:id/rows`, { bodyLimit: ROWS_BODY_LIMIT }, async (req, reply) => {
    admin(req);
    const { table, rows } = parse(rowsSchema, req.body);
    await stageRows(database, parse(idParam, req.params).id, table, rows);
    return reply.status(204).send();
  });

  app.post(`${prefix}/restore/:id/check`, async (req) => {
    admin(req);
    return commitRestore(database, rules, parse(idParam, req.params).id, parse(commitSchema, req.body).rows, { dryRun: true });
  });

  app.post(`${prefix}/restore/:id/commit`, async (req) => {
    const principal = admin(req);
    const { id } = parse(idParam, req.params);
    const result = await commitRestore(database, rules, id, parse(commitSchema, req.body).rows);
    audit('restored', principal, { restoreId: id, rows: result.rows });
    return result;
  });

  app.delete(`${prefix}/restore/:id`, async (req, reply) => {
    const principal = admin(req);
    const { id } = parse(idParam, req.params);
    await abortRestore(database, id);
    audit('restore cancelled', principal, { restoreId: id });
    return reply.status(204).send();
  });
}
