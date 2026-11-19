import { randomBytes } from 'node:crypto';
import { AppError, addDuration, type IsoDate, type ObligationQuery, type Scope, type TrackedDate } from '@am/core';
import { scopeFilter } from '@am/platform';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { ObligationWithAsset, SchedulerStore, UserRef } from '../application/ports.js';
import type { AssetRef, ObligationRecord } from '../domain/obligation.js';
import type { SchedulerDB } from './schema.js';

const json = (v: unknown) => JSON.stringify(v);
const ACTIVE = ['open', 'snoozed'] as const;

type Row = Selectable<SchedulerDB['obligations']> & Selectable<SchedulerDB['assets_ref']>;

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
});

const toAsset = (r: Row): AssetRef => ({
  assetId: r.asset_id,
  name: r.name,
  assetTypeId: r.asset_type_id,
  assetTypeName: r.asset_type_name,
  purchaseClassId: r.purchase_class_id,
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
    return this.db.selectFrom('obligations').innerJoin('assets_ref', 'assets_ref.asset_id', 'obligations.asset_id').selectAll(['obligations', 'assets_ref']);
  }

  // ─── Projection ──────────────────────────────────────────────────────────

  async upsertAsset(ref: AssetRef, version: number) {
    const values = {
      name: ref.name,
      asset_type_id: ref.assetTypeId,
      asset_type_name: ref.assetTypeName,
      purchase_class_id: ref.purchaseClassId,
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
    if (opts.forUpdate) q = q.forUpdate();
    return (await q.execute()).map((r) => toObligation(r as Row));
  }

  private trackedValues(t: TrackedDate) {
    return {
      label: t.label,
      date_kind: json(t.dateKind),
      due_date: t.date,
      recurring: !!t.recurrence,
      reminders: json(t.reminders),
      notify: json({ ...t.notify, emails: t.notify.emails.map((e) => e.toLowerCase()) }),
    };
  }

  async createObligation(assetId: string, t: TrackedDate) {
    const r = await this.db
      .insertInto('obligations')
      .values({ asset_id: assetId, field_key: t.fieldKey, ...this.trackedValues(t), state: 'open', snoozed_until: null, invites_synced_sequence: null, resolved_at: null, resolved_by: null, note: null })
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
        ...(dateChanged && { state: 'open', snoozed_until: null }),
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

  async query(q: ObligationQuery, scopes: Scope[], userId: string) {
    let base = this.db
      .selectFrom('obligations')
      .innerJoin('assets_ref', 'assets_ref.asset_id', 'obligations.asset_id')
      .where('assets_ref.deleted', '=', false)
      .where((eb) => scopeFilter(eb, scopes, 'assets_ref.purchase_class_id', 'assets_ref.asset_type_id'));
    if (q.state === 'active') base = base.where('obligations.state', 'in', ACTIVE);
    else if (q.state === 'all') base = base.where('obligations.state', '!=', 'superseded');
    else base = base.where('obligations.state', '=', q.state);
    if (q.from) base = base.where('obligations.due_date', '>=', q.from);
    if (q.to) base = base.where('obligations.due_date', '<=', q.to);
    if (q.assetId) base = base.where('obligations.asset_id', '=', q.assetId);
    if (q.dateKindId) base = base.where(sql`obligations.date_kind->>'id'`, '=', q.dateKindId);
    if (q.mine) {
      base = base.where((eb) => eb.or([eb('assets_ref.owner_id', '=', userId), eb(sql`obligations.notify->'userIds'`, '@>', sql`${json([userId])}::jsonb`)]));
    }
    const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const rows = await base
      .selectAll(['obligations', 'assets_ref'])
      .orderBy('obligations.due_date', q.state === 'done' || q.state === 'dismissed' ? 'desc' : 'asc')
      .orderBy('obligations.id')
      .limit(q.limit)
      .offset(q.offset)
      .execute();
    return { items: rows.map((r) => toPair(r as Row)), total };
  }

  async summary(scopes: Scope[], today: IsoDate) {
    const rows = await this.db
      .selectFrom('obligations')
      .innerJoin('assets_ref', 'assets_ref.asset_id', 'obligations.asset_id')
      .select(['obligations.asset_id', 'obligations.due_date', 'obligations.recurring', 'assets_ref.spend'])
      .where('assets_ref.deleted', '=', false)
      .where('assets_ref.active', '=', true)
      .where('obligations.state', 'in', ACTIVE)
      .where('obligations.due_date', '<=', addDuration(today, { amount: 90, unit: 'day' }))
      .where((eb) => scopeFilter(eb, scopes, 'assets_ref.purchase_class_id', 'assets_ref.asset_type_id'))
      .execute();
    const week = addDuration(today, { amount: 7, unit: 'day' });
    const month = addDuration(today, { amount: 30, unit: 'day' });
    const spend = new Map<string, { next30: Map<string, number>; next90: Map<string, number> }>();
    for (const r of rows) {
      if (!r.recurring || !r.spend || r.due_date < today) continue;
      const s = spend.get(r.spend.currency) ?? { next30: new Map(), next90: new Map() };
      s.next90.set(r.asset_id, r.spend.amount); // per asset, so two dates on one asset are not double counted
      if (r.due_date <= month) s.next30.set(r.asset_id, r.spend.amount);
      spend.set(r.spend.currency, s);
    }
    const sum = (m: Map<string, number>) => Math.round([...m.values()].reduce((a, b) => a + b, 0) * 100) / 100;
    return {
      overdue: rows.filter((r) => r.due_date < today).length,
      dueThisWeek: rows.filter((r) => r.due_date >= today && r.due_date <= week).length,
      dueThisMonth: rows.filter((r) => r.due_date >= today && r.due_date <= month).length,
      spend: [...spend.entries()].map(([currency, s]) => ({ currency, next30: sum(s.next30), next90: sum(s.next90) })),
    };
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

  async upsertUser(u: UserRef & { username: string }) {
    const values = {
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
    const token = randomBytes(24).toString('base64url');
    await this.db.updateTable('users_ref').set({ calendar_token: token }).where('id', '=', userId).execute();
    return token;
  }

  async userByCalendarToken(token: string) {
    const r = await this.db.selectFrom('users_ref').selectAll().where('calendar_token', '=', token).executeTakeFirst();
    return r ? toUser(r) : null;
  }
}
