import {
  addDuration,
  daysBetween,
  reminderDates,
  type AssetChanged,
  type Duration,
  type IsoDate,
  type Obligation,
  type ObligationState,
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
export function reconcile(active: readonly ObligationRecord[], event: AssetChanged): ReconcileAction[] {
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
  for (const tracked of byField.values()) actions.push({ kind: 'create', tracked });
  return actions;
}

function sameSemantics(o: ObligationRecord, t: TrackedDate): boolean {
  return (
    o.label === t.label &&
    o.recurring === !!t.recurrence &&
    JSON.stringify(o.dateKind) === JSON.stringify(t.dateKind) &&
    JSON.stringify(o.reminders) === JSON.stringify(t.reminders) &&
    JSON.stringify(o.notify) === JSON.stringify(t.notify)
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
  if (o.state === 'snoozed') {
    if (o.snoozedUntil && o.snoozedUntil > today) return null;
    if (o.snoozedUntil) return `snooze:${o.snoozedUntil}`;
  }
  if (o.state !== 'open' && o.state !== 'snoozed') return null;
  if (!o.reminders.length) return null;
  if (today > o.dueDate) {
    const weeks = Math.floor(daysBetween(o.dueDate, today) / 7);
    return `overdue:${addDuration(o.dueDate, { amount: weeks * 7, unit: 'day' })}`;
  }
  if (today === o.dueDate) return `due:${o.dueDate}`;
  // Only the most recent passed offset fires, so a late start never sends a burst of stale reminders.
  const passed = reminderDates({ date: o.dueDate, reminders: o.reminders }).filter((d) => d <= today);
  return passed.length ? `before:${passed[passed.length - 1]}` : null;
}

export function nextReminderDate(o: Pick<ObligationRecord, 'dueDate' | 'reminders' | 'state' | 'snoozedUntil'>, today: IsoDate): IsoDate | null {
  if (o.state === 'snoozed' && o.snoozedUntil && o.snoozedUntil > today) return o.snoozedUntil;
  if (o.state !== 'open' || !o.reminders.length) return null;
  const upcoming = [...reminderDates({ date: o.dueDate, reminders: o.reminders }), o.dueDate].filter((d) => d > today).sort();
  return upcoming[0] ?? null;
}

export interface AssetRef {
  assetId: string;
  name: string;
  assetTypeId: string;
  assetTypeName: string;
  purchaseClassId: string;
  ownerId: string | null;
  active: boolean;
  spend: { amount: number; currency: string } | null;
}

export function present(o: ObligationRecord, asset: AssetRef, today: IsoDate): Obligation {
  return {
    id: o.id,
    assetId: o.assetId,
    assetName: asset.name,
    assetTypeId: asset.assetTypeId,
    assetTypeName: asset.assetTypeName,
    purchaseClassId: asset.purchaseClassId,
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
  };
}

/** Today's calendar date in the organisation's timezone. */
export function todayIn(timeZone: string, now = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
