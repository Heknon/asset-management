import {
  AppError,
  foldText,
  type ActivityEntry,
  type AssetQuery,
  type AssetType,
  type AssetTypeInput,
  type DateKind,
  type DateKindInput,
  type EventMap,
  type EventName,
  type RequestEvent,
  type RequestQuery,
  type RequestStatus,
  type SavedView,
  type SavedViewInput,
  type Scope,
} from '@am/core';
import { enqueue, inSubtree, scopeFilter } from '@am/platform';
import { sql, type Kysely, type Selectable, type SqlBool } from 'kysely';
import type { RegistryStore, RequestRow, UnitRef } from '../application/ports.js';
import { splitRestricted, type AssetDraft, type AssetState } from '../domain/asset.js';
import type { RequestState } from '../domain/request.js';
import type { RegistryDB } from './schema.js';
import { filterExpression, textSearch } from './sql-search.js';

const json = (v: unknown) => JSON.stringify(v);
const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

const toKind = (r: Selectable<RegistryDB['date_kinds']>): DateKind => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description ?? undefined,
  color: r.color,
  behavior: r.behavior,
  actionLabel: r.action_label,
  defaultRecurrence: r.default_recurrence ?? undefined,
  defaultReminders: r.default_reminders,
  archived: r.archived,
});

const toType = (r: Selectable<RegistryDB['asset_types']>): AssetType => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description ?? undefined,
  icon: r.icon,
  color: r.color,
  statuses: r.statuses,
  sections: r.sections,
  fields: r.fields,
  version: r.version,
  archived: r.archived,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

type AssetRow = Selectable<RegistryDB['assets']> & { unit_path: string[] | null; snippet?: string | null };

const toAsset = (r: AssetRow): AssetState & { snippet?: string } => ({
  id: r.id,
  assetTypeId: r.asset_type_id,
  typeVersion: r.type_version,
  name: r.name,
  status: r.status,
  ownerId: r.owner_id,
  unitId: r.unit_id,
  unitPath: r.unit_path ?? [r.unit_id],
  values: { ...r.attributes, ...r.restricted_attributes },
  reminderOverrides: r.reminder_overrides,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.snippet && r.snippet.includes('«') ? { snippet: r.snippet } : {}),
});

type RequestRowDb = Selectable<RegistryDB['requests']> & { unit_path: string[] | null; comment_count?: number | string | null; snippet?: string | null };

const toRequest = (r: RequestRowDb): RequestState & { snippet?: string } => ({
  id: r.id,
  seq: Number(r.seq),
  title: r.title,
  description: r.description,
  unitId: r.unit_id,
  unitPath: r.unit_path ?? [r.unit_id],
  assetTypeId: r.asset_type_id,
  requesterId: r.requester_id,
  requesterName: r.requester_name,
  assigneeId: r.assignee_id,
  status: r.status,
  quantity: r.quantity,
  estimatedCost: r.estimated_amount !== null && r.estimated_currency ? { amount: Number(r.estimated_amount), currency: r.estimated_currency } : null,
  neededBy: r.needed_by,
  link: r.link,
  assetId: r.asset_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  commentCount: Number(r.comment_count ?? 0),
  ...(r.snippet && r.snippet.includes('«') ? { snippet: r.snippet } : {}),
});

type Visibility = { userId: string; viewScopes: Scope[]; editScopes: Scope[]; myUnitIds: string[] };

const SORT_COLUMNS = { name: 'name', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' } as const;
/** Columns shown by name rather than id sort by that name (case-insensitive). */
const SORT_LOOKUPS = {
  type: sql`(select lower(t.name) from asset_types t where t.id = assets.asset_type_id)`,
  unit: sql`lower(units_ref.name)`,
  owner: sql`(select lower(u.display_name) from users_ref u where u.id = assets.owner_id)`,
} as const;

export class PgRegistryStore implements RegistryStore {
  /** Types are cached only within a transaction, never across requests or replicas. */
  private readonly typeCache = new Map<string, AssetType | null>();

  /** `fuzzy`: pg_trgm is installed, so typo-tolerant matching is available. */
  constructor(
    private readonly db: Kysely<RegistryDB>,
    private readonly fuzzy = false,
  ) {}

  transaction<T>(fn: (store: RegistryStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new PgRegistryStore(trx, this.fuzzy)));
  }

  // ─── Date kinds ──────────────────────────────────────────────────────────

  async listDateKinds() {
    return (await this.db.selectFrom('date_kinds').selectAll().orderBy('name').execute()).map(toKind);
  }

  private kindValues(input: DateKindInput) {
    return {
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      color: input.color,
      behavior: input.behavior,
      action_label: input.actionLabel,
      default_recurrence: json(input.defaultRecurrence ?? null),
      default_reminders: json(input.defaultReminders),
    };
  }

  async createDateKind(input: DateKindInput) {
    try {
      return toKind(await this.db.insertInto('date_kinds').values(this.kindValues(input)).returningAll().executeTakeFirstOrThrow());
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(`Date kind "${input.key}" already exists`);
      throw e;
    }
  }

  async updateDateKind(id: string, input: DateKindInput & { archived: boolean }) {
    const r = await this.db.updateTable('date_kinds').set({ ...this.kindValues(input), archived: input.archived }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw AppError.notFound('Date kind');
    return toKind(r);
  }

  // ─── Asset types ─────────────────────────────────────────────────────────

  async listTypes(includeArchived: boolean) {
    let q = this.db.selectFrom('asset_types').selectAll().orderBy('name');
    if (!includeArchived) q = q.where('archived', '=', false);
    return (await q.execute()).map(toType);
  }

  async getType(id: string) {
    if (this.db.isTransaction && this.typeCache.has(id)) return this.typeCache.get(id) ?? null;
    const r = await this.db.selectFrom('asset_types').selectAll().where('id', '=', id).executeTakeFirst();
    const type = r ? toType(r) : null;
    if (this.db.isTransaction) this.typeCache.set(id, type);
    return type;
  }

  private typeValues(input: AssetTypeInput) {
    return {
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      icon: input.icon,
      color: input.color,
      statuses: json(input.statuses),
      sections: json(input.sections),
      fields: json(input.fields),
    };
  }

  async createType(input: AssetTypeInput) {
    try {
      return toType(await this.db.insertInto('asset_types').values({ ...this.typeValues(input), version: 1 }).returningAll().executeTakeFirstOrThrow());
    } catch (e) {
      if (isUniqueViolation(e)) throw AppError.conflict(`An asset type with key "${input.key}" already exists`);
      throw e;
    }
  }

  /** Optimistic concurrency: two admins editing the same template cannot silently overwrite each other. */
  async updateType(id: string, input: AssetTypeInput, expectedVersion: number) {
    const r = await this.db
      .updateTable('asset_types')
      .set({ ...this.typeValues(input), version: sql`version + 1`, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!r) {
      const exists = await this.db.selectFrom('asset_types').select('id').where('id', '=', id).executeTakeFirst();
      throw exists ? AppError.conflict('The template was changed by someone else. Reload and try again.') : AppError.notFound('Asset type');
    }
    this.typeCache.delete(id);
    return toType(r);
  }

  async setTypeArchived(id: string, archived: boolean) {
    const r = await this.db.updateTable('asset_types').set({ archived, updated_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirst();
    if (!r) throw AppError.notFound('Asset type');
    this.typeCache.delete(id);
    return toType(r);
  }

  async countAssetsOfType(id: string) {
    const r = await this.db.selectFrom('assets').select((eb) => eb.fn.countAll<number>().as('n')).where('asset_type_id', '=', id).executeTakeFirstOrThrow();
    return Number(r.n);
  }

  // ─── Assets ──────────────────────────────────────────────────────────────

  private assets() {
    return this.db
      .selectFrom('assets')
      .leftJoin('units_ref', 'units_ref.id', 'assets.unit_id')
      .selectAll('assets')
      .select(sql<string[] | null>`units_ref.path`.as('unit_path'));
  }

  async queryAssets(query: AssetQuery, scopes: Scope[], type: AssetType | null) {
    const search = query.q ? textSearch('assets', query.q, this.fuzzy) : null;
    let q = this.db
      .selectFrom('assets')
      .leftJoin('units_ref', 'units_ref.id', 'assets.unit_id')
      .where(scopeFilter(scopes, 'units_ref.path', 'assets.asset_type_id'));
    if (query.assetTypeId) q = q.where('assets.asset_type_id', '=', query.assetTypeId);
    if (query.unitId) q = q.where(query.includeSubunits ? inSubtree(query.unitId, 'units_ref.path') : sql<SqlBool>`assets.unit_id = ${query.unitId}`);
    if (query.status) q = q.where('assets.status', '=', query.status);
    if (query.ownerId) q = q.where('assets.owner_id', '=', query.ownerId);
    // Only non-restricted values are indexed, so search cannot reveal secrets.
    if (query.q) q = q.where(search ? search.where : sql<SqlBool>`false`);
    for (const f of query.filters) q = q.where(filterExpression(f, type));

    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    let page = q.selectAll('assets').select(sql<string[] | null>`units_ref.path`.as('unit_path'));
    if (search) page = page.select(search.snippet.as('snippet'));
    if (query.sort === 'relevance' && search) {
      page = page.orderBy(search.rank, 'desc').orderBy('assets.updated_at', 'desc');
    } else if (query.sort.startsWith('attributes.')) {
      const key = query.sort.slice('attributes.'.length);
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw AppError.validation('Invalid sort field');
      page = page.orderBy(sql`assets.attributes -> ${key}`, sql.raw(`${query.order} nulls last`));
    } else if (query.sort in SORT_LOOKUPS) {
      page = page.orderBy(SORT_LOOKUPS[query.sort as keyof typeof SORT_LOOKUPS], sql.raw(`${query.order} nulls last`));
    } else {
      const col = SORT_COLUMNS[(query.sort === 'relevance' ? 'updatedAt' : query.sort) as keyof typeof SORT_COLUMNS];
      if (!col) throw AppError.validation('Invalid sort field');
      page = page.orderBy(sql.ref(`assets.${col}`), query.order);
    }
    const rows = await page.orderBy('assets.id').limit(query.limit).offset(query.offset).execute();
    return { items: rows.map((r) => toAsset(r as AssetRow)), total };
  }

  async getAsset(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.assets().where('assets.id', '=', id);
    if (opts.forUpdate) q = q.forUpdate('assets');
    const r = await q.executeTakeFirst();
    return r ? toAsset(r as AssetRow) : null;
  }

  private async assetValues(draft: AssetDraft, searchText: string) {
    const type = await this.getType(draft.assetTypeId);
    const { open, restricted } = splitRestricted(type!, draft.values);
    return {
      asset_type_id: draft.assetTypeId,
      type_version: draft.typeVersion,
      name: draft.name,
      status: draft.status,
      owner_id: draft.ownerId,
      unit_id: draft.unitId,
      attributes: json(open),
      restricted_attributes: json(restricted),
      reminder_overrides: json(draft.reminderOverrides),
      search_text: searchText,
      search_key: foldText(searchText),
    };
  }

  async insertAsset(draft: AssetDraft, actorId: string, searchText: string) {
    const r = await this.db
      .insertInto('assets')
      .values({ ...(await this.assetValues(draft, searchText)), version: 1, created_by: actorId, updated_by: actorId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return (await this.getAsset(r.id))!;
  }

  async saveAsset(id: string, draft: AssetDraft, actorId: string, searchText: string) {
    await this.db
      .updateTable('assets')
      .set({ ...(await this.assetValues(draft, searchText)), version: sql`version + 1`, updated_by: actorId, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
    return (await this.getAsset(id))!;
  }

  async setSearchText(id: string, searchText: string) {
    await this.db.updateTable('assets').set({ search_text: searchText, search_key: foldText(searchText) }).where('id', '=', id).execute();
  }

  async deleteAsset(id: string) {
    await this.db.deleteFrom('assets').where('id', '=', id).execute();
  }

  async assetIdsOfTypes(typeIds: string[]) {
    return (await this.db.selectFrom('assets').select('id').where('asset_type_id', 'in', typeIds).execute()).map((r) => r.id);
  }

  async assetIdsToReindex(where: { unitIds?: string[]; userIds?: string[]; unindexed?: boolean }) {
    const conds: Array<ReturnType<typeof sql<SqlBool>>> = [];
    if (where.unitIds?.length) conds.push(sql<SqlBool>`unit_id in (select id from units_ref where path && ${sql.val(where.unitIds)}::uuid[])`);
    for (const u of where.userIds ?? []) conds.push(sql<SqlBool>`(owner_id = ${u}::uuid or attributes::text like ${`%${u}%`})`);
    if (where.unindexed) conds.push(sql<SqlBool>`search_text = ''`);
    if (!conds.length) return [];
    const rows = await this.db.selectFrom('assets').select('id').where(sql<SqlBool>`(${sql.join(conds, sql` or `)})`).limit(50_000).execute();
    return rows.map((r) => r.id);
  }

  async assetNames(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await this.db.selectFrom('assets').select(['id', 'name']).where('id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ─── Activity ────────────────────────────────────────────────────────────

  async addActivity(e: Omit<ActivityEntry, 'id' | 'at'>) {
    await this.db.insertInto('activity').values({ asset_id: e.assetId, actor_id: e.actorId, actor_name: e.actorName, action: e.action, changes: json(e.changes) }).execute();
  }

  async listActivity(assetId: string, limit: number): Promise<ActivityEntry[]> {
    const rows = await this.db.selectFrom('activity').selectAll().where('asset_id', '=', assetId).orderBy('at', 'desc').limit(limit).execute();
    return rows.map((r) => ({ id: r.id, assetId: r.asset_id, actorId: r.actor_id, actorName: r.actor_name, action: r.action, changes: r.changes, at: r.at.toISOString() }));
  }

  // ─── Projections ─────────────────────────────────────────────────────────

  async getUnit(id: string): Promise<UnitRef | null> {
    const r = await this.db.selectFrom('units_ref').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? { id: r.id, key: r.key, name: r.name, kind: r.kind, parentId: r.parent_id, path: r.path, archived: r.archived } : null;
  }

  async unitPaths(ids: string[]) {
    if (!ids.length) return new Map<string, string[]>();
    const rows = await this.db.selectFrom('units_ref').select(['id', 'path']).where('id', 'in', [...new Set(ids)]).execute();
    return new Map(rows.map((r) => [r.id, r.path]));
  }

  async unitNames(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await this.db.selectFrom('units_ref').select(['id', 'name']).where('id', 'in', [...new Set(ids)]).execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async upsertUnitRef(ref: UnitRef) {
    const values = { key: ref.key, name: ref.name, kind: ref.kind, parent_id: ref.parentId, path: ref.path, archived: ref.archived };
    await this.db
      .insertInto('units_ref')
      .values({ id: ref.id, ...values })
      .onConflict((oc) => oc.column('id').doUpdateSet(values))
      .execute();
  }

  async activeUserIds(ids: string[]) {
    const rows = await this.db.selectFrom('users_ref').select('id').where('id', 'in', ids).where('active', '=', true).execute();
    return new Set(rows.map((r) => r.id));
  }

  async userNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = await this.db.selectFrom('users_ref').select(['id', 'display_name']).where('id', 'in', unique).execute();
    return new Map(rows.map((r) => [r.id, r.display_name]));
  }

  async upsertUserRef(ref: { id: string; displayName: string; active: boolean }) {
    const prev = await this.db.selectFrom('users_ref').select('display_name').where('id', '=', ref.id).executeTakeFirst();
    await this.db
      .insertInto('users_ref')
      .values({ id: ref.id, display_name: ref.displayName, active: ref.active })
      .onConflict((oc) => oc.column('id').doUpdateSet({ display_name: ref.displayName, active: ref.active }))
      .execute();
    return { renamed: !!prev && prev.display_name !== ref.displayName };
  }

  // ─── Requests ────────────────────────────────────────────────────────────

  private requests() {
    const comments = this.db
      .selectFrom('request_events')
      .select((eb) => ['request_id', eb.fn.countAll<number>().as('n')])
      .where('kind', '=', 'comment')
      .groupBy('request_id')
      .as('c');
    return this.db
      .selectFrom('requests')
      .leftJoin('units_ref', 'units_ref.id', 'requests.unit_id')
      .leftJoin(comments, 'c.request_id', 'requests.id')
      .selectAll('requests')
      .select([sql<string[] | null>`units_ref.path`.as('unit_path'), sql<number>`coalesce(c.n, 0)`.as('comment_count')]);
  }

  private requestValues(row: RequestRow, searchText: string) {
    return {
      title: row.title,
      description: row.description,
      unit_id: row.unitId,
      asset_type_id: row.assetTypeId,
      quantity: row.quantity,
      estimated_amount: row.estimatedCost?.amount ?? null,
      estimated_currency: row.estimatedCost?.currency ?? null,
      needed_by: row.neededBy,
      link: row.link,
      search_text: searchText,
      search_key: foldText(searchText),
    };
  }

  async insertRequest(row: RequestRow, requester: { id: string; name: string }, searchText: string) {
    const r = await this.db
      .insertInto('requests')
      .values({ ...this.requestValues(row, searchText), requester_id: requester.id, requester_name: requester.name, assignee_id: null, status: 'submitted', asset_id: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    return (await this.getRequest(r.id))!;
  }

  async updateRequest(id: string, row: RequestRow, searchText: string) {
    await this.db.updateTable('requests').set({ ...this.requestValues(row, searchText), updated_at: sql`now()` }).where('id', '=', id).execute();
    return (await this.getRequest(id))!;
  }

  async getRequest(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.requests().where('requests.id', '=', id);
    if (opts.forUpdate) q = q.forUpdate('requests');
    const r = await q.executeTakeFirst();
    return r ? toRequest(r as RequestRowDb) : null;
  }

  async setRequestStatus(id: string, status: RequestStatus, assetId?: string | null) {
    await this.db
      .updateTable('requests')
      .set({ status, updated_at: sql`now()`, ...(assetId !== undefined && { asset_id: assetId }) })
      .where('id', '=', id)
      .execute();
  }

  async setRequestAssignee(id: string, assigneeId: string | null) {
    await this.db.updateTable('requests').set({ assignee_id: assigneeId, updated_at: sql`now()` }).where('id', '=', id).execute();
  }

  /** Visible = I asked for it, or I can view its unit (members can, by default). */
  private visible(v: Visibility) {
    return sql<SqlBool>`(requests.requester_id = ${v.userId}::uuid or ${scopeFilter(v.viewScopes, 'units_ref.path', 'requests.asset_type_id')})`;
  }

  private requestScope(scope: RequestQuery['scope'], v: Visibility) {
    switch (scope) {
      case 'mine':
        return sql<SqlBool>`requests.requester_id = ${v.userId}::uuid`;
      case 'team':
        return v.myUnitIds.length ? sql<SqlBool>`(${this.visible(v)} and units_ref.path && ${sql.val(v.myUnitIds)}::uuid[])` : sql<SqlBool>`false`;
      case 'handle':
        return scopeFilter(v.editScopes, 'units_ref.path', 'requests.asset_type_id');
      case 'all':
        return this.visible(v);
    }
  }

  async queryRequests(q: RequestQuery, v: Visibility) {
    const search = q.q ? textSearch('requests', q.q, this.fuzzy) : null;
    let base = this.db.selectFrom('requests').leftJoin('units_ref', 'units_ref.id', 'requests.unit_id').where(this.requestScope(q.scope, v));
    if (q.status === 'open') base = base.where('requests.status', 'in', ['submitted', 'in_review', 'approved', 'ordered']);
    else if (q.status === 'closed') base = base.where('requests.status', 'in', ['fulfilled', 'rejected', 'cancelled']);
    else if (q.status !== 'all') base = base.where('requests.status', '=', q.status);
    if (q.unitId) base = base.where(inSubtree(q.unitId, 'units_ref.path'));
    if (q.assigneeId) base = base.where('requests.assignee_id', '=', q.assigneeId);
    if (q.q) base = base.where(search ? search.where : sql<SqlBool>`false`);
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const ids = await base
      .select('requests.id')
      .$if(!!search, (qb) => qb.orderBy(search!.rank, 'desc'))
      .orderBy('requests.created_at', 'desc')
      .limit(q.limit)
      .offset(q.offset)
      .execute();
    if (!ids.length) return { items: [], total };
    let rows = this.requests().where('requests.id', 'in', ids.map((r) => r.id));
    if (search) rows = rows.select(search.snippet.as('snippet'));
    const byId = new Map((await rows.execute()).map((r) => [r.id, toRequest(r as RequestRowDb)]));
    return { items: ids.map((r) => byId.get(r.id)!).filter(Boolean), total };
  }

  async countRequests(v: Visibility) {
    const open = sql<SqlBool>`requests.status in ('submitted','in_review','approved','ordered')`;
    const r = await this.db
      .selectFrom('requests')
      .leftJoin('units_ref', 'units_ref.id', 'requests.unit_id')
      .where(open)
      .select([
        sql<number>`count(*) filter (where ${this.requestScope('mine', v)})`.as('mine'),
        sql<number>`count(*) filter (where ${this.requestScope('team', v)})`.as('team'),
        sql<number>`count(*) filter (where ${this.requestScope('handle', v)})`.as('handle'),
        sql<number>`count(*) filter (where ${this.requestScope('handle', v)} and requests.assignee_id is null)`.as('unassigned'),
      ])
      .executeTakeFirstOrThrow();
    return { mine: Number(r.mine), team: Number(r.team), handle: Number(r.handle), unassigned: Number(r.unassigned) };
  }

  async addRequestEvent(e: Omit<RequestEvent, 'id' | 'at'>) {
    await this.db
      .insertInto('request_events')
      .values({ request_id: e.requestId, actor_id: e.actorId, actor_name: e.actorName, kind: e.kind, body: e.body, from_status: e.fromStatus, to_status: e.toStatus })
      .execute();
  }

  async listRequestEvents(requestId: string): Promise<RequestEvent[]> {
    const rows = await this.db.selectFrom('request_events').selectAll().where('request_id', '=', requestId).orderBy('at').execute();
    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      actorId: r.actor_id,
      actorName: r.actor_name,
      kind: r.kind,
      body: r.body,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      at: r.at.toISOString(),
    }));
  }

  async requestForAsset(assetId: string) {
    const r = await this.requests().where('requests.asset_id', '=', assetId).executeTakeFirst();
    return r ? toRequest(r as RequestRowDb) : null;
  }

  // ─── Saved views ─────────────────────────────────────────────────────────

  async listViews(ownerId: string): Promise<SavedView[]> {
    const rows = await this.db.selectFrom('saved_views').selectAll().where('owner_id', '=', ownerId).orderBy('created_at').execute();
    return rows.map(toView);
  }

  async createView(ownerId: string, input: SavedViewInput) {
    const count = await this.db.selectFrom('saved_views').select((eb) => eb.fn.countAll<number>().as('n')).where('owner_id', '=', ownerId).executeTakeFirstOrThrow();
    if (Number(count.n) >= 100) throw AppError.validation('You can keep up to 100 saved views');
    return toView(await this.db.insertInto('saved_views').values({ owner_id: ownerId, name: input.name, query: json(input.query), pinned: input.pinned }).returningAll().executeTakeFirstOrThrow());
  }

  async updateView(ownerId: string, id: string, input: SavedViewInput) {
    const r = await this.db
      .updateTable('saved_views')
      .set({ name: input.name, query: json(input.query), pinned: input.pinned })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .returningAll()
      .executeTakeFirst();
    if (!r) throw AppError.notFound('Saved view');
    return toView(r);
  }

  async deleteView(ownerId: string, id: string) {
    await this.db.deleteFrom('saved_views').where('id', '=', id).where('owner_id', '=', ownerId).execute();
  }

  publish<E extends EventName>(event: E, payload: EventMap[E]) {
    return enqueue(this.db, event, payload);
  }
}

const toView = (r: Selectable<RegistryDB['saved_views']>): SavedView => ({ id: r.id, name: r.name, query: r.query, pinned: r.pinned, createdAt: r.created_at.toISOString() });

