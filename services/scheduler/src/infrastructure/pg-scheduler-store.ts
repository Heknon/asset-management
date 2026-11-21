import { AppError, addDuration, type CatalogChanged, type Permission, type EventMap, type EventName, type IsoDate, type ObligationQuery, type RenewalRequestRef, type TrackedDate, type Visibility } from '@am/core';
import { catalogSharePermissions, enqueue, inSubtree, randomToken, visibleFilter } from '@am/platform';
import { sql, type Kysely, type Selectable, type SqlBool } from 'kysely';
import type { ObligationWithAsset, SchedulerStore, UserRef } from '../application/ports.js';
import type { AssetRef, ObligationRecord, RenewalCheckRecord } from '../domain/obligation.js';
import type { SchedulerDB } from './schema.js';

const json = (v: unknown) => JSON.stringify(v);
const ACTIVE = ['open', 'snoozed'] as const;
const VISIBLE_COLS = { unitPath: 'units_ref.path', assetType: 'assets_ref.asset_type_id', catalog: 'assets_ref.catalog_id', owner: 'assets_ref.owner_id' };

type Row = Selectable<SchedulerDB['obligations']> & Selectable<SchedulerDB['assets_ref']> & { unit_path: string[] | null };

const toObligation = (r: Row): ObligationRecord => ({
  id: r.id,
  assetId: r.asset_id,
  fieldKey: r.field_key,
  label: r.label,
  dateKind: r.date_kind,
  dueDate: r.due_date,
  recurring: r.recurring,
  reminders: r.reminders,
  notify: r.notify,
  state: r.state,
  snoozedUntil: r.snoozed_until,
  sequence: r.sequence,
  resolvedAt: r.resolved_at,
  resolvedBy: r.resolved_by,
  note: r.note,
  confirmBefore: r.confirm_before,
  check: r.check_status
    ? {
        status: r.check_status,
        askedAt: r.check_asked_at,
        askedById: r.check_asked_by,
        askedByName: r.check_asked_by_name,
        message: r.check_message,
        answeredAt: r.check_answered_at,
        answeredById: r.check_answered_by,
        answeredByName: r.check_answered_by_name,
        note: r.check_note,
      }
    : null,
  renewalRequest: r.renewal_request ?? null,
});

const toAsset = (r: Row): AssetRef => ({
  assetId: r.asset_id,
  name: r.name,
  assetTypeId: r.asset_type_id,
  assetTypeName: r.asset_type_name,
  unitId: r.unit_id,
  unitPath: r.unit_path ?? [r.unit_id],
  catalogId: r.catalog_id,
  ownerId: r.owner_id,
  active: r.active,
  spend: r.spend,
});

const toPair = (r: Row): ObligationWithAsset => ({ obligation: toObligation(r), asset: toAsset(r) });

const toUser = (r: Selectable<SchedulerDB['users_ref']>): UserRef => ({
  id: r.id,
  displayName: r.display_name,
  email: r.email,
  active: r.active,
  emailReminders: r.email_reminders,
  outlookInvites: r.outlook_invites,
});

export class PgSchedulerStore implements SchedulerStore {
  constructor(private readonly db: Kysely<SchedulerDB>) {}

  transaction<T>(fn: (store: SchedulerStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return fn(this);
    return this.db.transaction().execute((trx) => fn(new PgSchedulerStore(trx)));
  }

  private joined() {
    return this.db
      .selectFrom('obligations')
      .innerJoin('assets_ref', 'assets_ref.asset_id', 'obligations.asset_id')
      .leftJoin('units_ref', 'units_ref.id', 'assets_ref.unit_id')
      .selectAll(['obligations', 'assets_ref'])
      .select(sql<string[] | null>`units_ref.path`.as('unit_path'));
  }

  // ─── Projection ──────────────────────────────────────────────────────────

  async upsertAsset(ref: AssetRef, version: number) {
    const values = {
      name: ref.name,
      asset_type_id: ref.assetTypeId,
      asset_type_name: ref.assetTypeName,
      unit_id: ref.unitId,
      catalog_id: ref.catalogId,
      owner_id: ref.ownerId,
      active: ref.active,
      spend: json(ref.spend),
      version,
    };
    // Version-guarded upsert: out-of-order or repeated events are ignored... except
    // re-publications at the same version (type/kind changes), which must re-apply.
    const r = await this.db
      .insertInto('assets_ref')
      .values({ asset_id: ref.assetId, ...values })
      .onConflict((oc) => oc.column('asset_id').doUpdateSet({ ...values, deleted: false }).where('assets_ref.version', '<=', version))
      .returning('asset_id')
      .executeTakeFirst();
    return !!r;
  }

  async markAssetDeleted(assetId: string) {
    await this.db.updateTable('assets_ref').set({ deleted: true, active: false }).where('asset_id', '=', assetId).execute();
  }

  async activeObligations(assetId: string, opts: { forUpdate?: boolean } = {}) {
    let q = this.joined().where('obligations.asset_id', '=', assetId).where('obligations.state', 'in', ACTIVE);
    if (opts.forUpdate) q = q.forUpdate('obligations');
    return (await q.execute()).map((r) => toObligation(r as Row));
  }

  /** Dates of an asset someone completed or dismissed: they stay closed while the date is the same. */
  async closedDates(assetId: string) {
    return (await this.db.selectFrom('obligations').select(['field_key', 'due_date']).where('asset_id', '=', assetId).where('state', 'in', ['done', 'dismissed']).execute()).map((r) => ({
      fieldKey: r.field_key,
      dueDate: String(r.due_date).slice(0, 10),
    }));
  }

  private trackedValues(t: TrackedDate) {
    return {
      label: t.label,
      date_kind: json(t.dateKind),
      due_date: t.date,
      recurring: !!t.recurrence,
      reminders: json(t.reminders),
      notify: json({ ...t.notify, emails: t.notify.emails.map((e) => e.toLowerCase()) }),
      confirm_before: json(t.confirmBefore ?? null),
    };
  }

  async createObligation(assetId: string, t: TrackedDate) {
    const r = await this.db
      .insertInto('obligations')
      .values({ asset_id: assetId, field_key: t.fieldKey, ...this.trackedValues(t), state: 'open', snoozed_until: null, invites_synced_sequence: null, resolved_at: null, resolved_by: null, note: null, renewal_request: json(null) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return toObligation((await this.joined().where('obligations.id', '=', r.id).executeTakeFirstOrThrow()) as Row);
  }

  /** A moved date keeps its identity (same Outlook UID) and starts its reminder cycle afresh. */
  async updateObligation(id: string, t: TrackedDate, dateChanged: boolean) {
    await this.db
      .updateTable('obligations')
      .set({
        ...this.trackedValues(t),
        sequence: sql`sequence + 1`,
        updated_at: sql`now()`,
        // A new date is a new question: the old "still needed?" answer was about the old one.
        ...(dateChanged && {
          state: 'open',
          snoozed_until: null,
          check_status: null,
          check_asked_at: null,
          check_asked_by: null,
          check_asked_by_name: null,
          check_message: null,
          check_answered_at: null,
          check_answered_by: null,
          check_answered_by_name: null,
          check_note: null,
        }),
      })
      .where('id', '=', id)
      .execute();
  }

  async resolveObligation(id: string, state: ObligationRecord['state'], by: string | null, note: string | null = null) {
    await this.db
      .updateTable('obligations')
      .set({ state, resolved_at: new Date(), resolved_by: by, note, snoozed_until: null, sequence: sql`sequence + 1`, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async setSnooze(id: string, until: IsoDate) {
    await this.db.updateTable('obligations').set({ state: 'snoozed', snoozed_until: until, updated_at: sql`now()` }).where('id', '=', id).execute();
  }

  async reopen(id: string) {
    await this.db
      .updateTable('obligations')
      .set({ state: 'open', snoozed_until: null, resolved_at: null, resolved_by: null, sequence: sql`sequence + 1`, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async getObligation(id: string) {
    const r = await this.joined().where('obligations.id', '=', id).where('assets_ref.deleted', '=', false).executeTakeFirst();
    return r ? toPair(r as Row) : null;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  async query(q: ObligationQuery, visibility: Visibility, userId: string) {
    let base = this.db
      .selectFrom('obligations')
      .innerJoin('assets_ref', 'assets_ref.asset_id', 'obligations.asset_id')
      .leftJoin('units_ref', 'units_ref.id', 'assets_ref.unit_id')
      .where('assets_ref.deleted', '=', false)
      .where(visibleFilter(visibility, VISIBLE_COLS));
    if (q.unitId) base = base.where(inSubtree(q.unitId, 'units_ref.path'));
    if (q.state === 'active') base = base.where('obligations.state', 'in', ACTIVE);
    else if (q.state === 'all') base = base.where('obligations.state', '!=', 'superseded');
    else base = base.where('obligations.state', '=', q.state);
    if (q.from) base = base.where('obligations.due_date', '>=', q.from);
    if (q.to) base = base.where('obligations.due_date', '<=', q.to);
    if (q.assetId) base = base.where('obligations.asset_id', '=', q.assetId);
    if (q.dateKindId) base = base.where(sql`obligations.date_kind->>'id'`, '=', q.dateKindId);
    if (q.check === 'asked') base = base.where('obligations.check_status', '=', 'asked');
    else if (q.check === 'answered') base = base.where('obligations.check_status', 'in', ['renew', 'change', 'cancel']);
    if (q.mine) {
      base = base.where((eb) => eb.or([eb('assets_ref.owner_id', '=', userId), eb(sql`obligations.notify->'userIds'`, '@>', sql`${json([userId])}::jsonb`)]));
    }
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base
      .selectAll(['obligations', 'assets_ref'])
      .select(sql<string[] | null>`units_ref.path`.as('unit_path'))
      .orderBy('obligations.due_date', q.state === 'done' || q.state === 'dismissed' ? 'desc' : 'asc')
      .orderBy('obligations.id')
      .limit(q.limit)
      .offset(q.offset)
      .execute();
    return { items: rows.map((r) => toPair(r as Row)), total };
  }

  /** Active obligations of active assets due within a year, in scope. */
  private async upcomingRows(visibility: Visibility, today: IsoDate, filter: { unitId?: string; userId?: string }) {
    let q = this.db
      .selectFrom('obligations')
      .innerJoin('assets_ref', 'assets_ref.asset_id', 'obligations.asset_id')
      .leftJoin('units_ref', 'units_ref.id', 'assets_ref.unit_id')
      .select(['obligations.asset_id', 'obligations.due_date', 'obligations.recurring', 'assets_ref.spend', 'assets_ref.unit_id', sql<string[] | null>`units_ref.path`.as('unit_path')])
      .where('assets_ref.deleted', '=', false)
      .where('assets_ref.active', '=', true)
      .where('obligations.state', 'in', ACTIVE)
      .where('obligations.due_date', '<=', addDuration(today, { amount: 365, unit: 'day' }))
      .where(visibleFilter(visibility, VISIBLE_COLS));
    if (filter.unitId) q = q.where(inSubtree(filter.unitId, 'units_ref.path'));
    if (filter.userId) q = q.where((eb) => eb.or([eb('assets_ref.owner_id', '=', filter.userId!), eb(sql`obligations.notify->'userIds'`, '@>', sql`${json([filter.userId])}::jsonb`)]));
    return q.execute();
  }

  async summary(visibility: Visibility, today: IsoDate, filter: { unitId?: string; userId?: string } = {}) {
    const rows = await this.upcomingRows(visibility, today, filter);
    const week = addDuration(today, { amount: 7, unit: 'day' });
    const month = addDuration(today, { amount: 30, unit: 'day' });
    const quarter = addDuration(today, { amount: 90, unit: 'day' });
    const spend = new Map<string, { next30: Map<string, number>; next90: Map<string, number>; next365: Map<string, number> }>();
    for (const r of rows) {
      if (!r.recurring || !r.spend || r.due_date < today) continue;
      const s = spend.get(r.spend.currency) ?? { next30: new Map(), next90: new Map(), next365: new Map() };
      // Per asset, so two dates on one asset (renewal + notice) are not double counted.
      s.next365.set(r.asset_id, r.spend.amount);
      if (r.due_date <= quarter) s.next90.set(r.asset_id, r.spend.amount);
      if (r.due_date <= month) s.next30.set(r.asset_id, r.spend.amount);
      spend.set(r.spend.currency, s);
    }
    return {
      overdue: rows.filter((r) => r.due_date < today).length,
      dueThisWeek: rows.filter((r) => r.due_date >= today && r.due_date <= week).length,
      dueThisMonth: rows.filter((r) => r.due_date >= today && r.due_date <= month).length,
      spend: [...spend.entries()].map(([currency, s]) => ({ currency, next30: sumOf(s.next30), next90: sumOf(s.next90), next365: sumOf(s.next365) })),
    };
  }

  /** What renews beneath each direct child of a unit (and on the unit itself). */
  async rollup(visibility: Visibility, today: IsoDate, unitId: string) {
    const rows = await this.upcomingRows(visibility, today, { unitId });
    const quarter = addDuration(today, { amount: 90, unit: 'day' });
    const acc = new Map<string, { open: number; overdue: number; renewing: Set<string>; spend: Map<string, Map<string, number>> }>();
    for (const r of rows) {
      const path = r.unit_path ?? [r.unit_id];
      const i = path.indexOf(unitId);
      const child = path[i + 1] ?? unitId;
      const a = acc.get(child) ?? { open: 0, overdue: 0, renewing: new Set(), spend: new Map() };
      a.open++;
      if (r.due_date < today) a.overdue++;
      if (r.recurring && r.due_date >= today && r.due_date <= quarter) a.renewing.add(r.asset_id);
      if (r.recurring && r.spend && r.due_date >= today) {
        const m = a.spend.get(r.spend.currency) ?? new Map();
        m.set(r.asset_id, r.spend.amount);
        a.spend.set(r.spend.currency, m);
      }
      acc.set(child, a);
    }
    return [...acc.entries()].map(([id, a]) => ({
      unitId: id,
      openItems: a.open,
      overdue: a.overdue,
      renewingNext90: a.renewing.size,
      spendNext365: [...a.spend.entries()].map(([currency, m]) => ({ currency, amount: sumOf(m) })),
    }));
  }

  // ─── Units ───────────────────────────────────────────────────────────────

  async upsertUnit(u: { id: string; name: string; parentId: string | null; path: string[]; archived: boolean; managerIds: string[] }) {
    const values = { name: u.name, parent_id: u.parentId, path: u.path, archived: u.archived, manager_ids: u.managerIds };
    await this.db
      .insertInto('units_ref')
      .values({ id: u.id, ...values })
      .onConflict((oc) => oc.column('id').doUpdateSet(values))
      .execute();
  }

  async unitPaths(ids: string[]) {
    if (!ids.length) return new Map<string, string[]>();
    const rows = await this.db.selectFrom('units_ref').select(['id', 'path']).where('id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, r.path]));
  }

  /** Managers of the nearest unit up the tree (starting at the unit itself) that has any. */
  async nearestManagers(unitPath: string[]) {
    if (!unitPath.length) return [];
    const rows = await this.db.selectFrom('units_ref').select(['id', 'manager_ids']).where('id', 'in', unitPath).execute();
    const byId = new Map(rows.map((r) => [r.id, r.manager_ids]));
    for (const id of [...unitPath].reverse()) {
      const m = byId.get(id);
      if (m?.length) return m;
    }
    return [];
  }

  // ─── Reminders & invites ─────────────────────────────────────────────────

  async remindable(today: IsoDate) {
    const rows = await this.joined()
      .where('obligations.state', 'in', ACTIVE)
      .where('assets_ref.active', '=', true)
      .where('assets_ref.deleted', '=', false)
      .where('obligations.due_date', '<=', addDuration(today, { amount: 2, unit: 'year' }))
      .execute();
    return rows.map((r) => toPair(r as Row));
  }

  async wasDelivered(obligationId: string, recipient: string, slot: string) {
    return !!(await this.db
      .selectFrom('deliveries')
      .select('slot')
      .where('obligation_id', '=', obligationId)
      .where('recipient', '=', recipient.toLowerCase())
      .where('slot', '=', slot)
      .executeTakeFirst());
  }

  async recordDelivery(obligationId: string, recipient: string, slot: string) {
    await this.db
      .insertInto('deliveries')
      .values({ obligation_id: obligationId, recipient: recipient.toLowerCase(), slot })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async pendingInvites(limit: number) {
    const rows = await this.joined().where(sql<boolean>`obligations.sequence is distinct from obligations.invites_synced_sequence`).orderBy('obligations.updated_at').limit(limit).execute();
    if (!rows.length) return [];
    const sent = await this.db.selectFrom('invites').selectAll().where('obligation_id', 'in', rows.map((r) => r.id)).execute();
    return rows.map((r) => ({
      ...toPair(r as Row),
      recipients: sent.filter((s) => s.obligation_id === r.id).map((s) => ({ email: s.recipient, sentSequence: s.cancelled ? null : s.sequence })),
    }));
  }

  async recordInvite(obligationId: string, recipient: string, sequence: number, cancelled: boolean) {
    await this.db
      .insertInto('invites')
      .values({ obligation_id: obligationId, recipient: recipient.toLowerCase(), sequence, cancelled })
      .onConflict((oc) => oc.columns(['obligation_id', 'recipient']).doUpdateSet({ sequence, cancelled, sent_at: new Date() }))
      .execute();
  }

  async markInvitesSynced(obligationId: string, sequence: number) {
    await this.db.updateTable('obligations').set({ invites_synced_sequence: sequence }).where('id', '=', obligationId).execute();
  }

  async feedFor(userId: string, from: IsoDate) {
    const rows = await this.joined()
      .where('assets_ref.deleted', '=', false)
      .where('obligations.state', 'in', ACTIVE)
      .where('obligations.due_date', '>=', from)
      .where((eb) => eb.or([eb('assets_ref.owner_id', '=', userId), eb(sql`obligations.notify->'userIds'`, '@>', sql`${json([userId])}::jsonb`)]))
      .orderBy('obligations.due_date')
      .limit(2000)
      .execute();
    return rows.map((r) => toPair(r as Row));
  }

  // ─── People ──────────────────────────────────────────────────────────────

  async upsertUser(u: UserRef & { username: string; groupIds?: string[] }) {
    const values = {
      ...(u.groupIds && { group_ids: u.groupIds }),
      username: u.username,
      display_name: u.displayName,
      email: u.email?.toLowerCase() ?? null,
      active: u.active,
      email_reminders: u.emailReminders,
      outlook_invites: u.outlookInvites,
    };
    await this.db
      .insertInto('users_ref')
      .values({ id: u.id, ...values, calendar_token: null })
      .onConflict((oc) => oc.column('id').doUpdateSet(values))
      .execute();
  }

  async users(ids: string[]) {
    if (!ids.length) return new Map();
    const rows = await this.db.selectFrom('users_ref').selectAll().where('id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, toUser(r)]));
  }

  async calendarToken(userId: string, rotate: boolean) {
    const row = await this.db.selectFrom('users_ref').select('calendar_token').where('id', '=', userId).executeTakeFirst();
    if (!row) throw new AppError('unavailable', 'Your profile is still being set up; try again in a moment');
    if (row.calendar_token && !rotate) return row.calendar_token;
    const token = randomToken(24);
    await this.db.updateTable('users_ref').set({ calendar_token: token }).where('id', '=', userId).execute();
    return token;
  }

  async userByCalendarToken(token: string) {
    const r = await this.db.selectFrom('users_ref').selectAll().where('calendar_token', '=', token).executeTakeFirst();
    return r ? toUser(r) : null;
  }

  // ─── Renewal checks ──────────────────────────────────────────────────────

  async setRenewalRequest(target: { obligationId: string | null; assetId: string; fieldKey: string }, ref: RenewalRequestRef) {
    const open = ref.category === 'todo' || ref.category === 'active';
    let q = this.db
      .updateTable('obligations')
      .set({ renewal_request: json(ref) })
      // Keep the newest news: an older event of the same request, or a finished
      // request arriving after a newer one was opened, changes nothing.
      .where(
        sql<SqlBool>`(renewal_request is null or jsonb_typeof(renewal_request) = 'null'
          or (renewal_request->>'id' = ${ref.id} and renewal_request->>'at' <= ${ref.at})
          or (renewal_request->>'id' <> ${ref.id} and (${open} or renewal_request->>'category' not in ('todo','active'))))`,
      );
    // The occurrence it was opened for; otherwise the date's current one.
    q = target.obligationId
      ? q.where('id', '=', target.obligationId)
      : q.where('asset_id', '=', target.assetId).where('field_key', '=', target.fieldKey).where('state', 'in', ['open', 'snoozed']);
    await q.execute();
  }

  async setCheck(id: string, check: RenewalCheckRecord) {
    await this.db
      .updateTable('obligations')
      .set({
        check_status: check.status,
        check_asked_at: check.askedAt,
        check_asked_by: check.askedById,
        check_asked_by_name: check.askedByName,
        check_message: check.message,
        check_answered_at: check.answeredAt,
        check_answered_by: check.answeredById,
        check_answered_by_name: check.answeredByName,
        check_note: check.note,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  async confirmable(today: IsoDate) {
    const rows = await this.joined()
      .where('obligations.state', 'in', ACTIVE)
      .where('obligations.recurring', '=', true)
      .where('obligations.check_status', 'is', null)
      .where(sql`obligations.confirm_before`, 'is not', null)
      .where(sql`obligations.confirm_before`, '!=', sql`'null'::jsonb`)
      .where('obligations.due_date', '>=', today)
      .where('assets_ref.active', '=', true)
      .where('assets_ref.deleted', '=', false)
      .execute();
    return rows.map((r) => toPair(r as Row));
  }

  // ─── Catalog sharing projection ──────────────────────────────────────────

  async applyCatalog(e: CatalogChanged) {
    const r = await this.db
      .insertInto('catalogs_ref')
      .values({ id: e.catalogId, version: e.version, deleted: e.deleted })
      .onConflict((oc) => oc.column('id').doUpdateSet({ version: e.version, deleted: e.deleted }).where('catalogs_ref.version', '<=', e.version))
      .returning('id')
      .executeTakeFirst();
    if (!r) return false; // older than what we hold
    await this.db.deleteFrom('catalog_shares').where('catalog_id', '=', e.catalogId).execute();
    if (e.shares.length) await this.db.insertInto('catalog_shares').values(e.shares.map((x) => ({ catalog_id: e.catalogId, subject_key: x.subjectKey, permissions: x.permissions }))).execute();
    return true;
  }

  catalogSharePermissions(catalogId: string | null, shareKeys: readonly string[]): Promise<Permission[]> {
    return catalogSharePermissions(this.db, catalogId, shareKeys);
  }

  async groupIdsOf(userId: string) {
    return (await this.db.selectFrom('users_ref').select('group_ids').where('id', '=', userId).executeTakeFirst())?.group_ids ?? [];
  }

  publish<E extends EventName>(event: E, payload: EventMap[E]) {
    return enqueue(this.db, event, payload);
  }
}

const sumOf = (m: Map<string, number>) => Math.round([...m.values()].reduce((a, b) => a + b, 0) * 100) / 100;
