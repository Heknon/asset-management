import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'bun:test';
import { workflowPresets, type Asset, type ExtraWorkflow, type Principal, type PurchaseRequest } from '@am/core';
import { migrate, type Database } from '@am/platform';
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type DatabaseConnection } from 'kysely';
import { PgRegistryStore } from '../infrastructure/pg-registry-store.js';
import { migrations, type RegistryDB } from '../infrastructure/schema.js';
import { AccessResolver } from './access.js';
import { AssetService } from './asset-service.js';
import { RequestService } from './request-service.js';
import { TypeService } from './type-service.js';
import { VariantService } from './variant-service.js';

/**
 * Added workflows end to end, on a real (in-process) Postgres: R&D's Lab
 * license adds "Machine status" on the item and "Swap the new license" on its
 * renewals, both the responsibility of the Lab; Procurement buys.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { company: id(1), procurement: id(2), rnd: id(3), lab: id(4), finance: id(5) };

function person(n: number, name: string, units: string[], grants: Principal['grants'] = []): Principal {
  return { userId: id(100 + n), username: name.toLowerCase(), displayName: name, email: null, isAdmin: false, grants, units: units.map((unitId) => ({ unitId, role: 'member' })) };
}
const dana = person(1, 'Dana', [U.procurement], [{ unitId: U.company, assetTypeId: null, permissions: ['view', 'comment', 'attach', 'create', 'edit', 'renew', 'export'] }]);
const tom = person(2, 'Tom', [U.lab], [{ unitId: U.lab, assetTypeId: null, permissions: ['view', 'comment', 'create'] }]);
const noa = person(3, 'Noa', [U.finance], [{ unitId: U.company, assetTypeId: null, permissions: ['view'] }]);
const avi = person(4, 'Avi', [U.procurement], [{ unitId: U.company, assetTypeId: null, permissions: ['view'] }]);
const admin: Principal = { ...person(9, 'Admin', []), isAdmin: true };

async function database() {
  const pg = await PGlite.create();
  await pg.exec('create schema registry; set search_path to registry');
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
  const db = new Kysely<RegistryDB>({
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
  await migrate({ db, schema: 'registry', ping: async () => undefined, close: async () => undefined } as unknown as Database<unknown>, migrations);
  return db;
}

describe('added workflows', () => {
  let store: PgRegistryStore;
  let types: TypeService;
  let assets: AssetService;
  let requests: RequestService;
  let item: Asset;
  let renewal: PurchaseRequest;

  beforeAll(async () => {
    store = new PgRegistryStore(await database(), false);
    const unit = (uid: string, name: string, path: string[]) => store.upsertUnitRef({ id: uid, key: name.toLowerCase(), name, kind: 'team', parentId: path.at(-2) ?? null, path, archived: false });
    await unit(U.company, 'Company', [U.company]);
    await unit(U.procurement, 'Procurement', [U.company, U.procurement]);
    await unit(U.finance, 'Finance', [U.company, U.finance]);
    await unit(U.rnd, 'R&D', [U.company, U.rnd]);
    await unit(U.lab, 'Lab', [U.company, U.rnd, U.lab]);
    for (const p of [dana, tom, noa, avi]) await store.upsertUserRef({ id: p.userId, displayName: p.displayName, active: true });
    types = new TypeService(store);
    assets = new AssetService(store, new AccessResolver(store));
    requests = new RequestService(store, assets);

    const license = await types.createFromTemplate('software_license');
    const lab = (w: Omit<ExtraWorkflow, 'key' | 'responsibleUnitId'>, key: string): ExtraWorkflow => ({ ...w, key, responsibleUnitId: U.lab });
    const variant = await new VariantService(store).create(admin, license.id, {
      unitId: U.rnd,
      name: 'Lab license',
      description: null,
      sections: [],
      fields: [],
      workflows: [lab(workflowPresets.machines, 'machines'), lab(workflowPresets.swap, 'swap')],
    });
    item = await assets.create(dana, { assetTypeId: license.id, name: 'Keysight', ownerId: tom.userId, unitId: U.lab, variantId: variant.id, catalogId: null, attributes: { vendor: 'Keysight', renewal_date: '2027-01-15', term_months: 12 }, reminderOverrides: {} });
  });

  it('starts an item workflow at its first status, moved only by the responsible unit', async () => {
    const asTom = await assets.get(tom, item.id);
    expect(asTom.workflows.map((w) => [w.key, w.statusInfo?.label, w.responsibleUnitId, w.canAct])).toEqual([['machines', 'Not deployed', U.lab, true]]);
    // Finance sees the status but cannot move it.
    const asNoa = await assets.get(noa, item.id);
    expect(asNoa.workflows[0]).toMatchObject({ canAct: false, moves: [], statusInfo: { label: 'Not deployed' } });
    await expect(assets.moveWorkflow(noa, item.id, 'machines', { status: 'installing' })).rejects.toThrow(/responsible/);
    const moved = await assets.moveWorkflow(tom, item.id, 'machines', { status: 'installing' });
    expect(moved.workflows[0]!.statusInfo).toMatchObject({ key: 'installing', category: 'active' });
    await expect(assets.moveWorkflow(tom, item.id, 'machines', { status: 'retired' })).rejects.toThrow(/cannot go from Installing to Retired/);
  });

  it('starts the team’s request workflow when the purchase is done, and shows everything together', async () => {
    renewal = await requests.requestRenewal(tom, item.id, { fieldKey: 'renewal_date', obligationId: null, note: '' });
    expect(renewal.workflows).toMatchObject([{ key: 'swap', started: false, statusInfo: null, responsibleUnitId: U.lab }]);
    expect(renewal.overall).toEqual({ category: 'todo', waitingOn: ['purchase'] });
    // The Lab cannot move a workflow that has not started.
    await expect(requests.act(tom, renewal.id, { action: 'status', status: 'installed', workflow: 'swap' })).rejects.toThrow(/starts once the purchase is done/);

    await requests.act(dana, renewal.id, { action: 'status', status: 'approved' });
    // Given a year and 10 days this time.
    const done = await requests.act(dana, renewal.id, { action: 'status', status: 'fulfilled', renewedUntil: '2028-01-25' });
    expect(done.statusInfo.category).toBe('done');
    expect(done.workflows[0]).toMatchObject({ started: true, statusInfo: { label: 'To install' }, canAct: false });
    expect(done.overall).toEqual({ category: 'todo', waitingOn: ['swap'] });
    // The renewal moved the date to what was bought.
    expect((await assets.get(dana, item.id)).attributes.renewal_date).toBe('2028-01-25');
  });

  it('lists the request as waiting on whoever owns the open workflow', async () => {
    const handle = async (p: Principal) => (await requests.list(p, { scope: 'handle', status: 'open', limit: 50, offset: 0 })).items.map((r) => r.id);
    expect(await handle(tom)).toEqual([renewal.id]);
    expect(await handle(dana)).toEqual([]);
    expect((await requests.counts(tom)).handle).toBe(1);
    // Still open overall: for the requester and in "everything I can see".
    expect((await requests.list(noa, { scope: 'all', status: 'open', limit: 50, offset: 0 })).items.map((r) => r.id)).toEqual([renewal.id]);

    const asTom = await requests.get(tom, renewal.id);
    expect(asTom.workflows[0]).toMatchObject({ canAct: true, moves: [{ key: 'swapping' }, { key: 'installed' }, { key: 'not_needed' }] });
    const finished = await requests.act(tom, renewal.id, { action: 'status', status: 'installed', workflow: 'swap', note: 'All 12 benches' });
    expect(finished.overall).toEqual({ category: 'done', waitingOn: [] });
    expect(await handle(tom)).toEqual([]);
    expect((await requests.list(noa, { scope: 'all', status: 'closed', limit: 50, offset: 0 })).items.map((r) => r.id)).toEqual([renewal.id]);

    const events = await requests.events(tom, renewal.id);
    expect(events.filter((e) => e.workflow === 'swap').map((e) => [e.fromStatus, e.toStatus, e.body])).toEqual([
      [null, 'to_install', null],
      ['to_install', 'installed', 'All 12 benches'],
    ]);
  });

  it('lets members of the unit responsible for purchases handle them', async () => {
    const next = await requests.requestRenewal(tom, item.id, { fieldKey: 'renewal_date', obligationId: null, note: '' });
    await expect(requests.act(avi, next.id, { action: 'status', status: 'approved' })).rejects.toThrow();
    await types.setPurchaseUnit(U.procurement);
    expect((await requests.get(avi, next.id)).access).toBe('handler');
    expect((await requests.list(avi, { scope: 'handle', status: 'open', limit: 50, offset: 0 })).items.map((r) => r.id)).toEqual([next.id]);
    expect((await requests.act(avi, next.id, { action: 'status', status: 'approved' })).statusInfo.key).toBe('approved');
  });

  it('keeps a template’s workflows when an older client saves it without them', async () => {
    const [type] = await store.listTypes(false);
    const withOne = await types.updateType(type!.id, { ...type!, workflows: [{ ...workflowPresets.machines, key: 'bench', responsibleUnitId: null }] }, type!.version);
    const { workflows: _omit, ...rest } = withOne;
    const saved = await types.updateType(type!.id, rest, withOne.version);
    expect(saved.workflows?.map((w) => w.key)).toEqual(['bench']);
    // A variant already uses "machines": the template may not add one with that key.
    await expect(types.updateType(type!.id, { ...saved, workflows: [{ ...workflowPresets.machines, key: 'machines', responsibleUnitId: null }] }, saved.version)).rejects.toThrow(/problems/);
  });
});

describe('login fields', () => {
  it('stores the password with the secrets, never in search, and shows it to whom the field allows', async () => {
    const db = await database();
    const store = new PgRegistryStore(db, false);
    await store.upsertUnitRef({ id: U.company, key: 'company', name: 'Company', kind: 'team', parentId: null, path: [U.company], archived: false });
    for (const p of [dana, tom, noa]) await store.upsertUserRef({ id: p.userId, displayName: p.displayName, active: true });
    const types = new TypeService(store);
    const assets = new AssetService(store, new AccessResolver(store));
    const login = (key: string, ownerCanSee?: boolean) => ({ id: crypto.randomUUID(), key, label: key, kind: 'login' as const, required: false, restricted: false, showInTable: false, ...(ownerCanSee && { ownerCanSee }), config: { secretLabel: 'password' as const } });
    const type = await types.createType({ key: 'portal', name: 'Portal', icon: 'box', color: '#6366f1', statuses: [{ value: 'active', label: 'Active', color: '#10b981', active: true }], sections: [], fields: [login('admin'), login('user_login', true)] });
    const item = await assets.create(admin, {
      assetTypeId: type.id, name: 'Miro', ownerId: tom.userId, unitId: U.company, variantId: null, catalogId: null, reminderOverrides: {},
      attributes: { admin: { url: 'https://miro.com/admin', username: 'ops@corp.com', secret: 'S3cret-admin' }, user_login: { username: 'tom@corp.com', secret: 'S3cret-user' } },
    });
    const row = await db.selectFrom('assets').select(['attributes', 'restricted_attributes', 'search_text']).where('id', '=', item.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(row.attributes)).not.toContain('S3cret');
    expect(row.restricted_attributes).toEqual({ admin: { secret: 'S3cret-admin' }, user_login: { secret: 'S3cret-user' } });
    expect(row.search_text).toContain('ops@corp.com');
    expect(row.search_text).not.toContain('S3cret');
    // Buyers see everything; the owner sees only the password the field allows; others see neither.
    expect((await assets.get(admin, item.id)).attributes.admin).toEqual({ url: 'https://miro.com/admin', username: 'ops@corp.com', secret: 'S3cret-admin' });
    const asTom = (await assets.get(tom, item.id)).attributes;
    expect(asTom.admin).toEqual({ url: 'https://miro.com/admin', username: 'ops@corp.com', hasSecret: true });
    expect(asTom.user_login).toEqual({ username: 'tom@corp.com', secret: 'S3cret-user' });
    expect((await assets.get(noa, item.id)).attributes.user_login).toEqual({ username: 'tom@corp.com', hasSecret: true });
    // An editor without "See secrets" changes the user name; the password is kept.
    const editor = { ...noa, grants: [{ unitId: U.company, assetTypeId: null, permissions: ['view', 'comment', 'attach', 'create', 'edit', 'renew', 'export'] as Principal['grants'][number]['permissions'] }] };
    await assets.update(editor, item.id, { attributes: { admin: { url: 'https://miro.com/admin', username: 'it@corp.com', hasSecret: true } } });
    expect((await assets.get(admin, item.id)).attributes.admin).toEqual({ url: 'https://miro.com/admin', username: 'it@corp.com', secret: 'S3cret-admin' });
  });
});

describe('team fields', () => {
  it('lets a team mark an item as theirs, so it carries their fields, without anyone else having to know them', async () => {
    const store = new PgRegistryStore(await database(), false);
    const unit = (uid: string, name: string, path: string[]) => store.upsertUnitRef({ id: uid, key: name.toLowerCase(), name, kind: 'team', parentId: path.at(-2) ?? null, path, archived: false });
    await unit(U.company, 'Company', [U.company]);
    await unit(U.procurement, 'Procurement', [U.company, U.procurement]);
    await unit(U.rnd, 'R&D', [U.company, U.rnd]);
    await unit(U.lab, 'Lab', [U.company, U.rnd, U.lab]);
    for (const p of [dana, tom, noa]) await store.upsertUserRef({ id: p.userId, displayName: p.displayName, active: true });
    const types = new TypeService(store);
    const assets = new AssetService(store, new AccessResolver(store));
    const requests = new RequestService(store, assets);
    const license = await types.createFromTemplate('software_license');
    const text = (key: string, required = false) => ({ id: crypto.randomUUID(), key, label: key, kind: 'text' as const, required, restricted: false, showInTable: false, config: {} });
    const avi = await new VariantService(store).create(admin, license.id, { unitId: U.lab, name: 'AVI license', description: null, sections: [], fields: [text('workstation', true), text('mac')] });

    // Tom asks for a license: "for us, this is an AVI license".
    const asked = await requests.create(tom, { title: 'Keysight for the lab', description: '', unitId: U.lab, assetTypeId: license.id, quantity: 1, estimatedCost: null, neededBy: null, link: null, variantId: avi.id });
    expect(asked.variantId).toBe(avi.id);
    // Somewhere else, it does not fit.
    await expect(requests.create(dana, { ...asked, title: 'For procurement', unitId: U.procurement, variantId: avi.id, estimatedCost: null })).rejects.toThrow(/only available/);

    // Procurement buys it without knowing the lab's fields (the workstation is required, but not of them).
    const item = await assets.create(dana, { assetTypeId: license.id, name: 'Keysight', ownerId: tom.userId, unitId: U.lab, variantId: null, catalogId: null, requestId: asked.id, attributes: { vendor: 'Keysight', renewal_date: '2027-01-15' }, reminderOverrides: {} });
    expect(item.variantId).toBe(avi.id);

    // Tom (no edit rights) fills them in; only the team's fields.
    const asTom = await assets.get(tom, item.id);
    expect(asTom.teamFields).toEqual({ choices: [{ id: avi.id, name: 'AVI license', unitId: U.lab }], canFill: true });
    const filled = await assets.setTeamFields(tom, item.id, { attributes: { workstation: 'WS-12', mac: 'aa:bb' } });
    expect(filled.attributes).toMatchObject({ vendor: 'Keysight', workstation: 'WS-12', mac: 'aa:bb' });
    await expect(assets.setTeamFields(tom, item.id, { attributes: { vendor: 'Other' } })).rejects.toThrow(/team’s own fields/);
    await expect(assets.update(tom, item.id, { name: 'x' })).rejects.toThrow();
    // Someone outside the team may not.
    expect((await assets.get(noa, item.id)).teamFields).toEqual({ choices: [], canFill: false });
    await expect(assets.setTeamFields(noa, item.id, { attributes: { mac: 'cc' } })).rejects.toThrow(/team/);

    // Items nobody marked stay as they are; the team can turn its fields on later, and off.
    const plain = await assets.create(dana, { assetTypeId: license.id, name: 'Plain', ownerId: tom.userId, unitId: U.lab, variantId: null, catalogId: null, attributes: { vendor: 'X', renewal_date: '2027-01-15' }, reminderOverrides: {} });
    expect(plain.variantId).toBeNull();
    const marked = await assets.setTeamFields(tom, plain.id, { variantId: avi.id, attributes: { mac: 'dd' } });
    expect(marked).toMatchObject({ variantId: avi.id, attributes: { mac: 'dd' } });
    const removed = await assets.setTeamFields(tom, plain.id, { variantId: null, attributes: {} });
    expect(removed.variantId).toBeNull();
    expect(removed.attributes.mac).toBeUndefined();
  });
});
