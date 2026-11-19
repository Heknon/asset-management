import { clsx, type ClassValue } from 'clsx';
import { daysBetween, describeDuration, type Duration, type IsoDate } from '@am/core';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function todayIso(): IsoDate {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function formatDate(iso: IsoDate | null | undefined, short = false): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  return (short && iso.slice(0, 4) === todayIso().slice(0, 4) ? shortDateFmt : dateFmt).format(d);
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatMoney(amount: number, currency = 'USD', compact = false): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: compact ? 0 : 2, notation: compact && amount >= 100_000 ? 'compact' : 'standard' }).format(amount);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function relativeDays(iso: IsoDate): string {
  const d = daysBetween(todayIso(), iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 0) return d < 60 ? `in ${d} days` : `in ${Math.round(d / 30)} months`;
  return -d < 60 ? `${-d} days ago` : `${Math.round(-d / 30)} months ago`;
}

export function formatDurations(list: Duration[]): string {
  return list.length ? list.map(describeDuration).join(', ') + ' before' : 'No reminders';
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
