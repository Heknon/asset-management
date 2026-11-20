import { clsx, type ClassValue } from 'clsx';
import { daysBetween, type Duration, type DurationUnit, type IsoDate } from '@am/core';
import { twMerge } from 'tailwind-merge';
import { intlLocale, plural, t } from '@/lib/i18n';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function todayIso(): IsoDate {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dateFmt = new Intl.DateTimeFormat(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDateFmt = new Intl.DateTimeFormat(intlLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function formatDate(iso: IsoDate | null | undefined, short = false): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  return (short && iso.slice(0, 4) === todayIso().slice(0, 4) ? shortDateFmt : dateFmt).format(d);
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatMoney(amount: number, currency = 'USD', compact = false): string {
  return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency, maximumFractionDigits: compact ? 0 : 2, notation: compact && amount >= 100_000 ? 'compact' : 'standard' }).format(amount);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** "Today", "Tomorrow", "in 12 days", "3 months ago" — in the app's language. */
export function relativeDays(iso: IsoDate): string {
  const d = daysBetween(todayIso(), iso);
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  const text = Math.abs(d) < 60 ? rtf.format(d, 'day') : rtf.format(Math.round(d / 30), 'month');
  // "today" → "Today": these labels stand on their own.
  return text.charAt(0).toLocaleUpperCase(intlLocale()) + text.slice(1);
}

const unitForms: Record<DurationUnit, [string, string]> = {
  day: ['{n} day', '{n} days'],
  week: ['{n} week', '{n} weeks'],
  month: ['{n} month', '{n} months'],
  year: ['{n} year', '{n} years'],
};

/** "1 day", "3 months" — in the app's language. */
export function describeDuration({ amount, unit }: Duration): string {
  const [one, other] = unitForms[unit] ?? ['{n} ' + unit, '{n} ' + unit + 's'];
  return plural(amount, one, other);
}

export function formatDurations(list: Duration[]): string {
  return list.length ? t('{list} before', { list: list.map(describeDuration).join(', ') }) : t('No reminders');
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function slugKey(label: string): string {
  const k = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 48);
}

/** A name inside a sentence: "Hardware" → "hardware", but "SIM / mobile line" and "VPN" keep their capitals. */
export function inSentence(name: string): string {
  return name
    .split(' ')
    .map((w) => (/^[A-Z][a-z]/.test(w) ? w[0]!.toLowerCase() + w.slice(1) : w))
    .join(' ');
}
