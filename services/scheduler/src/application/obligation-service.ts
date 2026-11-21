import {
  AppError,
  isValidIsoDate,
  ownerPermissions,
  effectivePermissions,
  SubjectKeyResolver,
  visibilityFor,
  type Permission,
  type AssetChanged,
  type CatalogChanged,
  type Obligation,
  type ObligationAction,
  type ObligationQuery,
  type ObligationSummary,
  type Page,
  type Principal,
  type UnitChanged,
  type UnitRollup,
  type UserChanged,
  type Visibility,
} from '@am/core';
import { authorize } from '@am/platform';
import { feed, type CalendarEntry } from '../domain/calendar.js';
import { needsAutoAsk, present, reconcile, type AssetRef, type ObligationRecord, type RenewalCheckRecord } from '../domain/obligation.js';
import type { ObligationWithAsset } from './ports.js';
import type { Clock, SchedulerStore } from './ports.js';

export class ObligationService {
  private readonly shareKeys: SubjectKeyResolver;

  constructor(
    private readonly store: SchedulerStore,
    private readonly clock: Clock,
    private readonly appUrl: string,
  ) {
    this.shareKeys = new SubjectKeyResolver(
      (ids) => store.unitPaths(ids),
      (userId) => store.groupIdsOf(userId),
    );
  }

  /** Org-tree scopes plus catalogs shared with the caller (same rules as the registry). */
  private async visibility(p: Principal, required: Permission): Promise<Visibility> {
    return visibilityFor(p, required, p.isAdmin ? [] : await this.shareKeys.of(p));
  }

  // ─── Projections (event handlers; idempotent) ────────────────────────────

  async onAssetChanged(e: AssetChanged): Promise<void> {
    await this.store.transaction(async (tx) => {
      const ref: AssetRef = {
        assetId: e.assetId,
        name: e.name,
        assetTypeId: e.assetTypeId,
        assetTypeName: e.assetTypeName,
        unitId: e.unitId,
        unitPath: [],
        catalogId: e.catalogId ?? null,
        ownerId: e.ownerId,
        active: e.active,
        spend: e.spend,
      };
      if (!(await tx.upsertAsset(ref, e.version))) return; // stale or duplicate delivery
      for (const action of reconcile(await tx.activeObligations(e.assetId, { forUpdate: true }), e, await tx.closedDates(e.assetId))) {
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
      groupIds: e.groupIds,
    });
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  async list(principal: Principal, q: ObligationQuery): Promise<Page<Obligation>> {
    const { items, total } = await this.store.query(q, await this.visibility(principal, 'view'), principal.userId);
    const today = this.clock.today();
    // Whether this person handles each date (snooze, dismiss, ask the owner): org grants, the owner's, and catalog shares.
    const keys = principal.isAdmin ? [] : await this.shareKeys.of(principal);
    const shares = new Map<string, Permission[]>();
    for (const c of new Set(items.map((i) => i.asset.catalogId).filter((c): c is string => !!c))) shares.set(c, principal.isAdmin ? [] : await this.store.catalogSharePermissions(c, keys));
    const canHandle = (a: AssetRef) =>
      effectivePermissions(principal, { unitPath: a.unitPath, assetTypeId: a.assetTypeId, shared: [...(a.ownerId === principal.userId ? ownerPermissions : []), ...(a.catalogId ? (shares.get(a.catalogId) ?? []) : [])] }).has('renew');
    return { items: items.map((i) => ({ ...present(i.obligation, i.asset, today), canHandle: canHandle(i.asset) })), total, limit: q.limit, offset: q.offset };
  }

  async summary(principal: Principal, q: { unitId?: string; mine: boolean }): Promise<ObligationSummary> {
    return this.store.summary(await this.visibility(principal, 'view'), this.clock.today(), { unitId: q.unitId, userId: q.mine ? principal.userId : undefined });
  }

  /** Division/department view: what renews beneath each child unit. */
  async rollup(principal: Principal, unitId: string): Promise<UnitRollup[]> {
    return this.store.rollup(await this.visibility(principal, 'view'), this.clock.today(), unitId);
  }

  async onCatalogChanged(e: CatalogChanged): Promise<void> {
    await this.store.transaction((tx) => tx.applyCatalog(e));
  }

  async onUnitChanged(e: UnitChanged): Promise<void> {
    await this.store.upsertUnit({ id: e.unitId, name: e.name, parentId: e.parentId, path: e.path, archived: e.archived, managerIds: e.managerIds });
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
    const shared = principal.isAdmin
      ? undefined
      : [...(found.asset.ownerId === principal.userId ? ownerPermissions : []), ...(await this.store.catalogSharePermissions(found.asset.catalogId, await this.shareKeys.of(principal)))];
    // The owner answers "still needed?" (owners usually only see); answering for them, and the rest, is "Handle renewals".
    const isOwner = !!found.asset.ownerId && found.asset.ownerId === principal.userId;
    authorize(principal, action.action === 'answer' && isOwner ? 'view' : 'renew', { unitPath: found.asset.unitPath, assetTypeId: found.asset.assetTypeId, shared });
    const o = found.obligation;
    const today = this.clock.today();

    switch (action.action) {
      case 'ask':
        assertActive(o);
        if (!found.asset.ownerId) throw AppError.validation('This item has no owner to ask');
        if (isOwner) throw AppError.validation('You own this item: answer it yourself');
        await this.recordCheck(found, {
          status: 'asked',
          askedAt: new Date(),
          askedById: principal.userId,
          askedByName: principal.displayName,
          message: action.message || null,
          answeredAt: null,
          answeredById: null,
          answeredByName: null,
          note: null,
        }, { id: principal.userId, name: principal.displayName });
        break;
      case 'answer':
        assertActive(o);
        await this.recordCheck(found, {
          ...(o.check ?? { askedAt: null, askedById: null, askedByName: null, message: null }),
          status: action.decision,
          answeredAt: new Date(),
          answeredById: principal.userId,
          answeredByName: principal.displayName,
          note: action.note || null,
        }, { id: principal.userId, name: principal.displayName });
        break;
      case 'complete':
        // A renewal is done by renewing it on the item (a new date), not by ticking it off.
        if (o.recurring || o.dateKind.behavior === 'recurring') throw AppError.validation(`Use "${o.dateKind.actionLabel}" on the asset to set its new date`);
        assertActive(o);
        await this.store.resolveObligation(id, 'done', principal.userId, action.note ?? null);
        break;
      case 'dismiss':
        assertActive(o);
        await this.store.resolveObligation(id, 'dismissed', principal.userId, action.note ?? null);
        break;
      case 'snooze':
        assertActive(o);
        // "Tomorrow" in the browser can already be today where reminders are sent (another time zone): accept today too.
        if (!isValidIsoDate(action.until) || action.until < today) throw AppError.validation('Snooze until a future date');
        // Snoozing hides reminders until then; past the date itself it would hide that it is due.
        if (action.until > o.dueDate && o.dueDate > today) throw AppError.validation('Snooze until the due date at the latest');
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

  /**
   * Asks owners "still needed?" when a recurring date's confirmation window
   * opens (the date field's "ask the owner … before" setting). Runs with the
   * reminder job; each occurrence is asked once.
   */
  async autoAsk(): Promise<number> {
    const today = this.clock.today();
    let asked = 0;
    for (const item of await this.store.confirmable(today)) {
      if (!needsAutoAsk(item.obligation, today)) continue;
      await this.recordCheck(item, {
        status: 'asked',
        askedAt: new Date(),
        askedById: null,
        askedByName: 'Asset Management',
        message: null,
        answeredAt: null,
        answeredById: null,
        answeredByName: null,
        note: null,
      }, null);
      asked++;
    }
    return asked;
  }

  /** Saves the check and publishes it (emails; a line in the asset's conversation). */
  private async recordCheck({ obligation: o, asset }: ObligationWithAsset, check: RenewalCheckRecord, actor: { id: string; name: string } | null) {
    await this.store.transaction(async (tx) => {
      await tx.setCheck(o.id, check);
      await tx.publish('renewal.check', {
        obligationId: o.id,
        assetId: o.assetId,
        assetName: asset.name,
        label: o.label,
        dueDate: o.dueDate,
        kind: check.status === 'asked' ? 'asked' : 'answered',
        status: check.status,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? 'Asset Management',
        text: check.status === 'asked' ? check.message : check.note,
        askedById: check.askedById,
        ownerId: asset.ownerId,
        unitId: asset.unitId,
        at: (check.status === 'asked' ? check.askedAt : check.answeredAt)!.toISOString(),
      });
    });
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

