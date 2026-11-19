import {
  AppError,
  isValidIsoDate,
  scopesFor,
  type AssetChanged,
  type Obligation,
  type ObligationAction,
  type ObligationQuery,
  type ObligationSummary,
  type Page,
  type Principal,
  type UserChanged,
} from '@am/core';
import { authorize } from '@am/platform';
import { feed, type CalendarEntry } from '../domain/calendar.js';
import { present, reconcile, type ObligationRecord, type AssetRef } from '../domain/obligation.js';
import type { Clock, SchedulerStore } from './ports.js';

export class ObligationService {
  constructor(
    private readonly store: SchedulerStore,
    private readonly clock: Clock,
    private readonly appUrl: string,
  ) {}

  // ─── Projections (event handlers; idempotent) ────────────────────────────

  async onAssetChanged(e: AssetChanged): Promise<void> {
    await this.store.transaction(async (tx) => {
      const ref: AssetRef = {
        assetId: e.assetId,
        name: e.name,
        assetTypeId: e.assetTypeId,
        assetTypeName: e.assetTypeName,
        purchaseClassId: e.purchaseClassId,
        ownerId: e.ownerId,
        active: e.active,
        spend: e.spend,
      };
      if (!(await tx.upsertAsset(ref, e.version))) return; // stale or duplicate delivery
      for (const action of reconcile(await tx.activeObligations(e.assetId, { forUpdate: true }), e)) {
        if (action.kind === 'create') await tx.createObligation(e.assetId, action.tracked);
        else if (action.kind === 'update') await tx.updateObligation(action.id, action.tracked, action.dateChanged);
        else await tx.resolveObligation(action.id, action.state, action.by);
      }
    });
  }

  async onAssetDeleted(assetId: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      for (const o of await tx.activeObligations(assetId, { forUpdate: true })) await tx.resolveObligation(o.id, 'superseded', null);
      await tx.markAssetDeleted(assetId);
    });
  }

  async onUserChanged(e: UserChanged): Promise<void> {
    await this.store.upsertUser({
      id: e.userId,
      username: e.username,
      displayName: e.displayName,
      email: e.email,
      active: e.active,
      emailReminders: e.preferences.emailReminders,
      outlookInvites: e.preferences.outlookInvites,
    });
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  async list(principal: Principal, q: ObligationQuery): Promise<Page<Obligation>> {
    const scopes = scopesFor(principal, 'view');
    const { items, total } = await this.store.query(q, scopes, principal.userId);
    const today = this.clock.today();
    return { items: items.map((i) => present(i.obligation, i.asset, today)), total, limit: q.limit, offset: q.offset };
  }

  async summary(principal: Principal): Promise<ObligationSummary> {
    return this.store.summary(scopesFor(principal, 'view'), this.clock.today());
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  /**
   * Acting on an occurrence. Recurring dates are completed by rolling the date
   * forward in the registry ("Renewed"), which closes this occurrence via the
   * resulting event; here they can only be snoozed, dismissed or reopened.
   */
  async act(principal: Principal, id: string, action: ObligationAction): Promise<Obligation> {
    const found = await this.store.getObligation(id);
    if (!found) throw AppError.notFound('Obligation');
    authorize(principal, 'edit', { purchaseClassId: found.asset.purchaseClassId, assetTypeId: found.asset.assetTypeId });
    const o = found.obligation;
    const today = this.clock.today();

    switch (action.action) {
      case 'complete':
        if (o.recurring) throw AppError.validation(`Use "${o.dateKind.actionLabel}" on the asset to roll this date forward`);
        assertActive(o);
        await this.store.resolveObligation(id, 'done', principal.userId, action.note ?? null);
        break;
      case 'dismiss':
        assertActive(o);
        await this.store.resolveObligation(id, 'dismissed', principal.userId, action.note ?? null);
        break;
      case 'snooze':
        assertActive(o);
        if (!isValidIsoDate(action.until) || action.until <= today) throw AppError.validation('Snooze until a future date');
        await this.store.setSnooze(id, action.until);
        break;
      case 'reopen':
        if (o.state !== 'done' && o.state !== 'dismissed' && o.state !== 'snoozed') throw AppError.validation('Only closed or snoozed items can be reopened');
        if ((await this.store.activeObligations(o.assetId)).some((x) => x.fieldKey === o.fieldKey && x.id !== o.id)) {
          throw AppError.conflict('A newer occurrence of this date is already open');
        }
        await this.store.reopen(id);
        break;
    }
    const updated = (await this.store.getObligation(id))!;
    return present(updated.obligation, updated.asset, today);
  }

  // ─── Calendar feed ───────────────────────────────────────────────────────

  async feedUrl(principal: Principal, rotate: boolean): Promise<{ url: string }> {
    const token = await this.store.calendarToken(principal.userId, rotate);
    return { url: `${this.appUrl}/api/scheduler/calendar/${token}.ics` };
  }

  /** Token-authenticated (calendar clients cannot sign in); only the user's own items are included. */
  async feed(token: string): Promise<string> {
    const user = await this.store.userByCalendarToken(token);
    if (!user?.active) throw AppError.notFound('Calendar');
    const from = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const items = await this.store.feedFor(user.id, from);
    return feed(
      'Asset obligations',
      items.map(({ obligation: o, asset }) => calendarEntry(o, asset, this.appUrl)),
    );
  }
}

function assertActive(o: ObligationRecord) {
  if (o.state !== 'open' && o.state !== 'snoozed') throw AppError.validation('This item is already closed');
}

export function calendarEntry(o: ObligationRecord, asset: AssetRef, appUrl: string, cancelled = false): CalendarEntry {
  const host = new URL(appUrl).hostname;
  return {
    uid: `${o.id}@${host}`,
    sequence: o.sequence,
    date: o.dueDate,
    summary: `${o.dateKind.name}: ${asset.name}`,
    description: `${o.label} for ${asset.name} (${asset.assetTypeName}). ${o.dateKind.actionLabel} in Asset Management.`,
    url: `${appUrl}/assets/${o.assetId}`,
    alarm: o.reminders.length ? [...o.reminders].sort((a, b) => toDays(a) - toDays(b))[0] : undefined,
    status: cancelled || (o.state !== 'open' && o.state !== 'snoozed') ? 'CANCELLED' : 'CONFIRMED',
  };
}

const toDays = (d: { amount: number; unit: string }) => d.amount * ({ day: 1, week: 7, month: 30, year: 365 }[d.unit] ?? 1);
