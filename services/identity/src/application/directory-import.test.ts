import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'bun:test';
import { migrate, type Database } from '@am/platform';
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type DatabaseConnection } from 'kysely';
import type { DirectoryPerson } from '../domain/directory.js';
import { PgIdentityStore } from '../infrastructure/pg-identity-store.js';
import { migrations, type IdentityDB } from '../infrastructure/schema.js';
import { DirectoryImportService, orgTagFor } from './directory-import.js';
import { OrgService } from './org-service.js';
import type { DirectoryCrawler } from './ports.js';

/** The directory import end to end, on a real (in-process) Postgres, with a directory in memory. */

async function database() {
  const pg = await PGlite.create();
  await pg.exec('create schema identity; set search_path to identity');
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
  const db = new Kysely<IdentityDB>({
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
  await migrate({ db, schema: 'identity', ping: async () => undefined, close: async () => undefined } as unknown as Database<unknown>, migrations);
  return db;
}

const dn = (cn: string) => `CN=${cn},OU=Users,DC=acme,DC=com`;
function person(cn: string, company: string, division: string | null, department: string | null, manager: string | null): DirectoryPerson {
  return {
    dn: dn(cn),
    username: cn.toLowerCase(),
    displayName: cn,
    email: `${cn.toLowerCase()}@acme.com`,
    otherNames: [],
    groups: [`CN=${division ?? 'all'}-people,OU=Groups,DC=acme,DC=com`],
    attributes: { company: [company], ...(division && { division: [division] }), ...(department && { department: [department] }) },
    managerDn: manager ? dn(manager) : null,
  };
}

class FakeDirectory implements DirectoryCrawler {
  people: DirectoryPerson[] = [];
  async crawl() {
    return { people: this.people, complete: true };
  }
}

describe('directory import', () => {
  let store: PgIdentityStore;
  let org: OrgService;
  let directory: FakeDirectory;
  let service: DirectoryImportService;
  const rule = { kind: 'attributes' as const, attributes: ['company', 'division', 'department'] };

  beforeAll(async () => {
    store = new PgIdentityStore(await database());
    org = new OrgService(store);
    directory = new FakeDirectory();
    directory.people = [
      person('Ceo', 'Acme', null, null, null),
      person('Dana', 'Acme', 'R&D', null, 'Ceo'),
      person('Tom', 'Acme', 'R&D', 'Platform', 'Dana'),
      person('Avi', 'Acme', 'R&D', 'Platform', 'Tom'),
      person('Ben', 'Acme', 'R&D', 'Platform', 'Tom'),
      person('Lia', 'Acme', 'R&D', 'Mobile', 'Dana'),
      person('Sam', 'Acme', 'Sales', null, 'Ceo'),
      person('Ron', 'Acme', 'Sales', null, 'Sam'),
    ];
    service = new DirectoryImportService(store, org, directory, 10_000);
  });

  it('previews the suggested tree, with heads, before changing anything', async () => {
    const preview = await service.preview();
    expect(preview.rule).toEqual(rule);
    expect(preview.units.map((u) => [u.path.join(' / '), u.people, u.manager?.name ?? null])).toEqual([
      ['Acme', 1, 'Ceo'],
      ['Acme / R&D', 1, 'Dana'],
      ['Acme / Sales', 2, 'Sam'],
      ['Acme / R&D / Mobile', 1, null],
      ['Acme / R&D / Platform', 3, 'Tom'],
    ]);
    expect(preview.users).toMatchObject({ create: 8, update: 0, deactivate: 0 });
    expect(await store.listUnits(true)).toEqual([]);
  });

  it('creates the units, everyone’s account, their places and the heads', async () => {
    const result = await service.apply({ rule, exclude: [], managers: true, deactivateLeavers: true, kinds: ['Company', 'Division', 'Department', 'Team'] });
    expect(result).toMatchObject({ unitsCreated: 5, unitsLinked: 0, usersCreated: 8, managersSet: 4, unplaced: 0 });
    const units = await store.listUnits(false);
    const unit = (name: string) => units.find((u) => u.name === name)!;
    expect(unit('Platform').directoryMembers).toEqual(['org:Acme / R&D / Platform']);
    expect(unit('Platform').kind).toBe('Department');
    const people = await store.unitPeople(unit('Platform').id);
    expect(people.filter((p) => p.role === 'member').map((p) => p.displayName).sort()).toEqual(['Avi', 'Ben', 'Tom']);
    expect(people.filter((p) => p.role === 'manager').map((p) => p.displayName)).toEqual(['Tom']);
  });

  it('runs again without duplicates, follows moves, and deactivates leavers', async () => {
    // Ben moves to Mobile; Ron leaves.
    directory.people = directory.people.filter((p) => p.username !== 'ron').map((p) => (p.username === 'ben' ? { ...p, attributes: { ...p.attributes, department: ['Mobile'] } } : p));
    // Opening the import reads the directory afresh (with the saved rule).
    const preview = await service.preview();
    expect(preview.rule).toEqual(rule);
    expect(preview.users).toMatchObject({ create: 0, update: 7, deactivate: 1, deactivateSample: ['Ron'] });
    const result = await service.apply({ rule, exclude: [], managers: true, deactivateLeavers: true, kinds: ['Company', 'Division', 'Department', 'Team'] });
    expect(result).toMatchObject({ unitsCreated: 0, usersCreated: 0, usersUpdated: 7, usersDeactivated: 1 });
    const units = await store.listUnits(false);
    expect(units).toHaveLength(5);
    const mobile = await store.unitPeople(units.find((u) => u.name === 'Mobile')!.id);
    expect(mobile.filter((p) => p.role === 'member').map((p) => p.displayName).sort()).toEqual(['Ben', 'Lia']);
    // Mobile has no lead of its own; both report up to Dana, who heads it now.
    expect(mobile.filter((p) => p.role === 'manager').map((p) => p.displayName)).toEqual(['Dana']);
    expect((await store.findUserByExternalId('ldap', dn('Ron')))?.active).toBe(false);
  });

  it('keeps people placed at sign-in, by the saved rule', async () => {
    const tag = await orgTagFor(store, { source: 'ldap', externalId: dn('Gal'), attributes: { company: ['Acme'], division: ['R&D'], department: ['Platform'] } });
    expect(tag).toBe('org:Acme / R&D / Platform');
    expect(await orgTagFor(store, { source: 'oidc', externalId: 'x', attributes: { company: ['Acme'] } })).toBeNull();
  });

  it('suggests links while typing', async () => {
    const links = await store.directoryLinkSuggestions('platf', 10);
    expect(links[0]).toMatchObject({ link: 'org:Acme / R&D / Platform', people: 2 });
    expect((await store.directoryLinkSuggestions('sales-people', 10))[0]?.label).toBe('Sales-people');
  });
});
