import { z } from 'zod';

export const durationUnits = ['day', 'week', 'month', 'year'] as const;
export type DurationUnit = (typeof durationUnits)[number];

export const durationSchema = z.object({
  amount: z.number().int().min(0).max(10_000),
  unit: z.enum(durationUnits),
});
export type Duration = z.infer<typeof durationSchema>;

/** Calendar dates are plain `YYYY-MM-DD` strings; all arithmetic is done in UTC to stay timezone-neutral. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format');
export type IsoDate = string;

export function parseIsoDate(value: IsoDate): Date {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  return date;
}

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !isoDateSchema.safeParse(value).success) return false;
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

export function formatIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/**
 * Adds a signed duration. Month/year arithmetic clamps to the last day of the
 * target month (Jan 31 + 1 month = Feb 28/29), matching how contracts are read.
 */
export function addDuration(date: IsoDate, duration: Duration, sign: 1 | -1 = 1): IsoDate {
  const d = parseIsoDate(date);
  const n = duration.amount * sign;
  switch (duration.unit) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + n);
      return formatIsoDate(d);
    case 'week':
      d.setUTCDate(d.getUTCDate() + n * 7);
      return formatIsoDate(d);
    case 'month':
    case 'year': {
      const months = duration.unit === 'year' ? n * 12 : n;
      const day = d.getUTCDate();
      const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
      const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      target.setUTCDate(Math.min(day, lastDay));
      return formatIsoDate(target);
    }
  }
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / 86_400_000);
}

export function describeDuration({ amount, unit }: Duration): string {
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}
