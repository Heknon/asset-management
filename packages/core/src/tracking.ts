import type { AssetType } from './asset-type.js';
import { computeDerivedDates, type Attributes } from './attributes.js';
import type { DateBehavior, DateKind } from './date-kinds.js';
import { addDuration, type Duration, type IsoDate } from './duration.js';
import { AppError } from './errors.js';
import type { FieldOf } from './fields.js';

/** A date field with a value and a meaning, resolved against its date kind. */
export interface TrackedDate {
  fieldKey: string;
  label: string;
  date: IsoDate;
  derived: boolean;
  dateKind: { id: string; key: string; name: string; color: string; behavior: DateBehavior; actionLabel: string };
  /** Interval for recurring dates, or null. */
  recurrence: Duration | null;
  /** Offsets before `date` at which reminders fire. */
  reminders: Duration[];
  notify: { owner: boolean; userIds: string[]; emails: string[]; unitManagers: 'never' | 'fallback' | 'always' };
  /** Ask the owner to confirm the renewal this long before the date (recurring dates only). */
  confirmBefore: Duration | null;
}

type KindLookup = ReadonlyMap<string, DateKind>;

function trackedFields(type: Pick<AssetType, 'fields'>) {
  return type.fields.filter((f): f is FieldOf<'date'> => f.kind === 'date' && !!f.config.tracking);
}

/** How a date behaves: the field's own choice, else its kind's. */
export function behaviorOf(field: FieldOf<'date'>, kind: Pick<DateKind, 'behavior'>): DateKind['behavior'] {
  return field.config.tracking?.behavior ?? kind.behavior;
}

function recurrenceFor(field: FieldOf<'date'>, kind: DateKind, values: Attributes): Duration | null {
  if (behaviorOf(field, kind) !== 'recurring') return null;
  const r = field.config.tracking?.recurrence;
  if (r?.mode === 'manual') return null;
  if (r?.mode === 'fixed') return r.every;
  if (r?.mode === 'field') {
    const n = values[r.field];
    return typeof n === 'number' && n > 0 ? { amount: Math.trunc(n), unit: r.unit } : null;
  }
  return kind.defaultRecurrence ?? null;
}

/**
 * Resolves the effective semantics of each tracked date: field overrides win
 * over the date kind's defaults; per-asset reminder overrides win over both.
 */
export function resolveTrackedDates(
  type: Pick<AssetType, 'fields'>,
  values: Attributes,
  kinds: KindLookup,
  reminderOverrides: Readonly<Record<string, Duration[]>> = {},
): TrackedDate[] {
  const out: TrackedDate[] = [];
  for (const field of trackedFields(type)) {
    const tracking = field.config.tracking!;
    const kind = kinds.get(tracking.dateKindId);
    const date = values[field.key];
    if (!kind || typeof date !== 'string') continue;
    const userIds = tracking.notify.userFields.flatMap((k) => {
      const v = values[k];
      return typeof v === 'string' ? [v] : [];
    });
    out.push({
      fieldKey: field.key,
      label: field.label,
      date,
      derived: !!tracking.derive,
      dateKind: { id: kind.id, key: kind.key, name: kind.name, color: kind.color, behavior: behaviorOf(field, kind), actionLabel: kind.actionLabel },
      recurrence: recurrenceFor(field, kind, values),
      reminders: behaviorOf(field, kind) === 'informational' ? [] : (reminderOverrides[field.key] ?? tracking.reminders ?? kind.defaultReminders),
      notify: { owner: tracking.notify.owner, userIds: [...new Set(userIds)], emails: tracking.notify.emails, unitManagers: tracking.notify.unitManagers },
      confirmBefore: behaviorOf(field, kind) === 'recurring' ? (tracking.confirmBefore ?? null) : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Rolls a recurring date forward by its interval (e.g. "Renewed" on a yearly
 * license) and recomputes every date derived from it.
 */
export function advanceRecurringDate(
  type: Pick<AssetType, 'fields'>,
  values: Attributes,
  fieldKey: string,
  kinds: KindLookup,
  /**
   * The new date, when it is not simply one term later ("bought a year, got a
   * year and 10 days"), or when the date has no fixed term. Reminders and the
   * next renewal follow it like any other.
   */
  until?: IsoDate,
): { values: Attributes; from: IsoDate; to: IsoDate } {
  const field = trackedFields(type).find((f) => f.key === fieldKey);
  if (!field) throw AppError.validation(`"${fieldKey}" is not a tracked date`);
  if (field.config.tracking!.derive) throw AppError.validation(`"${field.label}" is derived; advance the date it is derived from`);
  const kind = kinds.get(field.config.tracking!.dateKindId);
  if (!kind) throw AppError.validation('Unknown date kind');
  const from = values[fieldKey];
  if (typeof from !== 'string') throw AppError.validation(`"${field.label}" has no value`);
  let to: IsoDate;
  if (until) {
    if (until <= from) throw AppError.validation(`The new ${field.label.toLowerCase()} must be after ${from}`);
    to = until;
  } else {
    const every = recurrenceFor(field, kind, values);
    if (!every) throw AppError.validation(`“${field.label}” has no fixed term: say until when it was renewed`);
    to = addDuration(from, every);
  }
  const next: Attributes = { ...values, [fieldKey]: to };
  return { values: { ...next, ...computeDerivedDates(type.fields, next) }, from, to };
}

/** Calendar dates on which reminders fire, latest-first offsets de-duplicated. */
export function reminderDates(tracked: Pick<TrackedDate, 'date' | 'reminders'>): IsoDate[] {
  return [...new Set(tracked.reminders.map((r) => addDuration(tracked.date, r, -1)))].sort();
}
