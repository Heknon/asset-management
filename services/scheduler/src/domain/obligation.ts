import {
  addDuration,
  daysBetween,
  reminderDates,
  type AssetChanged,
  type Duration,
  type IsoDate,
  type Obligation,
  type ObligationState,
  type RenewalCheck,
  type RenewalRequestRef,
  type TrackedDate,
  type Urgency,
} from '@am/core';

/**
 * An obligation is one occurrence of a tracked date that someone must act on
 * ("Renew Figma by 2027-02-01"). There is at most one active obligation per
 * (asset, date field). Recurring dates produce a new obligation each cycle.
 */
export interface ObligationRecord {
  id: string;
  assetId: string;
  fieldKey: string;
  label: string;
  dateKind: TrackedDate['dateKind'];
  dueDate: IsoDate;
  recurring: boolean;
  reminders: Duration[];
  notify: TrackedDate['notify'];
  state: ObligationState;
  snoozedUntil: IsoDate | null;
  /** Bumped on every change so Outlook updates the same calendar entry. */
  sequence: number;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  note: string | null;
  /** Ask the owner this long before a recurring date (null: only on demand). */
  confirmBefore: Duration | null;
  check: RenewalCheckRecord | null;
  renewalRequest?: RenewalRequestRef | null;
}

export interface RenewalCheckRecord {
  status: RenewalCheck['status'];
  askedAt: Date | null;
  askedById: string | null;
  askedByName: string | null;
  message: string | null;
  answeredAt: Date | null;
  answeredById: string | null;
  answeredByName: string | null;
  note: string | null;
}

export const ACTIVE_STATES: ObligationState[] = ['open', 'snoozed'];

export type ReconcileAction =
  | { kind: 'create'; tracked: TrackedDate }
  | { kind: 'update'; id: string; tracked: TrackedDate; dateChanged: boolean }
  | { kind: 'resolve'; id: string; state: 'done' | 'superseded'; by: string | null };

/**
 * Pure reconciliation of the active obligations of one asset against the
 * asset's current tracked dates. The adapter applies the resulting actions.
 */
export function reconcile(active: readonly ObligationRecord[], event: AssetChanged, closed: ReadonlyArray<{ fieldKey: string; dueDate: string }> = []): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const actionable = event.active ? event.trackedDates.filter((t) => t.dateKind.behavior !== 'informational') : [];
  const byField = new Map(actionable.map((t) => [t.fieldKey, t]));

  for (const o of active) {
    const tracked = byField.get(o.fieldKey);
    if (!tracked) {
      actions.push({ kind: 'resolve', id: o.id, state: 'superseded', by: null });
      continue;
    }
    byField.delete(o.fieldKey);
    const adv = event.advanced;
    const advanced = !!adv && (o.fieldKey === adv.fieldKey ? adv.from === o.dueDate : adv.affected.includes(o.fieldKey) && o.dueDate !== tracked.date);
    if (advanced) {
      actions.push({ kind: 'resolve', id: o.id, state: 'done', by: adv!.by });
      actions.push({ kind: 'create', tracked });
    } else if (o.dueDate !== tracked.date || !sameSemantics(o, tracked)) {
      actions.push({ kind: 'update', id: o.id, tracked, dateChanged: o.dueDate !== tracked.date });
    }
  }
  for (const tracked of byField.values()) {
    // Completed or dismissed, and the date has not changed: it stays closed (an edit elsewhere does not reopen it).
    if (closed.some((c) => c.fieldKey === tracked.fieldKey && c.dueDate === tracked.date)) continue;
    actions.push({ kind: 'create', tracked });
  }
  return actions;
}

function sameSemantics(o: ObligationRecord, t: TrackedDate): boolean {
  return (
    o.label === t.label &&
    o.recurring === !!t.recurrence &&
    JSON.stringify(o.dateKind) === JSON.stringify(t.dateKind) &&
    JSON.stringify(o.reminders) === JSON.stringify(t.reminders) &&
    JSON.stringify(o.notify) === JSON.stringify(t.notify) &&
    JSON.stringify(o.confirmBefore ?? null) === JSON.stringify(t.confirmBefore ?? null)
  );
}

export function urgencyOf(dueDate: IsoDate, today: IsoDate): Urgency {
  const days = daysBetween(today, dueDate);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  if (days <= 30) return 'upcoming';
  return 'later';
}

/**
 * The reminder "slots" that have come due by `today`. Each slot is a stable
 * key used for idempotent delivery: before-due offsets, the due day itself,
 * the end of a snooze, and a weekly nudge while overdue.
 */
export function dueReminderSlot(o: Pick<ObligationRecord, 'dueDate' | 'reminders' | 'state' | 'snoozedUntil'>, today: IsoDate): string | null {
  // Once a snooze has ended it behaves as open again, with nothing from before its end.
  let after: IsoDate | null = null;
  if (o.state === 'snoozed') {
    if (o.snoozedUntil && o.snoozedUntil > today) return null;
    if (o.snoozedUntil === today) return `snooze:${o.snoozedUntil}`;
    after = o.snoozedUntil;
  }
  if (o.state !== 'open' && o.state !== 'snoozed') return null;
  if (!o.reminders.length) return null;
  if (today > o.dueDate) {
    const weeks = Math.floor(daysBetween(o.dueDate, today) / 7);
    const slot = addDuration(o.dueDate, { amount: weeks * 7, unit: 'day' });
    return after && slot <= after ? null : `overdue:${slot}`;
  }
  if (today === o.dueDate) return `due:${o.dueDate}`;
  // Only the most recent passed offset fires, so a late start never sends a burst of stale reminders.
  const passed = reminderDates({ date: o.dueDate, reminders: o.reminders }).filter((d) => d <= today && (!after || d > after));
  return passed.length ? `before:${passed[passed.length - 1]}` : null;
}

export function nextReminderDate(o: Pick<ObligationRecord, 'dueDate' | 'reminders' | 'state' | 'snoozedUntil'>, today: IsoDate): IsoDate | null {
  if (o.state === 'snoozed' && o.snoozedUntil && o.snoozedUntil > today) return o.snoozedUntil;
  if ((o.state !== 'open' && o.state !== 'snoozed') || !o.reminders.length) return null;
  const upcoming = [...reminderDates({ date: o.dueDate, reminders: o.reminders }), o.dueDate].filter((d) => d > today).sort();
  return upcoming[0] ?? null;
}

export interface AssetRef {
  assetId: string;
  name: string;
  assetTypeId: string;
  assetTypeName: string;
  unitId: string;
  /** Ancestor ids, root first, ending with the unit (from the units projection). */
  unitPath: string[];
  catalogId: string | null;
  ownerId: string | null;
  active: boolean;
  spend: { amount: number; currency: string } | null;
}

/** When the owner will be asked automatically, while nobody has asked yet. */
export function confirmOn(o: Pick<ObligationRecord, 'dueDate' | 'recurring' | 'confirmBefore' | 'check' | 'state'>): IsoDate | null {
  if (o.check || !o.recurring || !o.confirmBefore || !ACTIVE_STATES.includes(o.state)) return null;
  return addDuration(o.dueDate, o.confirmBefore, -1);
}

/** Due for the automatic "still needed?" question: the moment has come and the date has not passed. */
export function needsAutoAsk(o: ObligationRecord, today: IsoDate): boolean {
  const on = confirmOn(o);
  return !!on && on <= today && o.dueDate >= today;
}

const presentCheck = (c: RenewalCheckRecord): RenewalCheck => ({
  status: c.status,
  askedAt: c.askedAt?.toISOString() ?? null,
  askedByName: c.askedByName,
  message: c.message,
  answeredAt: c.answeredAt?.toISOString() ?? null,
  answeredByName: c.answeredByName,
  note: c.note,
});

export function present(o: ObligationRecord, asset: AssetRef, today: IsoDate): Obligation {
  return {
    id: o.id,
    assetId: o.assetId,
    assetName: asset.name,
    assetTypeId: asset.assetTypeId,
    assetTypeName: asset.assetTypeName,
    unitId: asset.unitId,
    ownerId: asset.ownerId,
    fieldKey: o.fieldKey,
    label: o.label,
    dateKind: o.dateKind,
    dueDate: o.dueDate,
    recurring: o.recurring,
    state: o.state,
    urgency: urgencyOf(o.dueDate, today),
    snoozedUntil: o.snoozedUntil,
    spend: asset.spend,
    resolvedAt: o.resolvedAt?.toISOString() ?? null,
    resolvedBy: o.resolvedBy,
    nextReminder: nextReminderDate(o, today),
    check: o.check ? presentCheck(o.check) : null,
    confirmOn: confirmOn(o),
    renewalRequest: o.renewalRequest && (o.renewalRequest.category === 'todo' || o.renewalRequest.category === 'active') ? o.renewalRequest : null,
  };
}

/** Today's calendar date in the organisation's timezone. */
export function todayIn(timeZone: string, now = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
