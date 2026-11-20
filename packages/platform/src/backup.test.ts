import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'bun:test';
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql, type DatabaseConnection, type Migration } from 'kysely';
import { abortRestore, backupInfo, beginRestore, commitRestore, dumpSchema, stageRows, uploadBackupPart, type BackupDatabase, type BackupRules } from './backup.js';
import { migrate, type Database } from './db.js';

/** An in-process Postgres (PGlite) with one schema, like a service's database. */
async function database(schema: string, migrations: Record<string, Migration>): Promise<BackupDatabase> {
  const pg = await PGlite.create();
  await pg.exec(`create schema ${schema}; set search_path to ${schema}`);
  const connection: DatabaseConnection = {
    executeQuery: async <R>(q: CompiledQuery) => {
      const r = await pg.query<R>(q.sql, [...q.parameters]);
      return { rows: r.rows, numAffectedRows: BigInt(r.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not supported');
    },
  };
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => connection,
        beginTransaction: async (c) => void (await c.executeQuery(CompiledQuery.raw('begin'))),
        commitTransaction: async (c) => void (await c.executeQuery(CompiledQuery.raw('commit'))),
        rollbackTransaction: async (c) => void (await c.executeQuery(CompiledQuery.raw('rollback'))),
        releaseConnection: async () => undefined,
        destroy: async () => undefined,
      }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  await migrate({ db, schema, ping: async () => undefined, close: async () => undefined } as Database<unknown>, migrations);
  return { db, schema };
}

const migrations: Record<string, Migration> = {
  '0001_shop': {
    async up(db) {
      await sql`create table kinds (id uuid primary key, name text not null, parent_id uuid references kinds(id))`.execute(db);
      await sql`create table things (
        id uuid primary key,
        kind_id uuid not null references kinds(id),
        seq bigserial not null unique,
        name text not null,
        note text,
        tags text[] not null default '{}',
        attributes jsonb not null,
        price numeric(10,2),
        bought_on date,
        changed_at timestamptz not null,
        active boolean not null default true,
        search tsvector generated always as (to_tsvector('simple', name)) stored
      )`.execute(db);
      await sql`create table sessions (id uuid primary key, thing_id uuid not null references things(id) on delete cascade)`.execute(db);
      await sql`create table outbox (id bigserial primary key, event text not null, payload jsonb not null, published_at timestamptz)`.execute(db);
    },
  },
};
const rules: BackupRules = { transient: ['sessions'] };

const K1 = '00000000-0000-4000-8000-000000000001';
const K2 = '00000000-0000-4000-8000-000000000002';
const T = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seed({ db }: BackupDatabase) {
  // The child kind comes first: a restore must not depend on the order rows were written in.
  await sql`insert into kinds (id, name, parent_id) values (${K2}, 'Laptops', null)`.execute(db);
  await sql`insert into kinds (id, name, parent_id) values (${K1}, 'Hardware', null)`.execute(db);
  await sql`update kinds set parent_id = ${K1} where id = ${K2}`.execute(db);
  await sql`insert into things (id, kind_id, name, note, tags, attributes, price, bought_on, changed_at) values
    (${T(1)}, ${K2}, 'מחשב נייד, "Pro"', null, '{"a b",c,"NULL",""}', '{"key": "it''s \\"quoted\\"", "n": [1, 2.5, null]}', 1234.50, '2026-02-28', '2026-11-20T10:00:00.123456+02'),
    (${T(2)}, ${K1}, E'line one\\r\\nline two', '', '{}', '{}', null, null, '2020-01-01T00:00:00Z')`.execute(db);
  await sql`insert into sessions (id, thing_id) values (${T(99)}, ${T(1)})`.execute(db);
  await sql`insert into outbox (event, payload, published_at) values ('sent', '{}', now()), ('waiting', '{"a": 1}', null)`.execute(db);
}

interface Dump {
  migrations: string[];
  tables: Record<string, { columns: string[]; rows: (string | null)[][] }>;
  counts: Record<string, number>;
}

async function dump(d: BackupDatabase): Promise<Dump> {
  let text = '';
  for await (const chunk of dumpSchema(d, rules)) text += chunk;
  const out: Dump = { migrations: [], tables: {}, counts: {} };
  let current = '';
  for (const line of text.split('\n').filter(Boolean)) {
    const v = JSON.parse(line);
    if (Array.isArray(v)) out.tables[current]!.rows.push(v);
    else if (v.migrations) out.migrations = v.migrations;
    else if (v.table) out.tables[(current = v.table)] = { columns: v.columns.map((c: { name: string }) => c.name), rows: [] };
    else if (v.end) out.counts = v.rows;
  }
  return out;
}

const plan = (d: Dump) => ({ migrations: d.migrations, tables: Object.entries(d.tables).map(([name, t]) => ({ name, columns: [...t.columns] })) });
const sorted = (d: Dump) => Object.fromEntries(Object.entries(d.tables).map(([k, t]) => [k, t.rows.map((r) => JSON.stringify(r)).sort()]));

async function restore(target: BackupDatabase, d: Dump, counts = d.counts) {
  const { id } = await beginRestore(target, rules, plan(d), 'admin');
  for (const [name, t] of Object.entries(d.tables)) if (t.rows.length) await stageRows(target, id, name, t.rows);
  await commitRestore(target, rules, id, counts, { dryRun: true });
  return commitRestore(target, rules, id, counts);
}

describe('backup and restore of a schema', () => {
  let source: BackupDatabase;
  let taken: Dump;

  beforeAll(async () => {
    source = await database('shop', migrations);
    await seed(source);
    taken = await dump(source);
  });

  it('describes what a backup would hold, without transient tables, bookkeeping and computed columns', async () => {
    const info = await backupInfo(source, rules);
    expect(info.migrations).toEqual(['0001_shop']);
    expect(info.tables.map((t) => [t.name, t.rows])).toEqual([['kinds', 2], ['outbox', 1], ['things', 2]]);
    expect(info.tables.find((t) => t.name === 'things')!.columns.map((c) => c.name)).not.toContain('search');
    expect(info.tables.find((t) => t.name === 'things')!.columns.find((c) => c.name === 'price')!.type).toBe('numeric(10,2)');
  });

  it('dumps every value as text, NULL as null, and only events that were not sent yet', () => {
    expect(taken.counts).toEqual({ kinds: 2, outbox: 1, things: 2 });
    const thing = Object.fromEntries(taken.tables.things!.columns.map((c, i) => [c, taken.tables.things!.rows.find((r) => r[0] === T(1))![i]]));
    expect(thing).toMatchObject({ name: 'מחשב נייד, "Pro"', note: null, tags: '{"a b",c,"NULL",""}', price: '1234.50', bought_on: '2026-02-28', active: 'true' });
    expect(JSON.parse(thing.attributes!)).toEqual({ key: 'it\'s "quoted"', n: [1, 2.5, null] });
    expect(taken.tables.outbox!.rows.map((r) => r[1])).toEqual(['waiting']);
  });

  it('restores into an empty installation of the same version, exactly', async () => {
    const target = await database('shop', migrations);
    expect(await restore(target, taken)).toEqual({ rows: 5 });
    expect(sorted(await dump(target))).toEqual(sorted(taken));
    // Computed columns are rebuilt, and counters continue after the highest restored number.
    const found = await sql<{ id: string }>`select id from things where search @@ to_tsquery('simple', 'pro')`.execute(target.db);
    expect(found.rows.map((r) => r.id)).toEqual([T(1)]);
    await sql`insert into things (id, kind_id, name, attributes, changed_at) values (${T(3)}, ${K1}, 'next', '{}', now())`.execute(target.db);
    const seq = await sql<{ seq: string }>`select seq::text from things where id = ${T(3)}`.execute(target.db);
    expect(seq.rows[0]!.seq).toBe('3');
    // Staging is gone and references are checked immediately again.
    const leftovers = await sql`select 1 from pg_class where relname like '\\_restore%'`.execute(target.db);
    expect(leftovers.rows).toHaveLength(0);
    await expect(sql`insert into things (id, kind_id, name, attributes, changed_at) values (${T(4)}, ${T(4)}, 'orphan', '{}', now())`.execute(target.db)).rejects.toThrow(/foreign key/);
  });

  it('replaces what was there, including tables that are not backed up', async () => {
    const target = await database('shop', migrations);
    await seed(target);
    await sql`delete from things where id = ${T(2)}`.execute(target.db);
    await sql`update things set name = 'changed'`.execute(target.db);
    await restore(target, taken);
    expect(sorted(await dump(target))).toEqual(sorted(taken));
    expect((await sql`select 1 from sessions`.execute(target.db)).rows).toHaveLength(0);
  });

  it('refuses a backup from another version before touching anything', async () => {
    const target = await database('shop', migrations);
    await expect(beginRestore(target, rules, { ...plan(taken), migrations: [] }, 'admin')).rejects.toThrow(/older version/);
    await expect(beginRestore(target, rules, { ...plan(taken), migrations: ['0001_shop', '0002_more'] }, 'admin')).rejects.toThrow(/newer version/);
    const lessColumns = plan(taken);
    lessColumns.tables.find((t) => t.name === 'things')!.columns.pop();
    await expect(beginRestore(target, rules, lessColumns, 'admin')).rejects.toThrow(/columns of “things”/);
  });

  it('leaves everything as it was when the data does not fit', async () => {
    const target = await database('shop', migrations);
    await seed(target);
    await sql`update things set name = 'current'`.execute(target.db);
    const before = sorted(await dump(target));

    // A value of the wrong type is refused on upload.
    const { id } = await beginRestore(target, rules, plan(taken), 'admin');
    const bad = taken.tables.things!.rows.map((r) => [...r]);
    bad[0]![0] = 'not-a-uuid';
    await expect(stageRows(target, id, 'things', bad)).rejects.toThrow(/does not fit/);

    // An upload that stopped half-way is refused on commit.
    await stageRows(target, id, 'kinds', taken.tables.kinds!.rows);
    await expect(commitRestore(target, rules, id, taken.counts)).rejects.toThrow(/incomplete/);

    // A row whose reference is missing fails the whole restore.
    const broken: Dump = { ...taken, tables: { ...taken.tables, kinds: { ...taken.tables.kinds!, rows: taken.tables.kinds!.rows.filter((r) => r[0] !== K2) } } };
    await expect(restore(target, broken, { ...taken.counts, kinds: 1 })).rejects.toThrow(/left as it was/);

    expect(sorted(await dump(target))).toEqual(before);
  });

  it('a new restore replaces an unfinished one, and a cancelled one cannot be committed', async () => {
    const target = await database('shop', migrations);
    const first = await beginRestore(target, rules, plan(taken), 'admin');
    const second = await beginRestore(target, rules, plan(taken), 'admin');
    await expect(stageRows(target, first.id, 'kinds', taken.tables.kinds!.rows)).rejects.toThrow(/no longer open/);
    await abortRestore(target, second.id);
    await expect(commitRestore(target, rules, second.id, {})).rejects.toThrow(/no longer open/);
  });

  it('uploads its part of a backup to storage as numbered pieces and a marker', async () => {
    const sent: Array<{ url: string; fields: Record<string, string>; body: string }> = [];
    const send = (async (url: string, init: { body: FormData }) => {
      const fields: Record<string, string> = {};
      let body = '';
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') fields[k] = v;
        else body = await v.text();
      }
      // S3 reads nothing after the file.
      expect([...init.body.keys()].at(-1)).toBe('file');
      sent.push({ url, fields, body });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const upload = { url: 'https://s3.example/bucket', fields: { key: 'backups/work/b1/${filename}', Policy: 'p' }, keyPrefix: 'backups/work/b1/' };
    expect(await uploadBackupPart(source, rules, upload, send)).toEqual({ pieces: 1 });
    expect(sent.map((p) => [p.url, p.fields.key, p.fields.Policy])).toEqual([
      ['https://s3.example/bucket', 'backups/work/b1/shop/000001', 'p'],
      ['https://s3.example/bucket', 'backups/work/b1/shop/done.json', 'p'],
    ]);
    const lines = sent[0]!.body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ format: 1, service: 'shop', migrations: ['0001_shop'] });
    expect(lines.at(-1)).toEqual({ end: true, rows: taken.counts });
    expect(JSON.parse(sent[1]!.body)).toEqual({ service: 'shop', pieces: 1 });

    const refused = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    await expect(uploadBackupPart(source, rules, upload, refused)).rejects.toThrow(/refused/);
  });
});
