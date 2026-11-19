import { AppError, type ActivityEntry, type AssetQuery, type AssetType, type AssetTypeInput, type DateKind, type DateKindInput, type EventMap, type EventName, type Scope } from '@am/core';
import { enqueue, scopeFilter } from '@am/platform';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { RegistryStore } from '../application/ports.js';
import { splitRestricted, type AssetDraft, type AssetState } from '../domain/asset.js';
import type { RegistryDB } from './schema.js';

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

const toAsset = (r: Selectable<RegistryDB['assets']>): AssetState => ({
  id: r.id,
  assetTypeId: r.asset_type_id,
  typeVersion: r.type_version,
  name: r.name,
  status: r.status,
  ownerId: r.owner_id,
  purchaseClassId: r.purchase_class_id,
  values: { ...r.attributes, ...r.restricted_attributes },
  reminderOverrides: r.reminder_overrides,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const SORT_COLUMNS = { name: 'name', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' } as const;

export class PgRegistryStore implements RegistryStore {
  /** Types are cached only within a transaction, never across requests or replicas. */
  private readonly typeCache = new Map<string, AssetType | null>();

  constructor(private readonly db: Kysely<RegistryDB>) {}

  transaction<T>(fn: (store: RegistryStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new PgRegistryStore(trx)));
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

  async queryAssets(query: AssetQuery, scopes: Scope[]) {
    let q = this.db.selectFrom('assets').where((eb) => scopeFilter(eb, scopes, 'purchase_class_id', 'asset_type_id'));
    if (query.assetTypeId) q = q.where('asset_type_id', '=', query.assetTypeId);
    if (query.purchaseClassId) q = q.where('purchase_class_id', '=', query.purchaseClassId);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.ownerId) q = q.where('owner_id', '=', query.ownerId);
    if (query.q) {
      // Only non-restricted attributes are searched, so search cannot reveal secrets.
      const like = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
      q = q.where((eb) => eb.or([eb('name', 'ilike', like), eb(sql`attributes::text`, 'ilike', like)]));
    }

    const total = Number((await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    let page = q.selectAll();
    if (query.sort.startsWith('attributes.')) {
      const key = query.sort.slice('attributes.'.length);
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw AppError.validation('Invalid sort field');
      page = page.orderBy(sql`attributes -> ${key}`, sql.raw(`${query.order} nulls last`));
    } else {
      const col = SORT_COLUMNS[query.sort as keyof typeof SORT_COLUMNS];
      if (!col) throw AppError.validation('Invalid sort field');
      page = page.orderBy(col, query.order);
    }
    const rows = await page.orderBy('id').limit(query.limit).offset(query.offset).execute();
    return { items: rows.map(toAsset), total };
  }

  async getAsset(id: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.db.selectFrom('assets').selectAll().where('id', '=', id);
    if (opts.forUpdate) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    return r ? toAsset(r) : null;
  }

  private async assetValues(draft: AssetDraft) {
    const type = await this.getType(draft.assetTypeId);
    const { open, restricted } = splitRestricted(type!, draft.values);
    return {
      asset_type_id: draft.assetTypeId,
      type_version: draft.typeVersion,
      name: draft.name,
      status: draft.status,
      owner_id: draft.ownerId,
      purchase_class_id: draft.purchaseClassId,
      attributes: json(open),
      restricted_attributes: json(restricted),
      reminder_overrides: json(draft.reminderOverrides),
    };
  }

  async insertAsset(draft: AssetDraft, actorId: string) {
    const r = await this.db
      .insertInto('assets')
      .values({ ...(await this.assetValues(draft)), version: 1, created_by: actorId, updated_by: actorId })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAsset(r);
  }

  async saveAsset(id: string, draft: AssetDraft, actorId: string) {
    const r = await this.db
      .updateTable('assets')
      .set({ ...(await this.assetValues(draft)), version: sql`version + 1`, updated_by: actorId, updated_at: sql`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAsset(r);
  }

  async deleteAsset(id: string) {
    await this.db.deleteFrom('assets').where('id', '=', id).execute();
  }

  async assetIdsOfTypes(typeIds: string[]) {
    return (await this.db.selectFrom('assets').select('id').where('asset_type_id', 'in', typeIds).execute()).map((r) => r.id);
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

  async purchaseClassExists(id: string) {
    return !!(await this.db.selectFrom('purchase_classes_ref').select('id').where('id', '=', id).where('archived', '=', false).executeTakeFirst());
  }

  async upsertPurchaseClassRef(ref: { id: string; key: string; name: string; archived: boolean }) {
    await this.db
      .insertInto('purchase_classes_ref')
      .values(ref)
      .onConflict((oc) => oc.column('id').doUpdateSet({ key: ref.key, name: ref.name, archived: ref.archived }))
      .execute();
  }

  async activeUserIds(ids: string[]) {
    const rows = await this.db.selectFrom('users_ref').select('id').where('id', 'in', ids).where('active', '=', true).execute();
    return new Set(rows.map((r) => r.id));
  }

  async upsertUserRef(ref: { id: string; displayName: string; active: boolean }) {
    await this.db
      .insertInto('users_ref')
      .values({ id: ref.id, display_name: ref.displayName, active: ref.active })
      .onConflict((oc) => oc.column('id').doUpdateSet({ display_name: ref.displayName, active: ref.active }))
      .execute();
  }

  publish<E extends EventName>(event: E, payload: EventMap[E]) {
    return enqueue(this.db, event, payload);
  }
}
